/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import Anthropic from '@anthropic-ai/sdk';
import type { Progress } from 'vscode';

/**
 * Result of classifying an error produced by a primary BYOK provider, used to
 * decide whether to transparently route a failing request to a secondary
 * provider.
 *
 *  - `ok`            : not actually an error (reserved for callers that pass a value)
 *  - `auth`          : credential-level failure (invalid / expired key)
 *  - `rate_limit`    : provider returned 429 or otherwise indicated ROM/TPM throttling
 *  - `server_error`  : provider returned 5xx or a transient connection error
 *  - `transient`     : network-layer errors, timeouts, aborts unrelated to user cancel
 *  - `fatal`         : the request itself was malformed / not retryable (4xx other than 401/429)
 */
export type FailoverClassification =
	| 'ok'
	| 'auth'
	| 'rate_limit'
	| 'server_error'
	| 'transient'
	| 'fatal';

/**
 * Categorise an error from the Anthropic SDK (or a Vertex-routed Anthropic
 * client, which shares the same error shape) for failover decisions.
 */
export function classifyAnthropicError(err: unknown): FailoverClassification {
	if (err === undefined || err === null) {
		return 'ok';
	}

	if (err instanceof Anthropic.RateLimitError) {
		return 'rate_limit';
	}
	if (err instanceof Anthropic.AuthenticationError || err instanceof Anthropic.PermissionDeniedError) {
		return 'auth';
	}
	if (err instanceof Anthropic.InternalServerError) {
		return 'server_error';
	}
	if (err instanceof Anthropic.APIConnectionTimeoutError || err instanceof Anthropic.APIConnectionError) {
		return 'transient';
	}
	if (err instanceof Anthropic.APIError) {
		const status = (err as { status?: number }).status ?? 0;
		if (status === 408 || status === 409 || status === 425 || status === 429) { return 'rate_limit'; }
		if (status >= 500) { return 'server_error'; }
		return 'fatal';
	}

	// Non-SDK errors (e.g. custom fetch failures from VertexAnthropic's override).
	const message = err instanceof Error ? err.message : String(err);
	const lower = message.toLowerCase();
	if (lower.includes('rate limit') || lower.includes('quota')) { return 'rate_limit'; }
	if (lower.includes('unauthorized') || lower.includes('forbidden')) { return 'auth'; }
	if (lower.includes('timeout') || lower.includes('fetch failed') || lower.includes('econnreset') || lower.includes('network')) {
		return 'transient';
	}
	return 'fatal';
}

/** Whether a classified error should trigger a failover to the secondary target. */
export function isFailoverTrigger(c: FailoverClassification): boolean {
	return c === 'rate_limit' || c === 'server_error' || c === 'transient' || c === 'auth';
}

/**
 * Shared, process-wide circuit-breaker / concurrency tracker for a BYOK
 * provider's upstream API. Keyed by API key hash so two configured keys on
 * the same provider have independent state.
 */
export class ApiKeyPool {
	private readonly _inFlight = new Map<string, number>();
	private readonly _cooldownUntil = new Map<string, number>();

	public maxConcurrency: number = 0;
	public cooldownMs: number = 60_000;

	/** Reset configuration from settings. 0 concurrency means unlimited. */
	configure(maxConcurrency: number, cooldownMs: number): void {
		this.maxConcurrency = Math.max(0, maxConcurrency | 0);
		this.cooldownMs = Math.max(0, cooldownMs | 0);
	}

	/** Whether primary traffic should currently be diverted for a given key. */
	shouldSkipPrimary(keyHash: string): boolean {
		const until = this._cooldownUntil.get(keyHash);
		if (until !== undefined && until > Date.now()) { return true; }
		if (this.maxConcurrency > 0 && (this._inFlight.get(keyHash) ?? 0) >= this.maxConcurrency) {
			return true;
		}
		return false;
	}

	acquireSlot(keyHash: string): void {
		this._inFlight.set(keyHash, (this._inFlight.get(keyHash) ?? 0) + 1);
	}

	releaseSlot(keyHash: string): void {
		const n = this._inFlight.get(keyHash) ?? 0;
		if (n <= 1) {
			this._inFlight.delete(keyHash);
		} else {
			this._inFlight.set(keyHash, n - 1);
		}
	}

	recordFailure(keyHash: string, classification: FailoverClassification): void {
		if (!isFailoverTrigger(classification)) { return; }
		if (this.cooldownMs <= 0) { return; }
		// Auth failures get a longer cooldown since they won't clear up on their own.
		const multiplier = classification === 'auth' ? 5 : 1;
		this._cooldownUntil.set(keyHash, Date.now() + this.cooldownMs * multiplier);
	}

	recordSuccess(keyHash: string): void {
		this._cooldownUntil.delete(keyHash);
	}

	/** Test-only helper. */
	_peek(keyHash: string): { inFlight: number; cooldownMs: number } {
		return {
			inFlight: this._inFlight.get(keyHash) ?? 0,
			cooldownMs: Math.max(0, (this._cooldownUntil.get(keyHash) ?? 0) - Date.now()),
		};
	}

	/** Test-only helper. */
	_clear(): void {
		this._inFlight.clear();
		this._cooldownUntil.clear();
	}
}

/** Singleton pool, sized by the runtime when providers configure themselves. */
export const anthropicPrimaryPool = new ApiKeyPool();

/**
 * Cheap, stable identifier for an API key — just enough to partition pool
 * state without logging the raw key. NOT a cryptographic hash.
 */
export function keyFingerprint(key: string | undefined): string {
	if (!key) { return '<no-key>'; }
	let h = 2166136261;
	for (let i = 0; i < key.length; i++) {
		h ^= key.charCodeAt(i);
		h = Math.imul(h, 16777619);
	}
	return (h >>> 0).toString(16);
}

/**
 * Forwards reports to a downstream `Progress<T>` but only after `commit()` is
 * called. Before commit, reports are buffered in memory. After `discard()` the
 * buffer is dropped and no further forwarding happens.
 *
 * Used by the BYOK failover layer to transparently retry a failing request on
 * a secondary provider without leaking partial output from the primary.
 */
export class DeferredProgress<T> implements Progress<T> {
	private _buffer: T[] = [];
	private _state: 'buffering' | 'committed' | 'discarded' = 'buffering';

	constructor(private readonly _downstream: Progress<T>) { }

	report(value: T): void {
		if (this._state === 'discarded') { return; }
		if (this._state === 'committed') {
			this._downstream.report(value);
			return;
		}
		this._buffer.push(value);
	}

	/** Forward all buffered items and switch to pass-through mode. */
	commit(): void {
		if (this._state !== 'buffering') { return; }
		this._state = 'committed';
		for (const v of this._buffer) {
			this._downstream.report(v);
		}
		this._buffer = [];
	}

	/** Drop all buffered items and ignore future reports. */
	discard(): void {
		this._state = 'discarded';
		this._buffer = [];
	}

	hasCommitted(): boolean { return this._state === 'committed'; }
	hasBuffered(): boolean { return this._state === 'buffering' && this._buffer.length > 0; }
}
