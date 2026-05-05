/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { GoogleGenAI } from '@google/genai';
import { ConfigKey, IConfigurationService } from '../../../platform/configuration/common/configurationService';
import { ILogService } from '../../../platform/log/common/logService';
import { IOTelService } from '../../../platform/otel/common/otelService';
import { IRequestLogger } from '../../../platform/requestLogger/common/requestLogger';
import { ITelemetryService } from '../../../platform/telemetry/common/telemetry';
import { BYOKKnownModels, byokKnownModelToAPIInfo } from '../common/byokProvider';
import { ExtendedLanguageModelChatInformation, LanguageModelChatConfiguration } from './abstractLanguageModelChatProvider';
import { IBYOKStorageService } from './byokStorageService';
import { GeminiNativeBYOKLMProvider } from './geminiNativeProvider';

/**
 * A single Vertex-hosted Gemini model configuration, as defined in the
 * `github.copilot.chat.vertexGeminiModels` user setting or per-group
 * `configuration.models` array in `chatLanguageModels.json`.
 */
export interface VertexGeminiModelConfig {
	name: string;
	projectId: string;
	locationId: string;
	maxInputTokens?: number;
	maxOutputTokens?: number;
	/**
	 * Override the default vision capability for this model. When omitted,
	 * vision defaults to whatever the known-models table says (true for every
	 * modern Gemini).
	 */
	vision?: boolean;
}

export interface VertexGeminiProviderConfig extends LanguageModelChatConfiguration {
	models?: (VertexGeminiModelConfig & { id: string })[];
}

// Sensible context defaults per https://ai.google.dev/gemini-api/docs/models and
// https://cloud.google.com/vertex-ai/generative-ai/docs/learn/models. Mirrors
// the per-family capability table we use in `vertexAnthropicProvider.ts` — the
// upstream VS Code LM API treats `maxInputTokens` as a hard cap and drives the
// chat UI context-window indicator off it, so under-reporting the window
// fires auto-compaction too early and over-reports a "full" ring.
const DEFAULT_VERTEX_GEMINI_MAX_INPUT_TOKENS = 1_000_000;
const DEFAULT_VERTEX_GEMINI_MAX_OUTPUT_TOKENS = 8_192;
interface KnownVertexGeminiModel { maxInputTokens: number; maxOutputTokens: number; vision: boolean }
const KNOWN_VERTEX_GEMINI_MODELS: Record<string, KnownVertexGeminiModel> = {
	// ─── Gemini 3.x ─────────────────────────────────────────────────────────
	'gemini-3-pro': { maxInputTokens: 1_000_000, maxOutputTokens: 64_000, vision: true },
	'gemini-3.1-pro': { maxInputTokens: 1_000_000, maxOutputTokens: 64_000, vision: true },
	'gemini-3.1-flash': { maxInputTokens: 1_000_000, maxOutputTokens: 64_000, vision: true },
	// ─── Gemini 2.x ─────────────────────────────────────────────────────────
	'gemini-2.5-pro': { maxInputTokens: 2_000_000, maxOutputTokens: 64_000, vision: true },
	'gemini-2.5-flash': { maxInputTokens: 1_000_000, maxOutputTokens: 64_000, vision: true },
	'gemini-2.5-flash-lite': { maxInputTokens: 1_000_000, maxOutputTokens: 64_000, vision: true },
	'gemini-2.0-flash': { maxInputTokens: 1_000_000, maxOutputTokens: 8_192, vision: true },
	'gemini-2.0-flash-lite': { maxInputTokens: 1_000_000, maxOutputTokens: 8_192, vision: true },
	// ─── Gemini 1.5 legacy ──────────────────────────────────────────────────
	'gemini-1.5-pro': { maxInputTokens: 2_000_000, maxOutputTokens: 8_192, vision: true },
	'gemini-1.5-flash': { maxInputTokens: 1_000_000, maxOutputTokens: 8_192, vision: true },
};

interface ResolvedVertexGeminiLimits { maxInputTokens: number; maxOutputTokens: number; vision: boolean }
function resolveVertexGeminiLimits(modelId: string, cfg: { maxInputTokens?: number; maxOutputTokens?: number; vision?: boolean }): ResolvedVertexGeminiLimits {
	// Strip Vertex's `@YYYYMMDD` pinned-revision suffix and any `-preview*` /
	// `-experimental*` qualifier so `gemini-3.1-pro-preview-20260130` matches
	// the `gemini-3.1-pro` known entry. Longest-prefix wins so
	// `gemini-2.5-pro` hits the 2.5 entry rather than the bare `gemini-2-`.
	const stripped = modelId
		.replace(/@.*$/, '')
		.replace(/-(preview|experimental|exp).*$/, '');
	let known: KnownVertexGeminiModel | undefined;
	let bestPrefix = '';
	for (const [prefix, limits] of Object.entries(KNOWN_VERTEX_GEMINI_MODELS)) {
		if ((stripped === prefix || stripped.startsWith(`${prefix}-`) || stripped.startsWith(`${prefix}_`)) && prefix.length > bestPrefix.length) {
			known = limits;
			bestPrefix = prefix;
		}
	}
	return {
		maxInputTokens: cfg.maxInputTokens ?? known?.maxInputTokens ?? DEFAULT_VERTEX_GEMINI_MAX_INPUT_TOKENS,
		maxOutputTokens: cfg.maxOutputTokens ?? known?.maxOutputTokens ?? DEFAULT_VERTEX_GEMINI_MAX_OUTPUT_TOKENS,
		// Gemini is natively multimodal; default-on is safe.
		vision: cfg.vision ?? known?.vision ?? true,
	};
}

/**
 * Routes Gemini requests through Google Cloud Vertex AI
 * (`{location}-aiplatform.googleapis.com`) instead of the public Gemini API
 * (`generativelanguage.googleapis.com`). Useful when a team's quota / billing
 * lives on GCP, or when an org has disabled the public generative-language
 * endpoint but retained Vertex AI access.
 *
 * Auth: the user's "API key" for this provider is either:
 *   - A Google Cloud service-account JSON (full credentials object as a string), or
 *   - A pre-fetched OAuth 2.0 Bearer access token
 *
 * Models: configured either via the `chat.vertexGeminiModels` user setting
 * (keyed by Vertex model id, e.g. `gemini-3.1-pro-preview`) or via the
 * per-group `models` array inside `chatLanguageModels.json`.
 *
 * Built on top of {@link GeminiNativeBYOKLMProvider} — we only override the
 * client-construction hook + the model-discovery pathway, everything else
 * (streaming, OTel telemetry, retry-on-429/503, readable errors) is inherited
 * unchanged.
 */
export class VertexGeminiLMProvider extends GeminiNativeBYOKLMProvider {

	public static override readonly providerName: string = 'VertexGemini';

	constructor(
		knownModels: BYOKKnownModels | undefined,
		byokStorageService: IBYOKStorageService,
		@ILogService logService: ILogService,
		@IRequestLogger requestLogger: IRequestLogger,
		@ITelemetryService telemetryService: ITelemetryService,
		@IOTelService otelService: IOTelService,
		@IConfigurationService private readonly _configurationService: IConfigurationService,
	) {
		super(knownModels, byokStorageService, logService, requestLogger, telemetryService, otelService);
		// The base class captures the Gemini providerName in its constructor; rebind so VS Code groups and
		// BYOK storage use the correct vendor for this subclass.
		(this as unknown as { _name: string })._name = VertexGeminiLMProvider.providerName;
		(this as unknown as { _id: string })._id = VertexGeminiLMProvider.providerName.toLowerCase();
	}

	protected override createClient(apiKey: string, model: ExtendedLanguageModelChatInformation<LanguageModelChatConfiguration>): GoogleGenAI {
		const vertexModel = model as ExtendedLanguageModelChatInformation<VertexGeminiProviderConfig>;
		const vertexModelId = (vertexModel as unknown as { id: string }).id;
		const modelConfig = vertexModel.configuration?.models?.find(m => m.id === vertexModelId);
		if (!modelConfig) {
			throw new Error(`Configuration not found for Vertex Gemini model ${vertexModelId}`);
		}

		const { projectId, locationId } = modelConfig;
		const trimmedApiKey = apiKey.trim();

		// Case 1: service-account JSON — let google-auth-library handle
		// token minting, refresh, and the `x-goog-user-project` quota header.
		if (trimmedApiKey.startsWith('{')) {
			let credentials: Record<string, unknown>;
			try {
				credentials = JSON.parse(trimmedApiKey);
			} catch (e) {
				this._logService.error(`[VertexGemini] Failed to parse credentials JSON: ${e}`);
				throw new Error('Invalid Vertex Gemini credentials: expected a service-account JSON object.');
			}
			this._logService.trace(`[VertexGemini] Using SA credentials (type: ${credentials.type ?? 'unknown'}) for ${vertexModelId} @ ${locationId}`);
			return new GoogleGenAI({
				vertexai: true,
				project: projectId,
				location: locationId,
				googleAuthOptions: {
					credentials: credentials as any, // CredentialBody shape validated by the SDK
					scopes: ['https://www.googleapis.com/auth/cloud-platform'],
					projectId: (credentials.project_id as string | undefined) || (credentials.quota_project_id as string | undefined) || projectId,
				},
			});
		}

		// Case 2: raw Bearer access token (already minted, e.g. via `gcloud
		// auth print-access-token`). Inject as an HTTP header and disable the
		// SDK's default ADC lookup by passing a no-op `googleAuthOptions`.
		this._logService.trace(`[VertexGemini] Using pre-minted Bearer token for ${vertexModelId} @ ${locationId}`);
		return new GoogleGenAI({
			vertexai: true,
			project: projectId,
			location: locationId,
			httpOptions: {
				headers: {
					Authorization: `Bearer ${trimmedApiKey}`,
				},
			},
		});
	}

	protected override async getAllModels(silent: boolean, apiKey: string | undefined, configuration?: VertexGeminiProviderConfig | undefined): Promise<ExtendedLanguageModelChatInformation<VertexGeminiProviderConfig>[]> {
		// Prefer per-group `configuration.models` (VS Code LM group config). Fall back to the global
		// `chat.vertexGeminiModels` setting so users who only edit settings still see models.
		let modelConfigs = configuration?.models;
		if (!modelConfigs || modelConfigs.length === 0) {
			const settingMap = this._configurationService.getConfig(ConfigKey.VertexGeminiModels) ?? {};
			modelConfigs = Object.entries(settingMap).map(([id, cfg]) => ({ id, ...cfg }));
		}

		if (!modelConfigs || modelConfigs.length === 0) {
			return [];
		}

		const models: ExtendedLanguageModelChatInformation<VertexGeminiProviderConfig>[] = [];
		for (const modelConfig of modelConfigs) {
			const modelId = modelConfig.id;
			const { maxInputTokens, maxOutputTokens, vision } = resolveVertexGeminiLimits(modelId, modelConfig);
			models.push({
				...byokKnownModelToAPIInfo(this._name, modelId, {
					name: modelConfig.name || modelId,
					maxInputTokens,
					maxOutputTokens,
					toolCalling: true,
					vision,
				}),
				configuration: {
					models: [{ ...modelConfig }],
				},
			});
		}
		return models;
	}
}
