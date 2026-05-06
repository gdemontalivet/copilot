/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// BYOK CUSTOM PATCH: mobile bridge chat tap (Patch 50)
// Preserved by .github/scripts/apply-byok-patches.sh. Do not remove.
//
// M0 stub: emits a canned `message.started` -> 8 deltas -> `message.completed`
// cycle every few seconds so we can verify the WS plumbing on a phone before
// wiring the real BYOK chat participant's `ChatResponseStream` (M1).
//
// The shape exposed here (`IChatTap.onEvent`) is what M1 will keep —
// `ChatTap` will be replaced by a real implementation that wraps the
// participant's response stream, but every consumer (currently just the
// contribution wiring `bridgeServer.broadcast`) will keep working unchanged.

import { Emitter, type Event } from '../../util/vs/base/common/event';
import { Disposable } from '../../util/vs/base/common/lifecycle';
import type { ServerEvent } from './protocol';

export interface IChatTap {
	readonly onEvent: Event<ServerEvent>;
	dispose(): void;
}

const SAMPLE_TURNS: ReadonlyArray<{ title: string; tokens: ReadonlyArray<string> }> = [
	{
		title: 'M0 sanity check',
		tokens: [
			'Connected', ' to', ' the', ' BYOK', ' mobile', ' bridge.',
			' Streaming', ' deltas', ' look', ' good.',
			'\n\nIf', ' you', ' can', ' read', ' this', ' on', ' your', ' phone,',
			' the', ' WebSocket', ' plumbing', ' works.',
		],
	},
	{
		title: 'Reply round-trip',
		tokens: [
			'Send', ' a', ' reply', ' from', ' the', ' composer', ' below.',
			'\n\nIt', ' will', ' show', ' up', ' in', ' the', ' "BYOK', ' Mobile"',
			' output', ' channel', ' inside', ' VS', ' Code.',
		],
	},
];

/**
 * Pseudo-randomly cycle through the sample turns with realistic delta cadence.
 * Cancellation is honoured immediately — the `dispose()` cuts the active
 * timer chain.
 */
export class CannedChatTap extends Disposable implements IChatTap {
	private readonly _emitter = this._register(new Emitter<ServerEvent>());
	readonly onEvent: Event<ServerEvent> = this._emitter.event;

	private _stopped = false;
	private _timer: ReturnType<typeof setTimeout> | undefined;
	private _sessionId = `m0-${Date.now().toString(36)}`;
	private _turn = 0;

	constructor() {
		super();
		this._emit({
			type: 'hello',
			sessionId: this._sessionId,
			title: 'BYOK Mobile (M0 canned)',
			model: 'm0-stub',
		});
		this._scheduleNextTurn(1500);
	}

	override dispose(): void {
		this._stopped = true;
		if (this._timer) {
			clearTimeout(this._timer);
			this._timer = undefined;
		}
		super.dispose();
	}

	private _emit(ev: ServerEvent): void {
		if (this._stopped) {
			return;
		}
		this._emitter.fire(ev);
	}

	private _scheduleNextTurn(delayMs: number): void {
		this._timer = setTimeout(() => {
			if (this._stopped) {
				return;
			}
			void this._runTurn();
		}, delayMs);
	}

	private async _runTurn(): Promise<void> {
		const turn = SAMPLE_TURNS[this._turn % SAMPLE_TURNS.length];
		this._turn += 1;
		const id = `msg-${Date.now().toString(36)}-${this._turn}`;
		this._emit({ type: 'message.started', id, role: 'assistant' });
		this._emit({ type: 'message.delta', id, text: `[${turn.title}] ` });
		for (const token of turn.tokens) {
			if (this._stopped) {
				return;
			}
			await delay(160 + Math.random() * 90);
			this._emit({ type: 'message.delta', id, text: token });
		}
		await delay(150);
		this._emit({ type: 'message.completed', id });
		// Loop with a longer pause between turns.
		this._scheduleNextTurn(3500);
	}
}

function delay(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}
