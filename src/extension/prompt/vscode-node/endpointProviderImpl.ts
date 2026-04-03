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

	private async _getFirstCustomModel(): Promise<IChatEndpoint | undefined> {
		try {
			this._logService.info(`[STARTUP] _getFirstCustomModel: querying vscode.lm.selectChatModels()...`);
			const models = await vscode.lm.selectChatModels();
			this._logService.info(`[STARTUP] _getFirstCustomModel: got ${models.length} total models: ${models.map(m => `${m.vendor}/${m.id}`).join(', ')}`);
			const customModels = models.filter(m => m.vendor !== 'copilot');
			this._logService.info(`[STARTUP] _getFirstCustomModel: found ${customModels.length} custom (non-copilot) models: ${customModels.map(m => `${m.vendor}/${m.id}`).join(', ')}`);
			if (customModels.length > 0) {
				this._logService.info(`[STARTUP] _getFirstCustomModel: using custom model: ${customModels[0].vendor}/${customModels[0].id}`);
				return this._instantiationService.createInstance(ExtensionContributedChatEndpoint, customModels[0]);
			}
		} catch (e) {
			this._logService.error(`[STARTUP] _getFirstCustomModel: failed to get custom models: ${e}`);
		}
		this._logService.info(`[STARTUP] _getFirstCustomModel: no custom models found`);
		return undefined;
	}

	async getChatEndpoint(requestOrFamilyOrModel: LanguageModelChat | ChatRequest | ChatEndpointFamily): Promise<IChatEndpoint> {
		const requestDesc = typeof requestOrFamilyOrModel === 'string' ? requestOrFamilyOrModel : ('model' in requestOrFamilyOrModel ? `model:${(requestOrFamilyOrModel as any).model?.id ?? 'none'}` : `chatRequest`);
		this._logService.info(`[STARTUP] getChatEndpoint called with: ${requestDesc}`);

		if (typeof requestOrFamilyOrModel === 'string') {
			try {
				this._logService.info(`[STARTUP] getChatEndpoint: fetching model from family '${requestOrFamilyOrModel}'`);
				const modelMetadata = await this._modelFetcher.getChatModelFromFamily(requestOrFamilyOrModel);
				this._logService.info(`[STARTUP] getChatEndpoint: got model from family '${requestOrFamilyOrModel}': ${modelMetadata?.id}`);
				return this.getOrCreateChatEndpointInstance(modelMetadata!);
			} catch (e) {
				this._logService.info(`[STARTUP] getChatEndpoint: failed to get model from family '${requestOrFamilyOrModel}', falling back to custom models. Error: ${e}`);
				const customEndpoint = await this._getFirstCustomModel();
				if (customEndpoint) {
					return customEndpoint;
				}
				throw e;
			}
		}

		const model = 'model' in requestOrFamilyOrModel ? requestOrFamilyOrModel.model : requestOrFamilyOrModel;

		if (!model) {
			// No model specified - try CAPI base, fall back to custom
			try {
				return await this.getChatEndpoint('copilot-base');
			} catch (e) {
				this._logService.info(`Failed to get copilot-base, falling back to custom models. Error: ${e}`);
				const customEndpoint = await this._getFirstCustomModel();
				if (customEndpoint) {
					return customEndpoint;
				}
				throw e;
			}
		}

		if (model.vendor !== 'copilot') {
			this._logService.info(`Using custom model directly: ${model.id}`);
			return this._instantiationService.createInstance(ExtensionContributedChatEndpoint, model);
		}

		if (model.id === AutoChatEndpoint.pseudoModelId) {
			try {
				const allEndpoints = await this.getAllChatEndpoints();
				if (allEndpoints.length > 0) {
					return await this._autoModeService.resolveAutoModeEndpoint(requestOrFamilyOrModel as ChatRequest, allEndpoints);
				}
			} catch (e) {
				this._logService.info(`Failed to resolve auto mode endpoint: ${e}`);
			}
			// Auto mode failed - fall back to custom models
			const customEndpoint = await this._getFirstCustomModel();
			if (customEndpoint) {
				return customEndpoint;
			}
			throw new Error('No models available - please configure a custom model in "Manage Language Models"');
		}

		try {
			const modelMetadata = await this._modelFetcher.getChatModelFromApiModel(model);
			if (modelMetadata) {
				return this.getOrCreateChatEndpointInstance(modelMetadata);
			}
		} catch (e) {
			this._logService.info(`Failed to get model from api model, falling back to custom models. Error: ${e}`);
		}
		// Fall back to custom models instead of recursing into copilot-base
		const customEndpoint = await this._getFirstCustomModel();
		if (customEndpoint) {
			return customEndpoint;
		}
		throw new Error('No models available - please configure a custom model in "Manage Language Models"');
	}

	async getEmbeddingsEndpoint(family?: EmbeddingsEndpointFamily): Promise<IEmbeddingsEndpoint> {
		this._logService.trace(`Resolving embedding model`);
		try {
			const modelMetadata = await this._modelFetcher.getEmbeddingsModel('text-embedding-3-small');
			const model = await this.getOrCreateEmbeddingEndpointInstance(modelMetadata);
			this._logService.trace(`Resolved embedding model`);
			return model;
		} catch (e) {
			this._logService.warn(`Failed to resolve embedding model: ${e}`);
			throw e;
		}
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
		try {
			return await this._modelFetcher.getAllCompletionModels(forceRefresh ?? false);
		} catch (e) {
			this._logService.warn(`Failed to get completion models: ${e}`);
			return [];
		}
	}

	async getAllChatEndpoints(): Promise<IChatEndpoint[]> {
		this._logService.info(`[STARTUP] getAllChatEndpoints: fetching all chat models from CAPI...`);
		try {
			const models: IChatModelInformation[] = await this._modelFetcher.getAllChatModels();
			this._logService.info(`[STARTUP] getAllChatEndpoints: got ${models.length} chat models from CAPI: ${models.map(m => m.id).join(', ')}`);
			return models.map(model => this.getOrCreateChatEndpointInstance(model));
		} catch (e) {
			this._logService.warn(`[STARTUP] getAllChatEndpoints: failed to get all chat models from CAPI: ${e}`);
			return [];
		}
	}
}
