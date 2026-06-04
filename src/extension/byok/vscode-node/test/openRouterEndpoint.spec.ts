/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as vscode from 'vscode';
import { IChatModelInformation, ModelSupportedEndpoint } from '../../../../platform/endpoint/common/endpointProvider';
import { ITestingServicesAccessor } from '../../../../platform/test/node/services';
import { TokenizerType } from '../../../../util/common/tokenizer';
import { DisposableStore } from '../../../../util/vs/base/common/lifecycle';
import { IInstantiationService } from '../../../../util/vs/platform/instantiation/common/instantiation';
import { createExtensionUnitTestingServices } from '../../../test/node/services';
import { OpenRouterEndpoint, OpenRouterLMProvider } from '../openRouterProvider';
import { IBYOKStorageService } from '../byokStorageService';

describe('OpenRouterEndpoint', () => {
	const disposables = new DisposableStore();
	let accessor: ITestingServicesAccessor;
	let instaService: IInstantiationService;

	beforeEach(() => {
		const testingServiceCollection = createExtensionUnitTestingServices();
		accessor = disposables.add(testingServiceCollection.createTestingAccessor());
		instaService = accessor.get(IInstantiationService);
	});

	afterEach(() => {
		disposables.clear();
	});

	describe('Anthropic models — Messages API', () => {
		let anthropicMetadata: IChatModelInformation;

		beforeEach(() => {
			anthropicMetadata = {
				id: 'anthropic/claude-sonnet-4',
				name: 'Claude Sonnet 4',
				vendor: 'OpenRouter',
				version: '1.0',
				model_picker_enabled: true,
				is_chat_default: false,
				is_chat_fallback: false,
				supported_endpoints: [ModelSupportedEndpoint.Messages],
				capabilities: {
					type: 'chat',
					family: 'anthropic/claude-sonnet-4',
					tokenizer: TokenizerType.O200K,
					supports: {
						parallel_tool_calls: false,
						streaming: true,
						tool_calls: true,
						vision: true,
						prediction: false,
						thinking: false
					},
					limits: {
						max_prompt_tokens: 200000,
						max_output_tokens: 16000,
						max_context_window_tokens: 200000
					}
				}
			};
		});

		it('should use Messages API when supported_endpoints includes Messages', () => {
			const endpoint = instaService.createInstance(OpenRouterEndpoint,
				anthropicMetadata,
				'test-api-key',
				'https://openrouter.ai/api/v1/messages');

			expect(endpoint.apiType).toBe('messages');
		});

	});

	describe('Non-Anthropic models — Chat Completions', () => {
		let nonAnthropicMetadata: IChatModelInformation;

		beforeEach(() => {
			nonAnthropicMetadata = {
				id: 'openai/gpt-4o',
				name: 'GPT-4o',
				vendor: 'OpenRouter',
				version: '1.0',
				model_picker_enabled: true,
				is_chat_default: false,
				is_chat_fallback: false,
				supported_endpoints: [ModelSupportedEndpoint.ChatCompletions],
				capabilities: {
					type: 'chat',
					family: 'openai/gpt-4o',
					tokenizer: TokenizerType.O200K,
					supports: {
						parallel_tool_calls: false,
						streaming: true,
						tool_calls: true,
						vision: true,
						prediction: false,
						thinking: false
					},
					limits: {
						max_prompt_tokens: 128000,
						max_output_tokens: 16000,
						max_context_window_tokens: 128000
					}
				}
			};
		});

		it('should use Chat Completions API for non-Anthropic models', () => {
			const endpoint = instaService.createInstance(OpenRouterEndpoint,
				nonAnthropicMetadata,
				'test-api-key',
				'https://openrouter.ai/api/v1/chat/completions');

			expect(endpoint.apiType).toBe('chatCompletions');
		});
	});

	describe('OpenRouterLMProvider', () => {
		it('should append openrouter/fusion to returned models', async () => {
			const fetch = vi.fn(async (url: string) => {
				if (url === 'https://openrouter.ai/api/v1/models?supported_parameters=tools') {
					return {
						json: async () => ({
							data: [
								{
									id: 'anthropic/claude-3.5-sonnet',
									name: 'Claude 3.5 Sonnet',
									supported_parameters: ['tools'],
									top_provider: {
										context_length: 200000,
									},
								}
							]
						})
					};
				}
				throw new Error(`Unexpected URL: ${url}`);
			});

			const byokStorageService: IBYOKStorageService = {
				getAPIKey: vi.fn().mockResolvedValue(undefined),
				storeAPIKey: vi.fn().mockResolvedValue(undefined),
				deleteAPIKey: vi.fn().mockResolvedValue(undefined),
				getStoredModelConfigs: vi.fn().mockResolvedValue({}),
				saveModelConfig: vi.fn().mockResolvedValue(undefined),
				removeModelConfig: vi.fn().mockResolvedValue(undefined),
			};

			const provider = new OpenRouterLMProvider(
				byokStorageService,
				{ fetch } as any,
				{ error: vi.fn() } as any,
				{ createInstance: vi.fn().mockReturnValue({}) } as any,
				{ isConfigured: vi.fn().mockReturnValue(false) } as any,
				{} as any
			);

			const tokenSource = new vscode.CancellationTokenSource();
			const models = await provider.provideLanguageModelChatInformation(
				{ silent: false, configuration: { apiKey: 'test-api-key' } },
				tokenSource.token
			);

			const modelIds = models.map(m => m.id);
			expect(modelIds).toContain('anthropic/claude-3.5-sonnet');
			expect(modelIds).toContain('openrouter/fusion');

			const fusionModel = models.find(m => m.id === 'openrouter/fusion');
			expect(fusionModel?.name).toBe('OpenRouter Fusion (Deliberation Router)');
			expect(fusionModel?.maxInputTokens).toBe(128000);
		});
	});
});
