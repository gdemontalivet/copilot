/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// BYOK CUSTOM PATCH: mobile bridge contribution (Patch 50)
// Preserved by .github/scripts/apply-byok-patches.sh. Do not remove.
//
// Wires together the bridgeServer + canned chat tap + reply injector and
// exposes the user-facing command:
//
//   "Copilot Full BYOK: Share chat with mobile"  (copilot-byok.mobile.share)
//   "Copilot Full BYOK: Stop sharing chat"        (copilot-byok.mobile.stop)
//
// The contribution is gated by `chat.byok.mobileBridge.enabled` (default
// `false`). With the setting off, the commands still register but issuing
// "Share" produces an info-message asking to opt in first — explicit by
// design because this opens a local-network port.
//
// M3 will replace the canned chatTap with the real BYOK chat participant
// stream wrapper, swap the loopback bind for a Dev Tunnel, and add QR-code
// rendering. M0 just gets the round-trip working.

import * as path from 'node:path';
import * as vscode from 'vscode';
import { ConfigKey, IConfigurationService } from '../../platform/configuration/common/configurationService';
import { IVSCodeExtensionContext } from '../../platform/extContext/common/extensionContext';
import { ILogService } from '../../platform/log/common/logService';
import type { IExtensionContribution } from '../common/contributions';
import { Disposable, DisposableStore } from '../../util/vs/base/common/lifecycle';
import { BridgeServer } from './bridgeServer';
import { CannedChatTap } from './chatTap';
import { LoggingReplyInjector } from './replyInjector';

const SHARE_COMMAND = 'copilot-byok.mobile.share';
const STOP_COMMAND = 'copilot-byok.mobile.stop';

export class BYOKRemoteContribution extends Disposable implements IExtensionContribution {
	public readonly id = 'byok-mobile-bridge';

	private _bridge: BridgeServer | undefined;
	private readonly _runtime = this._register(new DisposableStore());

	constructor(
		@IConfigurationService private readonly _configurationService: IConfigurationService,
		@ILogService private readonly _logService: ILogService,
		@IVSCodeExtensionContext private readonly _extensionContext: IVSCodeExtensionContext,
	) {
		super();
		this._register(vscode.commands.registerCommand(SHARE_COMMAND, () => this._share()));
		this._register(vscode.commands.registerCommand(STOP_COMMAND, () => this._stop()));
	}

	override dispose(): void {
		this._stop();
		super.dispose();
	}

	private async _share(): Promise<void> {
		if (!this._isEnabled()) {
			const action = await vscode.window.showInformationMessage(
				'BYOK Mobile bridge is disabled. Enable `chat.byok.mobileBridge.enabled` first?',
				'Open Settings',
			);
			if (action === 'Open Settings') {
				await vscode.commands.executeCommand(
					'workbench.action.openSettings',
					'chat.byok.mobileBridge',
				);
			}
			return;
		}

		if (this._bridge?.info) {
			const action = await vscode.window.showInformationMessage(
				`Bridge already running at ${this._bridge.info.url}`,
				'Copy URL',
				'Stop sharing',
			);
			if (action === 'Copy URL') {
				await vscode.env.clipboard.writeText(this._bridge.info.url);
			} else if (action === 'Stop sharing') {
				this._stop();
			}
			return;
		}

		try {
			await this._start();
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			this._logService.error(`BYOK Mobile: failed to start bridge: ${msg}`);
			void vscode.window.showErrorMessage(`BYOK Mobile: failed to start bridge — ${msg}`);
			this._stop();
			return;
		}

		const info = this._bridge?.info;
		if (!info) {
			return;
		}
		const action = await vscode.window.showInformationMessage(
			`Mobile bridge running at ${info.url}`,
			{ detail: 'Open this URL on your phone (same Wi-Fi if bound to 0.0.0.0).' },
			'Copy URL',
			'Stop sharing',
		);
		if (action === 'Copy URL') {
			await vscode.env.clipboard.writeText(info.url);
		} else if (action === 'Stop sharing') {
			this._stop();
		}
	}

	private async _start(): Promise<void> {
		const host = this._configurationService.getConfig(ConfigKey.ByokMobileBridgeBindHost) || '127.0.0.1';
		const port = this._configurationService.getConfig(ConfigKey.ByokMobileBridgePort) ?? 31547;
		const staticDir = this._resolveStaticDir();

		const bridge = new BridgeServer({
			host,
			port,
			staticDir,
			log: (msg) => this._logService.info(`BYOK Mobile: ${msg}`),
		});
		this._runtime.add(bridge);

		const tap = new CannedChatTap();
		this._runtime.add(tap);

		const injector = new LoggingReplyInjector();
		this._runtime.add(injector);

		this._runtime.add(tap.onEvent((ev) => bridge.broadcast(ev)));
		this._runtime.add(bridge.onReply(({ text }) => injector.injectReply(text)));
		this._runtime.add(bridge.onApproval(({ requestId, approved }) => injector.answerApproval(requestId, approved)));

		await bridge.start();

		this._bridge = bridge;
	}

	private _stop(): void {
		this._runtime.clear();
		this._bridge = undefined;
	}

	private _isEnabled(): boolean {
		try {
			return this._configurationService.getConfig(ConfigKey.ByokMobileBridgeEnabled) === true;
		} catch {
			return false;
		}
	}

	/**
	 * Resolve the directory containing the Vite-built mobile bundle. The
	 * bundle is shipped inside the VSIX at
	 * `<extensionPath>/dist/byokRemote/dist/` after `npm run sync` from the
	 * copilotmobile repo (which writes into
	 * `src/extension/byokRemote/dist/`, then the extension's own build copies
	 * it into the bundled output). We tolerate three layout variants so this
	 * works in dev (running from src), bundled extension (dist/extension.js),
	 * and tests.
	 */
	private _resolveStaticDir(): string {
		const extPath = this._extensionContext.extensionPath;
		const candidates = [
			path.join(extPath, 'dist', 'byokRemote', 'dist'),
			path.join(extPath, 'src', 'extension', 'byokRemote', 'dist'),
			path.join(extPath, 'out', 'extension', 'byokRemote', 'dist'),
		];
		// __dirname-based fallback covers the case where the file is loaded from
		// outside the extension context (unit tests, etc.).
		try {
			candidates.push(path.join(__dirname, 'dist'));
		} catch {
			// __dirname may not be defined under some bundlers — ignore.
		}
		const fs = require('node:fs') as typeof import('node:fs');
		for (const c of candidates) {
			try {
				if (fs.statSync(c).isDirectory()) {
					return c;
				}
			} catch {
				// keep trying
			}
		}
		this._logService.warn(
			`BYOK Mobile: static bundle not found at any of [${candidates.join(', ')}]. ` +
			'Run `npm run sync` from the copilotmobile repo to populate it.',
		);
		// Return the most-likely path anyway so the bridge starts and serves a
		// 404 — better UX than refusing to start at all.
		return candidates[0];
	}
}
