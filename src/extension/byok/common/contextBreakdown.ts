/*---------------------------------------------------------------------------------------------
 *  BYOK CUSTOM FILE (Patch 51). Canonical copy under
 *  `.github/byok-patches/files/contextBreakdown.ts` and installed into
 *  `src/extension/byok/common/` by `.github/scripts/apply-byok-patches.sh`
 *  on every upstream sync. Do not edit the installed copy directly.
 *--------------------------------------------------------------------------------------------*/

import { Raw } from '@vscode/prompt-tsx';
import type { ITokenizer } from '../../../util/common/tokenizer';

/**
 * Pure types + classifier for the chat-panel context-window breakdown
 * status item (Patch 51). See {@link computeContextBreakdown} for the
 * compute pipeline; the BYOK-only ChatStatusItem in
 * `contextWindowStatusItem.ts` consumes the result and renders it in
 * the chat-panel status row alongside the codebase-index and
 * session-sync entries.
 *
 * The Cursor IDE shows seven segments when its context popover is opened
 * ("System prompt / Tools / Rules / Skills / Subagents /
 * Summarized conversation / Conversation"). The Copilot Chat extension's
 * prompt structure flattens "Rules" / "Skills" / "Subagents" into the
 * system message (rules + custom instructions are baked into the agent
 * prompt; skills/subagents are not first-class in the upstream prompt
 * tree), so we map to a slightly smaller set:
 *
 *   - `system`        — every Raw.ChatRole.System message
 *   - `tools`         — sum of tool-description tokens (pre-computed by
 *                       the caller via `ITokenizer.countToolTokens`)
 *   - `summary`       — text of the most recent
 *                       SummarizedConversationHistoryMetadata, when
 *                       compaction has fired (see Patches 4/6/23)
 *   - `history`       — every non-latest user / assistant / tool
 *                       message
 *   - `current`       — the latest user message
 *
 * Splitting `system` further into rules vs. base prompt would require
 * either invasive prompt-tree instrumentation or fragile substring
 * matching against rendered prompt text, neither of which earns its
 * keep at this MVP stage. We can layer that on later by walking
 * effectiveBuildPromptResult.metadata for first-class
 * {@link CustomInstructionsMetadata} entries when one exists upstream.
 */

export type ContextSegmentKind =
	| 'system'
	| 'tools'
	| 'summary'
	| 'history'
	| 'current';

export interface ContextSegment {
	readonly kind: ContextSegmentKind;
	/** Human-readable label rendered in the status item detail line. */
	readonly label: string;
	/** Token count for this segment. Already includes per-message overhead where applicable. */
	readonly tokens: number;
}

export interface ContextBreakdown {
	readonly segments: readonly ContextSegment[];
	/** Sum of all segment tokens. Reported by the caller when known to avoid double-counting. */
	readonly totalPromptTokens: number;
	readonly modelMaxPromptTokens: number;
	readonly modelId: string;
	/** epoch ms when this breakdown was produced */
	readonly computedAt: number;
}

export interface ContextBreakdownInput {
	readonly messages: readonly Raw.ChatMessage[];
	readonly tokenizer: ITokenizer;
	readonly modelId: string;
	readonly modelMaxPromptTokens: number;
	/**
	 * Pre-computed tool-token total (the toolCallingLoop already runs
	 * `tokenizer.countToolTokens(availableTools)` upstream of us — re-running
	 * it here would either be redundant or, worse, double-charge a tokenizer
	 * that hits the network like {@link ExtensionContributedChatTokenizer}).
	 */
	readonly toolTokenCount: number;
	/** Optional: if compaction has fired, the summary text (from `SummarizedConversationHistoryMetadata.text`). */
	readonly summaryText?: string;
	/**
	 * Optional: pre-computed `tokenizer.countMessagesTokens(messages)` total.
	 * If provided, used as the source-of-truth for `totalPromptTokens` and
	 * the system+history+current segments are scaled to add up to it (so the
	 * pie always sums correctly even when per-message tokenization rounds
	 * differently from the bulk path). If absent, we recompute.
	 */
	readonly totalMessagesTokensHint?: number;
}

/**
 * Walk `messages`, classify each, and produce a {@link ContextBreakdown}.
 *
 * Async because tokenization is async (some tokenizers in this codebase
 * call out to a network LM API — see `ExtensionContributedChatTokenizer`).
 *
 * Never throws: a tokenizer-side failure is caught per-message and that
 * message contributes 0 tokens to its segment, so a transient glitch
 * downgrades the breakdown's accuracy rather than failing the chat turn.
 */
export async function computeContextBreakdown(input: ContextBreakdownInput): Promise<ContextBreakdown> {
	const {
		messages,
		tokenizer,
		modelId,
		modelMaxPromptTokens,
		toolTokenCount,
		summaryText,
		totalMessagesTokensHint,
	} = input;

	// 1. Locate the index of the LATEST user message — that's the "current"
	//    segment. Everything before it that is user/assistant/tool is
	//    "history". Walk from the end so we stop at the first hit.
	let latestUserIndex = -1;
	for (let i = messages.length - 1; i >= 0; i--) {
		if (messages[i].role === Raw.ChatRole.User) {
			latestUserIndex = i;
			break;
		}
	}

	let systemTokens = 0;
	let historyTokens = 0;
	let currentTokens = 0;

	for (let i = 0; i < messages.length; i++) {
		const message = messages[i];
		const tokens = await safeCountMessageTokens(tokenizer, message);

		switch (message.role) {
			case Raw.ChatRole.System:
				systemTokens += tokens;
				break;
			case Raw.ChatRole.User:
				if (i === latestUserIndex) {
					currentTokens += tokens;
				} else {
					historyTokens += tokens;
				}
				break;
			case Raw.ChatRole.Assistant:
			case Raw.ChatRole.Tool:
				historyTokens += tokens;
				break;
			default:
				historyTokens += tokens;
				break;
		}
	}

	// 2. Carve "summary" out of "history" when SummarizedConversationHistoryMetadata
	//    has fired. The summary text lands in the prompt as a synthetic
	//    user/system message; rather than substring-matching across
	//    role-specific renderings we just tokenize the summary text directly
	//    and reassign that count from history → summary. If the summary's
	//    real footprint in the rendered prompt is slightly higher than the
	//    raw text (per-message overhead, role tags), we underestimate
	//    `summary` by ~3-8 tokens, which the user will not notice; the
	//    important thing is that the segment is visible and roughly right.
	let summaryTokens = 0;
	if (summaryText && summaryText.length > 0) {
		summaryTokens = await safeCountTextTokens(tokenizer, summaryText);
		// Don't double-count: subtract from history (clamped at 0).
		historyTokens = Math.max(0, historyTokens - summaryTokens);
	}

	// 3. If a hint was provided, scale the dynamic segments so they sum to
	//    the hint. Tool tokens are excluded from the message-token total
	//    because they're tracked separately upstream.
	const dynamicSum = systemTokens + summaryTokens + historyTokens + currentTokens;
	if (totalMessagesTokensHint !== undefined && dynamicSum > 0) {
		const scale = totalMessagesTokensHint / dynamicSum;
		// Only scale if the drift is significant (>2%) — otherwise the
		// per-message totals are accurate enough and rescaling adds noise.
		if (Math.abs(scale - 1) > 0.02) {
			systemTokens = Math.round(systemTokens * scale);
			summaryTokens = Math.round(summaryTokens * scale);
			historyTokens = Math.round(historyTokens * scale);
			currentTokens = Math.round(currentTokens * scale);
		}
	}

	const segments: ContextSegment[] = [
		{ kind: 'system', label: 'System prompt', tokens: systemTokens },
		{ kind: 'tools', label: 'Tools', tokens: toolTokenCount },
		{ kind: 'summary', label: 'Summarized conversation', tokens: summaryTokens },
		{ kind: 'history', label: 'Conversation', tokens: historyTokens },
		{ kind: 'current', label: 'Current message', tokens: currentTokens },
	];

	const totalPromptTokens =
		systemTokens + toolTokenCount + summaryTokens + historyTokens + currentTokens;

	return {
		segments,
		totalPromptTokens,
		modelMaxPromptTokens,
		modelId,
		computedAt: Date.now(),
	};
}

async function safeCountMessageTokens(tokenizer: ITokenizer, message: Raw.ChatMessage): Promise<number> {
	try {
		return await tokenizer.countMessageTokens(message);
	} catch {
		// Swallow — never fail the turn for an instrumentation glitch.
		return 0;
	}
}

async function safeCountTextTokens(tokenizer: ITokenizer, text: string): Promise<number> {
	try {
		return await tokenizer.tokenLength(text);
	} catch {
		return 0;
	}
}

/**
 * Format a token count for the status-item description / detail.
 * `1234` → `1.2K`, `999` → `999`, `0` → `0`.
 */
export function formatTokens(n: number): string {
	if (n >= 1_000_000) { return `${(n / 1_000_000).toFixed(1)}M`; }
	if (n >= 10_000) { return `${Math.round(n / 1000)}K`; }
	if (n >= 1_000) { return `${(n / 1000).toFixed(1)}K`; }
	return `${n}`;
}

/** Percentage of the context window in use, clamped to [0, 100]. Returns an integer. */
export function contextPercent(breakdown: Pick<ContextBreakdown, 'totalPromptTokens' | 'modelMaxPromptTokens'>): number {
	if (breakdown.modelMaxPromptTokens <= 0) { return 0; }
	const raw = (breakdown.totalPromptTokens / breakdown.modelMaxPromptTokens) * 100;
	return Math.max(0, Math.min(100, Math.round(raw)));
}
