/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// BYOK CUSTOM PATCH: mobile bridge reply injector (Patch 50)
// Preserved by .github/scripts/apply-byok-patches.sh. Do not remove.
//
// M0 stub: logs every mobile reply / approval into the "BYOK Mobile" output
// channel so we can verify the round-trip without touching the actual chat
// session yet. M2 will replace `injectReply` with a real
// `vscode.commands.executeCommand('workbench.action.chat.open', { query })`
// call (with a fallback to chat-input write if that opens a new chat).

import * as vscode from 'vscode';
import { Disposable } from '../../util/vs/base/common/lifecycle';

export interface IReplyInjector {
	injectReply(text: string): void;
	answerApproval(requestId: string, approved: boolean): void;
	dispose(): void;
}

/**
 * Output-channel-backed stub. Created lazily on first message so the user
 * doesn't see an empty "BYOK Mobile" channel just because the bridge was
 * started. The channel is reused across server restarts within the same
 * VS Code session.
 */
export class LoggingReplyInjector extends Disposable implements IReplyInjector {
	private _channel: vscode.OutputChannel | undefined;

	constructor() {
		super();
	}

	override dispose(): void {
		this._channel?.dispose();
		this._channel = undefined;
		super.dispose();
	}

	private _ensureChannel(): vscode.OutputChannel {
		if (!this._channel) {
			this._channel = vscode.window.createOutputChannel('BYOK Mobile');
		}
		return this._channel;
	}

	injectReply(text: string): void {
		const ch = this._ensureChannel();
		ch.appendLine(`[${stamp()}] reply: ${oneLine(text)}`);
		ch.show(true);
	}

	answerApproval(requestId: string, approved: boolean): void {
		const ch = this._ensureChannel();
		ch.appendLine(`[${stamp()}] approval: ${requestId} -> ${approved ? 'approved' : 'denied'}`);
	}
}

function stamp(): string {
	return new Date().toISOString().slice(11, 19);
}

function oneLine(s: string): string {
	const trimmed = s.replace(/\s+/g, ' ').trim();
	return trimmed.length > 240 ? `${trimmed.slice(0, 240)}…` : trimmed;
}
