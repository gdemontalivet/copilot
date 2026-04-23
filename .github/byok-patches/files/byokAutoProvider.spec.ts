/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/* eslint-disable @typescript-eslint/no-explicit-any */

import { beforeEach, describe, expect, it, vi } from 'vitest';

// `vscode.lm.selectChatModels` is the seam the provider uses to resolve its
// delegation target. In unit tests the real vscode module is not loaded, so
// hoist a mock before the SUT imports it.
const { mockSelectChatModels, mockEventEmitter } = vi.hoisted(() => ({
	mockSelectChatModels: vi.fn(),
	mockEventEmitter: vi.fn(),
}));

vi.mock('vscode', () => ({
	lm: {
		selectChatModels: mockSelectChatModels,
	},
	EventEmitter: class {
		event = () => ({ dispose() { /* no-op */ } });
		fire = vi.fn();
		dispose = vi.fn();
	},
}));

// Must import the SUT AFTER `vi.mock` registration; it dereferences
// `vscode.lm` at import time through the top-level `import * as vscode`.
import { BYOKAutoLMProvider } from '../byokAutoProvider';

function makeProvider(opts: {
	setting?: string;
	throwOnRead?: boolean;
} = {}) {
	const configService = {
		getConfig: vi.fn(() => {
			if (opts.throwOnRead) {
				throw new Error('config read failed');
			}
			return opts.setting ?? '';
		}),
	} as any;

	const logService = {
		trace: vi.fn(),
		debug: vi.fn(),
		info: vi.fn(),
		warn: vi.fn(),
		error: vi.fn(),
	} as any;

	return new BYOKAutoLMProvider(configService, logService);
}

describe('BYOKAutoLMProvider', () => {
	beforeEach(() => {
		mockSelectChatModels.mockReset();
		mockEventEmitter.mockReset();
	});

	describe('provideLanguageModelChatInformation', () => {
		it('returns exactly one synthetic Auto model', async () => {
			const provider = makeProvider();
			const info = await provider.provideLanguageModelChatInformation(
				{ silent: true } as any,
				{ isCancellationRequested: false } as any,
			);
			expect(info).toHaveLength(1);
			expect(info[0].id).toBe('auto');
			expect(info[0].name).toBe('BYOK Auto');
			expect(info[0].family).toBe('byok-auto');
		});

		it('advertises tool-calling and image-input capabilities so the UI does not hide them', async () => {
			const provider = makeProvider();
			const [info] = await provider.provideLanguageModelChatInformation(
				{ silent: true } as any,
				{ isCancellationRequested: false } as any,
			);
			expect(info.capabilities).toEqual({ toolCalling: true, imageInput: true });
		});

		it('surfaces the configured target in the `detail` field', async () => {
			const provider = makeProvider({ setting: 'vertexgemini/gemini-3.1-pro-preview' });
			const [info] = await provider.provideLanguageModelChatInformation(
				{ silent: true } as any,
				{ isCancellationRequested: false } as any,
			);
			expect(info.detail).toBe('→ vertexgemini/gemini-3.1-pro-preview');
		});
	});

	describe('provideLanguageModelChatResponse delegation', () => {
		const stubToken = { isCancellationRequested: false } as any;

		it('selects the configured target and forwards all stream parts to progress', async () => {
			const targetResponse = {
				stream: (async function* () {
					yield { type: 'text', value: 'hello' };
					yield { type: 'text', value: 'world' };
				})(),
			};
			const targetModel = {
				vendor: 'vertexgemini',
				id: 'gemini-3.1-pro-preview',
				name: 'Gemini 3.1 Pro',
				sendRequest: vi.fn().mockResolvedValue(targetResponse),
			};
			mockSelectChatModels.mockResolvedValue([targetModel]);

			const provider = makeProvider({ setting: 'vertexgemini/gemini-3.1-pro-preview' });
			const reported: unknown[] = [];
			const progress = { report: (p: unknown) => reported.push(p) };

			await provider.provideLanguageModelChatResponse(
				{ id: 'auto' } as any,
				[{ role: 'user', content: 'hi' } as any],
				{ modelOptions: { temperature: 0.3 } } as any,
				progress as any,
				stubToken,
			);

			expect(mockSelectChatModels).toHaveBeenCalledWith({ vendor: 'vertexgemini', id: 'gemini-3.1-pro-preview' });
			expect(targetModel.sendRequest).toHaveBeenCalledTimes(1);
			const [sentMessages, sentOpts] = targetModel.sendRequest.mock.calls[0];
			expect(sentMessages).toEqual([{ role: 'user', content: 'hi' }]);
			expect(sentOpts.modelOptions).toEqual({ temperature: 0.3 });
			expect(sentOpts.justification).toMatch(/BYOK Auto/);
			expect(reported).toEqual([
				{ type: 'text', value: 'hello' },
				{ type: 'text', value: 'world' },
			]);
		});

		it('falls back to the compiled-in default when the setting is empty', async () => {
			mockSelectChatModels.mockResolvedValue([
				{ vendor: 'vertexgemini', id: 'gemini-3.1-pro-preview', sendRequest: vi.fn().mockResolvedValue({ stream: (async function* () { /* empty */ })() }) },
			]);
			const provider = makeProvider({ setting: '' });

			await provider.provideLanguageModelChatResponse(
				{ id: 'auto' } as any,
				[],
				{} as any,
				{ report: () => { /* no-op */ } } as any,
				stubToken,
			);

			expect(mockSelectChatModels).toHaveBeenCalledWith({
				vendor: 'vertexgemini',
				id: 'gemini-3.1-pro-preview',
			});
		});

		it('stops reporting once cancellation is requested', async () => {
			let cancelled = false;
			const token = {
				get isCancellationRequested() { return cancelled; },
			} as any;

			const targetModel = {
				sendRequest: vi.fn().mockResolvedValue({
					stream: (async function* () {
						yield { type: 'text', value: 'a' };
						cancelled = true;
						yield { type: 'text', value: 'b' };
						yield { type: 'text', value: 'c' };
					})(),
				}),
			};
			mockSelectChatModels.mockResolvedValue([targetModel]);

			const provider = makeProvider({ setting: 'vertexgemini/foo' });
			const reported: unknown[] = [];
			await provider.provideLanguageModelChatResponse(
				{ id: 'auto' } as any,
				[],
				{} as any,
				{ report: (p: unknown) => reported.push(p) } as any,
				token,
			);

			// After cancellation we stop reporting — the first part gets through,
			// the others are dropped even though the stream kept yielding. This
			// matches the pattern used by other BYOK providers: we respect the
			// cancellation token but do not forcibly close the upstream stream
			// (the SDK does that when its own cancellation hook fires).
			expect(reported).toEqual([{ type: 'text', value: 'a' }]);
		});

		it('rejects a target spec that points back at byokauto to avoid infinite loops', async () => {
			const provider = makeProvider({ setting: 'byokauto/auto' });
			await expect(
				provider.provideLanguageModelChatResponse(
					{ id: 'auto' } as any,
					[],
					{} as any,
					{ report: () => { /* no-op */ } } as any,
					stubToken,
				),
			).rejects.toThrow(/cannot route to itself/);
			expect(mockSelectChatModels).not.toHaveBeenCalled();
		});

		it('raises an actionable error when the target model is not registered', async () => {
			mockSelectChatModels.mockResolvedValue([]);
			const provider = makeProvider({ setting: 'vertexgemini/does-not-exist' });
			await expect(
				provider.provideLanguageModelChatResponse(
					{ id: 'auto' } as any,
					[],
					{} as any,
					{ report: () => { /* no-op */ } } as any,
					stubToken,
				),
			).rejects.toThrow(/no chat model matches/);
		});

		it('rejects malformed setting strings with a hint about the expected format', async () => {
			const provider = makeProvider({ setting: 'no-slash-here' });
			await expect(
				provider.provideLanguageModelChatResponse(
					{ id: 'auto' } as any,
					[],
					{} as any,
					{ report: () => { /* no-op */ } } as any,
					stubToken,
				),
			).rejects.toThrow(/vendor\/modelId/);
		});

		it('preserves slashes inside the model id portion (for openrouter-style ids)', async () => {
			const targetModel = {
				sendRequest: vi.fn().mockResolvedValue({ stream: (async function* () { /* empty */ })() }),
			};
			mockSelectChatModels.mockResolvedValue([targetModel]);

			const provider = makeProvider({ setting: 'openrouter/anthropic/claude-3.7-sonnet' });
			await provider.provideLanguageModelChatResponse(
				{ id: 'auto' } as any,
				[],
				{} as any,
				{ report: () => { /* no-op */ } } as any,
				stubToken,
			);

			expect(mockSelectChatModels).toHaveBeenCalledWith({
				vendor: 'openrouter',
				id: 'anthropic/claude-3.7-sonnet',
			});
		});
	});

	describe('provideTokenCount', () => {
		it('defers to the target model so agent budget math stays accurate', async () => {
			const countTokens = vi.fn().mockResolvedValue(42);
			mockSelectChatModels.mockResolvedValue([{ vendor: 'v', id: 'm', countTokens } as any]);
			const provider = makeProvider({ setting: 'v/m' });
			const count = await provider.provideTokenCount(
				{ id: 'auto' } as any,
				'hello world',
				{ isCancellationRequested: false } as any,
			);
			expect(count).toBe(42);
			expect(countTokens).toHaveBeenCalled();
		});

		it('falls back to a 4-chars-per-token heuristic when resolution throws', async () => {
			mockSelectChatModels.mockResolvedValue([]);
			const provider = makeProvider({ setting: 'v/missing' });
			const count = await provider.provideTokenCount(
				{ id: 'auto' } as any,
				'1234567890ab', // 12 chars → 3 tokens at 4-chars/token
				{ isCancellationRequested: false } as any,
			);
			expect(count).toBe(3);
		});
	});

	describe('setting read resilience', () => {
		it('uses the compiled-in default when getConfig throws (e.g. test stub without the key)', async () => {
			mockSelectChatModels.mockResolvedValue([
				{ sendRequest: vi.fn().mockResolvedValue({ stream: (async function* () { /* empty */ })() }) } as any,
			]);
			const provider = makeProvider({ throwOnRead: true });
			await provider.provideLanguageModelChatResponse(
				{ id: 'auto' } as any,
				[],
				{} as any,
				{ report: () => { /* no-op */ } } as any,
				{ isCancellationRequested: false } as any,
			);
			expect(mockSelectChatModels).toHaveBeenCalledWith({
				vendor: 'vertexgemini',
				id: 'gemini-3.1-pro-preview',
			});
		});
	});
});
