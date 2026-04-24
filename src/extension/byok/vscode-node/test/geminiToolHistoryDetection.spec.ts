/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { ApiError } from '@google/genai';
import { describe, expect, it } from 'vitest';
import { isGeminiToolHistoryInvalidError } from '../geminiNativeProvider';

// ─── BYOK CUSTOM PATCH: Patch 44 test coverage ──────────────────────────────
// Preserved by .github/scripts/apply-byok-patches.sh. Do not remove.
// Unit tests for isGeminiToolHistoryInvalidError, the detection helper
// that tags Gemini 400 INVALID_ARGUMENT errors caused by tool-history
// contract violations so the chat UI can surface the dedicated
// RESPONSE_TOOL_HISTORY_INVALID message instead of the generic
// "Sorry, no response was returned.".
// ─── END BYOK CUSTOM PATCH ─────────────────────────────────────────────────

function makeApiError(status: number, body: object): ApiError {
	return new ApiError({
		message: JSON.stringify({ error: { code: status, ...body } }),
		status,
	});
}

describe('isGeminiToolHistoryInvalidError (Patch 44)', () => {

	it('returns true for the canonical "function response parts" 400', () => {
		const err = makeApiError(400, {
			status: 'INVALID_ARGUMENT',
			message: 'Please ensure that the number of function response parts is equal to the number of function call parts of the function call turn.',
		});
		expect(isGeminiToolHistoryInvalidError(err)).toBe(true);
	});

	it('returns true for the "function call parts" phrasing', () => {
		const err = makeApiError(400, {
			status: 'INVALID_ARGUMENT',
			message: 'The number of function call parts in the response does not match the tool invocations.',
		});
		expect(isGeminiToolHistoryInvalidError(err)).toBe(true);
	});

	it('returns false for INVALID_ARGUMENT that is NOT about tool history', () => {
		const err = makeApiError(400, {
			status: 'INVALID_ARGUMENT',
			message: 'Invalid generation_config: maxOutputTokens must be positive.',
		});
		expect(isGeminiToolHistoryInvalidError(err)).toBe(false);
	});

	it('returns false for non-400 ApiError', () => {
		const err = makeApiError(429, {
			status: 'RESOURCE_EXHAUSTED',
			message: 'Quota exceeded.',
		});
		expect(isGeminiToolHistoryInvalidError(err)).toBe(false);
	});

	it('returns false for 400 with a non-INVALID_ARGUMENT inner status', () => {
		const err = makeApiError(400, {
			status: 'FAILED_PRECONDITION',
			message: 'Please ensure that the number of function response parts is correct.',
		});
		expect(isGeminiToolHistoryInvalidError(err)).toBe(false);
	});

	it('returns false for plain Error instances', () => {
		expect(isGeminiToolHistoryInvalidError(new Error('something bad'))).toBe(false);
		expect(isGeminiToolHistoryInvalidError(undefined)).toBe(false);
		expect(isGeminiToolHistoryInvalidError(null)).toBe(false);
	});

	it('returns false when the ApiError body is not valid JSON', () => {
		const err = new ApiError({ message: 'not-json-at-all', status: 400 });
		expect(isGeminiToolHistoryInvalidError(err)).toBe(false);
	});

	it('returns false when the inner message is missing', () => {
		const err = makeApiError(400, {
			status: 'INVALID_ARGUMENT',
		});
		expect(isGeminiToolHistoryInvalidError(err)).toBe(false);
	});
});
