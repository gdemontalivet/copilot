/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { LanguageModelChat, type ChatRequest } from 'vscode';
import { IAuthenticationService } from '../../../platform/authentication/common/authentication';
import { IConfigurationService } from '../../../platform/configuration/common/configurationService';
import { ChatEndpointFamily, EmbeddingsEndpointFamily, IChatModelInformation, ICompletionModelInformation, IEmbeddingModelInformation, IEndpointProvider } from '../../../platform/endpoint/common/endpointProvider';
import { AutoChatEndpoint } from '../../../platform/endpoint/node/autoChatEndpoint';
import { IAutomodeService } from '../../../platform/endpoint/node/automodeService';
import { CopilotChatEndpoint } from '../../../platform/endpoint/node/copilotChatEndpoint';
import { EmbeddingEndpoint } from '../../../platform/endpoint/node/embeddingsEndpoint';
import { IModelMetadataFetcher, ModelMetadataFetcher } from '../../../platform/endpoint/node/modelMetadataFetcher';
import { ExtensionContributedChatEndpoint } from '../../../platform/endpoint/vscode-node/extChatEndpoint';
import { ILogService } from '../../../platform/log/common/logService';
import { IChatEndpoint, IEmbeddingsEndpoint } from '../../../platform/networking/common/networking';
import { Emitter, Event } from '../../../util/vs/base/common/event';
import { Disposable } from '../../../util/vs/base/common/lifecycle';
import { IInstantiationService } from '../../../util/vs/platform/instantiation/common/instantiation';


export class ProductionEndpointProvider extends Disposable implements IEndpointProvider {

	declare readonly _serviceBrand: undefined;

	private readonly _onDidModelsRefresh = this._register(new Emitter<void>());
	readonly onDidModelsRefresh: Event<void> = this._onDidModelsRefresh.event;

	private _chatEndpoints: Map<string, IChatEndpoint> = new Map();
	private _embeddingEndpoints: Map<string, IEmbeddingsEndpoint> = new Map();
	private readonly _modelFetcher: IModelMetadataFetcher;

	constructor(
		@IAutomodeService private readonly _autoModeService: IAutomodeService,
		@ILogService protected readonly _logService: ILogService,
		@IConfigurationService protected readonly _configService: IConfigurationService,
		@IInstantiationService protected readonly _instantiationService: IInstantiationService,
		@IAuthenticationService protected readonly _authService: IAuthenticationService,
	) {
		super();

		this._modelFetcher = this._instantiationService.createInstance(ModelMetadataFetcher,
			false,
		);

		// When new models come in from CAPI we want to clear our local caches and let the endpoints be recreated since there may be new info
		this._register(this._modelFetcher.onDidModelsRefresh(() => {
			this._chatEndpoints.clear();
			this._embeddingEndpoints.clear();
			this._onDidModelsRefresh.fire();
		}));
	}

	private getOrCreateChatEndpointInstance(modelMetadata: IChatModelInformation): IChatEndpoint {
		const modelId = modelMetadata.id;
		let chatEndpoint = this._chatEndpoints.get(modelId);
		if (!chatEndpoint) {
			chatEndpoint = this._instantiationService.createInstance(CopilotChatEndpoint, modelMetadata);
			this._chatEndpoints.set(modelId, chatEndpoint);
		}
		return chatEndpoint;
	}

	async getChatEndpoint(requestOrFamilyOrModel: LanguageModelChat | ChatRequest | ChatEndpointFamily): Promise<IChatEndpoint> {
		this._logService.trace(`Resolving chat model`);

		if (typeof requestOrFamilyOrModel === 'string') {
			try {
				const modelMetadata = await this._modelFetcher.getChatModelFromFamily(requestOrFamilyOrModel);
				return this.getOrCreateChatEndpointInstance(modelMetadata!);
			} catch (err) {
				// ─── BYOK CUSTOM PATCH: family fallback in BYOK mode ────────────
				// Preserved by .github/scripts/apply-byok-patches.sh. Do not remove.
				// Under the fake-token bypass (Patch 1) `_familyMap` /
				// `_copilotBaseModel` are never populated, so resolving the
				// 'copilot-base' / 'copilot-fast' families throws. Patches
				// 15/16/18/45 already cover the well-known callsites, but
				// dozens more (codeMapper, search intent, title generator,
				// rename suggestions, chat variables, codebase tool calling,
				// promptCategorizer, intentDetector, devContainerConfigGenerator,
				// commandToConfigConverter, settingsEditorSearchService, etc.)
				// still call this method directly. Catch the throw here once
				// and substitute a registered BYOK chat endpoint so every
				// downstream feature that asks for a generic family can run.
				const fallback = await this._byokFamilyFallback(requestOrFamilyOrModel);
				if (fallback) {
					return fallback;
				}
				throw err;
				// ─── END BYOK CUSTOM PATCH ──────────────────────────────────
			}
		}

		const model = 'model' in requestOrFamilyOrModel ? requestOrFamilyOrModel.model : requestOrFamilyOrModel;

		if (!model) {
			return this.getChatEndpoint('copilot-base');
		}

		if (model.vendor !== 'copilot') {
			return this._instantiationService.createInstance(ExtensionContributedChatEndpoint, model);
		}

		if (model.id === AutoChatEndpoint.pseudoModelId) {
			try {
				const allEndpoints = await this.getAllChatEndpoints();
				return this._autoModeService.resolveAutoModeEndpoint(requestOrFamilyOrModel as ChatRequest, allEndpoints);
			} catch {
				return this.getChatEndpoint('copilot-base');
			}
		}

		const modelMetadata = await this._modelFetcher.getChatModelFromApiModel(model);
		// If we fail to resolve a model since this is panel we give copilot base. This really should never happen as the picker is powered by the same service.
		return modelMetadata ? this.getOrCreateChatEndpointInstance(modelMetadata) : this.getChatEndpoint('copilot-base');
	}

	async getEmbeddingsEndpoint(family?: EmbeddingsEndpointFamily): Promise<IEmbeddingsEndpoint> {
		this._logService.trace(`Resolving embedding model`);
		const modelMetadata = await this._modelFetcher.getEmbeddingsModel('text-embedding-3-small');
		const model = await this.getOrCreateEmbeddingEndpointInstance(modelMetadata);
		this._logService.trace(`Resolved embedding model`);
		return model;
	}

	private async getOrCreateEmbeddingEndpointInstance(modelMetadata: IEmbeddingModelInformation): Promise<IEmbeddingsEndpoint> {
		const modelId = 'text-embedding-3-small';
		let embeddingEndpoint = this._embeddingEndpoints.get(modelId);
		if (!embeddingEndpoint) {
			embeddingEndpoint = this._instantiationService.createInstance(EmbeddingEndpoint, modelMetadata);
			this._embeddingEndpoints.set(modelId, embeddingEndpoint);
		}
		return embeddingEndpoint;
	}

	async getAllCompletionModels(forceRefresh?: boolean): Promise<ICompletionModelInformation[]> {
		return this._modelFetcher.getAllCompletionModels(forceRefresh ?? false);
	}

	async getAllChatEndpoints(): Promise<IChatEndpoint[]> {
		const models: IChatModelInformation[] = await this._modelFetcher.getAllChatModels();
		return models.map(model => this.getOrCreateChatEndpointInstance(model));
	}

	// ─── BYOK CUSTOM PATCH: family fallback resolver ────────────────────────────
	// Preserved by .github/scripts/apply-byok-patches.sh. Do not remove.
	// Picks a registered BYOK chat model when the upstream `_modelFetcher`
	// can't resolve a generic family ('copilot-base' / 'copilot-fast').
	//
	// Both 'copilot-base' and 'copilot-fast' callsites in upstream are
	// background helper tasks (title generation, intent detection, prompt
	// categorisation, summarisation, code-mapper full-rewrite, search-intent
	// keyword extraction, devcontainer / debug-config generation, settings-
	// search, etc.) — almost always short prompts where the cheapest, fastest
	// model wins on every axis. Selection priority is therefore by *capability
	// class* first (cheap & fast: gemini-3.1-flash-lite > any flash/haiku/mini/
	// lite > anything tool-capable) and by vendor only as a tiebreaker. The
	// chosen model is wrapped in `ExtensionContributedChatEndpoint` (same
	// shape used for non-copilot vendors at line ~80) so every IChatEndpoint
	// consumer sees a real endpoint with a working tokenizer / send pipeline.
	//
	// `byokauto` is excluded: routing the family fallback through the synthetic
	// Auto vendor would re-enter `provideLanguageModelChatResponse` and risk
	// infinite recursion when a BYOK Auto delegation itself triggers a
	// 'copilot-fast' lookup (e.g. for chat-title generation).
	private static readonly _BYOK_FAMILY_FALLBACK_NEEDLES: readonly string[] = [
		// Most-preferred → least-preferred. Each needle is matched
		// case-insensitively against `id` AND `family`. First non-empty match
		// wins. All variants here are intentionally cheap+fast classes.
		// Ordered to spare rate-limited resources: DeepSeek first (no
		// per-minute pressure on the maintainer's setup), then Vertex-routed
		// Gemini Flash (Vertex projects don't share the direct-API 15rpm cap),
		// then direct Gemini Flash variants only as a fallback to the
		// fallback. Anthropic Haiku / OpenAI mini classes follow.
		'deepseek-chat',
		'deepseek',
		'gemini-3.1-flash-lite',
		'gemini-3-flash-lite',
		'gemini-flash-lite',
		'flash-lite',
		'gemini-3.1-flash',
		'gemini-3-flash',
		'gemini-flash',
		'flash',
		'claude-haiku',
		'haiku',
		'gpt-5-nano', 'gpt-4.1-nano', 'gpt-4o-mini',
		'mini',
		'lite',
	];
	private static readonly _BYOK_FAMILY_FALLBACK_VENDOR_PRIORITY: readonly string[] = [
		// `customoai` first because the maintainer's DeepSeek is configured
		// there; OpenRouter second (also generally cheap and provider-pooled).
		// `vertexgemini` outranks direct `gemini` so we route Flash through
		// Vertex when both are configured (avoids the direct-API 15rpm cap on
		// the maintainer's free Gemini key).
		'customoai', 'openrouter', 'vertexgemini', 'gemini',
		'vertexanthropic', 'anthropic', 'openai',
	];
	private readonly _byokFamilyFallbackCache = new Map<string, IChatEndpoint>();

	private async _byokFamilyFallback(family: ChatEndpointFamily): Promise<IChatEndpoint | undefined> {
		const cached = this._byokFamilyFallbackCache.get(family);
		if (cached) {
			return cached;
		}
		try {
			const all = await vscode.lm.selectChatModels({});
			const eligible = all.filter(m => m.vendor && m.vendor !== 'byokauto' && m.vendor !== 'copilot');
			if (eligible.length === 0) {
				return undefined;
			}
			let chosen: vscode.LanguageModelChat | undefined;
			let matchedNeedle: string | undefined;
			for (const needle of ProductionEndpointProvider._BYOK_FAMILY_FALLBACK_NEEDLES) {
				const lower = needle.toLowerCase();
				const matches = eligible.filter(m =>
					(m.id ?? '').toLowerCase().includes(lower) ||
					(m.family ?? '').toLowerCase().includes(lower)
				);
				if (matches.length === 0) {
					continue;
				}
				for (const v of ProductionEndpointProvider._BYOK_FAMILY_FALLBACK_VENDOR_PRIORITY) {
					const hit = matches.find(m => m.vendor === v);
					if (hit) {
						chosen = hit;
						matchedNeedle = needle;
						break;
					}
				}
				chosen ??= matches[0];
				matchedNeedle ??= needle;
				break;
			}
			if (!chosen) {
				for (const v of ProductionEndpointProvider._BYOK_FAMILY_FALLBACK_VENDOR_PRIORITY) {
					const hit = eligible.find(m => m.vendor === v);
					if (hit) {
						chosen = hit;
						break;
					}
				}
				chosen ??= eligible[0];
			}
			const endpoint = this._instantiationService.createInstance(ExtensionContributedChatEndpoint, chosen);
			this._logService.info(`[BYOK family-fallback] '${family}' -> ${chosen.vendor}/${chosen.id}${matchedNeedle ? ` (matched '${matchedNeedle}')` : ' (vendor-priority)'}`);
			this._byokFamilyFallbackCache.set(family, endpoint);
			return endpoint;
		} catch (err) {
			this._logService.warn(`[BYOK family-fallback] failed to resolve '${family}': ${(err as Error)?.message ?? err}`);
			return undefined;
		}
	}
	// ─── END BYOK CUSTOM PATCH ──────────────────────────────────────────────────
}
