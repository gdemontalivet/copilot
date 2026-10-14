/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it } from 'vitest';
import { classifyRetryableGeminiError, extractReadableGeminiMessage } from '../geminiErrorUtils';

describe('Gemini error utilities', () => {
	it('does not retry depleted billing credits labelled RESOURCE_EXHAUSTED', () => {
		const error = new Error(JSON.stringify({ error: {
			message: JSON.stringify({ error: { code: 402, message: 'Your prepayment credits are depleted.', status: 'RESOURCE_EXHAUSTED' } }),
			code: 402,
			status: 'Payment Required',
		} }));

		expect(extractReadableGeminiMessage(error)).toContain('Gemini API payment required (HTTP 402)');
		expect(extractReadableGeminiMessage(error)).toContain('https://aistudio.google.com/projects');
		expect(classifyRetryableGeminiError(error)).toBeNull();
	});

	it('recognizes the opaque payment error produced by the bundled Interactions SDK', () => {
		const error = new Error('402 API error occurred: {"httpMeta":{"response":{},"request":{}}}');

		expect(extractReadableGeminiMessage(error)).toContain('prepaid credit balance');
		expect(classifyRetryableGeminiError(error)).toBeNull();
	});

	it('reads the Interactions SDK response body and statusCode through error causes', () => {
		const cause = Object.assign(new Error('API error occurred'), {
			statusCode: 400,
			body: JSON.stringify({ error: { message: 'Function call is missing a thought_signature.', status: 'INVALID_ARGUMENT' } }),
		});
		const error = new Error('Request failed', { cause });

		expect(extractReadableGeminiMessage(error)).toBe('Function call is missing a thought_signature.');
		expect(classifyRetryableGeminiError(error)).toBeNull();
	});

	it('reads a payment status from HTTP metadata without treating it as a rate limit', () => {
		const error = Object.assign(new Error('API error occurred'), {
			httpMeta: { response: { status: 402 }, body: { error: { message: 'Your prepayment credits are depleted.', status: 'RESOURCE_EXHAUSTED' } } },
		});

		expect(extractReadableGeminiMessage(error)).toContain('Gemini API payment required (HTTP 402)');
		expect(classifyRetryableGeminiError(error)).toBeNull();
	});

	it('turns a double-wrapped Gemini capacity response into an actionable message', () => {
		const providerResponse = JSON.stringify({
			error: {
				code: 503,
				message: 'This model is currently experiencing high demand. Spikes in demand are usually temporary. Please try again later.',
				status: 'UNAVAILABLE',
			},
		});
		const sdkResponse = JSON.stringify({
			error: {
				message: providerResponse,
				code: 503,
				status: 'Service Unavailable',
			},
		});

		const error = new Error(sdkResponse);
		expect(extractReadableGeminiMessage(error)).toBe(
			'Gemini is temporarily at capacity. Retry shortly or choose another model.'
		);
		expect(classifyRetryableGeminiError(error)).toBe('unavailable');
	});

	it('keeps a nested non-transient Gemini message readable', () => {
		const error = new Error(JSON.stringify({
			error: {
				message: JSON.stringify({
					error: {
						code: 400,
						message: 'Function call is missing a thought_signature.',
						status: 'INVALID_ARGUMENT',
					},
				}),
				code: 400,
				status: 'Bad Request',
			},
		}));

		expect(extractReadableGeminiMessage(error)).toBe('Function call is missing a thought_signature.');
		expect(classifyRetryableGeminiError(error)).toBeNull();
	});

	it('recognizes Interactions API transport and quota errors', () => {
		expect(classifyRetryableGeminiError(new TypeError('GeminiIA stream inactivity timeout — no events for 180s'))).toBe('network');
		expect(classifyRetryableGeminiError(new Error('Gemini Interactions API error (quota_exceeded): slow down'))).toBe('rate-limit');
	});

	it('leaves ordinary errors unchanged', () => {
		expect(extractReadableGeminiMessage(new Error('API key not configured'))).toBe('API key not configured');
	});
});
