/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { CancellationToken, CancellationTokenSource } from '../../../../util/vs/base/common/cancellation';

/**
 * State machine for background conversation summarization.
 *
 * Lifecycle:
 *   Idle → InProgress → Completed / Failed
 *                              ↓          ↓
 *                        (consumeAndReset → Idle)
 *                                    Failed → InProgress (retry)
 */

export const enum BackgroundSummarizationState {
	/** No summarization running. */
	Idle = 'Idle',
	/** An LLM summarization request is in flight. */
	InProgress = 'InProgress',
	/** Summarization finished successfully — summary text is available. */
	Completed = 'Completed',
	/** Summarization failed. */
	Failed = 'Failed',
}

export interface IBackgroundSummarizationResult {
	readonly summary: string;
	readonly toolCallRoundId: string;
	readonly promptTokens?: number;
	readonly promptCacheTokens?: number;
	readonly outputTokens?: number;
	readonly durationMs?: number;
	readonly model?: string;
	readonly summarizationMode?: string;
	readonly numRounds?: number;
	readonly numRoundsSinceLastSummarization?: number;
}

/**
 * Thresholds used by {@link shouldKickOffBackgroundSummarization}. Exported so
 * tests can reference the same numbers without repeating them.
 */
export const BackgroundSummarizationThresholds = {
	/** Minimum of the jittered warm-cache range. */
	warmJitterMin: 0.78,
	/** Width of the jittered warm-cache range; together with `warmJitterMin` yields [0.78, 0.82). */
	warmJitterSpan: 0.04,
	/**
	 * Cold-cache emergency ratio. Above this we kick off even without a warmed
	 * cache to avoid forcing a foreground sync compaction on the next render.
	 * Tuned low enough that long-running sessions stay ahead of the budget
	 * without relying on foreground compaction.
	 */
	emergency: 0.90,
} as const;

/**
 * Decide whether to kick off post-render background compaction.
 *
 * Prompt-cache parity matters, so we:
 *   - require a completed tool call in this turn ("warm" cache) before
 *     firing at the normal, jittered ~0.80 threshold;
 *   - allow an emergency kick-off at >= 0.90 even with a cold cache to
 *     avoid forcing a foreground sync compaction on the next render.
 *
 * The jitter range straddles the historical 0.80 threshold (not "lower the
 * bar") — the goal is to avoid always firing at the exact same boundary,
 * not to kick off systematically earlier.
 *
 * `rng` is only consumed on the warm-cache branch, which keeps deterministic
 * tests straightforward.
 */
export function shouldKickOffBackgroundSummarization(
	postRenderRatio: number,
	cacheWarm: boolean,
	rng: () => number,
): boolean {
	const t = BackgroundSummarizationThresholds;
	if (!cacheWarm) {
		return postRenderRatio >= t.emergency;
	}
	const jittered = t.warmJitterMin + rng() * t.warmJitterSpan;
	return postRenderRatio >= jittered;
}

/**
 * Tracks a single background summarization pass for one chat session.
 *
 * The singleton `AgentIntent` owns one instance per session (keyed by
 * `sessionId`). `AgentIntentInvocation.buildPrompt` queries the state
 * on every tool-call iteration to decide whether to start, wait for, or
 * apply a background summary.
 */
export class BackgroundSummarizer {

	private _state: BackgroundSummarizationState = BackgroundSummarizationState.Idle;
	private _result: IBackgroundSummarizationResult | undefined;
	private _error: unknown;
	private _promise: Promise<void> | undefined;
	private _cts: CancellationTokenSource | undefined;

	readonly modelMaxPromptTokens: number;

	get state(): BackgroundSummarizationState { return this._state; }
	get error(): unknown { return this._error; }

	get token() { return this._cts?.token; }

	constructor(modelMaxPromptTokens: number) {
		this.modelMaxPromptTokens = modelMaxPromptTokens;
	}

	start(work: (token: CancellationToken) => Promise<IBackgroundSummarizationResult>, parentToken?: CancellationToken): void {
		if (this._state !== BackgroundSummarizationState.Idle && this._state !== BackgroundSummarizationState.Failed) {
			return; // already running or completed
		}

		this._state = BackgroundSummarizationState.InProgress;
		this._error = undefined;
		this._cts = new CancellationTokenSource(parentToken);
		const token = this._cts.token;
		this._promise = work(token).then(
			result => {
				if (this._state !== BackgroundSummarizationState.InProgress) {
					return; // cancelled while in flight
				}
				this._result = result;
				this._state = BackgroundSummarizationState.Completed;
			},
			err => {
				if (this._state !== BackgroundSummarizationState.InProgress) {
					return; // cancelled while in flight
				}
				this._error = err;
				this._state = BackgroundSummarizationState.Failed;
			},
		);
	}

	async waitForCompletion(): Promise<void> {
		if (this._promise) {
			await this._promise;
		}
	}

	consumeAndReset(): IBackgroundSummarizationResult | undefined {
		if (this._state === BackgroundSummarizationState.InProgress) {
			return undefined;
		}
		const result = this._result;
		this._state = BackgroundSummarizationState.Idle;
		this._result = undefined;
		this._error = undefined;
		this._promise = undefined;
		this._cts?.dispose();
		this._cts = undefined;
		return result;
	}

	cancel(): void {
		this._cts?.cancel();
		this._cts?.dispose();
		this._cts = undefined;
		this._state = BackgroundSummarizationState.Idle;
		this._result = undefined;
		this._error = undefined;
		this._promise = undefined;
	}
}

// ─── BYOK CUSTOM PATCH: Tiered auto-compaction ──────────────────────────────
// The following exports are preserved across upstream syncs by
// .github/scripts/apply-byok-patches.sh. Do not remove.

/**
 * Compaction urgency tier:
 *   0 = no action
 *   1 = start background compaction
 *   2 = start urgent background compaction (log warning)
 *   3 = block synchronously on background compaction before next LLM call
 */
export type CompactionTier = 0 | 1 | 2 | 3;

/**
 * Tiered thresholds used to preempt context window overflow. Unlike the single
 * `BackgroundSummarizationThresholds.base` gate, these fire at lower estimate
 * ratios so compaction starts well before we hit Gemini's 1M input-token cap.
 */
export const TieredCompactionThresholds = {
	tier1Estimate: 0.70,
	tier2Estimate: 0.80,
	tier3Estimate: 0.90,
	tier1Confirmed: 0.65,
	tier2Confirmed: 0.75,
	tier3Confirmed: 0.85,
} as const;

/**
 * Adaptive compaction thresholds for large-context models.
 *
 * Claude Opus 4.6 / 4.7 and Sonnet 4.6 on Vertex AI ship with a native 1M
 * context window at flat per-token pricing. Applying the default percentage
 * thresholds (0.70 / 0.80 / 0.90) would mean tier-1 compaction doesn't fire
 * until ~700K tokens — an individual turn ~5x larger (and ~5x more expensive
 * per call) than the same workflow on a 200K model. Cap the absolute token
 * budget before compaction at roughly the 200K mark so per-call cost tracks
 * the smaller-context baseline, while still leaving the 1M window available
 * as a safety net for the rare turn that genuinely needs it.
 *
 * Only kicks in for models with `modelMaxPromptTokens > 300_000` so the
 * default behaviour is untouched for everything else (Gemini, OpenAI,
 * 200K Claude models).
 */
const LARGE_CONTEXT_THRESHOLD_TOKENS = 300_000;
const LARGE_CONTEXT_TIER1_ABSOLUTE = 180_000;
const LARGE_CONTEXT_TIER2_ABSOLUTE = 200_000;
const LARGE_CONTEXT_TIER3_ABSOLUTE = 220_000;
export function resolveCompactionThresholds(modelMaxPromptTokens?: number): typeof TieredCompactionThresholds {
	if (!modelMaxPromptTokens || modelMaxPromptTokens <= LARGE_CONTEXT_THRESHOLD_TOKENS) {
		return TieredCompactionThresholds;
	}
	const max = modelMaxPromptTokens;
	return {
		tier1Estimate: LARGE_CONTEXT_TIER1_ABSOLUTE / max,
		tier2Estimate: LARGE_CONTEXT_TIER2_ABSOLUTE / max,
		tier3Estimate: LARGE_CONTEXT_TIER3_ABSOLUTE / max,
		tier1Confirmed: (LARGE_CONTEXT_TIER1_ABSOLUTE * 0.93) / max,
		tier2Confirmed: (LARGE_CONTEXT_TIER2_ABSOLUTE * 0.93) / max,
		tier3Confirmed: (LARGE_CONTEXT_TIER3_ABSOLUTE * 0.93) / max,
	} as const;
}

/**
 * Map a post-render context ratio to a compaction tier.
 *
 * Inline path (cache parity matters): cold cache only triggers tier 3, warm
 * cache uses the full tiered ladder.
 *
 * Non-inline path (no cache benefit): full tiered ladder regardless.
 *
 * `modelMaxPromptTokens` is optional for backwards compat with the existing
 * test suite; when provided and >300K, switches to absolute-token thresholds
 * so large-context models don't pay 5x per turn just because the cap is 5x.
 */
export function getCompactionTier(
	postRenderRatio: number,
	useInlineSummarization: boolean,
	cacheWarm: boolean,
	modelMaxPromptTokens?: number,
): CompactionTier {
	const t = resolveCompactionThresholds(modelMaxPromptTokens);
	if (!useInlineSummarization) {
		if (postRenderRatio >= t.tier3Estimate) { return 3; }
		if (postRenderRatio >= t.tier2Estimate) { return 2; }
		if (postRenderRatio >= t.tier1Estimate) { return 1; }
		return 0;
	}
	if (!cacheWarm) {
		return postRenderRatio >= t.tier3Estimate ? 3 : 0;
	}
	if (postRenderRatio >= t.tier3Estimate) { return 3; }
	if (postRenderRatio >= t.tier2Estimate) { return 2; }
	if (postRenderRatio >= t.tier1Estimate) { return 1; }
	return 0;
}

/**
 * Map an API-confirmed ratio (from Gemini countTokens) to a compaction tier.
 * Reserved for future use once the countTokens gate is wired in.
 */
export function getConfirmedCompactionTier(trueRatio: number, modelMaxPromptTokens?: number): CompactionTier {
	const t = resolveCompactionThresholds(modelMaxPromptTokens);
	if (trueRatio >= t.tier3Confirmed) { return 3; }
	if (trueRatio >= t.tier2Confirmed) { return 2; }
	if (trueRatio >= t.tier1Confirmed) { return 1; }
	return 0;
}
// ─── END BYOK CUSTOM PATCH ──────────────────────────────────────────────────
