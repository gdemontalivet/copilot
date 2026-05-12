// ─── BYOK CUSTOM PATCH: DeepSeek V4 DSML tool-call leakage workaround (Patch 58) ───
// Preserved by .github/scripts/apply-byok-patches.sh. Do not remove.
// Installed at: src/extension/byok/common/dsmlToolCallStripper.ts
//
// DeepSeek-V4-Pro and DeepSeek-V4-Flash have a known server-side bug
// (vllm-project/vllm#40801, deepseek-ai/DeepSeek-V3#1244,
// CherryHQ/cherry-studio#14714) where, in ~11% of `tool_choice=auto`
// + `stream=true` requests, the model's native DSML (DeepSeek Markup
// Language) tool-call tokens leak into the `content` field with
// `finish_reason: "stop"` and `tool_calls: null`. The client receives
// raw text that looks like:
//
//   <｜｜DSML｜｜tool_calls>
//   <｜｜DSML｜｜invoke name="read_file">
//     <｜｜DSML｜｜parameter name="filePath" string="true">/path</｜｜DSML｜｜parameter>
//     <｜｜DSML｜｜parameter name="startLine" string="false">1</｜｜DSML｜｜parameter>
//   </｜｜DSML｜｜invoke>
//   </｜｜DSML｜｜tool_calls>
//
// instead of the expected structured `tool_calls` JSON. The agent loop
// then treats the DSML markup as a plain assistant message and the
// tool calls are never executed — the user sees raw markup in the chat.
//
// This module is a streaming sanitizer with a state machine:
//
//   passthrough  — emit text as-is, except keep the last N chars
//                  buffered in case they're a partial DSML start marker
//   in-dsml      — buffer everything until we see the closing
//                  `</｜｜DSML｜｜tool_calls>` marker, then parse the
//                  payload into structured tool calls
//
// Output of `process(chunk)`:
//   - `text`: characters that are confirmed not part of a DSML block
//   - `calls`: any tool calls fully parsed during this chunk
//
// `flush()` drains residual state when the stream ends. If we're still
// mid-DSML the partial payload is parsed (best-effort) and any
// remaining passthrough text is emitted.
//
// The parser uses regex pre-compiled at module load. Tool-call IDs are
// minted deterministically per stripper instance: `deepseek_dsml_<n>`
// so the agent loop can reference them in subsequent tool_result
// messages without collision.
//
// ───────────────────────────────────────────────────────────────────────────

// Note: the special character below is FULLWIDTH VERTICAL LINE (U+FF5C),
// not the ASCII pipe (U+007C). DeepSeek's tokenizer uses this codepoint
// for its DSML control markers because U+FF5C is rare in real text.
export const DSML_TOOL_CALLS_OPEN = '<\uFF5C\uFF5CDSML\uFF5C\uFF5Ctool_calls>';
export const DSML_TOOL_CALLS_CLOSE = '</\uFF5C\uFF5CDSML\uFF5C\uFF5Ctool_calls>';

const DSML_INVOKE_REGEX = /<\uFF5C\uFF5CDSML\uFF5C\uFF5Cinvoke name="([^"]+)">([\s\S]*?)<\/\uFF5C\uFF5CDSML\uFF5C\uFF5Cinvoke>/g;
const DSML_PARAMETER_REGEX = /<\uFF5C\uFF5CDSML\uFF5C\uFF5Cparameter name="([^"]+)"(?:\s+string="(true|false)")?>([\s\S]*?)<\/\uFF5C\uFF5CDSML\uFF5C\uFF5Cparameter>/g;

export interface ParsedDsmlCall {
	readonly id: string;
	readonly name: string;
	readonly args: Record<string, unknown>;
}

export interface DsmlStripResult {
	readonly text: string;
	readonly calls: ParsedDsmlCall[];
}

/**
 * Parse the inner payload of a `<｜｜DSML｜｜tool_calls>...</｜｜DSML｜｜tool_calls>`
 * block into structured tool-call objects.
 *
 * Each `<｜｜DSML｜｜invoke name="X">` becomes a call with name `X`.
 * Each nested `<｜｜DSML｜｜parameter name="K" string="true|false">V</｜｜DSML｜｜parameter>`
 * becomes an entry in `args`. When `string="false"` the value is parsed
 * as JSON (matches DeepSeek's encoding for non-string types — numbers,
 * booleans, objects, arrays); otherwise treated as a literal string.
 *
 * Returns calls without IDs — the caller assigns them.
 */
export function parseDsmlPayload(payload: string): Array<{ name: string; args: Record<string, unknown> }> {
	const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
	DSML_INVOKE_REGEX.lastIndex = 0;
	let invokeMatch: RegExpExecArray | null;
	while ((invokeMatch = DSML_INVOKE_REGEX.exec(payload)) !== null) {
		const [, name, body] = invokeMatch;
		const args: Record<string, unknown> = {};
		DSML_PARAMETER_REGEX.lastIndex = 0;
		let paramMatch: RegExpExecArray | null;
		while ((paramMatch = DSML_PARAMETER_REGEX.exec(body)) !== null) {
			const [, key, isString, rawValue] = paramMatch;
			if (isString === 'false') {
				try {
					args[key] = JSON.parse(rawValue);
				} catch {
					args[key] = rawValue;
				}
			} else {
				args[key] = rawValue;
			}
		}
		calls.push({ name, args });
	}
	return calls;
}

/**
 * Streaming sanitizer for DSML tool-call leakage. Feed text chunks via
 * `process()` and call `flush()` when the stream ends.
 */
export class DsmlToolCallStripper {
	private _buffer = '';
	private _inDsml = false;
	private _callCounter = 0;
	private readonly _idPrefix: string;

	constructor(idPrefix = 'deepseek_dsml') {
		this._idPrefix = idPrefix;
	}

	process(chunk: string): DsmlStripResult {
		if (!chunk) {
			return this._drainOnce();
		}
		this._buffer += chunk;
		return this._drainAll();
	}

	flush(): DsmlStripResult {
		const allText: string[] = [];
		const allCalls: ParsedDsmlCall[] = [];
		if (this._inDsml) {
			const calls = this._mintCalls(parseDsmlPayload(this._buffer));
			allCalls.push(...calls);
			this._buffer = '';
			this._inDsml = false;
		}
		if (this._buffer) {
			allText.push(this._buffer);
			this._buffer = '';
		}
		return { text: allText.join(''), calls: allCalls };
	}

	private _drainAll(): DsmlStripResult {
		const collectedText: string[] = [];
		const collectedCalls: ParsedDsmlCall[] = [];
		for (;;) {
			const beforeLen = this._buffer.length;
			const beforeMode = this._inDsml;
			const step = this._drainOnce();
			if (step.text) {
				collectedText.push(step.text);
			}
			if (step.calls.length) {
				collectedCalls.push(...step.calls);
			}
			const stateChanged = this._inDsml !== beforeMode || this._buffer.length !== beforeLen;
			if (!stateChanged && !step.text && step.calls.length === 0) {
				break;
			}
		}
		return { text: collectedText.join(''), calls: collectedCalls };
	}

	private _drainOnce(): DsmlStripResult {
		if (!this._inDsml) {
			const openIdx = this._buffer.indexOf(DSML_TOOL_CALLS_OPEN);
			if (openIdx !== -1) {
				const text = this._buffer.slice(0, openIdx);
				this._buffer = this._buffer.slice(openIdx + DSML_TOOL_CALLS_OPEN.length);
				this._inDsml = true;
				return { text, calls: [] };
			}
			const safeEnd = this._findSafePassthroughEnd(this._buffer);
			if (safeEnd === 0) {
				return { text: '', calls: [] };
			}
			const text = this._buffer.slice(0, safeEnd);
			this._buffer = this._buffer.slice(safeEnd);
			return { text, calls: [] };
		}
		const closeIdx = this._buffer.indexOf(DSML_TOOL_CALLS_CLOSE);
		if (closeIdx === -1) {
			return { text: '', calls: [] };
		}
		const payload = this._buffer.slice(0, closeIdx);
		this._buffer = this._buffer.slice(closeIdx + DSML_TOOL_CALLS_CLOSE.length);
		this._inDsml = false;
		const calls = this._mintCalls(parseDsmlPayload(payload));
		return { text: '', calls };
	}

	private _findSafePassthroughEnd(buffer: string): number {
		const markerLen = DSML_TOOL_CALLS_OPEN.length;
		const start = Math.max(0, buffer.length - markerLen + 1);
		for (let i = start; i < buffer.length; i++) {
			const suffix = buffer.slice(i);
			if (DSML_TOOL_CALLS_OPEN.startsWith(suffix)) {
				return i;
			}
		}
		return buffer.length;
	}

	private _mintCalls(parsed: Array<{ name: string; args: Record<string, unknown> }>): ParsedDsmlCall[] {
		return parsed.map(c => ({
			id: `${this._idPrefix}_${++this._callCounter}`,
			name: c.name,
			args: c.args,
		}));
	}
}
