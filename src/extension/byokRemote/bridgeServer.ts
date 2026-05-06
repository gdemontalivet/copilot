/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// BYOK CUSTOM PATCH: mobile bridge server (Patch 50)
// Preserved by .github/scripts/apply-byok-patches.sh. Do not remove.
//
// Local HTTP + WebSocket server that the copilotmobile web app talks to.
// M0 scope:
//   - serves the Vite-built mobile bundle from the sibling `dist/` directory
//   - exposes `GET /events` (WebSocket) for streaming `ServerEvent`s
//   - exposes `POST /reply` and `POST /approval` for `ClientRequest`s
//   - exposes `GET /healthz` for liveness probes
//   - authenticates every request with a per-server `tkn` (rotated each start),
//     accepted via `?tkn=<token>` query string OR `vscode-tkn` cookie set on
//     first valid request.
//
// Deliberately hand-rolls the minimal RFC 6455 frame writer / close-frame
// reader rather than pulling in `ws` as a new dependency — the BYOK fork
// already eats nightly merge pain on package.json, and this server only
// streams text frames out.

import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as http from 'node:http';
import type { Socket } from 'node:net';
import * as path from 'node:path';
import type { Event } from '../../util/vs/base/common/event';
import { Emitter } from '../../util/vs/base/common/event';
import { Disposable } from '../../util/vs/base/common/lifecycle';
import type { ClientRequest, ServerEvent } from './protocol';

const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const COOKIE_NAME = 'vscode-tkn';
/** Static-asset MIME types we may ship from the Vite build. */
const MIME: Record<string, string> = {
	'.html': 'text/html; charset=utf-8',
	'.js': 'application/javascript; charset=utf-8',
	'.mjs': 'application/javascript; charset=utf-8',
	'.css': 'text/css; charset=utf-8',
	'.svg': 'image/svg+xml',
	'.png': 'image/png',
	'.jpg': 'image/jpeg',
	'.jpeg': 'image/jpeg',
	'.gif': 'image/gif',
	'.webp': 'image/webp',
	'.ico': 'image/x-icon',
	'.json': 'application/json; charset=utf-8',
	'.map': 'application/json; charset=utf-8',
	'.woff': 'font/woff',
	'.woff2': 'font/woff2',
	'.txt': 'text/plain; charset=utf-8',
};

export interface BridgeServerOptions {
	/** Absolute path to the directory containing index.html and assets/. */
	staticDir: string;
	/** Bind host. M0 default 127.0.0.1. */
	host: string;
	/** Bind port. 0 picks a random free port. */
	port: number;
	/** Optional preset token (test seam). When omitted, a fresh one is generated. */
	token?: string;
	/** Logger. */
	log: (msg: string) => void;
}

export interface BridgeServerInfo {
	host: string;
	port: number;
	token: string;
	url: string;
}

interface WsClient {
	socket: Socket;
	alive: boolean;
}

/**
 * Minimal HTTP + WS server. Events are broadcast to every connected
 * WebSocket client; HTTP requests are dispatched on the contribution side
 * via `onReply` / `onApproval`.
 */
export class BridgeServer extends Disposable {
	private _server: http.Server | undefined;
	private _info: BridgeServerInfo | undefined;
	private readonly _clients = new Set<WsClient>();
	/** Buffered events emitted before any client connected, replayed on first connect. */
	private readonly _replay: ServerEvent[] = [];

	private readonly _onReply = this._register(new Emitter<{ text: string }>());
	readonly onReply: Event<{ text: string }> = this._onReply.event;

	private readonly _onApproval = this._register(new Emitter<{ requestId: string; approved: boolean }>());
	readonly onApproval: Event<{ requestId: string; approved: boolean }> = this._onApproval.event;

	private readonly _onClientCount = this._register(new Emitter<number>());
	readonly onClientCount: Event<number> = this._onClientCount.event;

	constructor(private readonly opts: BridgeServerOptions) {
		super();
	}

	get info(): BridgeServerInfo | undefined {
		return this._info;
	}

	get clientCount(): number {
		return this._clients.size;
	}

	async start(): Promise<BridgeServerInfo> {
		if (this._info) {
			return this._info;
		}
		const token = this.opts.token ?? crypto.randomBytes(24).toString('base64url');
		const server = http.createServer((req, res) => this._onHttp(req, res, token));
		server.on('upgrade', (req, socket, head) => this._onUpgrade(req as http.IncomingMessage, socket as Socket, head as Buffer, token));

		await new Promise<void>((resolve, reject) => {
			const onError = (err: Error) => {
				server.removeListener('error', onError);
				reject(err);
			};
			server.once('error', onError);
			server.listen(this.opts.port, this.opts.host, () => {
				server.removeListener('error', onError);
				resolve();
			});
		});

		const addr = server.address();
		if (typeof addr !== 'object' || addr === null) {
			throw new Error('bridgeServer: failed to resolve listening address');
		}
		this._server = server;
		this._info = {
			host: this.opts.host,
			port: addr.port,
			token,
			url: `http://${this.opts.host}:${addr.port}/?tkn=${token}`,
		};
		this.opts.log(`bridgeServer listening on ${this._info.host}:${this._info.port}`);
		return this._info;
	}

	override dispose(): void {
		this.stop();
		super.dispose();
	}

	stop(): void {
		for (const c of this._clients) {
			try {
				writeCloseFrame(c.socket);
				c.socket.destroy();
			} catch {
				// Already disconnected — nothing to do.
			}
		}
		this._clients.clear();
		this._onClientCount.fire(0);
		this._server?.close();
		this._server = undefined;
		this._info = undefined;
		this._replay.length = 0;
	}

	/** Broadcast an event to every connected WebSocket client. */
	broadcast(event: ServerEvent): void {
		const payload = JSON.stringify(event);
		if (this._clients.size === 0) {
			// Buffer up to 200 events so a client connecting moments later
			// still sees the start of the active turn.
			this._replay.push(event);
			if (this._replay.length > 200) {
				this._replay.shift();
			}
			return;
		}
		for (const c of this._clients) {
			try {
				writeTextFrame(c.socket, payload);
			} catch (err) {
				this.opts.log(`bridgeServer: write failed, dropping client (${err instanceof Error ? err.message : String(err)})`);
				this._dropClient(c);
			}
		}
	}

	private _dropClient(c: WsClient): void {
		if (!this._clients.delete(c)) {
			return;
		}
		try {
			c.socket.destroy();
		} catch {
			// Already closed.
		}
		this._onClientCount.fire(this._clients.size);
	}

	private _onHttp(req: http.IncomingMessage, res: http.ServerResponse, token: string): void {
		const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
		const auth = checkToken(req, url, token);

		if (url.pathname === '/healthz') {
			res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
			res.end('ok');
			return;
		}

		if (!auth.ok) {
			res.writeHead(401, { 'Content-Type': 'text/plain; charset=utf-8' });
			res.end('unauthorized');
			return;
		}

		const setCookie = auth.setCookie ? buildCookieHeader(token) : undefined;

		if (req.method === 'POST' && url.pathname === '/reply') {
			void this._readJson(req).then(
				(body) => this._handleReply(body, res, setCookie),
				(err) => sendError(res, 400, `bad request: ${err.message}`, setCookie),
			);
			return;
		}
		if (req.method === 'POST' && url.pathname === '/approval') {
			void this._readJson(req).then(
				(body) => this._handleApproval(body, res, setCookie),
				(err) => sendError(res, 400, `bad request: ${err.message}`, setCookie),
			);
			return;
		}

		if (req.method === 'GET' || req.method === 'HEAD') {
			this._serveStatic(url.pathname, res, setCookie, req.method === 'HEAD');
			return;
		}

		sendError(res, 405, 'method not allowed', setCookie);
	}

	private _onUpgrade(req: http.IncomingMessage, socket: Socket, _head: Buffer, token: string): void {
		const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
		const auth = checkToken(req, url, token);
		if (!auth.ok || url.pathname !== '/events') {
			socket.write('HTTP/1.1 401 Unauthorized\r\nContent-Length: 0\r\n\r\n');
			socket.destroy();
			return;
		}
		const key = req.headers['sec-websocket-key'];
		if (typeof key !== 'string' || key.length === 0) {
			socket.write('HTTP/1.1 400 Bad Request\r\nContent-Length: 0\r\n\r\n');
			socket.destroy();
			return;
		}
		const accept = crypto.createHash('sha1').update(key + WS_GUID).digest('base64');
		socket.write(
			'HTTP/1.1 101 Switching Protocols\r\n' +
			'Upgrade: websocket\r\n' +
			'Connection: Upgrade\r\n' +
			`Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
		);
		socket.setNoDelay(true);

		const client: WsClient = { socket, alive: true };
		this._clients.add(client);
		this._onClientCount.fire(this._clients.size);
		this.opts.log(`bridgeServer: client connected (${this._clients.size} active)`);

		const onClose = () => {
			if (!client.alive) {
				return;
			}
			client.alive = false;
			this._dropClient(client);
			this.opts.log(`bridgeServer: client disconnected (${this._clients.size} active)`);
		};
		socket.on('close', onClose);
		socket.on('error', onClose);

		// Drain any buffered events emitted before this client showed up.
		const replay = this._replay.slice();
		for (const ev of replay) {
			try {
				writeTextFrame(socket, JSON.stringify(ev));
			} catch {
				onClose();
				return;
			}
		}

		// Discard any inbound frames except close/ping (RFC 6455 minimal subset).
		readFrames(socket, {
			onClose: () => {
				try {
					writeCloseFrame(socket);
				} catch {
					// Already closing.
				}
				onClose();
			},
			onPing: (payload) => {
				try {
					writeFrame(socket, 0x8a, payload);
				} catch {
					onClose();
				}
			},
			onError: onClose,
		});
	}

	private async _readJson(req: http.IncomingMessage): Promise<unknown> {
		const chunks: Buffer[] = [];
		let total = 0;
		const limit = 64 * 1024; // 64KB request cap — replies and approvals are tiny.
		for await (const chunk of req) {
			const buf = chunk instanceof Buffer ? chunk : Buffer.from(chunk);
			total += buf.length;
			if (total > limit) {
				throw new Error('request body too large');
			}
			chunks.push(buf);
		}
		const text = Buffer.concat(chunks).toString('utf8');
		try {
			return JSON.parse(text) as unknown;
		} catch {
			throw new Error('invalid JSON');
		}
	}

	private _handleReply(body: unknown, res: http.ServerResponse, setCookie?: string): void {
		const req = body as Partial<ClientRequest>;
		if (!req || req.type !== 'reply' || typeof req.text !== 'string' || req.text.length === 0) {
			sendError(res, 400, 'expected { type: "reply", text: string }', setCookie);
			return;
		}
		this._onReply.fire({ text: req.text });
		sendJson(res, 202, { accepted: true }, setCookie);
	}

	private _handleApproval(body: unknown, res: http.ServerResponse, setCookie?: string): void {
		const req = body as Partial<ClientRequest>;
		if (
			!req ||
			req.type !== 'approval' ||
			typeof req.requestId !== 'string' ||
			typeof req.approved !== 'boolean'
		) {
			sendError(res, 400, 'expected { type: "approval", requestId: string, approved: boolean }', setCookie);
			return;
		}
		this._onApproval.fire({ requestId: req.requestId, approved: req.approved });
		sendJson(res, 202, { accepted: true }, setCookie);
	}

	private _serveStatic(reqPath: string, res: http.ServerResponse, setCookie?: string, headOnly = false): void {
		const safe = reqPath === '/' ? '/index.html' : reqPath;
		const resolved = path.join(this.opts.staticDir, safe);
		const normalized = path.normalize(resolved);
		if (!normalized.startsWith(this.opts.staticDir)) {
			sendError(res, 403, 'forbidden', setCookie);
			return;
		}

		const tryFile = (file: string) => {
			fs.stat(file, (err, st) => {
				if (err || !st.isFile()) {
					if (file !== path.join(this.opts.staticDir, 'index.html')) {
						// SPA fallback — assets/* should 404, but `/` and unknown paths
						// fall back to index.html so direct deep-links still load.
						const indexFile = path.join(this.opts.staticDir, 'index.html');
						fs.stat(indexFile, (e2, st2) => {
							if (e2 || !st2.isFile()) {
								sendError(res, 404, 'not found', setCookie);
							} else {
								sendFile(indexFile, res, setCookie, headOnly);
							}
						});
					} else {
						sendError(res, 404, 'not found', setCookie);
					}
					return;
				}
				sendFile(file, res, setCookie, headOnly);
			});
		};

		tryFile(normalized);
	}
}

function sendFile(file: string, res: http.ServerResponse, setCookie?: string, headOnly = false): void {
	const ext = path.extname(file).toLowerCase();
	const headers: http.OutgoingHttpHeaders = {
		'Content-Type': MIME[ext] ?? 'application/octet-stream',
		// We aggressively no-cache so a freshly-synced bundle is always picked up.
		// In M0 we don't ship versioned URLs so this is the safe choice.
		'Cache-Control': 'no-store',
	};
	if (setCookie) {
		headers['Set-Cookie'] = setCookie;
	}
	if (headOnly) {
		res.writeHead(200, headers);
		res.end();
		return;
	}
	const stream = fs.createReadStream(file);
	stream.on('error', () => sendError(res, 500, 'read error', setCookie));
	res.writeHead(200, headers);
	stream.pipe(res);
}

function sendJson(res: http.ServerResponse, status: number, body: unknown, setCookie?: string): void {
	const headers: http.OutgoingHttpHeaders = {
		'Content-Type': 'application/json; charset=utf-8',
		'Cache-Control': 'no-store',
	};
	if (setCookie) {
		headers['Set-Cookie'] = setCookie;
	}
	res.writeHead(status, headers);
	res.end(JSON.stringify(body));
}

function sendError(res: http.ServerResponse, status: number, message: string, setCookie?: string): void {
	const headers: http.OutgoingHttpHeaders = {
		'Content-Type': 'text/plain; charset=utf-8',
		'Cache-Control': 'no-store',
	};
	if (setCookie) {
		headers['Set-Cookie'] = setCookie;
	}
	res.writeHead(status, headers);
	res.end(message);
}

function checkToken(req: http.IncomingMessage, url: URL, token: string): { ok: boolean; setCookie: boolean } {
	const queryToken = url.searchParams.get('tkn');
	if (queryToken && timingSafeEquals(queryToken, token)) {
		return { ok: true, setCookie: true };
	}
	const cookieToken = parseCookie(req.headers.cookie ?? '', COOKIE_NAME);
	if (cookieToken && timingSafeEquals(cookieToken, token)) {
		return { ok: true, setCookie: false };
	}
	return { ok: false, setCookie: false };
}

function parseCookie(header: string, name: string): string | undefined {
	const parts = header.split(';');
	for (const part of parts) {
		const eq = part.indexOf('=');
		if (eq === -1) {
			continue;
		}
		const k = part.slice(0, eq).trim();
		if (k === name) {
			return decodeURIComponent(part.slice(eq + 1).trim());
		}
	}
	return undefined;
}

function buildCookieHeader(token: string): string {
	// HttpOnly so JS can't read it; we still pass tkn= in the URL for WS upgrade
	// reliability on Mobile Safari. SameSite=Lax is fine — tunnel host is a
	// distinct origin so we can't set Strict.
	return `${COOKIE_NAME}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax`;
}

function timingSafeEquals(a: string, b: string): boolean {
	const aBuf = Buffer.from(a);
	const bBuf = Buffer.from(b);
	if (aBuf.length !== bBuf.length) {
		return false;
	}
	return crypto.timingSafeEqual(aBuf, bBuf);
}

// ─── Minimal RFC 6455 helpers ──────────────────────────────────────────────

function writeTextFrame(socket: Socket, text: string): void {
	const payload = Buffer.from(text, 'utf8');
	writeFrame(socket, 0x81, payload);
}

function writeCloseFrame(socket: Socket): void {
	// 1000 = normal closure
	const payload = Buffer.from([0x03, 0xe8]);
	writeFrame(socket, 0x88, payload);
}

function writeFrame(socket: Socket, opcodeByte: number, payload: Buffer): void {
	const len = payload.length;
	let header: Buffer;
	if (len < 126) {
		header = Buffer.from([opcodeByte, len]);
	} else if (len < 65536) {
		header = Buffer.alloc(4);
		header[0] = opcodeByte;
		header[1] = 126;
		header.writeUInt16BE(len, 2);
	} else {
		header = Buffer.alloc(10);
		header[0] = opcodeByte;
		header[1] = 127;
		header.writeUInt32BE(0, 2);
		header.writeUInt32BE(len >>> 0, 6);
	}
	socket.write(Buffer.concat([header, payload]));
}

interface FrameHandlers {
	onClose: () => void;
	onPing: (payload: Buffer) => void;
	onError: () => void;
}

/**
 * Drain inbound WebSocket frames. M0 cares about close + ping only — text/binary
 * payloads from the client are accepted but discarded (the mobile UI uses
 * POST /reply and POST /approval for client -> server messaging).
 */
function readFrames(socket: Socket, h: FrameHandlers): void {
	let buffer = Buffer.alloc(0);
	socket.on('data', (chunk) => {
		buffer = buffer.length === 0 ? chunk : Buffer.concat([buffer, chunk]);
		try {
			while (true) {
				const consumed = parseOneFrame(buffer, h);
				if (consumed === 0) {
					return;
				}
				buffer = buffer.slice(consumed);
			}
		} catch {
			h.onError();
			try {
				socket.destroy();
			} catch {
				// Already destroyed.
			}
		}
	});
}

function parseOneFrame(buffer: Buffer, h: FrameHandlers): number {
	if (buffer.length < 2) {
		return 0;
	}
	const b0 = buffer[0];
	const b1 = buffer[1];
	const opcode = b0 & 0x0f;
	const masked = (b1 & 0x80) !== 0;
	let payloadLen = b1 & 0x7f;
	let offset = 2;
	if (payloadLen === 126) {
		if (buffer.length < offset + 2) {
			return 0;
		}
		payloadLen = buffer.readUInt16BE(offset);
		offset += 2;
	} else if (payloadLen === 127) {
		if (buffer.length < offset + 8) {
			return 0;
		}
		const hi = buffer.readUInt32BE(offset);
		const lo = buffer.readUInt32BE(offset + 4);
		if (hi !== 0) {
			throw new Error('frame too large');
		}
		payloadLen = lo;
		offset += 8;
	}
	let mask: Buffer | undefined;
	if (masked) {
		if (buffer.length < offset + 4) {
			return 0;
		}
		mask = buffer.slice(offset, offset + 4);
		offset += 4;
	}
	if (buffer.length < offset + payloadLen) {
		return 0;
	}
	let payload = buffer.slice(offset, offset + payloadLen);
	if (mask) {
		const out = Buffer.alloc(payload.length);
		for (let i = 0; i < payload.length; i++) {
			out[i] = payload[i] ^ mask[i % 4];
		}
		payload = out;
	}
	const consumed = offset + payloadLen;

	switch (opcode) {
		case 0x8: // close
			h.onClose();
			break;
		case 0x9: // ping
			h.onPing(payload);
			break;
		case 0xa: // pong — ignored
			break;
		default:
			// text / binary / continuation — discard for M0
			break;
	}
	return consumed;
}
