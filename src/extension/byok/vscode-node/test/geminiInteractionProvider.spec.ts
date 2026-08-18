/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it } from 'vitest';
import { LanguageModelChatMessage, LanguageModelChatMessageRole, LanguageModelTextPart, LanguageModelToolResultPart } from 'vscode';
import {
	buildGeminiInteractionInputForTest,
	classifyGeminiInteractionRetryableErrorForTest,
	recordGeminiInteractionCallNameForTest,
} from '../geminiInteractionProvider';

describe('GeminiInteractionLMProvider tool results', () => {
	it('preserves the tool name when a signed call id is round-tripped', () => {
		const signedCallId = 'call-123|thinking-signature';
		const callIdToName = new Map<string, string>();
		recordGeminiInteractionCallNameForTest(callIdToName, signedCallId, 'run_in_terminal');

		const messages = [
			new LanguageModelChatMessage(LanguageModelChatMessageRole.User, [
				new LanguageModelToolResultPart(signedCallId, [new LanguageModelTextPart('command completed')]),
			]),
		];

		expect(buildGeminiInteractionInputForTest(messages, callIdToName)).toEqual([{
			type: 'function_result',
			call_id: 'call-123',
			name: 'run_in_terminal',
			result: [{ type: 'text', text: 'command completed' }],
		}]);
	});
});

describe('GeminiInteractionLMProvider retries', () => {
	it('retries a stream inactivity timeout as a transient network failure', () => {
		expect(classifyGeminiInteractionRetryableErrorForTest(
			new TypeError('GeminiIA stream inactivity timeout — no events for 180s; the stream appears to have silently stalled')
		)).toBe('network');
	});

	it('retries a stream connection timeout as a transient network failure', () => {
		expect(classifyGeminiInteractionRetryableErrorForTest(
			new TypeError('GeminiIA connect timeout waiting for stream')
		)).toBe('network');
	});

	it('does not retry invalid requests', () => {
		expect(classifyGeminiInteractionRetryableErrorForTest(
			new Error('Gemini Interactions API error (invalid_request): Invalid input received.')
		)).toBeNull();
	});
});
