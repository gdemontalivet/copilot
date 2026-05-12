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

import { CancellationToken, LanguageModelChatMessage, LanguageModelChatMessage2, LanguageModelResponsePart2, LanguageModelTextPart, LanguageModelToolCallPart, Progress, ProvideLanguageModelChatResponseOptions } from 'vscode';
import { IConfigurationService } from '../../../platform/configuration/common/configurationService';
import { ILogService } from '../../../platform/log/common/logService';
import { IFetcherService } from '../../../platform/networking/common/fetcherService';
import { IExperimentationService } from '../../../platform/telemetry/common/nullExperimentationService';
import { IInstantiationService } from '../../../util/vs/platform/instantiation/common/instantiation';
import { BYOKKnownModels, BYOKModelCapabilities } from '../common/byokProvider';
import { DsmlToolCallStripper } from '../common/dsmlToolCallStripper';
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
	 * Override the response handler to install a streaming DSML sanitizer
	 * between the OpenAI-compatible stream and the VS Code progress
	 * reporter. DeepSeek V4 has a known server-side bug
	 * (vllm-project/vllm#40801) where in ~11% of `tool_choice=auto`
	 * + `stream=true` requests, the model's native DSML tool-call tokens
	 * leak into `delta.content` as plain text instead of being parsed
	 * into structured `tool_calls`. Without this wrapper, the agent loop
	 * treats the markup as an assistant message and the tool calls are
	 * never executed — the user sees raw `<｜｜DSML｜｜tool_calls>…` in chat.
	 *
	 * The wrapped progress reporter:
	 *   1. Forwards thinking parts, real tool-call parts, and any other
	 *      non-text parts unchanged.
	 *   2. Feeds incoming text-part deltas through `DsmlToolCallStripper`,
	 *      which emits sanitized text and any structured tool calls
	 *      extracted from DSML markup as separate parts.
	 *
	 * Stripper state is per-request — a fresh instance per
	 * `provideLanguageModelChatResponse` invocation — so concurrent
	 * requests never share buffers.
	 */
	override async provideLanguageModelChatResponse(
		model: OpenAICompatibleLanguageModelChatInformation<LanguageModelChatConfiguration>,
		messages: Array<LanguageModelChatMessage | LanguageModelChatMessage2>,
		options: ProvideLanguageModelChatResponseOptions,
		progress: Progress<LanguageModelResponsePart2>,
		token: CancellationToken,
	): Promise<void> {
		const stripper = new DsmlToolCallStripper();
		const wrappedProgress: Progress<LanguageModelResponsePart2> = {
			report: (part: LanguageModelResponsePart2) => {
				if (part instanceof LanguageModelTextPart) {
					const { text, calls } = stripper.process(part.value);
					if (text) {
						progress.report(new LanguageModelTextPart(text));
					}
					for (const call of calls) {
						progress.report(new LanguageModelToolCallPart(call.id, call.name, call.args));
					}
					return;
				}
				progress.report(part);
			},
		};
		try {
			await super.provideLanguageModelChatResponse(model, messages, options, wrappedProgress, token);
		} finally {
			const tail = stripper.flush();
			if (tail.text) {
				progress.report(new LanguageModelTextPart(tail.text));
			}
			for (const call of tail.calls) {
				progress.report(new LanguageModelToolCallPart(call.id, call.name, call.args));
			}
		}
	}

	/**
	 * Serve models from the hardcoded table — no live /models API call.
	 *
	 * Mirrors the base-class `getModelsFromEndpoint` guard (`if (!apiKey && silent)`)
	 * so the behaviour is:
	 *   - Background refresh, no key  → empty (models don't clutter the picker)
	 *   - User opens Add Models, no key → return catalogue (VS Code can prompt for key)
	 *   - Any call with a key          → return catalogue immediately, no network call
	 */
	protected override async getAllModels(
		silent: boolean,
		apiKey: string | undefined,
	): Promise<OpenAICompatibleLanguageModelChatInformation<LanguageModelChatConfiguration>[]> {
		if (!apiKey && silent) {
			return [];
		}
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
