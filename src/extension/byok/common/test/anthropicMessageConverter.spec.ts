/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { MessageParam, TextBlockParam } from '@anthropic-ai/sdk/resources';
import { expect, suite, test } from 'vitest';
import { anthropicMessagesToRawMessages, apiMessageToAnthropicMessage, sanitizeAnthropicToolId } from '../anthropicMessageConverter';
import { LanguageModelChatMessage, LanguageModelToolCallPart, LanguageModelToolResultPart } from '../../../../vscodeTypes';

suite('anthropicMessagesToRawMessages', function () {

	test('converts simple text messages', function () {
		const messages: MessageParam[] = [
			{
				role: 'user',
				content: 'Hello world'
			},
			{
				role: 'assistant',
				content: 'Hi there!'
			}
		];
		const system: TextBlockParam = { type: 'text', text: 'You are a helpful assistant' };

		const result = anthropicMessagesToRawMessages(messages, system);

		expect(result).toMatchSnapshot();
	});

	test('handles empty system message', function () {
		const messages: MessageParam[] = [
			{
				role: 'user',
				content: 'Hello'
			}
		];
		const system: TextBlockParam = { type: 'text', text: '' };

		const result = anthropicMessagesToRawMessages(messages, system);

		expect(result).toMatchSnapshot();
	});

	test('converts messages with content blocks', function () {
		const messages: MessageParam[] = [
			{
				role: 'user',
				content: [
					{ type: 'text', text: 'Look at this image:' },
					{
						type: 'image',
						source: {
							type: 'base64',
							media_type: 'image/jpeg',
							data: 'fake-base64-data'
						}
					}
				]
			}
		];
		const system: TextBlockParam = { type: 'text', text: 'System prompt' };

		const result = anthropicMessagesToRawMessages(messages, system);

		expect(result).toMatchSnapshot();
	});

	test('converts tool use messages', function () {
		const messages: MessageParam[] = [
			{
				role: 'assistant',
				content: [
					{ type: 'text', text: 'I will use a tool:' },
					{
						type: 'tool_use',
						id: 'call_123',
						name: 'get_weather',
						input: { location: 'London' }
					}
				]
			}
		];
		const system: TextBlockParam = { type: 'text', text: '' };

		const result = anthropicMessagesToRawMessages(messages, system);

		expect(result).toMatchSnapshot();
	});

	test('converts tool result messages', function () {
		const messages: MessageParam[] = [
			{
				role: 'user',
				content: [
					{
						type: 'tool_result',
						tool_use_id: 'call_123',
						content: 'The weather in London is sunny'
					}
				]
			}
		];
		const system: TextBlockParam = { type: 'text', text: '' };

		const result = anthropicMessagesToRawMessages(messages, system);

		expect(result).toMatchSnapshot();
	});

	test('converts tool result with content blocks', function () {
		const messages: MessageParam[] = [
			{
				role: 'user',
				content: [
					{
						type: 'tool_result',
						tool_use_id: 'call_456',
						content: [
							{ type: 'text', text: 'Here is the chart:' },
							{
								type: 'image',
								source: {
									type: 'base64',
									media_type: 'image/png',
									data: 'chart-data'
								}
							}
						]
					}
				]
			}
		];
		const system: TextBlockParam = { type: 'text', text: '' };

		const result = anthropicMessagesToRawMessages(messages, system);

		expect(result).toMatchSnapshot();
	});

	test('handles cache control blocks', function () {
		const messages: MessageParam[] = [
			{
				role: 'user',
				content: [
					{
						type: 'text',
						text: 'Cached content',
						cache_control: { type: 'ephemeral' }
					}
				]
			}
		];
		const system: TextBlockParam = {
			type: 'text',
			text: 'System with cache',
			cache_control: { type: 'ephemeral' }
		};

		const result = anthropicMessagesToRawMessages(messages, system);

		expect(result).toMatchSnapshot();
	});

	test('includes thinking blocks in conversion to raw messages', function () {
		const messages: MessageParam[] = [
			{
				role: 'assistant',
				content: [
					{ type: 'thinking', thinking: 'Let me think...', signature: '' },
					{ type: 'text', text: 'Here is my response' }
				]
			}
		];
		const system: TextBlockParam = { type: 'text', text: '' };

		const result = anthropicMessagesToRawMessages(messages, system);

		expect(result).toMatchSnapshot();
	});

	test('handles url-based images', function () {
		const messages: MessageParam[] = [
			{
				role: 'user',
				content: [
					{
						type: 'image',
						source: {
							type: 'url',
							url: 'https://example.com/image.jpg'
						}
					}
				]
			}
		];
		const system: TextBlockParam = { type: 'text', text: '' };

		const result = anthropicMessagesToRawMessages(messages, system);

		expect(result).toMatchSnapshot();
	});

	test('handles empty tool result content', function () {
		const messages: MessageParam[] = [
			{
				role: 'user',
				content: [
					{
						type: 'tool_result',
						tool_use_id: 'call_empty',
						content: []
					}
				]
			}
		];
		const system: TextBlockParam = { type: 'text', text: '' };

		const result = anthropicMessagesToRawMessages(messages, system);

		expect(result).toMatchSnapshot();
	});
});

suite('sanitizeAnthropicToolId', function () {

	test('passes already-valid ids through unchanged', function () {
		expect(sanitizeAnthropicToolId('toolu_01ABC')).toBe('toolu_01ABC');
		expect(sanitizeAnthropicToolId('call_abc-123_XYZ')).toBe('call_abc-123_XYZ');
		expect(sanitizeAnthropicToolId('a')).toBe('a');
	});

	test('rewrites gemini-style dotted ids deterministically', function () {
		const a = sanitizeAnthropicToolId('function_call_abc.123.456');
		const b = sanitizeAnthropicToolId('function_call_abc.123.456');
		expect(a).toBe(b);
		expect(a).toMatch(/^[a-zA-Z0-9_-]+$/);
		expect(a).not.toBe('function_call_abc.123.456');
	});

	test('distinguishes ids that differ only in invalid chars', function () {
		// Two Gemini ids that would otherwise collapse to the same underscore
		// form ('a_b') must remain distinguishable after sanitization.
		const a = sanitizeAnthropicToolId('a.b');
		const b = sanitizeAnthropicToolId('a/b');
		const c = sanitizeAnthropicToolId('a_b');
		expect(a).not.toBe(b);
		expect(a).not.toBe(c);
		expect(b).not.toBe(c);
		expect(a).toMatch(/^[a-zA-Z0-9_-]+$/);
		expect(b).toMatch(/^[a-zA-Z0-9_-]+$/);
	});

	test('handles ids that are entirely invalid characters', function () {
		const out = sanitizeAnthropicToolId('.../');
		expect(out).toMatch(/^[a-zA-Z0-9_-]+$/);
		expect(out.length).toBeGreaterThan(0);
	});
});

suite('apiMessageToAnthropicMessage - tool id sanitization', function () {

	test('sanitizes tool_use and matching tool_result consistently', function () {
		const geminiId = 'func_call.abc.123';
		const assistantMessage = LanguageModelChatMessage.Assistant([
			new LanguageModelToolCallPart(geminiId, 'my_tool', { foo: 'bar' }),
		]);
		const userMessage = LanguageModelChatMessage.User([
			new LanguageModelToolResultPart(geminiId, []),
		]);

		const { messages } = apiMessageToAnthropicMessage([assistantMessage, userMessage]);

		// Find the tool_use and tool_result blocks.
		let toolUseId: string | undefined;
		let toolResultId: string | undefined;
		for (const m of messages) {
			if (!Array.isArray(m.content)) { continue; }
			for (const block of m.content) {
				if (block.type === 'tool_use') { toolUseId = block.id; }
				if (block.type === 'tool_result') { toolResultId = block.tool_use_id; }
			}
		}

		expect(toolUseId).toBeDefined();
		expect(toolResultId).toBeDefined();
		expect(toolUseId).toBe(toolResultId);
		expect(toolUseId).toMatch(/^[a-zA-Z0-9_-]+$/);
		expect(toolUseId).not.toBe(geminiId);
	});
});