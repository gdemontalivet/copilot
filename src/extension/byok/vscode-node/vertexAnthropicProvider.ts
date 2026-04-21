/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import Anthropic from '@anthropic-ai/sdk';
import { GoogleAuth } from 'google-auth-library';
import { ConfigKey, IConfigurationService } from '../../../platform/configuration/common/configurationService';
import { ILogService } from '../../../platform/log/common/logService';
import { IToolDeferralService } from '../../../platform/networking/common/toolDeferralService';
import { IOTelService } from '../../../platform/otel/common/otelService';
import { IRequestLogger } from '../../../platform/requestLogger/common/requestLogger';
import { IExperimentationService } from '../../../platform/telemetry/common/nullExperimentationService';
import { ITelemetryService } from '../../../platform/telemetry/common/telemetry';
import { BYOKKnownModels, byokKnownModelToAPIInfo } from '../common/byokProvider';
import { AnthropicLMProvider, IAnthropicFailoverTarget } from './anthropicProvider';
import { IBYOKStorageService } from './byokStorageService';
import { ExtendedLanguageModelChatInformation, LanguageModelChatConfiguration } from './abstractLanguageModelChatProvider';

/**
 * A single Vertex-hosted Anthropic model configuration, as defined in the
 * `github.copilot.chat.vertexAnthropicModels` user setting.
 */
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

// ─── BYOK CUSTOM PATCH: vertex anthropic sensible context defaults ────────────
// Preserved by .github/scripts/apply-byok-patches.sh. Do not remove.
// Upstream falls back to 100 000 when a Vertex model config omits
// `maxInputTokens`, which is half of modern Claude models' real 200K context
// window (and far less than the 1M that recent claude-sonnet-4 previews
// advertise with the long-context beta). The symptom is dangerous: the VS
// Code LM API treats `maxInputTokens` as a hard cap, so prompts approaching
// 100K get rejected client-side before they ever reach Vertex — the chat UI
// just stops responding with no useful error. We also provide a small
// static lookup so users can drop a model ID into `chatLanguageModels.json`
// without manually recalculating limits every time Anthropic ships a new
// Claude release.
const DEFAULT_VERTEX_ANTHROPIC_MAX_INPUT_TOKENS = 200_000;
const DEFAULT_VERTEX_ANTHROPIC_MAX_OUTPUT_TOKENS = 8_192;
const KNOWN_VERTEX_ANTHROPIC_MODELS: Record<string, { maxInputTokens: number; maxOutputTokens: number }> = {
	'claude-opus-4-6': { maxInputTokens: 200_000, maxOutputTokens: 32_000 },
	'claude-opus-4-5': { maxInputTokens: 200_000, maxOutputTokens: 32_000 },
	'claude-opus-4': { maxInputTokens: 200_000, maxOutputTokens: 32_000 },
	'claude-sonnet-4-5': { maxInputTokens: 200_000, maxOutputTokens: 64_000 },
	'claude-sonnet-4': { maxInputTokens: 200_000, maxOutputTokens: 64_000 },
	'claude-3-7-sonnet': { maxInputTokens: 200_000, maxOutputTokens: 64_000 },
	'claude-3-5-sonnet': { maxInputTokens: 200_000, maxOutputTokens: 8_192 },
	'claude-3-5-haiku': { maxInputTokens: 200_000, maxOutputTokens: 8_192 },
	'claude-3-opus': { maxInputTokens: 200_000, maxOutputTokens: 4_096 },
	'claude-3-haiku': { maxInputTokens: 200_000, maxOutputTokens: 4_096 },
};
function resolveVertexAnthropicLimits(modelId: string, cfg: { maxInputTokens?: number; maxOutputTokens?: number }): { maxInputTokens: number; maxOutputTokens: number } {
	// Strip the `@YYYYMMDD` date suffix Vertex uses so `claude-sonnet-4@20250629`
	// matches the `claude-sonnet-4` known entry. Longest-prefix wins so
	// `claude-3-5-sonnet-…` hits the 3.5 entry rather than the bare `claude-3-`.
	const stripped = modelId.replace(/@.*$/, '');
	let known: { maxInputTokens: number; maxOutputTokens: number } | undefined;
	let bestPrefix = '';
	for (const [prefix, limits] of Object.entries(KNOWN_VERTEX_ANTHROPIC_MODELS)) {
		if ((stripped === prefix || stripped.startsWith(`${prefix}-`) || stripped.startsWith(`${prefix}_`)) && prefix.length > bestPrefix.length) {
			known = limits;
			bestPrefix = prefix;
		}
	}
	return {
		maxInputTokens: cfg.maxInputTokens ?? known?.maxInputTokens ?? DEFAULT_VERTEX_ANTHROPIC_MAX_INPUT_TOKENS,
		maxOutputTokens: cfg.maxOutputTokens ?? known?.maxOutputTokens ?? DEFAULT_VERTEX_ANTHROPIC_MAX_OUTPUT_TOKENS,
	};
}
// ─── END BYOK CUSTOM PATCH ────────────────────────────────────────────────────

/**
 * Routes Anthropic (Claude) requests through Google Cloud Vertex AI instead of
 * Anthropic's direct API. Useful as a failover target when the direct API is
 * rate-limited, or when a team's quota / billing lives on GCP.
 *
 * Auth: the user's "API key" for this provider is either:
 *   - A Google Cloud service-account JSON (full credentials object as a string), or
 *   - A pre-fetched OAuth 2.0 Bearer token
 *
 * Models: configured via the `chat.vertexAnthropicModels` setting, keyed by the
 * Vertex model id (e.g. `claude-sonnet-4-5@20250629`).
 */
export class VertexAnthropicLMProvider extends AnthropicLMProvider implements IAnthropicFailoverTarget {

	public static override readonly providerName: string = 'VertexAnthropic';

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
		// The base class captures the Anthropic providerName in its constructor; rebind so VS Code groups and
		// BYOK storage use the correct vendor for this subclass.
		(this as unknown as { _name: string })._name = VertexAnthropicLMProvider.providerName;
		(this as unknown as { _id: string })._id = VertexAnthropicLMProvider.providerName.toLowerCase();
	}

	/**
	 * Resolves the user-provided credential into a Bearer token.
	 * If the credential isn't JSON, it's treated as an already-minted token.
	 */
	private async _getAccessToken(apiKey: string, projectId?: string): Promise<string> {
		const trimmedApiKey = apiKey.trim();
		if (!trimmedApiKey.startsWith('{')) {
			return trimmedApiKey;
		}

		if (this._tokenCache && this._tokenCache.expiresAt > Date.now() + 60_000) {
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

			this._logService.info(`[VertexAnthropic] Retrieved access token (credential type: ${credentials.type ?? 'unknown'})`);

			// Access tokens are typically valid for 1h; cache for 45 min to be safe.
			this._tokenCache = { token, expiresAt: Date.now() + 45 * 60 * 1000 };
			return token;
		} catch (e) {
			this._logService.error(`[VertexAnthropic] Error parsing or refreshing Google credentials: ${e}`);
			return trimmedApiKey;
		}
	}

	/**
	 * Build a self-contained model info for the Vertex model that should take over
	 * when the direct Anthropic provider fails for `primaryModelId`.
	 *
	 * Resolution order:
	 *   1. Explicit mapping in `chat.byok.anthropic.fallback.modelMap`
	 *   2. Prefix match against the keys of `chat.vertexAnthropicModels`
	 *
	 * Returns `undefined` if no suitable Vertex model is configured OR no Vertex
	 * API key has been stored yet (nothing to fail over to).
	 */
	async resolveFailoverModel(primaryModelId: string): Promise<ExtendedLanguageModelChatInformation<LanguageModelChatConfiguration> | undefined> {
		const explicitMap = this._configurationService.getConfig(ConfigKey.ByokAnthropicFallbackModelMap) ?? {};
		const vertexModels = this._configurationService.getConfig(ConfigKey.VertexAnthropicModels) ?? {};

		let vertexId: string | undefined = explicitMap[primaryModelId];
		if (!vertexId || !vertexModels[vertexId]) {
			vertexId = Object.keys(vertexModels).find(k => k === primaryModelId || k.startsWith(`${primaryModelId}@`));
		}
		if (!vertexId) { return undefined; }
		const cfg = vertexModels[vertexId];
		if (!cfg) { return undefined; }

		const apiKey = await this._byokStorageService.getAPIKey(this._name)
			?? await this._byokStorageService.getAPIKey(this._name, vertexId);
		if (!apiKey) {
			this._logService.warn('[VertexAnthropic] No API key stored; cannot act as failover target.');
			return undefined;
		}

		const { maxInputTokens, maxOutputTokens } = resolveVertexAnthropicLimits(vertexId, cfg);
		const baseInfo = byokKnownModelToAPIInfo(this._name, vertexId, {
			name: cfg.name || vertexId,
			maxInputTokens,
			maxOutputTokens,
			toolCalling: true,
			vision: false,
		});
		const failoverConfig: VertexAnthropicProviderConfig = {
			apiKey,
			models: [{ id: vertexId, ...cfg }],
		};
		return {
			...baseInfo,
			configuration: failoverConfig,
		} as ExtendedLanguageModelChatInformation<LanguageModelChatConfiguration>;
	}

	protected override async getAllModels(silent: boolean, apiKey: string | undefined, configuration?: VertexAnthropicProviderConfig | undefined): Promise<ExtendedLanguageModelChatInformation<VertexAnthropicProviderConfig>[]> {
		// Prefer per-group `configuration.models` (VS Code LM group config). Fall back to the global
		// `chat.vertexAnthropicModels` setting so users who only edit settings still see models.
		let modelConfigs = configuration?.models;
		if (!modelConfigs || modelConfigs.length === 0) {
			const settingMap = this._configurationService.getConfig(ConfigKey.VertexAnthropicModels) ?? {};
			modelConfigs = Object.entries(settingMap).map(([id, cfg]) => ({ id, ...cfg }));
		}

		if (!modelConfigs || modelConfigs.length === 0) {
			return [];
		}

		const models: ExtendedLanguageModelChatInformation<VertexAnthropicProviderConfig>[] = [];
		for (const modelConfig of modelConfigs) {
			const modelId = modelConfig.id;
			const { maxInputTokens, maxOutputTokens } = resolveVertexAnthropicLimits(modelId, modelConfig);
			models.push({
				...byokKnownModelToAPIInfo(this._name, modelId, {
					name: modelConfig.name || modelId,
					maxInputTokens,
					maxOutputTokens,
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

	protected override createClient(apiKey: string, model: ExtendedLanguageModelChatInformation<LanguageModelChatConfiguration>): Anthropic {
		const vertexModel = model as ExtendedLanguageModelChatInformation<VertexAnthropicProviderConfig>;
		const modelConfig = vertexModel.configuration?.models?.find(m => m.id === vertexModel.id);
		if (!modelConfig) {
			throw new Error(`Configuration not found for Vertex Anthropic model ${vertexModel.id}`);
		}

		const { projectId, locationId } = modelConfig;
		const endpoint = locationId === 'global' ? 'aiplatform.googleapis.com' : `${locationId}-aiplatform.googleapis.com`;
		const baseUrl = `https://${endpoint}/v1/projects/${projectId}/locations/${locationId}/publishers/anthropic/models`;

		return new Anthropic({
			apiKey,
			baseURL: baseUrl,
			fetch: async (url, init) => {
				const urlStr = url.toString();
				// Anthropic SDK appends `/messages` or `/messages/stream` to baseURL — Vertex uses
				// `/${modelId}:streamRawPredict` instead.
				const finalUrl = urlStr.includes('/messages')
					? `${baseUrl}/${vertexModel.id}:streamRawPredict`
					: urlStr;

				const token = await this._getAccessToken(apiKey, projectId);
				const headers = new Headers(init?.headers);
				headers.delete('x-api-key');
				headers.set('Authorization', `Bearer ${token.trim()}`);

				// `authorized_user` (ADC) credentials require quota project header.
				const trimmedApiKey = apiKey.trim();
				if (trimmedApiKey.startsWith('{')) {
					try {
						const credentials = JSON.parse(trimmedApiKey);
						if (credentials.type === 'authorized_user') {
							const userProject = credentials.quota_project_id || projectId;
							headers.set('x-goog-user-project', userProject);
						}
					} catch {
						// Non-JSON key: nothing to do.
					}
				}

				// Vertex expects `anthropic_version` in the body and rejects the `model` field.
				let bodyStr = init?.body;
				if (bodyStr && typeof bodyStr === 'string') {
					try {
						const bodyObj = JSON.parse(bodyStr);
						bodyObj.anthropic_version = 'vertex-2023-10-16';
						delete bodyObj.model;
						bodyStr = JSON.stringify(bodyObj);
					} catch {
						// Non-JSON body: leave alone.
					}
				}

				headers.delete('content-length');
				this._logService.trace(`[VertexAnthropic] POST ${finalUrl}`);

				return fetch(finalUrl, { ...init, headers, body: bodyStr });
			}
		});
	}
}
