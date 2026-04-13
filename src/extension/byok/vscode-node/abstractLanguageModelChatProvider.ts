/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { CancellationToken, commands, EventEmitter, LanguageModelChatInformation, LanguageModelChatMessage, LanguageModelChatMessage2, LanguageModelChatProvider, LanguageModelResponsePart2, PrepareLanguageModelChatModelOptions, Progress, ProvideLanguageModelChatResponseOptions } from 'vscode';
import { ConfigKey, IConfigurationService } from '../../../platform/configuration/common/configurationService';
import { IChatModelInformation, ModelSupportedEndpoint } from '../../../platform/endpoint/common/endpointProvider';
import { ILogService } from '../../../platform/log/common/logService';
import { IFetcherService } from '../../../platform/networking/common/fetcherService';
import { IExperimentationService } from '../../../platform/telemetry/common/nullExperimentationService';
import { IStringDictionary } from '../../../util/vs/base/common/collections';
import { IInstantiationService } from '../../../util/vs/platform/instantiation/common/instantiation';
import { CopilotLanguageModelWrapper } from '../../conversation/vscode-node/languageModelAccess';
import { BYOKAuthType, BYOKKnownModels, byokKnownModelsToAPIInfo, BYOKModelCapabilities, resolveModelInfo } from '../common/byokProvider';
import { OpenAIEndpoint } from '../node/openAIEndpoint';
import { IBYOKStorageService } from './byokStorageService';

export interface LanguageModelChatConfiguration {
	readonly apiKey?: string;
}

export interface ExtendedLanguageModelChatInformation<C extends LanguageModelChatConfiguration> extends LanguageModelChatInformation {
	readonly configuration?: C;
}

export abstract class AbstractLanguageModelChatProvider<C extends LanguageModelChatConfiguration = LanguageModelChatConfiguration, T extends ExtendedLanguageModelChatInformation<C> = ExtendedLanguageModelChatInformation<C>> implements LanguageModelChatProvider<T> {

	protected readonly _onDidChangeLanguageModelChatInformation = new EventEmitter<void>();
	public readonly onDidChangeLanguageModelChatInformation = this._onDidChangeLanguageModelChatInformation.event;

	constructor(
		protected readonly _id: string,
		protected readonly _name: string,
		protected _knownModels: BYOKKnownModels | undefined,
		protected readonly _byokStorageService: IBYOKStorageService,
		@ILogService protected readonly _logService: ILogService,
	) {
		this.configureDefaultGroupWithApiKeyOnly();
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

	private _modelsCache = new Map<string, { models: T[]; timestamp: number }>();
	private readonly CACHE_DURATION_MS = 1000 * 60 * 60 * 24; // 24 hours

	async provideLanguageModelChatInformation({ silent, configuration }: PrepareLanguageModelChatModelOptions, token: CancellationToken): Promise<T[]> {
		let apiKey: string | undefined = (configuration as C)?.apiKey;
		if (!apiKey) {
			apiKey = await this.configureDefaultGroupWithApiKeyOnly();
		}

		const cacheKey = JSON.stringify({ apiKey, configuration });
		const cached = this._modelsCache.get(cacheKey);
		if (cached && (Date.now() - cached.timestamp) < this.CACHE_DURATION_MS) {
			return cached.models.map(model => ({
				...model,
				apiKey,
				configuration
			}));
		}

		const models = await this.getAllModels(silent, apiKey, configuration as C);

		// If models changed, fire the event
		if (!cached || JSON.stringify(cached.models) !== JSON.stringify(models)) {
			this._modelsCache.set(cacheKey, { models, timestamp: Date.now() });
			this._onDidChangeLanguageModelChatInformation.fire();
		} else {
			// Update timestamp even if models didn't change
			this._modelsCache.set(cacheKey, { models, timestamp: Date.now() });
		}

		return models.map(model => ({
			...model,
			apiKey,
			configuration
		}));
	}

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
		const maxRpm = this._configurationService.getConfig(ConfigKey.Shared.BYOKMaxRPM);
		await this._byokStorageService.throttleIfNecessary?.(maxRpm, this._name);

		const openAIChatEndpoint = await this.createOpenAIEndPoint(model, options);
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
			return byokKnownModelsToAPIInfo(this._name, models).map(model => ({
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
		} catch (error) {			// If we hit a rate limit or other error, fallback to known models to prevent infinite polling
			if (this._knownModels) {
				this._logService.warn(`Error fetching models from ${endpoint}, falling back to known models. Error: ${error instanceof Error ? error.message : error}`);
				return this._knownModels;
			}
			this._logService.error(error, `Error fetching available OpenRouter models`);
			throw error;
		}
	}

	protected async createOpenAIEndPoint(model: OpenAICompatibleLanguageModelChatInformation<T>, options?: ProvideLanguageModelChatResponseOptions): Promise<OpenAIEndpoint> {
		const modelInfo = this.getModelInfo(model.id, model.url);
		const url = modelInfo.supported_endpoints?.includes(ModelSupportedEndpoint.Responses) ?
			`${model.url}/responses` :
			`${model.url}/chat/completions`;
		return this._instantiationService.createInstance(OpenAIEndpoint, modelInfo, model.configuration?.apiKey ?? (model as unknown as { apiKey?: string }).apiKey ?? options?.modelConfiguration?.apiKey ?? '', url);
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
export function getApproximateTokenCount(text: string | LanguageModelChatMessage | LanguageModelChatMessage2): number {
	if (!text) {
		return 0;
	}
	let textStr = '';
	if (typeof text === 'string') {
		textStr = text;
	} else if (typeof (text as unknown as { content: unknown }).content === 'string') {
		textStr = (text as unknown as { content: string }).content;
	} else if (Array.isArray((text as LanguageModelChatMessage).content)) {
		textStr = ((text as LanguageModelChatMessage).content as unknown as Array<string | { value?: string; name?: string; input?: unknown; callId?: string; content?: unknown }>).map(part => {
			if (typeof part === 'string') {
				return part;
			} else if (part && typeof part === 'object') {
				if (typeof part.value === 'string') {
					return part.value;
				} else if (part.name && part.input) {
					return part.name + JSON.stringify(part.input);
				} else if (part.callId && part.content) {
					return part.callId + JSON.stringify(part.content);
				}
				return JSON.stringify(part);
			}
			return String(part);
		}).join(' ');
	} else {
		textStr = JSON.stringify(text);
	}
	return Math.ceil(textStr.length / 4);
}
