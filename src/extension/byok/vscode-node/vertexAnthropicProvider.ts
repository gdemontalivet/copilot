import Anthropic from '@anthropic-ai/sdk';
import { GoogleAuth } from 'google-auth-library';
import { IConfigurationService } from '../../../platform/configuration/common/configurationService';
import { ILogService } from '../../../platform/log/common/logService';
import { IToolDeferralService } from '../../../platform/networking/common/toolDeferralService';
import { IOTelService } from '../../../platform/otel/common/otelService';
import { IRequestLogger } from '../../../platform/requestLogger/common/requestLogger';
import { IExperimentationService } from '../../../platform/telemetry/common/nullExperimentationService';
import { ITelemetryService } from '../../../platform/telemetry/common/telemetry';
import { BYOKKnownModels, byokKnownModelToAPIInfo } from '../common/byokProvider';
import { ExtendedLanguageModelChatInformation, LanguageModelChatConfiguration } from './abstractLanguageModelChatProvider';
import { AnthropicLMProvider } from './anthropicProvider';
import { IBYOKStorageService } from './byokStorageService';

export interface VertexAnthropicModelConfig {
	name: string;
	projectId: string;
	locationId: string;
	maxInputTokens?: number;
	maxOutputTokens?: number;
}

export interface VertexAnthropicProviderConfig extends LanguageModelChatConfiguration {
	models?: (VertexAnthropicModelConfig & { id: string })[];
}

export class VertexAnthropicLMProvider extends AnthropicLMProvider {

	public static override readonly providerName = 'VertexAnthropic';

	private _tokenCache: { token: string; expiresAt: number } | undefined;

	constructor(
		knownModels: BYOKKnownModels | undefined,
		byokStorageService: IBYOKStorageService,
		@ILogService logService: ILogService,
		@IRequestLogger requestLogger: IRequestLogger,
		@IConfigurationService configurationService: IConfigurationService,
		@IExperimentationService experimentationService: IExperimentationService,
		@ITelemetryService telemetryService: ITelemetryService,
		@IOTelService otelService: IOTelService,
		@IToolDeferralService toolDeferralService: IToolDeferralService,
	) {
		super(knownModels, byokStorageService, logService, requestLogger, configurationService, experimentationService, telemetryService, otelService, toolDeferralService);
		// Override the name from super constructor
		(this as any)._name = VertexAnthropicLMProvider.providerName;
		(this as any)._id = VertexAnthropicLMProvider.providerName.toLowerCase();
	}

	private async _getAccessToken(apiKey: string, projectId?: string): Promise<string> {
		// If it doesn't look like JSON, assume it's already a token
		const trimmedApiKey = apiKey.trim();
		if (!trimmedApiKey.startsWith('{')) {
			return trimmedApiKey;
		}

		// Check cache
		if (this._tokenCache && this._tokenCache.expiresAt > Date.now() + 60000) {
			return this._tokenCache.token;
		}

		try {
			const credentials = JSON.parse(trimmedApiKey);

			const auth = new GoogleAuth({
				credentials,
				scopes: 'https://www.googleapis.com/auth/cloud-platform',
				projectId: credentials.project_id || credentials.quota_project_id || projectId,
			});

			const client = await auth.getClient();
			const tokenResponse = await client.getAccessToken();
			const token = tokenResponse.token;

			if (!token) {
				throw new Error('Failed to retrieve access token from GoogleAuth');
			}

			this._logService.info(`[VertexAnthropic] Successfully retrieved access token. Type: ${credentials.type}, Scopes: ${tokenResponse.res?.config?.url || 'unknown'}`);

			// Estimate expiration (usually 1 hour, we cache for 45 mins to be safe)
			this._tokenCache = {
				token,
				expiresAt: Date.now() + 45 * 60 * 1000,
			};
			return token;
		} catch (e) {
			this._logService.error(`Error parsing or refreshing Google credentials: ${e}`);
			// Fallback to original string if parsing fails
			return trimmedApiKey;
		}
	}

	protected override async getAllModels(silent: boolean, apiKey: string | undefined, configuration?: VertexAnthropicProviderConfig | undefined): Promise<ExtendedLanguageModelChatInformation<VertexAnthropicProviderConfig>[]> {
		if (!configuration || !Array.isArray(configuration.models)) {
			return [];
		}

		const models: ExtendedLanguageModelChatInformation<VertexAnthropicProviderConfig>[] = [];
		for (const modelConfig of configuration.models) {
			const modelId = modelConfig.id;
			models.push({
				...byokKnownModelToAPIInfo(this._name, modelId, {
					name: modelConfig.name || modelId,
					maxInputTokens: modelConfig.maxInputTokens || 100000,
					maxOutputTokens: modelConfig.maxOutputTokens || 8192,
					toolCalling: true,
					vision: false
				}),
				configuration: {
					models: [{ ...modelConfig }]
				}
			});
		}
		return models;
	}

	protected override createClient(apiKey: string, model: ExtendedLanguageModelChatInformation<VertexAnthropicProviderConfig>): Anthropic {
		const modelConfig = model.configuration?.models?.find(m => m.id === model.id);
		if (!modelConfig) {
			throw new Error(`Configuration not found for Vertex Anthropic model ${model.id}`);
		}

		const projectId = modelConfig.projectId;
		const locationId = modelConfig.locationId;
		const endpoint = locationId === 'global' ? 'aiplatform.googleapis.com' : `${locationId}-aiplatform.googleapis.com`;
		const baseUrl = `https://${endpoint}/v1/projects/${projectId}/locations/${locationId}/publishers/anthropic/models`;

		return new Anthropic({
			apiKey: apiKey, // The JSON credentials or the Bearer token
			baseURL: baseUrl,
			fetch: async (url, init) => {
				const urlStr = url.toString();
				let finalUrl = urlStr;

				const token = await this._getAccessToken(apiKey, projectId);

				// The SDK will append '/messages' or '/messages/stream' to the baseURL
				// We need to rewrite it to `/${model.id}:streamRawPredict`
				if (urlStr.includes('/messages')) {
					finalUrl = `${baseUrl}/${model.id}:streamRawPredict`;
				}

				const headers = new Headers(init?.headers);
				// Remove the Anthropic x-api-key header and replace with Bearer token
				headers.delete('x-api-key');
				headers.set('Authorization', `Bearer ${token.trim()}`);

				// For user credentials (ADC), we often need to provide the x-goog-user-project header
				const trimmedApiKey = apiKey.trim();
				if (trimmedApiKey.startsWith('{')) {
					try {
						const credentials = JSON.parse(trimmedApiKey);
						if (credentials.type === 'authorized_user') {
							const userProject = credentials.quota_project_id || projectId;
							headers.set('x-goog-user-project', userProject);
							this._logService.info(`[VertexAnthropic] Set x-goog-user-project header to ${userProject}`);
						}
					} catch (e) {
						// Ignore JSON parse errors
					}
				}

				// Parse the body to add anthropic_version expected by Vertex
				let bodyStr = init?.body;
				if (bodyStr && typeof bodyStr === 'string') {
					try {
						const bodyObj = JSON.parse(bodyStr);
						bodyObj.anthropic_version = 'vertex-2023-10-16';
						// Vertex AI rejects the request if 'model' is included in the body
						delete bodyObj.model;
						bodyStr = JSON.stringify(bodyObj);
					} catch (e) {
						// Ignore JSON parse errors
					}
				}

				// Remove Content-Length because the body size has changed
				headers.delete('content-length');

				this._logService.info(`[VertexAnthropic] Sending request to ${finalUrl}. Headers: ${Array.from(headers.keys()).join(', ')}`);

				const newInit = {
					...init,
					headers,
					body: bodyStr
				};

				return fetch(finalUrl, newInit);
			}
		});
	}
}
