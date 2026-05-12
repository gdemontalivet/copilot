// ─── BYOK CUSTOM PATCH: DeepSeek native provider (Patch 55) ─────────────────
// Preserved by .github/scripts/apply-byok-patches.sh. Do not remove.
// Installed at: src/extension/byok/vscode-node/deepseekProvider.ts
//
// DeepSeek V4 is OpenAI-compatible at the wire level but has a few
// important differences that warrant a dedicated provider rather than
// asking users to configure it through CustomOAI:
//
//   1. 1 M token context window (deepseek-v4-flash / deepseek-v4-pro) —
//      CustomOAI defaults to 128 K, so users would see silent truncation.
//   2. Fixed base URL (https://api.deepseek.com) — no manual URL config.
//   3. `reasoning_content` in responses is surfaced as a LanguageModelThinkingPart
//      (via Patch 53) but must NOT be round-tripped back on the next request
//      (per DeepSeek docs: including it causes HTTP 400). Setting
//      `thinking: false` in capabilities tells the serialiser to drop it.
//   4. `reasoning_effort` is `high` (default) / `max` — the existing
//      `_applyReasoningEffort` logic in openAIEndpoint.ts handles this when
//      `supportsReasoningEffort: ['high', 'max']` is declared.
//   5. Known model catalogue avoids a live `/models` round-trip on every
//      picker refresh; the API endpoint is still queried as a fallback so
//      future models (deepseek-v5-*, etc.) appear automatically.
//
// ─────────────────────────────────────────────────────────────────────────────

import { IConfigurationService } from '../../../platform/configuration/common/configurationService';
import { ILogService } from '../../../platform/log/common/logService';
import { IFetcherService } from '../../../platform/networking/common/fetcherService';
import { IExperimentationService } from '../../../platform/telemetry/common/nullExperimentationService';
import { IInstantiationService } from '../../../util/vs/platform/instantiation/common/instantiation';
import { BYOKKnownModels, BYOKModelCapabilities } from '../common/byokProvider';
import { AbstractOpenAICompatibleLMProvider, LanguageModelChatConfiguration, OpenAICompatibleLanguageModelChatInformation } from './abstractLanguageModelChatProvider';
import { byokKnownModelsToAPIInfoWithEffort } from './byokModelInfo';
import { IBYOKStorageService } from './byokStorageService';

interface DeepSeekModelData {
	id: string;
	object?: string;
}

// DeepSeek V4 context window: 1 M tokens, max output: up to 384 K.
// We advertise 64 K max output as a safe default; users who need more
// can set max_tokens per request.
const DEFAULT_MAX_INPUT  = 1_000_000;
const DEFAULT_MAX_OUTPUT = 64_000;

// Shared capability shape used both for the static model list and
// for `resolveModelCapabilities` (API-discovery fallback).
const KNOWN_MODELS: BYOKKnownModels = {
	// Current production models
	'deepseek-v4-pro':   { name: 'DeepSeek V4 Pro',               maxInputTokens: DEFAULT_MAX_INPUT, maxOutputTokens: DEFAULT_MAX_OUTPUT, toolCalling: true,  vision: false, thinking: false, supportsReasoningEffort: ['high', 'max'] },
	'deepseek-v4-flash': { name: 'DeepSeek V4 Flash',             maxInputTokens: DEFAULT_MAX_INPUT, maxOutputTokens: DEFAULT_MAX_OUTPUT, toolCalling: true,  vision: false, thinking: false, supportsReasoningEffort: ['high', 'max'] },
	// Deprecated aliases (→ deepseek-v4-flash, going away 2026-07-24)
	'deepseek-chat':     { name: 'DeepSeek Chat (→ V4 Flash)',    maxInputTokens: DEFAULT_MAX_INPUT, maxOutputTokens: DEFAULT_MAX_OUTPUT, toolCalling: true,  vision: false, thinking: false, supportsReasoningEffort: ['high', 'max'] },
	'deepseek-reasoner': { name: 'DeepSeek Reasoner (→ V4 Flash)', maxInputTokens: DEFAULT_MAX_INPUT, maxOutputTokens: DEFAULT_MAX_OUTPUT, toolCalling: false, vision: false, thinking: false, supportsReasoningEffort: ['high', 'max'] },
};

export class DeepSeekBYOKLMProvider extends AbstractOpenAICompatibleLMProvider {

	public static readonly providerName = 'DeepSeek';
	public static readonly providerId   = 'deepseek';

	constructor(
		knownModels: BYOKKnownModels,
		byokStorageService: IBYOKStorageService,
		@IFetcherService fetcherService: IFetcherService,
		@ILogService logService: ILogService,
		@IInstantiationService instantiationService: IInstantiationService,
		@IConfigurationService configurationService: IConfigurationService,
		@IExperimentationService expService: IExperimentationService,
	) {
		super(
			DeepSeekBYOKLMProvider.providerId,
			DeepSeekBYOKLMProvider.providerName,
			knownModels,
			byokStorageService,
			fetcherService,
			logService,
			instantiationService,
			configurationService,
			expService,
		);
	}

	protected getModelsBaseUrl(): string | undefined {
		return 'https://api.deepseek.com';
	}

	/**
	 * Serve models from the hardcoded table — no live /models API call.
	 *
	 * DeepSeek has a very small, stable model catalogue (2 production models +
	 * 2 deprecated aliases). Bypassing API discovery means:
	 *   - Models appear in the picker immediately, even before the key is set.
	 *   - No 401/format errors during extension startup.
	 *   - No quota burn from the Patch 42 cache-miss window.
	 *
	 * If DeepSeek ever ships a new model that isn't in KNOWN_MODELS, users can
	 * still reach it via the CustomOAI provider until we add it here.
	 */
	protected override async getAllModels(
		_silent: boolean,
		_apiKey: string | undefined,
	): Promise<OpenAICompatibleLanguageModelChatInformation<LanguageModelChatConfiguration>[]> {
		const url = this.getModelsBaseUrl()!;
		return byokKnownModelsToAPIInfoWithEffort(DeepSeekBYOKLMProvider.providerName, KNOWN_MODELS)
			.map(model => ({ ...model, url }));
	}

	/**
	 * Fallback capability resolver used when API discovery is active (e.g. if a
	 * subclass re-enables it). Maps model IDs to the KNOWN_MODELS table first,
	 * then falls back to sensible V4 defaults.
	 */
	protected override resolveModelCapabilities(modelData: unknown): BYOKModelCapabilities | undefined {
		const model = modelData as DeepSeekModelData;
		if (!model?.id) {
			return undefined;
		}
		return KNOWN_MODELS[model.id] ?? this._capabilitiesForUnknown(model.id);
	}

	private _capabilitiesForUnknown(modelId: string): BYOKModelCapabilities {
		// Prefix-match: e.g. "deepseek-v4-pro-20260601" → deepseek-v4-pro defaults
		for (const [key, caps] of Object.entries(KNOWN_MODELS)) {
			if (modelId.startsWith(key)) {
				return { ...caps, name: this._humanize(modelId) };
			}
		}
		return {
			name: this._humanize(modelId),
			toolCalling: true,
			vision: false,
			maxInputTokens: DEFAULT_MAX_INPUT,
			maxOutputTokens: DEFAULT_MAX_OUTPUT,
			thinking: false,
			supportsReasoningEffort: ['high', 'max'],
		};
	}

	private _humanize(modelId: string): string {
		return modelId
			.split('-')
			.map(p => p.charAt(0).toUpperCase() + p.slice(1))
			.join(' ');
	}
}
