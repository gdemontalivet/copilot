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
 * Compaction urgency tier returned by {@link getCompactionTier}.
 *
 * - 0: no action needed
 * - 1: start background compaction (low urgency)
 * - 2: urgent background compaction + warning
 * - 3: synchronous compaction — block before next LLM call
 */
export type CompactionTier = 0 | 1 | 2 | 3;

/**
 * Thresholds used by {@link getCompactionTier}. Exported so tests can
 * reference the same numbers without repeating them.
 *
 * Estimate thresholds trigger an API verification (countTokens). The
 * confirmed thresholds gate the actual compaction action after the API
 * returns the true token count.
 */
export const BackgroundSummarizationThresholds = {
	/** Estimate ratio that triggers Tier 1 (background compaction check). */
	tier1Estimate: 0.70,
	/** Estimate ratio that triggers Tier 2 (urgent background compaction check). */
	tier2Estimate: 0.80,
	/** Estimate ratio that triggers Tier 3 (synchronous compaction check). */
	tier3Estimate: 0.90,
	/** API-confirmed ratio for Tier 1 action (start background compaction). */
	tier1Confirmed: 0.65,
	/** API-confirmed ratio for Tier 2 action (urgent background compaction). */
	tier2Confirmed: 0.75,
	/** API-confirmed ratio for Tier 3 action (synchronous compaction). */
	tier3Confirmed: 0.85,
} as const;

/**
 * Determine which compaction tier the current context ratio falls into.
 *
 * For the inline-summarization path, prompt-cache parity matters. With a
 * cold cache we require a higher estimate (tier3Estimate) to avoid wasting
 * a compaction pass. With a warm cache we use the full tiered thresholds.
 *
 * The non-inline path has no cache benefit and uses the simple tiered
 * thresholds directly.
 */
export function getCompactionTier(
	postRenderRatio: number,
	useInlineSummarization: boolean,
	cacheWarm: boolean,
): CompactionTier {
	const t = BackgroundSummarizationThresholds;
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
 * After an API countTokens verification, re-evaluate the tier based on
 * the true (API-confirmed) ratio. Returns the action tier to execute.
 */
export function getConfirmedCompactionTier(trueRatio: number): CompactionTier {
	const t = BackgroundSummarizationThresholds;
	if (trueRatio >= t.tier3Confirmed) { return 3; }
	if (trueRatio >= t.tier2Confirmed) { return 2; }
	if (trueRatio >= t.tier1Confirmed) { return 1; }
	return 0;
}

/**
 * Legacy wrapper — returns true when the estimate tier is >= 1.
 * Kept for backward compatibility with callers that only need a boolean.
 * @deprecated Use {@link getCompactionTier} for tiered compaction.
 */
export function shouldKickOffBackgroundSummarization(
	postRenderRatio: number,
	useInlineSummarization: boolean,
	cacheWarm: boolean,
	rng: () => number,
): boolean {
	return getCompactionTier(postRenderRatio, useInlineSummarization, cacheWarm) >= 1;
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
