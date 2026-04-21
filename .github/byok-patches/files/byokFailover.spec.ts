/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import Anthropic from '@anthropic-ai/sdk';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
	ApiKeyPool,
	DeferredProgress,
	anthropicPrimaryPool,
	classifyAnthropicError,
	isFailoverTrigger,
	keyFingerprint,
} from '../byokFailover';

describe('classifyAnthropicError', () => {
	it('classifies undefined as ok', () => {
		expect(classifyAnthropicError(undefined)).toBe('ok');
	});

	it('classifies Anthropic RateLimitError', () => {
		const err = new Anthropic.RateLimitError(429, { error: { message: 'slow down' } }, 'rate limited', new Headers());
		expect(classifyAnthropicError(err)).toBe('rate_limit');
	});

	it('classifies Anthropic AuthenticationError as auth', () => {
		const err = new Anthropic.AuthenticationError(401, { error: { message: 'bad key' } }, 'unauth', new Headers());
		expect(classifyAnthropicError(err)).toBe('auth');
	});

	it('classifies InternalServerError as server_error', () => {
		const err = new Anthropic.InternalServerError(500, { error: { message: 'boom' } }, 'boom', new Headers());
		expect(classifyAnthropicError(err)).toBe('server_error');
	});

	it('classifies generic APIError by status', () => {
		const err = new Anthropic.APIError(503, { error: { message: 'down' } }, 'service unavailable', new Headers());
		expect(classifyAnthropicError(err)).toBe('server_error');
		const err2 = new Anthropic.APIError(400, { error: { message: 'bad body' } }, 'bad request', new Headers());
		expect(classifyAnthropicError(err2)).toBe('fatal');
	});

	it('falls back to string parsing for non-SDK errors', () => {
		expect(classifyAnthropicError(new Error('quota exceeded'))).toBe('rate_limit');
		expect(classifyAnthropicError(new Error('Unauthorized'))).toBe('auth');
		expect(classifyAnthropicError(new Error('fetch failed: ECONNRESET'))).toBe('transient');
		expect(classifyAnthropicError(new Error('something else'))).toBe('fatal');
	});
});

describe('isFailoverTrigger', () => {
	it('returns true for rate_limit, server_error, transient, auth', () => {
		expect(isFailoverTrigger('rate_limit')).toBe(true);
		expect(isFailoverTrigger('server_error')).toBe(true);
		expect(isFailoverTrigger('transient')).toBe(true);
		expect(isFailoverTrigger('auth')).toBe(true);
	});
	it('returns false for ok and fatal', () => {
		expect(isFailoverTrigger('ok')).toBe(false);
		expect(isFailoverTrigger('fatal')).toBe(false);
	});
});

describe('ApiKeyPool', () => {
	let pool: ApiKeyPool;
	beforeEach(() => { pool = new ApiKeyPool(); });

	it('respects maxConcurrency', () => {
		pool.configure(2, 60_000);
		pool.acquireSlot('k1');
		pool.acquireSlot('k1');
		expect(pool.shouldSkipPrimary('k1')).toBe(true);
		pool.releaseSlot('k1');
		expect(pool.shouldSkipPrimary('k1')).toBe(false);
	});

	it('isolates state per key', () => {
		pool.configure(1, 60_000);
		pool.acquireSlot('k1');
		expect(pool.shouldSkipPrimary('k1')).toBe(true);
		expect(pool.shouldSkipPrimary('k2')).toBe(false);
	});

	it('sets cooldown on retryable failures', () => {
		pool.configure(0, 30_000);
		pool.recordFailure('k1', 'rate_limit');
		expect(pool.shouldSkipPrimary('k1')).toBe(true);
		const peek = pool._peek('k1');
		expect(peek.cooldownMs).toBeGreaterThan(0);
		expect(peek.cooldownMs).toBeLessThanOrEqual(30_000);
	});

	it('gives auth failures a longer cooldown', () => {
		pool.configure(0, 10_000);
		pool.recordFailure('k1', 'auth');
		const peek = pool._peek('k1');
		expect(peek.cooldownMs).toBeGreaterThan(30_000);
	});

	it('does not set cooldown on fatal errors', () => {
		pool.configure(0, 60_000);
		pool.recordFailure('k1', 'fatal');
		expect(pool.shouldSkipPrimary('k1')).toBe(false);
	});

	it('recordSuccess clears cooldown', () => {
		pool.configure(0, 60_000);
		pool.recordFailure('k1', 'server_error');
		pool.recordSuccess('k1');
		expect(pool.shouldSkipPrimary('k1')).toBe(false);
	});

	it('treats maxConcurrency=0 as unlimited', () => {
		pool.configure(0, 0);
		for (let i = 0; i < 100; i++) { pool.acquireSlot('k1'); }
		expect(pool.shouldSkipPrimary('k1')).toBe(false);
	});
});

describe('anthropicPrimaryPool singleton', () => {
	afterEach(() => {
		anthropicPrimaryPool._clear();
		anthropicPrimaryPool.configure(0, 60_000);
	});
	it('is a shared ApiKeyPool instance', () => {
		anthropicPrimaryPool.configure(1, 60_000);
		anthropicPrimaryPool.acquireSlot('shared');
		expect(anthropicPrimaryPool.shouldSkipPrimary('shared')).toBe(true);
	});
});

describe('keyFingerprint', () => {
	it('is stable for the same input', () => {
		expect(keyFingerprint('sk-abc')).toBe(keyFingerprint('sk-abc'));
	});
	it('differs for different inputs', () => {
		expect(keyFingerprint('sk-abc')).not.toBe(keyFingerprint('sk-abd'));
	});
	it('handles empty / undefined inputs', () => {
		expect(keyFingerprint(undefined)).toBe('<no-key>');
		expect(keyFingerprint('')).toBe('<no-key>');
	});
});

describe('DeferredProgress', () => {
	it('buffers until committed, then flushes', () => {
		const sink: number[] = [];
		const dp = new DeferredProgress<number>({ report: (v: number) => sink.push(v) });
		dp.report(1);
		dp.report(2);
		expect(sink).toEqual([]);
		dp.commit();
		expect(sink).toEqual([1, 2]);
		dp.report(3);
		expect(sink).toEqual([1, 2, 3]);
	});

	it('discard drops buffer and silences later reports', () => {
		const sink: number[] = [];
		const dp = new DeferredProgress<number>({ report: (v: number) => sink.push(v) });
		dp.report(1);
		dp.discard();
		dp.report(2);
		expect(sink).toEqual([]);
	});

	it('tracks commit state', () => {
		const dp = new DeferredProgress<number>({ report: () => { /* noop */ } });
		expect(dp.hasCommitted()).toBe(false);
		expect(dp.hasBuffered()).toBe(false);
		dp.report(1);
		expect(dp.hasBuffered()).toBe(true);
		dp.commit();
		expect(dp.hasCommitted()).toBe(true);
		expect(dp.hasBuffered()).toBe(false);
	});
});
