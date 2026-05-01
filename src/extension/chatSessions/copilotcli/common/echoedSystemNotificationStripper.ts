/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// ─── BYOK CUSTOM PATCH: strip echoed SYSTEM NOTIFICATION header (Patch 46) ──
// Preserved by .github/scripts/apply-byok-patches.sh. Do not remove.
// Purpose: drop the verbatim 3-line prompt wrapper that the Copilot CLI
// SDK prepends to task-notification prompts when a language model echoes
// it back at the start of its own response.
//
// Background. The Copilot CLI bundle (node_modules/@github/copilot/sdk)
// contains a helper `ICK(q, K)` that wraps background-task notifications
// with:
//
//     [SYSTEM NOTIFICATION - NOT USER INPUT]
//     This is an automated background-task event, NOT a message from the user.
//     Do NOT interpret this as user acknowledgement, confirmation, or
//     response to any pending question.
//
//     <original content>
//
// This header is meant to stay inside the model's prompt — it exists to
// stop the model from treating the injected tool result as a new user
// turn. Empirically, Gemini (gemini-2.5-pro, gemini-3.1-pro-preview) and
// to a lesser extent Claude occasionally echo the whole wrapper back at
// the start of their response when the turn is confused or interrupted
// by a downstream error. The first line renders as a Markdown-style
// heading in the chat UI and every subsequent `#` inside the echoed
// payload renders as a header too, producing the "there's a system
// notification inside my chatbox" artefact observed in long Gemini
// sessions.
//
// Fix scope. Intercept the two places where CopilotCLISession forwards
// assistant text to the chat UI (`assistant.message_delta` and
// `assistant.message` handlers in copilotcliSession.ts). For each
// messageId, buffer leading chunks until we have enough bytes to decide
// whether the prefix matches the exact 3-line wrapper. If it matches,
// drop the wrapper and flush the remainder. If it doesn't match, flush
// the buffered chunks as-is and commit to pass-through for the rest of
// that message. Only position 0 of a message is eligible — subsequent
// occurrences inside tool output or code blocks are left alone.
// ─── END BYOK CUSTOM PATCH ────────────────────────

/** The exact prompt-wrapper the Copilot CLI SDK prepends to task-notification prompts. */
export const ECHOED_SYSTEM_NOTIFICATION_HEADER =
	'[SYSTEM NOTIFICATION - NOT USER INPUT]\n' +
	'This is an automated background-task event, NOT a message from the user.\n' +
	'Do NOT interpret this as user acknowledgement, confirmation, or response to any pending question.\n\n';

/**
 * Returns a stateful stripper that tracks progress per messageId.
 *
 * The stripper has two public methods:
 *  - `process(messageId, chunk)` — call on every streaming chunk. Returns
 *    the text that should be forwarded downstream (possibly empty while
 *    the first chunks of a message are buffered pending a match decision).
 *  - `flush(messageId)` — call when the message is known to be complete
 *    (e.g. the wrapping turn ended) to drain any residual buffered bytes
 *    that never reached the decision threshold. Safe to call multiple
 *    times; a no-op once the message committed.
 *
 * Behaviour:
 *  - A chunk whose accumulated buffer starts with the FULL header is
 *    stripped once, and the post-header bytes (plus every later chunk
 *    for that messageId) flow through unchanged.
 *  - A chunk whose accumulated buffer does NOT start with a prefix of
 *    the header causes immediate commit-to-pass-through; the buffered
 *    bytes are returned as one chunk and every later chunk is forwarded
 *    unchanged.
 *  - While the buffer is strictly shorter than the header AND is still a
 *    valid prefix of it, the stripper holds the bytes and returns `''`.
 */
export function createEchoedSystemNotificationStripper() {
	type StripState = 'buffering' | 'stripped' | 'passthrough';
	const buffers = new Map<string, string>();
	const states = new Map<string, StripState>();
	const HEADER = ECHOED_SYSTEM_NOTIFICATION_HEADER;

	function commitPassthrough(messageId: string): string {
		const buffered = buffers.get(messageId) ?? '';
		states.set(messageId, 'passthrough');
		buffers.delete(messageId);
		return buffered;
	}

	return {
		process(messageId: string, chunk: string): string {
			if (!chunk) {
				return chunk;
			}
			const state = states.get(messageId);
			if (state === 'stripped' || state === 'passthrough') {
				return chunk;
			}
			const buffered = (buffers.get(messageId) ?? '') + chunk;

			if (buffered.length >= HEADER.length) {
				if (buffered.startsWith(HEADER)) {
					states.set(messageId, 'stripped');
					buffers.delete(messageId);
					return buffered.slice(HEADER.length);
				}
				states.set(messageId, 'passthrough');
				buffers.delete(messageId);
				return buffered;
			}

			// Buffered is shorter than the header — only keep buffering while
			// the accumulated text is still a valid prefix of the header.
			if (!HEADER.startsWith(buffered)) {
				states.set(messageId, 'passthrough');
				buffers.delete(messageId);
				return buffered;
			}

			buffers.set(messageId, buffered);
			states.set(messageId, 'buffering');
			return '';
		},

		flush(messageId: string): string {
			const state = states.get(messageId);
			if (state !== 'buffering') {
				return '';
			}
			return commitPassthrough(messageId);
		},
	};
}

export type EchoedSystemNotificationStripper = ReturnType<typeof createEchoedSystemNotificationStripper>;
