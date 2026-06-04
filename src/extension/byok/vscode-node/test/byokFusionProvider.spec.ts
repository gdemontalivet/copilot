/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mockSelectChatModels } = vi.hoisted(() => ({
	mockSelectChatModels: vi.fn(),
}));

vi.mock('vscode', () => {
	class LanguageModelTextPart {
		constructor(public value: string) { }
	}
	return {
		lm: {
			selectChatModels: mockSelectChatModels,
		},
		EventEmitter: class {
			event = () => ({ dispose() { /* no-op */ } });
			fire = vi.fn();
			dispose = vi.fn();
		},
		LanguageModelTextPart,
		LanguageModelChatMessage: {
			User: (content: string) => ({ role: 1, content }),
			Assistant: (content: string) => ({ role: 2, content }),
		},
	};
});

import { BYOKFusionLMProvider } from '../byokFusionProvider';
import * as vscode from 'vscode';

describe('BYOKFusionLMProvider', () => {
	let logService: any;
	let configService: any;

	beforeEach(() => {
		vi.clearAllMocks();
		logService = {
			trace: vi.fn(),
			warn: vi.fn(),
			info: vi.fn(),
		};
		configService = {
			getConfig: vi.fn((key: any) => {
				const id = key?.id ?? '';
				if (id === 'chat.byok.fusion.models') {
					return [];
				}
				if (id === 'chat.byok.fusion.mergerModel') {
					return '';
				}
				if (id === 'chat.byok.fusion.showHint') {
					return true;
				}
				return undefined;
			}),
		};
	});

	it('returns the fusion model information', async () => {
		const provider = new BYOKFusionLMProvider(configService, logService);
		const info = await provider.provideLanguageModelChatInformation({} as any, {} as any);
		expect(info.length).toBe(1);
		expect(info[0].id).toBe('byok-fusion');
		expect(info[0].name).toBe('BYOK Fusion');
	});

	it('throws error when no candidate models are available', async () => {
		const provider = new BYOKFusionLMProvider(configService, logService);
		mockSelectChatModels.mockResolvedValue([]);

		const messages = [{ role: 1, content: 'test' }] as any[];
		const progress = { report: vi.fn() };

		await expect(provider.provideLanguageModelChatResponse(
			{} as any,
			messages,
			{ modelOptions: {}, toolMode: 1, tools: [] } as any,
			progress,
			{ isCancellationRequested: false } as any
		)).rejects.toThrow('BYOK Fusion: No candidate models are configured or registered. Enable at least one other BYOK provider.');
	});

	it('runs candidates in parallel and merges using the configured merger', async () => {
		const provider = new BYOKFusionLMProvider(configService, logService);

		// Mock available models
		const mockModelAStream = (async function* () {
			yield new vscode.LanguageModelTextPart('Code candidate A');
		})();
		const mockModelBStream = (async function* () {
			yield new vscode.LanguageModelTextPart('Code candidate B');
		})();
		const mockMergerStream = (async function* () {
			yield new vscode.LanguageModelTextPart('Fused response');
		})();

		const mockModelA = {
			id: 'claude-3-5-sonnet',
			vendor: 'anthropic',
			sendRequest: vi.fn().mockResolvedValue({ stream: mockModelAStream }),
		};

		const mockModelB = {
			id: 'gemini-2.5-pro',
			vendor: 'gemini',
			sendRequest: vi.fn().mockResolvedValue({ stream: mockModelBStream }),
		};

		const mockMerger = {
			id: 'gpt-4o',
			vendor: 'openai',
			sendRequest: vi.fn().mockResolvedValue({ stream: mockMergerStream }),
			countTokens: vi.fn().mockResolvedValue(42),
		};

		// Setup configure settings
		configService.getConfig = vi.fn((key: any) => {
			const id = key?.id ?? '';
			if (id === 'chat.byok.fusion.models') {
				return ['anthropic/claude-3-5-sonnet', 'gemini/gemini-2.5-pro'];
			}
			if (id === 'chat.byok.fusion.mergerModel') {
				return 'openai/gpt-4o';
			}
			if (id === 'chat.byok.fusion.showHint') {
				return true;
			}
			return undefined;
		});

		mockSelectChatModels.mockImplementation(async (query: any) => {
			if (query.vendor === 'anthropic' && query.id === 'claude-3-5-sonnet') {
				return [mockModelA];
			}
			if (query.vendor === 'gemini' && query.id === 'gemini-2.5-pro') {
				return [mockModelB];
			}
			if (query.vendor === 'openai' && query.id === 'gpt-4o') {
				return [mockMerger];
			}
			return [];
		});

		const progressReported: any[] = [];
		const progress = {
			report: (val: any) => {
				progressReported.push(val.value);
			}
		};

		await provider.provideLanguageModelChatResponse(
			{} as any,
			[{ role: 1, content: 'Write a sorting function.' }] as any[],
			{ modelOptions: {}, toolMode: 1, tools: [] } as any,
			progress,
			{ isCancellationRequested: false } as any
		);

		// Verify candidates were called
		expect(mockModelA.sendRequest).toHaveBeenCalled();
		expect(mockModelB.sendRequest).toHaveBeenCalled();

		// Verify merger was called with prompt containing candidate code
		expect(mockMerger.sendRequest).toHaveBeenCalled();
		const mergerCallArgs = mockMerger.sendRequest.mock.calls[0][0];
		const mergerPrompt = mergerCallArgs[mergerCallArgs.length - 1].content;
		expect(mergerPrompt).toContain('Code candidate A');
		expect(mergerPrompt).toContain('Code candidate B');

		// Verify progress reported showHint items and final response
		expect(progressReported).toContain('Fused response');
		expect(progressReported.some(p => p.includes('anthropic/claude-3-5-sonnet'))).toBe(true);
	});
});
