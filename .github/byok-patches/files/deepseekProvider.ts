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
import { AbstractOpenAICompatibleLMProvider } from './abstractLanguageModelChatProvider';
import { IBYOKStorageService } from './byokStorageService';

interface DeepSeekModelData {
	id: string;
	object?: string;
}

interface KnownDeepSeekModel {
	name: string;
	maxInputTokens: number;
	maxOutputTokens: number;
	toolCalling: boolean;
}

// DeepSeek V4 context window: 1 M tokens, max output: up to 384 K.
// We advertise 64 K max output as a safe default; users who need more
// can increase via per-model CustomOAI config or a future setting.
const DEFAULT_MAX_INPUT = 1_000_000;
const DEFAULT_MAX_OUTPUT = 64_000;

const KNOWN_MODELS: Record<string, KnownDeepSeekModel> = {
	// Current production models
	'deepseek-v4-pro':   { name: 'DeepSeek V4 Pro',   maxInputTokens: DEFAULT_MAX_INPUT, maxOutputTokens: DEFAULT_MAX_OUTPUT, toolCalling: true  },
	'deepseek-v4-flash': { name: 'DeepSeek V4 Flash', maxInputTokens: DEFAULT_MAX_INPUT, maxOutputTokens: DEFAULT_MAX_OUTPUT, toolCalling: true  },
	// Deprecated aliases (→ deepseek-v4-flash, going away 2026-07-24)
	'deepseek-chat':     { name: 'DeepSeek Chat (→ V4 Flash)', maxInputTokens: DEFAULT_MAX_INPUT, maxOutputTokens: DEFAULT_MAX_OUTPUT, toolCalling: true  },
	'deepseek-reasoner': { name: 'DeepSeek Reasoner (→ V4 Flash)', maxInputTokens: DEFAULT_MAX_INPUT, maxOutputTokens: DEFAULT_MAX_OUTPUT, toolCalling: false },
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

	protected override resolveModelCapabilities(modelData: unknown): BYOKModelCapabilities | undefined {
		const model = modelData as DeepSeekModelData;
		if (!model?.id) {
			return undefined;
		}

		const known = this._lookupKnown(model.id);

		return {
			name:           known?.name     ?? this._humanize(model.id),
			toolCalling:    known?.toolCalling ?? true,
			vision:         false,
			maxInputTokens: known?.maxInputTokens  ?? DEFAULT_MAX_INPUT,
			maxOutputTokens: known?.maxOutputTokens ?? DEFAULT_MAX_OUTPUT,
			// `thinking: false` — DeepSeek's reasoning_content is captured
			// and shown by Patch 53 but MUST NOT be sent back to the API
			// on subsequent turns (causes HTTP 400 per DeepSeek docs).
			thinking: false,
			// `reasoning_effort` maps to 'high' (default) or 'max' on DeepSeek.
			// The existing `_applyReasoningEffort` in openAIEndpoint.ts writes
			// this as a top-level `reasoning_effort` field (chat-completions format).
			supportsReasoningEffort: ['high', 'max'],
		};
	}

	/** Exact-match first, then prefix-match for future model IDs. */
	private _lookupKnown(modelId: string): KnownDeepSeekModel | undefined {
		if (KNOWN_MODELS[modelId]) {
			return KNOWN_MODELS[modelId];
		}
		// e.g. "deepseek-v4-pro-20260601" → prefix matches "deepseek-v4-pro"
		for (const [key, val] of Object.entries(KNOWN_MODELS)) {
			if (modelId.startsWith(key)) {
				return val;
			}
		}
		return undefined;
	}

	private _humanize(modelId: string): string {
		return modelId
			.split('-')
			.map(p => p.charAt(0).toUpperCase() + p.slice(1))
			.join(' ');
	}
}
