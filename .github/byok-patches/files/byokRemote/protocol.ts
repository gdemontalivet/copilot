/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// AUTO-GENERATED — do NOT edit directly.
// Source of truth: /Users/guillaume/development/copilotmobile/protocol/index.ts
// Re-generate via `npm run sync` from the copilotmobile repo.

/**
 * Wire protocol between the BYOK extension's bridgeServer and the
 * copilotmobile web app.
 *
 * Single source of truth — the BYOK extension keeps a verbatim mirror of this
 * file at `src/extension/byokRemote/protocol.ts`. The sync script copies the
 * built web bundle into the extension, but the protocol types are duplicated
 * by hand so the extension's TypeScript compile doesn't need to reach across
 * repo boundaries.
 *
 * If you change anything here, mirror the edit in the BYOK extension copy.
 */

/**
 * Server -> client events streamed over the `/events` WebSocket.
 *
 * Lifecycle of a single assistant turn:
 *   1. `message.started` with a fresh `id`
 *   2. zero or more `message.delta` events appending text to that `id`
 *   3. zero or more interleaved `tool.started` / `tool.completed` pairs
 *   4. zero or more `approval.required` events that the client may answer
 *      with a `ClientRequest.approval`
 *   5. `message.completed` for the same `id`
 */
export type ServerEvent =
	| { type: 'hello'; sessionId: string; title: string; model: string }
	| { type: 'message.started'; id: string; role: 'assistant' }
	| { type: 'message.delta'; id: string; text: string }
	| { type: 'message.completed'; id: string }
	| { type: 'tool.started'; toolId: string; name: string; summary: string }
	| { type: 'tool.completed'; toolId: string; ok: boolean; summary: string }
	| { type: 'approval.required'; requestId: string; kind: string; details: string };

/**
 * Client -> server requests. `reply` posts a new user turn into the active
 * VS Code chat session; `approval` answers a pending tool-call confirmation.
 *
 * The bridgeServer accepts both via `POST /reply` and `POST /approval` HTTP
 * endpoints. We keep the shape as a discriminated union so a future iteration
 * can multiplex them over the same WebSocket if needed.
 */
export type ClientRequest =
	| { type: 'reply'; text: string }
	| { type: 'approval'; requestId: string; approved: boolean };

/** Type of any event the server can send. Useful for runtime narrowing. */
export const SERVER_EVENT_TYPES = [
	'hello',
	'message.started',
	'message.delta',
	'message.completed',
	'tool.started',
	'tool.completed',
	'approval.required',
] as const;

export type ServerEventType = (typeof SERVER_EVENT_TYPES)[number];
