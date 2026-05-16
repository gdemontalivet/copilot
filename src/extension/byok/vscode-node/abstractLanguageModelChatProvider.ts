/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { CancellationToken, commands, LanguageModelChatInformation, LanguageModelChatMessage, LanguageModelChatMessage2, LanguageModelChatProvider, LanguageModelResponsePart2, PrepareLanguageModelChatModelOptions, Progress, ProvideLanguageModelChatResponseOptions } from 'vscode';
import { IConfigurationService } from '../../../platform/configuration/common/configurationService';
import { IChatModelInformation, ModelSupportedEndpoint } from '../../../platform/endpoint/common/endpointProvider';
import { ILogService } from '../../../platform/log/common/logService';
import { IFetcherService } from '../../../platform/networking/common/fetcherService';
import { IExperimentationService } from '../../../platform/telemetry/common/nullExperimentationService';
import { IStringDictionary } from '../../../util/vs/base/common/collections';
import { IInstantiationService } from '../../../util/vs/platform/instantiation/common/instantiation';
import { CopilotLanguageModelWrapper } from '../../conversation/vscode-node/languageModelAccess';
import { BYOKAuthType, BYOKKnownModels, BYOKModelCapabilities, resolveModelInfo } from '../common/byokProvider';
import { OpenAIEndpoint } from '../node/openAIEndpoint';
import { byokKnownModelsToAPIInfoWithEffort } from './byokModelInfo';
import { IBYOKStorageService } from './byokStorageService';

export interface LanguageModelChatConfiguration {
	readonly apiKey?: string;
}

export interface ExtendedLanguageModelChatInformation<C extends LanguageModelChatConfiguration> extends LanguageModelChatInformation {
	readonly configuration?: C;
}

export abstract class AbstractLanguageModelChatProvider<C extends LanguageModelChatConfiguration = LanguageModelChatConfiguration, T extends ExtendedLanguageModelChatInformation<C> = ExtendedLanguageModelChatInformation<C>> implements LanguageModelChatProvider<T> {

	constructor(
		protected readonly _id: string,
		protected readonly _name: string,
		protected _knownModels: BYOKKnownModels | undefined,
		protected readonly _byokStorageService: IBYOKStorageService,
		@ILogService protected readonly _logService: ILogService,
	) {
		this.configureDefaultGroupWithApiKeyOnly();
	}

	updateKnownModels(knownModels: BYOKKnownModels | undefined): void {
		if (!knownModels) {
			return;
		}
		this._knownModels = { ...this._knownModels, ...knownModels };
	}

	// TODO: Remove this after 6 months
	protected async configureDefaultGroupWithApiKeyOnly(): Promise<string | undefined> {
		const apiKey = await this._byokStorageService.getAPIKey(this._name);
		if (apiKey) {
			this.configureDefaultGroupIfExists(this._name, { apiKey } as C);
			await this._byokStorageService.deleteAPIKey(this._name, BYOKAuthType.GlobalApiKey);
		}
		return apiKey;
	}

	protected async configureDefaultGroupIfExists(name: string, configuration: C): Promise<void> {
		await commands.executeCommand('lm.migrateLanguageModelsProviderGroup', { vendor: this._id, name, ...configuration });
	}

	async provideLanguageModelChatInformation({ silent, configuration }: PrepareLanguageModelChatModelOptions, token: CancellationToken): Promise<T[]> {
		let apiKey: string | undefined = (configuration as C)?.apiKey;
		if (!apiKey) {
			apiKey = await this.configureDefaultGroupWithApiKeyOnly();
		}

		// ─── BYOK CUSTOM PATCH: cache getAllModels to survive picker refresh storms ──
		// Preserved by .github/scripts/apply-byok-patches.sh (Patch 42). Do not remove.
		// See class-level state block below for rationale.
		const cacheKey = this._byokModelListCacheKey(apiKey, !!silent, configuration);
		const now = Date.now();
		const cached = this._byokModelListCache.get(cacheKey);
		if (cached && cached.expiresAt > now) {
			if ('models' in cached) {
				return cached.models.map(model => ({ ...model, apiKey, configuration }));
			}
			throw cached.error;
		}
		let inflight = this._byokModelListInFlight.get(cacheKey);
		if (!inflight) {
			inflight = (async () => {
				try {
					const result = await this.getAllModels(silent, apiKey, configuration as C);
					this._byokModelListCache.set(cacheKey, {
						models: result,
						expiresAt: Date.now() + AbstractLanguageModelChatProvider._BYOK_MODEL_LIST_TTL_MS,
					});
					return result;
				} catch (err) {
					this._byokModelListCache.set(cacheKey, {
						error: err,
						expiresAt: Date.now() + AbstractLanguageModelChatProvider._BYOK_MODEL_LIST_NEGATIVE_TTL_MS,
					});
					throw err;
				} finally {
					this._byokModelListInFlight.delete(cacheKey);
				}
			})();
			this._byokModelListInFlight.set(cacheKey, inflight);
		}
		const models = await inflight;
		// ─── END BYOK CUSTOM PATCH ────────────────────────

		return models.map(model => ({
			...model,
			apiKey,
			configuration
		}));
	}

	// ─── BYOK CUSTOM PATCH: model-list cache state (Patch 42) ────────
	// Preserved by .github/scripts/apply-byok-patches.sh. Do not remove.
	// Upstream calls `getAllModels` on every `provideLanguageModelChatInformation`
	// with zero caching; VS Code fires `provideLanguageModelChatInformation`
	// 10-15×/second on picker refresh; every Gemini/Anthropic `models.list`
	// call then hits the wire and blows Google's 200/min quota within seconds.
	// 24h TTL is safe because vendors ship new models at most monthly.
	// Negative cache (30s) prevents transient 429s from causing a second storm.
	// Cache lives on the instance, so disposing the provider (key rotation,
	// workspace reload) drops it.
	private static readonly _BYOK_MODEL_LIST_TTL_MS = 24 * 60 * 60 * 1000;
	private static readonly _BYOK_MODEL_LIST_NEGATIVE_TTL_MS = 30 * 1000;
	private readonly _byokModelListCache = new Map<string, { models: T[]; expiresAt: number } | { error: unknown; expiresAt: number }>();
	private readonly _byokModelListInFlight = new Map<string, Promise<T[]>>();

	private _byokHashApiKey(apiKey: string | undefined): string {
		if (!apiKey) { return 'noKey'; }
		// Cheap non-cryptographic fingerprint. Key never leaves memory.
		let h = 0;
		for (let i = 0; i < apiKey.length; i++) {
			h = ((h << 5) - h + apiKey.charCodeAt(i)) | 0;
		}
		return `${apiKey.length}_${(h >>> 0).toString(16)}`;
	}

	private _byokModelListCacheKey(apiKey: string | undefined, silent: boolean, configuration: unknown): string {
		return `${this._id}::${this._byokHashApiKey(apiKey)}::${silent ? 's' : 'i'}::${JSON.stringify(configuration ?? {})}`;
	}
	// ─── END BYOK CUSTOM PATCH ───────────────────────

	abstract provideLanguageModelChatResponse(model: T, messages: Array<LanguageModelChatMessage | LanguageModelChatMessage2>, options: ProvideLanguageModelChatResponseOptions, progress: Progress<LanguageModelResponsePart2>, token: CancellationToken): Promise<void>;
	abstract provideTokenCount(model: T, text: string | LanguageModelChatMessage | LanguageModelChatMessage2, token: CancellationToken): Promise<number>;
	protected abstract getAllModels(silent: boolean, apiKey: string | undefined, configuration: C | undefined): Promise<T[]>;
}

export interface OpenAICompatibleLanguageModelChatInformation<C extends LanguageModelChatConfiguration> extends ExtendedLanguageModelChatInformation<C> {
	url: string;
}

export abstract class AbstractOpenAICompatibleLMProvider<T extends LanguageModelChatConfiguration = LanguageModelChatConfiguration> extends AbstractLanguageModelChatProvider<T, OpenAICompatibleLanguageModelChatInformation<T>> {
	protected readonly _lmWrapper: CopilotLanguageModelWrapper;

	constructor(
		id: string,
		name: string,
		knownModels: BYOKKnownModels | undefined,
		byokStorageService: IBYOKStorageService,
		@IFetcherService protected readonly _fetcherService: IFetcherService,
		logService: ILogService,
		@IInstantiationService protected readonly _instantiationService: IInstantiationService,
		@IConfigurationService protected readonly _configurationService: IConfigurationService,
		@IExperimentationService protected readonly _expService: IExperimentationService
	) {
		super(id, name, knownModels, byokStorageService, logService);
		this._lmWrapper = this._instantiationService.createInstance(CopilotLanguageModelWrapper);
	}

	async provideLanguageModelChatResponse(model: OpenAICompatibleLanguageModelChatInformation<T>, messages: Array<LanguageModelChatMessage | LanguageModelChatMessage2>, options: ProvideLanguageModelChatResponseOptions, progress: Progress<LanguageModelResponsePart2>, token: CancellationToken): Promise<void> {
		const openAIChatEndpoint = await this.createOpenAIEndPoint(model);
		return this._lmWrapper.provideLanguageModelResponse(openAIChatEndpoint, messages, options, options.requestInitiator, progress, token);
	}

	async provideTokenCount(model: OpenAICompatibleLanguageModelChatInformation<T>, text: string | LanguageModelChatMessage | LanguageModelChatMessage2, token: CancellationToken): Promise<number> {
		const openAIChatEndpoint = await this.createOpenAIEndPoint(model);
		return this._lmWrapper.provideTokenCount(openAIChatEndpoint, text);
	}

	protected async getAllModels(silent: boolean, apiKey: string | undefined, configuration: T | undefined): Promise<OpenAICompatibleLanguageModelChatInformation<T>[]> {
		const modelsUrl = this.getModelsBaseUrl(configuration);
		if (modelsUrl) {
			const models = await this.getModelsFromEndpoint(modelsUrl, silent, apiKey);
			return byokKnownModelsToAPIInfoWithEffort(this._name, models).map(model => ({
				...model,
				url: modelsUrl
			}));
		}
		return [];
	}

	private async getModelsFromEndpoint(endpoint: string, silent: boolean, apiKey: string | undefined): Promise<BYOKKnownModels> {
		if (!apiKey && silent) {
			return {};
		}

		try {
			const headers: IStringDictionary<string> = {
				'Content-Type': 'application/json',
				'Authorization': `Bearer ${apiKey}`
			};

			const modelsEndpoint = this.getModelsDiscoveryUrl(endpoint);
			const response = await this._fetcherService.fetch(modelsEndpoint, {
				method: 'GET',
				headers,
				callSite: 'byok-models-discovery',
			});
			const data = await response.json();
			const modelList: BYOKKnownModels = {};

			const models = data.data ?? data.models;
			if (!models || !Array.isArray(models)) {
				throw new Error('Invalid response format');
			}

			for (const model of models) {
				let modelCapabilities = this._knownModels?.[model.id];
				if (!modelCapabilities) {
					modelCapabilities = this.resolveModelCapabilities(model);
					if (!modelCapabilities) {
						continue;
					}
					if (!this._knownModels) {
						this._knownModels = {};
					}
					this._knownModels[model.id] = modelCapabilities;
				}
				modelList[model.id] = modelCapabilities;
			}
			return modelList;
		} catch (error) {
			this._logService.error(error, `Error fetching available OpenRouter models`);
			throw error;
		}
	}

	protected async createOpenAIEndPoint(model: OpenAICompatibleLanguageModelChatInformation<T>): Promise<OpenAIEndpoint> {
		const modelInfo = this.getModelInfo(model.id, model.url);
		const url = modelInfo.supported_endpoints?.includes(ModelSupportedEndpoint.Responses) ?
			`${model.url}/responses` :
			`${model.url}/chat/completions`;
		return this._instantiationService.createInstance(OpenAIEndpoint, modelInfo, model.configuration?.apiKey ?? '', url);
	}

	protected getModelInfo(modelId: string, modelUrl: string): IChatModelInformation {
		return resolveModelInfo(modelId, this._name, this._knownModels);
	}

	protected resolveModelCapabilities(modelData: unknown): BYOKModelCapabilities | undefined {
		return undefined;
	}

	protected abstract getModelsBaseUrl(configuration: T | undefined): string | undefined;

	protected getModelsDiscoveryUrl(modelsBaseUrl: string): string {
		return `${modelsBaseUrl}/models`;
	}

}
