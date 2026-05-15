// ─── BYOK CUSTOM PATCH: Qwen3 <think> tag stripping (Patch 61) ──────────────
// Preserved by .github/scripts/apply-byok-patches.sh. Do not remove.
// Installed at: src/extension/byok/common/qwenThinkingStripper.ts
//
// Qwen3 models (qwen3.6:27b, etc.) emit reasoning tokens inside
// <think>...</think> tags directly in the `content` delta field of
// /v1/chat/completions responses. Ollama (≤0.23.x) does not promote them
// to a separate `reasoning_content` field the way DeepSeek / OpenAI o-series
// do, so the extension's ThinkingDataContainer pipeline never sees them —
// the user observes raw <think> markup in the chat bubble instead of the
// collapsible "Thinking" section.
//
// This module is a streaming state machine with two modes:
//
//   passthrough  — emit content as-is, buffer last N chars in case they
//                  are the start of a partial <think> open tag
//   in-think     — buffer everything as reasoning text until </think> is
//                  found, then switch back to passthrough
//
// `process(chunk)` returns { content, reasoning_content }
//   content          — characters confirmed NOT part of a <think> block
//   reasoning_content — characters extracted from inside <think>…</think>
//
// `flush()` drains residual state when the stream ends. If we're still
// mid-<think> the buffered text is promoted to reasoning_content (best-effort).
//
// The caller (stream.ts) mutates `choice.delta` in-place before
// `extractThinkingDeltaFromChoice` runs, so the rest of the pipeline
// treats the reasoning as a normal ThinkingDelta.
// ─────────────────────────────────────────────────────────────────────────────

const THINK_OPEN = '<think>';
const THINK_CLOSE = '</think>';

export interface QwenStripResult {
	readonly content: string;
	readonly reasoning_content: string;
}

/**
 * Streaming sanitizer for Qwen3 <think>…</think> blocks.
 * Feed text chunks from `choice.delta.content` via `process()`,
 * call `flush()` when the stream ends.
 */
export class QwenThinkingStripper {
	private _buffer = '';
	private _thinkBuffer = '';
	private _inThink = false;

	process(chunk: string): QwenStripResult {
		if (!chunk) {
			return { content: '', reasoning_content: '' };
		}
		this._buffer += chunk;
		return this._drain();
	}

	flush(): QwenStripResult {
		if (this._inThink) {
			// Stream ended inside a <think> block — treat everything as reasoning
			const reasoning_content = this._thinkBuffer + this._buffer;
			this._thinkBuffer = '';
			this._buffer = '';
			this._inThink = false;
			return { content: '', reasoning_content };
		}
		const content = this._buffer;
		this._buffer = '';
		return { content, reasoning_content: '' };
	}

	private _drain(): QwenStripResult {
		let outContent = '';
		let outReasoning = '';

		for (;;) {
			if (!this._inThink) {
				const openIdx = this._buffer.indexOf(THINK_OPEN);
				if (openIdx !== -1) {
					// Emit everything before <think> as content
					outContent += this._buffer.slice(0, openIdx);
					this._buffer = this._buffer.slice(openIdx + THINK_OPEN.length);
					this._inThink = true;
					continue;
				}
				// No <think> found — safe to emit all but the last (THINK_OPEN.length - 1)
				// chars (they could be the start of a split tag spanning two chunks).
				const safeEnd = Math.max(0, this._buffer.length - (THINK_OPEN.length - 1));
				if (safeEnd > 0) {
					outContent += this._buffer.slice(0, safeEnd);
					this._buffer = this._buffer.slice(safeEnd);
				}
				break;
			} else {
				// Inside <think>: scan for </think>
				const closeIdx = this._buffer.indexOf(THINK_CLOSE);
				if (closeIdx !== -1) {
					outReasoning += this._thinkBuffer + this._buffer.slice(0, closeIdx);
					this._thinkBuffer = '';
					this._buffer = this._buffer.slice(closeIdx + THINK_CLOSE.length);
					this._inThink = false;
					continue;
				}
				// No </think> yet — buffer all but the last (THINK_CLOSE.length - 1) chars
				const safeEnd = Math.max(0, this._buffer.length - (THINK_CLOSE.length - 1));
				if (safeEnd > 0) {
					this._thinkBuffer += this._buffer.slice(0, safeEnd);
					this._buffer = this._buffer.slice(safeEnd);
				}
				break;
			}
		}

		return { content: outContent, reasoning_content: outReasoning };
	}
}
