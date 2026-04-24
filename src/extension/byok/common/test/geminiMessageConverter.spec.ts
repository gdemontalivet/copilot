/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Raw } from '@vscode/prompt-tsx';
import { describe, expect, it } from 'vitest';
import type { LanguageModelChatMessage } from 'vscode';
import { CustomDataPartMimeTypes } from '../../../../platform/endpoint/common/endpointTypes';
import { LanguageModelChatMessageRole, LanguageModelDataPart, LanguageModelTextPart, LanguageModelToolCallPart, LanguageModelToolResultPart, LanguageModelTextPart as LMText } from '../../../../vscodeTypes';
import { apiMessageToGeminiMessage } from '../geminiMessageConverter';

describe('GeminiMessageConverter', () => {
	it('should convert basic user and assistant messages', () => {
		const messages: LanguageModelChatMessage[] = [
			{
				role: LanguageModelChatMessageRole.User,
				content: [new LanguageModelTextPart('Hello, how are you?')],
				name: undefined
			},
			{
				role: LanguageModelChatMessageRole.Assistant,
				content: [new LanguageModelTextPart('I am doing well, thank you!')],
				name: undefined
			}
		];

		const result = apiMessageToGeminiMessage(messages);

		expect(result.contents).toHaveLength(2);
		expect(result.contents[0].role).toBe('user');
		expect(result.contents[0].parts).toBeDefined();
		expect(result.contents[0].parts![0].text).toBe('Hello, how are you?');
		expect(result.contents[1].role).toBe('model');
		expect(result.contents[1].parts).toBeDefined();
		expect(result.contents[1].parts![0].text).toBe('I am doing well, thank you!');
	});

	it('should handle system messages as system instruction', () => {
		const messages: LanguageModelChatMessage[] = [
			{
				role: LanguageModelChatMessageRole.System,
				content: [new LanguageModelTextPart('You are a helpful assistant.')],
				name: undefined
			},
			{
				role: LanguageModelChatMessageRole.User,
				content: [new LanguageModelTextPart('Hello!')],
				name: undefined
			}
		];

		const result = apiMessageToGeminiMessage(messages);

		expect(result.systemInstruction).toBeDefined();
		expect(result.systemInstruction!.parts).toBeDefined();
		expect(result.systemInstruction!.parts![0].text).toBe('You are a helpful assistant.');
		expect(result.contents).toHaveLength(1);
		expect(result.contents[0].role).toBe('user');
	});

	it('should filter out empty text parts', () => {
		const messages: LanguageModelChatMessage[] = [
			{
				role: LanguageModelChatMessageRole.User,
				content: [
					new LanguageModelTextPart(''),
					new LanguageModelTextPart('  '),
					new LanguageModelTextPart('Hello!')
				],
				name: undefined
			}
		];

		const result = apiMessageToGeminiMessage(messages);

		expect(result.contents[0].parts).toBeDefined();
		expect(result.contents[0].parts!).toHaveLength(2); // Empty string filtered out, whitespace kept
		expect(result.contents[0].parts![0].text).toBe('  ');
		expect(result.contents[0].parts![1].text).toBe('Hello!');
	});

	it('should extract functionResponse parts from model message into subsequent user message and prune empty model', () => {
		// Simulate a model message that (incorrectly) contains only a tool result part
		const toolResult = new LanguageModelToolResultPart('myTool_12345', [new LanguageModelTextPart('{"foo":"bar"}')]);
		const messages: LanguageModelChatMessage[] = [
			{
				role: LanguageModelChatMessageRole.Assistant,
				content: [toolResult],
				name: undefined
			}
		];

		const { contents } = apiMessageToGeminiMessage(messages);

		// The original (empty) model message should be pruned; we expect a single user message with functionResponse
		expect(contents).toHaveLength(1);
		expect(contents[0].role).toBe('user');
		expect(contents[0].parts![0]).toHaveProperty('functionResponse');
		const fr: any = contents[0].parts![0];
		expect(fr.functionResponse.name).toBe('myTool'); // extracted from callId prefix
		expect(fr.functionResponse.response).toEqual({ foo: 'bar' });
	});

	it('should wrap array responses in an object', () => {
		const toolResult = new LanguageModelToolResultPart('listRepos_12345', [new LanguageModelTextPart('["repo1", "repo2"]')]);
		const messages: LanguageModelChatMessage[] = [
			{
				role: LanguageModelChatMessageRole.Assistant,
				content: [toolResult],
				name: undefined
			}
		];

		const result = apiMessageToGeminiMessage(messages);

		expect(result.contents).toHaveLength(1);
		expect(result.contents[0].role).toBe('user');
		const fr: any = result.contents[0].parts![0];
		expect(fr.functionResponse.response).toEqual({ result: ['repo1', 'repo2'] });
	});

	it('should be idempotent when called multiple times (no duplication)', () => {
		const toolResult = new LanguageModelToolResultPart('doThing_12345', [new LMText('{"value":42}')]);
		const messages: LanguageModelChatMessage[] = [
			{ role: LanguageModelChatMessageRole.Assistant, content: [new LMText('Result:'), toolResult], name: undefined }
		];
		const first = apiMessageToGeminiMessage(messages);
		const second = apiMessageToGeminiMessage(messages); // Re-run with same original messages

		// Both runs should yield identical normalized structure (model text + user tool response) without growth
		expect(first.contents.length).toBe(2);
		expect(second.contents.length).toBe(2);
		expect(first.contents[0].role).toBe('model');
		expect(first.contents[1].role).toBe('user');
		expect(second.contents[0].role).toBe('model');
		expect(second.contents[1].role).toBe('user');
	});

	describe('Image handling', () => {
		it('should handle LanguageModelDataPart as inline image data', () => {
			const imageData = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]); // PNG header
			const imagePart = new LanguageModelDataPart(imageData, 'image/png');

			const messages: LanguageModelChatMessage[] = [
				{
					role: LanguageModelChatMessageRole.User,
					content: [new LanguageModelTextPart('Here is an image:'), imagePart as any],
					name: undefined
				}
			];

			const result = apiMessageToGeminiMessage(messages);

			expect(result.contents).toHaveLength(1);
			expect(result.contents[0].parts).toHaveLength(2);
			expect(result.contents[0].parts![0].text).toBe('Here is an image:');
			expect(result.contents[0].parts![1]).toHaveProperty('inlineData');
			const inlineData: any = result.contents[0].parts![1];
			expect(inlineData.inlineData.mimeType).toBe('image/png');
			expect(inlineData.inlineData.data).toBe(Buffer.from(imageData).toString('base64'));
		});

		it('should filter out StatefulMarker and CacheControl data parts', () => {
			const imageData = new Uint8Array([137, 80, 78, 71]);
			const validImage = new LanguageModelDataPart(imageData, 'image/jpeg');
			const statefulMarker = new LanguageModelDataPart(new Uint8Array([1, 2, 3]), CustomDataPartMimeTypes.StatefulMarker);
			const cacheControl = new LanguageModelDataPart(new TextEncoder().encode('ephemeral'), CustomDataPartMimeTypes.CacheControl);

			const messages: LanguageModelChatMessage[] = [
				{
					role: LanguageModelChatMessageRole.User,
					content: [validImage as any, statefulMarker as any, cacheControl as any],
					name: undefined
				}
			];

			const result = apiMessageToGeminiMessage(messages);

			// Should only include the valid image, not the stateful marker or cache control
			expect(result.contents[0].parts).toHaveLength(1);
			expect(result.contents[0].parts![0]).toHaveProperty('inlineData');
			const inlineData: any = result.contents[0].parts![0];
			expect(inlineData.inlineData.mimeType).toBe('image/jpeg');
		});

		it('should handle images in tool result content with text', () => {
			const imageData = new Uint8Array([255, 216, 255, 224]); // JPEG header
			const imagePart = new LanguageModelDataPart(imageData, 'image/jpeg');
			const textPart = new LanguageModelTextPart('{"success": true}');

			const toolResult = new LanguageModelToolResultPart('processImage_12345', [textPart, imagePart as any]);
			const messages: LanguageModelChatMessage[] = [
				{
					role: LanguageModelChatMessageRole.Assistant,
					content: [toolResult],
					name: undefined
				}
			];

			const result = apiMessageToGeminiMessage(messages);

			// Should have a user message with function response
			expect(result.contents).toHaveLength(1);
			expect(result.contents[0].role).toBe('user');
			expect(result.contents[0].parts![0]).toHaveProperty('functionResponse');

			const fr: any = result.contents[0].parts![0];
			expect(fr.functionResponse.name).toBe('processImage');
			expect(fr.functionResponse.response.success).toBe(true);
			expect(fr.functionResponse.response.images).toBeDefined();
			expect(fr.functionResponse.response.images).toHaveLength(1);
			expect(fr.functionResponse.response.images[0].mimeType).toBe('image/jpeg');
			expect(fr.functionResponse.response.images[0].size).toBe(imageData.length);
		});

		it('should handle images in tool result content without text', () => {
			const imageData1 = new Uint8Array([255, 216, 255, 224]); // JPEG header
			const imageData2 = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]); // PNG header
			const imagePart1 = new LanguageModelDataPart(imageData1, 'image/jpeg');
			const imagePart2 = new LanguageModelDataPart(imageData2, 'image/png');

			const toolResult = new LanguageModelToolResultPart('generateImages_12345', [imagePart1 as any, imagePart2 as any]);
			const messages: LanguageModelChatMessage[] = [
				{
					role: LanguageModelChatMessageRole.Assistant,
					content: [toolResult],
					name: undefined
				}
			];

			const result = apiMessageToGeminiMessage(messages);

			expect(result.contents).toHaveLength(1);
			expect(result.contents[0].role).toBe('user');

			const fr: any = result.contents[0].parts![0];
			expect(fr.functionResponse.name).toBe('generateImages');
			expect(fr.functionResponse.response.images).toHaveLength(2);

			// First image
			expect(fr.functionResponse.response.images[0].mimeType).toBe('image/jpeg');
			expect(fr.functionResponse.response.images[0].size).toBe(imageData1.length);
			expect(fr.functionResponse.response.images[0].data).toBe(Buffer.from(imageData1).toString('base64'));

			// Second image
			expect(fr.functionResponse.response.images[1].mimeType).toBe('image/png');
			expect(fr.functionResponse.response.images[1].size).toBe(imageData2.length);
			expect(fr.functionResponse.response.images[1].data).toBe(Buffer.from(imageData2).toString('base64'));
		});

		it('should handle mixed text and filtered data parts in tool results', () => {
			const validImageData = new Uint8Array([255, 216]);
			const validImage = new LanguageModelDataPart(validImageData, 'image/jpeg');
			const statefulMarker = new LanguageModelDataPart(new Uint8Array([1, 2, 3]), CustomDataPartMimeTypes.StatefulMarker);
			const textPart = new LanguageModelTextPart('Result text');

			const toolResult = new LanguageModelToolResultPart('mixedContent_12345', [textPart, validImage as any, statefulMarker as any]);
			const messages: LanguageModelChatMessage[] = [
				{
					role: LanguageModelChatMessageRole.Assistant,
					content: [toolResult],
					name: undefined
				}
			];

			const result = apiMessageToGeminiMessage(messages);

			const fr: any = result.contents[0].parts![0];
			expect(fr.functionResponse.name).toBe('mixedContent');
			// Should include text and valid image, but not stateful marker
			expect(fr.functionResponse.response.result).toContain('Result text');
			expect(fr.functionResponse.response.result).toContain('[Contains 1 image(s) with types: image/jpeg]');
			expect(fr.functionResponse.response.images).toHaveLength(1);
			expect(fr.functionResponse.response.images[0].mimeType).toBe('image/jpeg');
		});
	});

	describe('Cross-provider tool-id resolution (Patch 43)', () => {
		it('should resolve functionResponse.name via the assistant turn\'s tool_call when callId is an Anthropic toolu_… id', () => {
			// Reproduces the mid-conversation switch from Sonnet → Gemini that
			// caused Gemini to 400 with "function response parts not equal to
			// function call parts" — Anthropic's callId carried no tool name,
			// so the legacy split-on-underscore collapsed every response to
			// `name: 'toolu'` and the names no longer matched.
			const callId = 'toolu_01ABCdefGHIjklMNOpqrSTUv';
			const messages: LanguageModelChatMessage[] = [
				{
					role: LanguageModelChatMessageRole.Assistant,
					content: [new LanguageModelToolCallPart(callId, 'read_file', { path: '/foo.ts' })],
					name: undefined
				},
				{
					role: LanguageModelChatMessageRole.User,
					content: [new LanguageModelToolResultPart(callId, [new LanguageModelTextPart('{"content":"ok"}')])],
					name: undefined
				}
			];

			const { contents } = apiMessageToGeminiMessage(messages);

			expect(contents).toHaveLength(2);
			expect(contents[0].role).toBe('model');
			const fc: any = contents[0].parts![0];
			expect(fc.functionCall.name).toBe('read_file');

			expect(contents[1].role).toBe('user');
			const fr: any = contents[1].parts![0];
			// Must match the functionCall.name above — used to be 'toolu'.
			expect(fr.functionResponse.name).toBe('read_file');
			expect(fr.functionResponse.response).toEqual({ content: 'ok' });
		});

		it('should keep Gemini-native ids working via the legacy split heuristic when the map has no entry', () => {
			// Partial transcript — no preceding toolCallPart, so the callId→name
			// map is empty and we fall back to `callId.split('_')[0]`.
			const messages: LanguageModelChatMessage[] = [
				{
					role: LanguageModelChatMessageRole.Assistant,
					content: [new LanguageModelToolResultPart('readFile_1712345678', [new LanguageModelTextPart('{"ok":true}')])],
					name: undefined
				}
			];

			const { contents } = apiMessageToGeminiMessage(messages);

			expect(contents).toHaveLength(1);
			const fr: any = contents[0].parts![0];
			expect(fr.functionResponse.name).toBe('readFile');
		});

		it('should resolve names for multiple parallel tool calls with distinct Anthropic ids', () => {
			// Sonnet routinely emits 3-5 parallel tool calls in one assistant
			// turn. Every callId must resolve to its own tool name.
			const call1 = 'toolu_01AAAAAAAAAAAAAAAAAAAA';
			const call2 = 'toolu_01BBBBBBBBBBBBBBBBBBBB';
			const call3 = 'toolu_01CCCCCCCCCCCCCCCCCCCC';
			const messages: LanguageModelChatMessage[] = [
				{
					role: LanguageModelChatMessageRole.Assistant,
					content: [
						new LanguageModelToolCallPart(call1, 'read_file', { path: '/a.ts' }),
						new LanguageModelToolCallPart(call2, 'list_dir', { path: '/' }),
						new LanguageModelToolCallPart(call3, 'grep_search', { query: 'foo' })
					],
					name: undefined
				},
				{
					role: LanguageModelChatMessageRole.User,
					content: [
						new LanguageModelToolResultPart(call1, [new LanguageModelTextPart('"a"')]),
						new LanguageModelToolResultPart(call2, [new LanguageModelTextPart('[]')]),
						new LanguageModelToolResultPart(call3, [new LanguageModelTextPart('[]')])
					],
					name: undefined
				}
			];

			const { contents } = apiMessageToGeminiMessage(messages);

			expect(contents).toHaveLength(2);
			const callNames = (contents[0].parts as any[]).map(p => p.functionCall.name);
			const respNames = (contents[1].parts as any[]).map(p => p.functionResponse.name);
			expect(callNames).toEqual(['read_file', 'list_dir', 'grep_search']);
			// Response-name multiset must match the call-name multiset for Gemini.
			expect(respNames.sort()).toEqual(callNames.slice().sort());
		});

		it('should tolerate OpenAI-style call_… ids', () => {
			// OpenAI (via CustomOAI) ids look like `call_AbCdEfGhIjKl` — also
			// no tool name encoded. Same resolution path.
			const callId = 'call_AbCdEfGhIjKl';
			const messages: LanguageModelChatMessage[] = [
				{
					role: LanguageModelChatMessageRole.Assistant,
					content: [new LanguageModelToolCallPart(callId, 'run_shell', { cmd: 'ls' })],
					name: undefined
				},
				{
					role: LanguageModelChatMessageRole.User,
					content: [new LanguageModelToolResultPart(callId, [new LanguageModelTextPart('"x"')])],
					name: undefined
				}
			];

			const { contents } = apiMessageToGeminiMessage(messages);

			const fr: any = contents[1].parts![0];
			expect(fr.functionResponse.name).toBe('run_shell');
		});
	});

	describe('Orphan tool-result drop (Patch 43)', () => {
		it('should drop a tool-result whose callId has no matching tool-call in the transcript', () => {
			// Reproduces the history-truncation case: user turn carries a
			// tool-result whose corresponding assistant tool-call was dropped
			// from history. Gemini would 400 with "the number of function
			// response parts is equal to the number of function call parts"
			// — drop the orphan so the rest of the transcript still renders.
			const validCallId = 'toolu_01VALIDVALIDVALIDVALIDV';
			const orphanCallId = 'toolu_01ORPHANORPHANORPHANORPH';
			const messages: LanguageModelChatMessage[] = [
				{
					role: LanguageModelChatMessageRole.Assistant,
					content: [new LanguageModelToolCallPart(validCallId, 'read_file', { path: '/a.ts' })],
					name: undefined
				},
				{
					role: LanguageModelChatMessageRole.User,
					content: [
						new LanguageModelToolResultPart(validCallId, [new LanguageModelTextPart('"ok"')]),
						new LanguageModelToolResultPart(orphanCallId, [new LanguageModelTextPart('"stale"')])
					],
					name: undefined
				}
			];

			const { contents } = apiMessageToGeminiMessage(messages);

			expect(contents).toHaveLength(2);
			// Assistant turn unchanged — one functionCall.
			expect((contents[0].parts as any[]).length).toBe(1);
			expect((contents[0].parts as any[])[0].functionCall.name).toBe('read_file');
			// User turn keeps only the matching response; orphan dropped.
			expect((contents[1].parts as any[]).length).toBe(1);
			expect((contents[1].parts as any[])[0].functionResponse.name).toBe('read_file');
		});

		it('should prune a user turn that consisted entirely of orphan tool-results', () => {
			// If every tool-result in a user turn is orphaned, the whole turn
			// becomes empty after the drop pass. An empty `{role:'user',parts:[]}`
			// is also rejected by Gemini — drop the whole turn.
			// Needs at least one tool_call in the transcript so callIdToName is
			// non-empty and orphan-drop activates.
			const validCallId = 'toolu_01VALIDVALIDVALIDVALIDV';
			const messages: LanguageModelChatMessage[] = [
				{
					role: LanguageModelChatMessageRole.Assistant,
					content: [new LanguageModelToolCallPart(validCallId, 'read_file', { path: '/a.ts' })],
					name: undefined
				},
				{
					role: LanguageModelChatMessageRole.User,
					content: [new LanguageModelToolResultPart(validCallId, [new LanguageModelTextPart('"ok"')])],
					name: undefined
				},
				{
					role: LanguageModelChatMessageRole.User,
					content: [
						new LanguageModelToolResultPart('toolu_01AAAAAAAAAAAAAAAAAAAA', [new LanguageModelTextPart('"x"')]),
						new LanguageModelToolResultPart('toolu_01BBBBBBBBBBBBBBBBBBBB', [new LanguageModelTextPart('"y"')])
					],
					name: undefined
				}
			];

			const { contents } = apiMessageToGeminiMessage(messages);

			// Assistant turn + the matching user response survive; the all-orphan turn is pruned.
			expect(contents).toHaveLength(2);
			expect(contents[0].role).toBe('model');
			expect((contents[0].parts as any[])[0].functionCall.name).toBe('read_file');
			expect(contents[1].role).toBe('user');
			expect((contents[1].parts as any[])[0].functionResponse.name).toBe('read_file');
		});

		it('should preserve legacy fallback behaviour when no tool-calls were pre-walked (empty map path)', () => {
			// Sanity check: a transcript with only a tool-result part and no
			// tool-call anywhere leaves callIdToName empty, which disables the
			// orphan-drop pass. The legacy split-on-underscore fallback still
			// runs so `apiContentToGeminiContent` remains testable in isolation
			// by callers that don't pre-walk.
			const messages: LanguageModelChatMessage[] = [
				{
					role: LanguageModelChatMessageRole.User,
					content: [new LanguageModelToolResultPart('readFile_1712345678', [new LanguageModelTextPart('{"ok":true}')])],
					name: undefined
				}
			];

			const { contents } = apiMessageToGeminiMessage(messages);

			// Empty map → orphan-drop inactive → result preserved with fallback name.
			expect(contents).toHaveLength(1);
			const fr: any = contents[0].parts![0];
			expect(fr.functionResponse.name).toBe('readFile');
		});
	});

	describe('geminiMessagesToRawMessages', () => {
		it('should convert function response with images to Raw format with image content parts', async () => {
			const { geminiMessagesToRawMessages } = await import('../geminiMessageConverter');

			// Simulate a Gemini Content with function response containing images
			const contents = [{
				role: 'user',
				parts: [{
					functionResponse: {
						name: 'generateImages',
						response: {
							success: true,
							images: [
								{
									mimeType: 'image/jpeg',
									size: 1024,
									data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=='
								},
								{
									mimeType: 'image/png',
									size: 512,
									data: '/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAYEBAQFBAYFBQYJBgUGCQsIBgYICwwKCgsKCgwQDAwMDAwMEAwODxAPDgwTExQUExMcGxsbHB8fHx8fHx8fHx//2wBDAQcHBw0MDRgQEBgaFREVGh8fHx8fHx8fHx8fHx8fHx8fHx8fHx8fHx8fHx8fHx8fHx8fHx8fHx8fHx8fHx8fHx//wAARCAABAAEDAREAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAv/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/8QAFQEBAQAAAAAAAAAAAAAAAAAAAAX/xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oADAMBAAIRAxEAPwCdABmX/9k='
								}
							]
						}
					}
				}]
			}];

			const rawMessages = geminiMessagesToRawMessages(contents);

			expect(rawMessages).toHaveLength(1);
			// Check the role - should be Raw.ChatRole.Tool enum value
			expect(rawMessages[0].role).toBe(Raw.ChatRole.Tool);

			// Type assertion for tool message
			const toolMessage = rawMessages[0] as any;
			expect(toolMessage.toolCallId).toBe('generateImages');
			expect(rawMessages[0].content).toHaveLength(3); // 2 images + 1 text part

			// Check first image
			expect(rawMessages[0].content[0].type).toBe(Raw.ChatCompletionContentPartKind.Image);
			const firstImage = rawMessages[0].content[0] as any;
			expect(firstImage.imageUrl?.url).toBe('data:image/jpeg;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==');

			// Check second image
			expect(rawMessages[0].content[1].type).toBe(Raw.ChatCompletionContentPartKind.Image);
			const secondImage = rawMessages[0].content[1] as any;
			expect(secondImage.imageUrl?.url).toBe('data:image/png;base64,/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAYEBAQFBAYFBQYJBgUGCQsIBgYICwwKCgsKCgwQDAwMDAwMEAwODxAPDgwTExQUExMcGxsbHB8fHx8fHx8fHx//2wBDAQcHBw0MDRgQEBgaFREVGh8fHx8fHx8fHx8fHx8fHx8fHx8fHx8fHx8fHx8fHx8fHx8fHx8fHx8fHx8fHx8fHx//wAARCAABAAEDAREAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAv/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/8QAFQEBAQAAAAAAAAAAAAAAAAAAAAX/xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oADAMBAAIRAxEAPwCdABmX/9k=');

			// Check text content with cleaned response
			expect(rawMessages[0].content[2].type).toBe(Raw.ChatCompletionContentPartKind.Text);
			const textPart = rawMessages[0].content[2] as any;
			const textContent = JSON.parse(textPart.text);
			expect(textContent.success).toBe(true);
			expect(textContent.images).toHaveLength(2);
			expect(textContent.images[0].mimeType).toBe('image/jpeg');
			expect(textContent.images[0].size).toBe(1024);
			expect(textContent.images[1].mimeType).toBe('image/png');
			expect(textContent.images[1].size).toBe(512);
			// Should not contain raw base64 data in text content
			expect(textContent.images[0]).not.toHaveProperty('data');
			expect(textContent.images[1]).not.toHaveProperty('data');
		});

		it('should handle function response without images normally', async () => {
			const { geminiMessagesToRawMessages } = await import('../geminiMessageConverter');

			const contents = [{
				role: 'user',
				parts: [{
					functionResponse: {
						name: 'textFunction',
						response: { result: 'success', value: 42 }
					}
				}]
			}];

			const rawMessages = geminiMessagesToRawMessages(contents);

			expect(rawMessages).toHaveLength(1);
			expect(rawMessages[0].role).toBe(Raw.ChatRole.Tool);
			expect(rawMessages[0].content).toHaveLength(1);
			expect(rawMessages[0].content[0].type).toBe(Raw.ChatCompletionContentPartKind.Text);
			const textPart = rawMessages[0].content[0] as any;
			expect(JSON.parse(textPart.text)).toEqual({ result: 'success', value: 42 });
		});
	});
});