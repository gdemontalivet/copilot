/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { toErrorMessage } from '../../../util/common/errorMessage';

export type GeminiRetryableErrorKind = 'rate-limit' | 'unavailable' | 'network';

interface GeminiErrorDetails {
	message: string;
	statusCode?: number;
	statusName?: string;
	errorCode?: string;
}

const GEMINI_CAPACITY_MESSAGE = 'Gemini is temporarily at capacity. Retry shortly or choose another model.';
const GEMINI_UNAVAILABLE_MESSAGE = 'Gemini is temporarily unavailable. Retry shortly or choose another model.';
const GEMINI_RATE_LIMIT_MESSAGE = 'Gemini rate limit reached. Retry shortly or choose another model.';

function asStatusCode(value: unknown): number | undefined {
	if (typeof value === 'number' && Number.isFinite(value)) {
		return value;
	}
	if (typeof value === 'string' && /^\d{3}$/.test(value)) {
		return Number(value);
	}
	return undefined;
}

function collectErrorMetadata(value: unknown, details: GeminiErrorDetails): void {
	if (!value || typeof value !== 'object') {
		return;
	}
	const object = value as Record<string, unknown>;
	details.statusCode ??= asStatusCode(object.status) ?? asStatusCode(object.code);
	if (!details.statusName && typeof object.status === 'string' && !asStatusCode(object.status)) {
		details.statusName = object.status;
	}
	if (!details.errorCode && typeof object.code === 'string' && !asStatusCode(object.code)) {
		details.errorCode = object.code;
	}
}

/**
 * Gemini SDK errors can contain JSON whose nested `error.message` is itself
 * another JSON error response. Peel every wrapper while retaining status
 * metadata from the Error object, its causes, and each JSON layer.
 */
function getGeminiErrorDetails(err: unknown): GeminiErrorDetails {
	const details: GeminiErrorDetails = { message: toErrorMessage(err, false) };

	let cause: unknown = err;
	for (let depth = 0; depth < 5 && cause && typeof cause === 'object'; depth++) {
		collectErrorMetadata(cause, details);
		cause = (cause as { cause?: unknown }).cause;
	}

	for (let depth = 0; depth < 5; depth++) {
		let parsed: unknown;
		try {
			parsed = JSON.parse(details.message);
		} catch {
			break;
		}
		if (!parsed || typeof parsed !== 'object') {
			break;
		}

		const parsedObject = parsed as Record<string, unknown>;
		const nested = parsedObject.error && typeof parsedObject.error === 'object'
			? parsedObject.error as Record<string, unknown>
			: parsedObject;
		collectErrorMetadata(nested, details);

		const nextMessage = nested.message ?? parsedObject.message;
		if (typeof nextMessage !== 'string' || nextMessage.trim().length === 0 || nextMessage === details.message) {
			break;
		}
		details.message = nextMessage.trim();
	}

	return details;
}

export function extractReadableGeminiMessage(err: unknown): string {
	const details = getGeminiErrorDetails(err);
	const message = details.message.trim();
	const lowerMessage = message.toLowerCase();
	const normalizedStatus = details.statusName?.toLowerCase().replace(/[\s-]+/g, '_');

	if (/high demand|at capacity|capacity pressure/.test(lowerMessage)) {
		return GEMINI_CAPACITY_MESSAGE;
	}
	if (details.statusCode === 429 || normalizedStatus === 'resource_exhausted' || /too_many_requests|quota_exceeded|rate.?limit/.test(lowerMessage)) {
		return GEMINI_RATE_LIMIT_MESSAGE;
	}
	if ([502, 503, 504].includes(details.statusCode ?? 0) || normalizedStatus === 'unavailable') {
		return GEMINI_UNAVAILABLE_MESSAGE;
	}

	return message;
}

export function classifyRetryableGeminiError(err: unknown): GeminiRetryableErrorKind | null {
	const details = getGeminiErrorDetails(err);
	const message = details.message.toLowerCase();
	const normalizedStatus = details.statusName?.toLowerCase().replace(/[\s-]+/g, '_');

	if (details.statusCode === 429 || normalizedStatus === 'resource_exhausted' || /too_many_requests|quota_exceeded|resource_exhausted/.test(message)) {
		return 'rate-limit';
	}
	if ([502, 503, 504].includes(details.statusCode ?? 0) || normalizedStatus === 'unavailable' ||
		(/service_unavailable|server_unavailable|unavailable|internal_error|server_error/.test(message) &&
			!/invalid|bad_request|not_found|permission/.test(message))) {
		return 'unavailable';
	}

	const networkCodes = new Set([
		'ECONNRESET', 'ENOTFOUND', 'ETIMEDOUT', 'EAI_AGAIN', 'ECONNREFUSED',
		'ENETUNREACH', 'EHOSTUNREACH', 'ERR_NETWORK', 'UND_ERR_SOCKET', 'UND_ERR_CONNECT_TIMEOUT',
	]);
	if ((details.errorCode && networkCodes.has(details.errorCode)) ||
		/fetch failed|network error|timed? ?out|socket hang up|geminiia connect timeout|geminiia stream inactivity timeout/.test(message)) {
		return 'network';
	}

	return null;
}
