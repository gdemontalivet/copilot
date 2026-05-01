/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import Anthropic from '@anthropic-ai/sdk';
import * as vscode from 'vscode';
import { CancellationToken, LanguageModelChatInformation, LanguageModelChatMessage, LanguageModelChatMessage2, LanguageModelDataPart, LanguageModelResponsePart2, LanguageModelTextPart, LanguageModelThinkingPart, LanguageModelToolCallPart, LanguageModelToolResultPart, Progress, ProvideLanguageModelChatResponseOptions } from 'vscode';
import { ChatFetchResponseType, ChatLocation } from '../../../platform/chat/common/commonTypes';
import { ConfigKey, IConfigurationService } from '../../../platform/configuration/common/configurationService';
import { CustomDataPartMimeTypes } from '../../../platform/endpoint/common/endpointTypes';
import { modelSupportsToolSearch } from '../../../platform/endpoint/common/chatModelCapabilities';
import { buildToolInputSchema } from '../../../platform/endpoint/node/messagesApi';
import { ILogService } from '../../../platform/log/common/logService';
import { ContextManagementResponse, CUSTOM_TOOL_SEARCH_NAME, getContextManagementFromConfig, isAnthropicContextEditingEnabled, isAnthropicMemoryToolEnabled } from '../../../platform/networking/common/anthropic';
import { IToolDeferralService } from '../../../platform/networking/common/toolDeferralService';
import { IResponseDelta, OpenAiFunctionTool } from '../../../platform/networking/common/fetch';
import { APIUsage } from '../../../platform/networking/common/openai';
import { CopilotChatAttr, emitInferenceDetailsEvent, GenAiAttr, GenAiMetrics, GenAiOperationName, GenAiProviderName, type OTelModelOptions, StdAttr, toToolDefinitions, truncateForOTel } from '../../../platform/otel/common/index';
import { IOTelService, SpanKind, SpanStatusCode } from '../../../platform/otel/common/otelService';
import { IRequestLogger } from '../../../platform/requestLogger/common/requestLogger';
import { retrieveCapturingTokenByCorrelation, runWithCapturingToken } from '../../../platform/requestLogger/node/requestLogger';
import { IExperimentationService } from '../../../platform/telemetry/common/nullExperimentationService';
import { ITelemetryService } from '../../../platform/telemetry/common/telemetry';
import { toErrorMessage } from '../../../util/common/errorMessage';
import { RecordedProgress } from '../../../util/common/progressRecorder';
import { generateUuid } from '../../../util/vs/base/common/uuid';
import { anthropicMessagesToRawMessagesForLogging, apiMessageToAnthropicMessage } from '../common/anthropicMessageConverter';
import { anthropicPrimaryPool, classifyAnthropicError, DeferredProgress, isFailoverTrigger, keyFingerprint } from '../common/byokFailover';
import { BYOKKnownModels, BYOKModelCapabilities, LMResponsePart } from '../common/byokProvider';
import { AbstractLanguageModelChatProvider, ExtendedLanguageModelChatInformation, LanguageModelChatConfiguration } from './abstractLanguageModelChatProvider';
import { byokKnownModelsToAPIInfoWithEffort } from './byokModelInfo';
import { IBYOKStorageService } from './byokStorageService';

export interface IAnthropicFailoverTarget {
	resolveFailoverModel(primaryModelId: string): Promise<ExtendedLanguageModelChatInformation<LanguageModelChatConfiguration> | undefined>;
	provideLanguageModelChatResponse(model: ExtendedLanguageModelChatInformation<LanguageModelChatConfiguration>, messages: Array<LanguageModelChatMessage | LanguageModelChatMessage2>, options: ProvideLanguageModelChatResponseOptions, progress: Progress<LanguageModelResponsePart2>, token: CancellationToken): Promise<void>;
}

// ─── BYOK CUSTOM PATCH: readable Anthropic errors ─────────────────────
// Preserved by .github/scripts/apply-byok-patches.sh. Do not remove.
// Anthropic (and Vertex-routed Anthropic) errors arrive with `.message` set
// to the raw JSON body, e.g.
//   `{"type":"error","error":{"type":"overloaded_error","message":"Overloaded"},"request_id":"..."}`
// Surfacing that directly in chat produces the illegible "Reason: {...}:
// Error: {...}" format users see today. Extract the nested
// `error.message` + `error.type` so the chat UI shows "Overloaded
// (overloaded_error)" instead of the JSON blob.
export function extractReadableAnthropicMessage(err: unknown): string {
	const raw = err instanceof Error ? err.message : typeof err === 'string' ? err : undefined;
	if (raw) {
		const jsonStart = raw.indexOf('{');
		if (jsonStart >= 0) {
			const jsonSlice = raw.slice(jsonStart);
			try {
				const parsed = JSON.parse(jsonSlice);
				const innerMsg = parsed?.error?.message ?? parsed?.message;
				const innerType = parsed?.error?.type ?? parsed?.type;
				if (innerMsg) {
					return innerType && typeof innerType === 'string' && innerType !== 'error'
						? `${innerMsg} (${innerType})`
						: String(innerMsg);
				}
			} catch {
				// Not JSON, fall through.
			}
		}
		// Drop anything after the first newline — Anthropic sometimes appends a
		// full stack trace, which is noise for the chat UI.
		const firstLine = raw.split('\n', 1)[0];
		if (firstLine && firstLine.length > 0) {
			return firstLine;
		}
	}
	return toErrorMessage(err, false);
}
// ─── END BYOK CUSTOM PATCH ─────────────────────────────────────────

// ─── BYOK CUSTOM PATCH: Anthropic retry resilience ──────────────────
// Preserved by .github/scripts/apply-byok-patches.sh. Do not remove.
// Classify Anthropic SDK / transport errors as retryable. Returns a label
// used in progress messages, or null if the error is terminal.
//
// Anthropic status codes we treat as retryable:
//   429 — rate limit / TPM throttle
//   502 — bad gateway (transient upstream glitch)
//   503 — service unavailable
//   504 — gateway timeout
//   529 — "Overloaded" (Anthropic-specific capacity signal)
//   other 5xx — general server error
// Plus any Anthropic.APIConnectionError / APIConnectionTimeoutError and
// node-level transient codes (ECONNRESET, ETIMEDOUT, UND_ERR_SOCKET, ...).
//
// We do NOT retry 400/401/403/404/422 — those are request-level problems
// that won't resolve with another attempt.
export function classifyRetryableAnthropicError(err: unknown): 'overloaded' | 'rate-limit' | 'unavailable' | 'server-error' | 'network' | null {
	if (err === undefined || err === null) { return null; }

	if (err instanceof Anthropic.APIConnectionTimeoutError || err instanceof Anthropic.APIConnectionError) {
		return 'network';
	}
	if (err instanceof Anthropic.RateLimitError) { return 'rate-limit'; }
	if (err instanceof Anthropic.InternalServerError) { return 'server-error'; }
	if (err instanceof Anthropic.APIError) {
		const status = (err as { status?: number }).status ?? 0;
		if (status === 529) { return 'overloaded'; }
		if (status === 429) { return 'rate-limit'; }
		if (status === 502 || status === 503 || status === 504) { return 'unavailable'; }
		if (status >= 500) { return 'server-error'; }
		return null;
	}

	// Non-SDK errors (VertexAnthropic's custom fetch or Node transport errors).
	const e = err as { code?: string; cause?: { code?: string }; message?: string; status?: number };
	const code = typeof e.code === 'string' ? e.code : (typeof e.cause?.code === 'string' ? e.cause.code : undefined);
	const transientCodes = new Set(['ECONNRESET', 'ETIMEDOUT', 'EAI_AGAIN', 'ECONNREFUSED', 'ENETUNREACH', 'EHOSTUNREACH', 'UND_ERR_SOCKET', 'UND_ERR_CONNECT_TIMEOUT']);
	if (code && transientCodes.has(code)) { return 'network'; }

	const msg = typeof e.message === 'string' ? e.message.toLowerCase() : '';
	// Match the common overloaded_error payload inside err.message.
	if (msg.includes('overloaded_error') || msg.includes('"overloaded"')) { return 'overloaded'; }
	if (typeof e.status === 'number') {
		if (e.status === 529) { return 'overloaded'; }
		if (e.status === 429) { return 'rate-limit'; }
		if (e.status === 502 || e.status === 503 || e.status === 504) { return 'unavailable'; }
		if (e.status >= 500) { return 'server-error'; }
	}
	if (/fetch failed|network error|timed? ?out|socket hang up/.test(msg)) { return 'network'; }
	return null;
}
// ─── END BYOK CUSTOM PATCH ─────────────────────────────────────────

export class AnthropicLMProvider extends AbstractLanguageModelChatProvider {

	// BYOK CUSTOM PATCH — optional sibling provider (Vertex) used as a failover target.
	private _failoverTarget: IAnthropicFailoverTarget | undefined;
	setFailoverTarget(target: IAnthropicFailoverTarget | undefined): void { this._failoverTarget = target; }

	// Typed as `string` so subclasses (VertexAnthropicLMProvider) can override.
	public static readonly providerName: string = 'Anthropic';

	constructor(
		knownModels: BYOKKnownModels | undefined,
		byokStorageService: IBYOKStorageService,
		@ILogService logService: ILogService,
		@IRequestLogger private readonly _requestLogger: IRequestLogger,
		@IConfigurationService protected readonly _configurationService: IConfigurationService,
		@IExperimentationService private readonly _experimentationService: IExperimentationService,
		@ITelemetryService private readonly _telemetryService: ITelemetryService,
		@IOTelService private readonly _otelService: IOTelService,
		@IToolDeferralService private readonly _toolDeferralService: IToolDeferralService,
	) {
		super(AnthropicLMProvider.providerName.toLowerCase(), AnthropicLMProvider.providerName, knownModels, byokStorageService, logService);

	}

	private _getThinkingBudget(modelId: string, maxOutputTokens: number): number | undefined {
		const modelCapabilities = this._knownModels?.[modelId];
		const modelSupportsThinking = modelCapabilities?.thinking ?? false;
		if (!modelSupportsThinking) {
			return undefined;
		}
		return Math.min(32000, maxOutputTokens - 1, 16000);
	}

	// ─── BYOK CUSTOM PATCH: anthropic known-models capability fallback ────────
	// Preserved by .github/scripts/apply-byok-patches.sh. Do not remove.
	// Upstream's generic fallback for models missing from `_knownModels`
	// hard-codes `maxInputTokens: 100000`, `vision: false`, `thinking: false`.
	// Under the BYOK fake-token bypass `_knownModels` is almost always empty
	// (the list is fetched from GitHub and filtered by Copilot subscription),
	// so every Anthropic model falls through to that fallback and the user
	// sees "vision is not supported by the current model" even when chatting
	// with Claude Opus 4.6 which natively accepts images. Consult a small
	// per-model-family capability table first.
	private static readonly _KNOWN_ANTHROPIC_CAPABILITIES: Record<string, { maxInputTokens: number; maxOutputTokens: number; vision: boolean; thinking: boolean }> = {
		'claude-opus-4-6': { maxInputTokens: 200_000, maxOutputTokens: 32_000, vision: true, thinking: true },
		'claude-opus-4-5': { maxInputTokens: 200_000, maxOutputTokens: 32_000, vision: true, thinking: true },
		'claude-opus-4': { maxInputTokens: 200_000, maxOutputTokens: 32_000, vision: true, thinking: true },
		'claude-sonnet-4-5': { maxInputTokens: 200_000, maxOutputTokens: 64_000, vision: true, thinking: true },
		'claude-sonnet-4': { maxInputTokens: 200_000, maxOutputTokens: 64_000, vision: true, thinking: true },
		'claude-3-7-sonnet': { maxInputTokens: 200_000, maxOutputTokens: 64_000, vision: true, thinking: true },
		'claude-3-5-sonnet': { maxInputTokens: 200_000, maxOutputTokens: 8_192, vision: true, thinking: false },
		// Claude 3.5 Haiku is the one modern Claude that does NOT accept images.
		'claude-3-5-haiku': { maxInputTokens: 200_000, maxOutputTokens: 8_192, vision: false, thinking: false },
		'claude-3-opus': { maxInputTokens: 200_000, maxOutputTokens: 4_096, vision: true, thinking: false },
		'claude-3-haiku': { maxInputTokens: 200_000, maxOutputTokens: 4_096, vision: true, thinking: false },
	};
	private _resolveAnthropicCapabilities(modelId: string): { maxInputTokens: number; maxOutputTokens: number; vision: boolean; thinking: boolean } | undefined {
		// Claude API IDs usually carry a `-YYYYMMDD` date suffix
		// (e.g. `claude-sonnet-4-5-20250629`). Longest-prefix match so
		// `claude-3-5-sonnet-…` matches the 3.5 entry rather than `claude-3-…`.
		let best: { maxInputTokens: number; maxOutputTokens: number; vision: boolean; thinking: boolean } | undefined;
		let bestPrefix = '';
		for (const [prefix, caps] of Object.entries(AnthropicLMProvider._KNOWN_ANTHROPIC_CAPABILITIES)) {
			if ((modelId === prefix || modelId.startsWith(`${prefix}-`) || modelId.startsWith(`${prefix}@`) || modelId.startsWith(`${prefix}_`)) && prefix.length > bestPrefix.length) {
				best = caps;
				bestPrefix = prefix;
			}
		}
		return best;
	}
	// ─── END BYOK CUSTOM PATCH ────────────────────────────────────────────────

	// Filters the byok known models based on what the anthropic API knows as well
	protected async getAllModels(silent: boolean, apiKey: string | undefined): Promise<ExtendedLanguageModelChatInformation<LanguageModelChatConfiguration>[]> {
		if (!apiKey && silent) {
			return [];
		}

		try {
			const response = await new Anthropic({ apiKey }).models.list();
			const modelList: Record<string, BYOKModelCapabilities> = {};
			for (const model of response.data) {
				if (this._knownModels && this._knownModels[model.id]) {
					modelList[model.id] = this._knownModels[model.id];
				} else {
					// ─── BYOK CUSTOM PATCH: vision-aware generic fallback ──────────
					// Preserved by .github/scripts/apply-byok-patches.sh. Do not remove.
					// Consult the static known-capability table first; fall back to
					// a safe generic entry only if the model family is unrecognised.
					const known = this._resolveAnthropicCapabilities(model.id);
					modelList[model.id] = known
						? {
							maxInputTokens: known.maxInputTokens,
							maxOutputTokens: known.maxOutputTokens,
							name: model.display_name,
							toolCalling: true,
							vision: known.vision,
							thinking: known.thinking,
						}
						: {
							maxInputTokens: 200_000,
							maxOutputTokens: 16_000,
							name: model.display_name,
							toolCalling: true,
							// Modern Claude is multimodal by default; the cost of a
							// false positive (a 400 on image input against a text-only
							// model Anthropic ships later) is far lower than the false
							// negative ("vision is not supported") users hit today.
							vision: true,
							thinking: false,
						};
					// ─── END BYOK CUSTOM PATCH ──────────────────────────────────────
				}
			}
			return byokKnownModelsToAPIInfoWithEffort(this._name, modelList);
		} catch (error) {
			this._logService.error(error, `Error fetching available ${AnthropicLMProvider.providerName} models`);
			throw new Error(error.message ? error.message : error);
		}
	}

	/** Hook for subclasses (e.g. Vertex) to replace the Anthropic client. */
	protected createClient(apiKey: string, _model: ExtendedLanguageModelChatInformation<LanguageModelChatConfiguration>): Anthropic {
		return new Anthropic({ apiKey });
	}

	async provideLanguageModelChatResponse(model: ExtendedLanguageModelChatInformation<LanguageModelChatConfiguration>, messages: Array<LanguageModelChatMessage | LanguageModelChatMessage2>, options: ProvideLanguageModelChatResponseOptions, progress: Progress<LanguageModelResponsePart2>, token: CancellationToken): Promise<void> {
		const failoverEnabled = !!this._failoverTarget
			&& this._configurationService.getConfig(ConfigKey.ByokAnthropicFallbackEnabled);
		if (!failoverEnabled) {
			return this._doProvideLanguageModelChatResponse(model, messages, options, progress, token);
		}
		anthropicPrimaryPool.configure(
			this._configurationService.getConfig(ConfigKey.ByokAnthropicMaxConcurrency),
			this._configurationService.getConfig(ConfigKey.ByokAnthropicCooldownSeconds) * 1000,
		);
		const fingerprint = keyFingerprint(model.configuration?.apiKey);
		const runSecondary = async (reason: string) => {
			const target = this._failoverTarget!;
			const secondaryModel = await target.resolveFailoverModel(model.id);
			if (!secondaryModel) {
				this._logService.warn(`[BYOK failover] No Vertex fallback configured for ${model.id}; surfacing primary error.`);
				throw new Error(`Anthropic failover requested (${reason}) but no Vertex fallback is configured for ${model.id}`);
			}
			this._logService.info(`[BYOK failover] Routing ${model.id} via VertexAnthropic (${reason}).`);
			return target.provideLanguageModelChatResponse(secondaryModel, messages, options, progress, token);
		};
		if (anthropicPrimaryPool.shouldSkipPrimary(fingerprint)) { return runSecondary('circuit-open'); }
		const deferred = new DeferredProgress<LanguageModelResponsePart2>(progress);
		anthropicPrimaryPool.acquireSlot(fingerprint);
		try {
			const commitOnFirstReport: Progress<LanguageModelResponsePart2> = {
				report: value => { if (!deferred.hasCommitted()) { deferred.commit(); } deferred.report(value); },
			};
			await this._doProvideLanguageModelChatResponse(model, messages, options, commitOnFirstReport, token);
			anthropicPrimaryPool.recordSuccess(fingerprint);
			if (!deferred.hasCommitted()) { deferred.commit(); }
		} catch (err) {
			const classification = classifyAnthropicError(err);
			anthropicPrimaryPool.recordFailure(fingerprint, classification);
			if (isFailoverTrigger(classification) && !deferred.hasCommitted()) {
				deferred.discard();
				return runSecondary(classification);
			}
			deferred.commit();
			throw err;
		} finally {
			anthropicPrimaryPool.releaseSlot(fingerprint);
		}
	}

	private async _doProvideLanguageModelChatResponse(model: ExtendedLanguageModelChatInformation<LanguageModelChatConfiguration>, messages: Array<LanguageModelChatMessage | LanguageModelChatMessage2>, options: ProvideLanguageModelChatResponseOptions, progress: Progress<LanguageModelResponsePart2>, token: CancellationToken): Promise<void> {
		// Restore CapturingToken context if correlation ID was passed through modelOptions.
		// This handles the case where AsyncLocalStorage context was lost crossing VS Code IPC.
		const correlationId = (options as { modelOptions?: OTelModelOptions }).modelOptions?._capturingTokenCorrelationId;
		const capturingToken = correlationId ? retrieveCapturingTokenByCorrelation(correlationId) : undefined;

		// Restore OTel trace context to link spans back to the agent trace
		const parentTraceContext = (options as { modelOptions?: OTelModelOptions }).modelOptions?._otelTraceContext ?? undefined;

		// OTel span handle — created outside doRequest, enriched inside with usage data
		let otelSpan: ReturnType<typeof this._otelService.startSpan> | undefined;

		const doRequest = async () => {
			const issuedTime = Date.now();
			const apiKey = model.configuration?.apiKey;
			if (!apiKey) {
				throw new Error('API key not found for the model');
			}

			const anthropicClient = this.createClient(apiKey, model);

			// Convert the messages from the API format into messages that we can use against anthropic
			const { system, messages: convertedMessages } = apiMessageToAnthropicMessage(messages as LanguageModelChatMessage[]);

			const requestId = generateUuid();
			const pendingLoggedChatRequest = this._requestLogger.logChatRequest(
				'AnthropicBYOK',
				{
					model: model.id,
					modelMaxPromptTokens: model.maxInputTokens,
					urlOrRequestMetadata: anthropicClient.baseURL,
				},
				{
					model: model.id,
					messages: anthropicMessagesToRawMessagesForLogging(convertedMessages, system),
					ourRequestId: requestId,
					location: ChatLocation.Other,
					body: {
						tools: options.tools?.map((tool): OpenAiFunctionTool => ({
							type: 'function',
							function: {
								name: tool.name,
								description: tool.description,
								parameters: tool.inputSchema
							}
						}))
					},
				});

			const memoryToolEnabled = isAnthropicMemoryToolEnabled(model.id, this._configurationService, this._experimentationService);

			// Requires the client-side tool_search tool in the request: without it, defer-loaded tools can't be retrieved.
			// If the user disables tool_search in the tool picker, it won't be present here and tool search is skipped.
			const toolSearchEnabled = modelSupportsToolSearch(model.id)
				&& !!options.tools?.some(t => t.name === CUSTOM_TOOL_SEARCH_NAME);

			// Build tools array, handling both standard tools and native Anthropic tools
			const tools: Anthropic.Beta.BetaToolUnion[] = [];

			let hasMemoryTool = false;
			for (const tool of (options.tools ?? [])) {
				// Handle native Anthropic memory tool (only for models that support it)
				if (tool.name === 'memory' && memoryToolEnabled) {

					hasMemoryTool = true;
					tools.push({
						name: 'memory',
						type: 'memory_20250818'
					} as Anthropic.Beta.BetaMemoryTool20250818);
					continue;
				}

				// Mark tools for deferred loading when tool search is enabled, except for frequently used tools
				const shouldDefer = toolSearchEnabled ? !this._toolDeferralService.isNonDeferredTool(tool.name) : undefined;

				if (!tool.inputSchema) {
					tools.push({
						name: tool.name,
						description: tool.description,
						input_schema: {
							type: 'object',
							properties: {},
							required: []
						},
						...(shouldDefer ? { defer_loading: shouldDefer } : {})
					});
					continue;
				}

				tools.push({
					name: tool.name,
					description: tool.description,
					input_schema: buildToolInputSchema(tool.inputSchema as Record<string, unknown>),
					...(shouldDefer ? { defer_loading: shouldDefer } : {})
				});
			}

			// Check if web search is enabled and append web_search tool if not already present.
			// We need to do this because there is no local web_search tool definition we can replace.
			const webSearchEnabled = this._configurationService.getExperimentBasedConfig(ConfigKey.AnthropicWebSearchToolEnabled, this._experimentationService);
			if (webSearchEnabled && !tools.some(tool => 'name' in tool && tool.name === 'web_search')) {
				const maxUses = this._configurationService.getConfig(ConfigKey.AnthropicWebSearchMaxUses);
				const allowedDomains = this._configurationService.getConfig(ConfigKey.AnthropicWebSearchAllowedDomains);
				const blockedDomains = this._configurationService.getConfig(ConfigKey.AnthropicWebSearchBlockedDomains);
				const userLocation = this._configurationService.getConfig(ConfigKey.AnthropicWebSearchUserLocation);
				const shouldDeferWebSearch = toolSearchEnabled ? !this._toolDeferralService.isNonDeferredTool('web_search') : undefined;

				const webSearchTool: Anthropic.Beta.BetaWebSearchTool20250305 = {
					name: 'web_search',
					type: 'web_search_20250305',
					max_uses: maxUses,
					...(shouldDeferWebSearch ? { defer_loading: shouldDeferWebSearch } : {})
				};

				// Add domain filtering if configured
				// Cannot use both allowed and blocked domains simultaneously
				if (allowedDomains && allowedDomains.length > 0) {
					webSearchTool.allowed_domains = allowedDomains;
				} else if (blockedDomains && blockedDomains.length > 0) {
					webSearchTool.blocked_domains = blockedDomains;
				}

				// Add user location if configured
				// Note: All fields are optional according to Anthropic docs
				if (userLocation && (userLocation.city || userLocation.region || userLocation.country || userLocation.timezone)) {
					webSearchTool.user_location = {
						type: 'approximate',
						...userLocation
					};
				}

				tools.push(webSearchTool);
			}

			const thinkingBudget = this._getThinkingBudget(model.id, model.maxOutputTokens);

			// Check if model supports adaptive thinking
			const modelCapabilities = this._knownModels?.[model.id];
			const supportsAdaptiveThinking = modelCapabilities?.adaptiveThinking ?? false;

			// Build context management configuration
			const thinkingEnabled = supportsAdaptiveThinking || (thinkingBudget ?? 0) > 0;
			const contextManagement = isAnthropicContextEditingEnabled(model.id, this._configurationService, this._experimentationService) ? getContextManagementFromConfig(
				this._configurationService,
				this._experimentationService,
				thinkingEnabled
			) : undefined;

			// Build betas array for beta API features (adaptive thinking doesn't need interleaved-thinking beta)
			const betas: string[] = [];
			if (thinkingBudget && !supportsAdaptiveThinking) {
				betas.push('interleaved-thinking-2025-05-14');
			}
			if (hasMemoryTool || contextManagement) {
				betas.push('context-management-2025-06-27');
			}
			if (toolSearchEnabled) {
				betas.push('advanced-tool-use-2025-11-20');
			}

			const rawEffort = options.modelConfiguration?.reasoningEffort;
			const supportsEffort = modelCapabilities?.supportsReasoningEffort;
			const effort = supportsEffort && typeof rawEffort === 'string' && supportsEffort.includes(rawEffort)
				? rawEffort as 'low' | 'medium' | 'high' | 'max'
				: undefined;

			// ─── BYOK CUSTOM PATCH: always cache system prompt + tools ────────────────────────
			// Preserved by .github/scripts/apply-byok-patches.sh. Do not remove.
			// Upstream `addCacheBreakpoints` only reserves leftover cache slots for
			// the system message after tool-result breakpoints have been allocated,
			// so in multi-tool-call turns the system prompt (often the largest
			// stable prefix, 10K+ tokens with workspace rules + agent prompt) never
			// gets marked and every turn re-bills it at full rate. The `tools`
			// array is similarly stable across the agent loop but upstream never
			// caches it at all for BYOK.
			//
			// Anthropic enforces a hard cap of 4 cache_control breakpoints across
			// system + tools + messages. Upstream can already place up to 4 on
			// message content blocks, so unconditionally adding ours overflows to
			// 5-6 and the API rejects the request with invalid_request_error.
			// Priority: system > lastTool > recent message breakpoints. Strip
			// message breakpoints from oldest to newest (later breakpoints subsume
			// earlier ones anyway, so evicting the oldest costs nothing) until we
			// fit under the cap.
			//
			// Anthropic prompt caching: writes cost 1.25x, reads cost 0.1x. Break-
			// even after 2 turns. Multi-turn agentic loops save ~70% on the shared
			// prefix.
			// https://docs.anthropic.com/en/docs/build-with-claude/prompt-caching
			if (system.text && system.text.length > 0 && !system.cache_control) {
				system.cache_control = { type: 'ephemeral' };
			}
			if (tools.length > 0) {
				const lastTool = tools[tools.length - 1] as Anthropic.Beta.BetaToolUnion & { cache_control?: { type: 'ephemeral' } };
				if (!lastTool.cache_control) {
					lastTool.cache_control = { type: 'ephemeral' };
				}
			}
			const MAX_CACHE_BREAKPOINTS = 4;
			type MaybeCacheBlock = { cache_control?: unknown; content?: unknown };
			// Anthropic counts every cache_control occurrence in the request,
			// including on nested text blocks inside tool_result.content[] (the
			// converter emits those when the upstream `addCacheBreakpoints`
			// pass fires between two tool_result parts — see
			// anthropicMessageConverter.ts line ~107). A flat walk over
			// `msg.content` misses those and we'd overshoot the 4-slot cap.
			// Enabling MCP makes this much easier to hit because more tools
			// mean more tool_result messages → more nested breakpoints.
			const locateMessageBreakpoints = (): Array<{ block: MaybeCacheBlock }> => {
				const found: Array<{ block: MaybeCacheBlock }> = [];
				const walk = (blocks: unknown): void => {
					if (!Array.isArray(blocks)) { return; }
					for (const b of blocks as MaybeCacheBlock[]) {
						if (!b) { continue; }
						if (b.cache_control) { found.push({ block: b }); }
						if (Array.isArray(b.content)) { walk(b.content); }
					}
				};
				for (const msg of convertedMessages) { walk(msg.content); }
				return found;
			};
			const countBreakpoints = (messageBreakpoints: Array<{ block: MaybeCacheBlock }>): number => {
				let total = messageBreakpoints.length;
				if ((system as MaybeCacheBlock).cache_control) { total++; }
				for (const tool of tools as MaybeCacheBlock[]) {
					if (tool.cache_control) { total++; }
				}
				return total;
			};
			let messageBreakpoints = locateMessageBreakpoints();
			let total = countBreakpoints(messageBreakpoints);
			while (total > MAX_CACHE_BREAKPOINTS && messageBreakpoints.length > 0) {
				const oldest = messageBreakpoints.shift()!;
				delete oldest.block.cache_control;
				total = countBreakpoints(messageBreakpoints);
			}
			// ─── END BYOK CUSTOM PATCH ────────────────────────────────────────

			const params: Anthropic.Beta.Messages.MessageCreateParamsStreaming = {
				model: model.id,
				messages: convertedMessages,
				max_tokens: model.maxOutputTokens,
				stream: true,
				system: [system],
				tools: tools.length > 0 ? tools : undefined,
				thinking: supportsAdaptiveThinking
					? { type: 'adaptive' as const }
					: thinkingBudget ? { type: 'enabled' as const, budget_tokens: thinkingBudget } : undefined,
				...(effort ? { output_config: { effort } } : {}),
				context_management: contextManagement as Anthropic.Beta.Messages.BetaContextManagementConfig | undefined,
			};

			const wrappedProgress = new RecordedProgress(progress);

			try {
				const result = await this._makeRequest(anthropicClient, wrappedProgress, params, betas, token, issuedTime);
				if (result.ttft) {
					pendingLoggedChatRequest.markTimeToFirstToken(result.ttft);
				}
				// ─── BYOK CUSTOM PATCH: emit TokenUsage to context-window ring ───
				// Preserved by .github/scripts/apply-byok-patches.sh (Patch 33).
				// The LM API host (extChatEndpoint.ts) otherwise hardcodes usage
				// to zeros, leaving the UI ring indicator empty on every BYOK turn.
				if (result.usage) {
					progress.report(new LanguageModelDataPart(
						new TextEncoder().encode(JSON.stringify(result.usage)),
						CustomDataPartMimeTypes.TokenUsage
					));
				}
				// ─── END BYOK CUSTOM PATCH ───────────────────────────────
				const responseDeltas: IResponseDelta[] = wrappedProgress.items.map((i): IResponseDelta => {
					if (i instanceof LanguageModelTextPart) {
						return { text: i.value };
					} else if (i instanceof LanguageModelToolCallPart) {
						return {
							text: '',
							copilotToolCalls: [{
								name: i.name,
								arguments: JSON.stringify(i.input),
								id: i.callId
							}]
						};
					} else if (i instanceof LanguageModelToolResultPart) {
						// Handle tool results - extract text from content
						const resultText = i.content.map(c => c instanceof LanguageModelTextPart ? c.value : '').join('');
						return {
							text: `[Tool Result ${i.callId}]: ${resultText}`
						};
					} else {
						return { text: '' };
					}
				});
				// TODO: @bhavyaus - Add telemetry tracking for context editing (contextEditingApplied, contextEditingClearedTokens, contextEditingEditCount) like messagesApi.ts does
				if (result.contextManagement) {
					responseDeltas.push({
						text: '',
						contextManagement: result.contextManagement
					});
				}
				pendingLoggedChatRequest.resolve({
					type: ChatFetchResponseType.Success,
					requestId,
					serverRequestId: requestId,
					usage: result.usage,
					value: ['value'],
					resolvedModel: model.id
				}, responseDeltas);

				// Enrich OTel span with usage data from the Anthropic response
				if (otelSpan && result.usage) {
					otelSpan.setAttributes({
						[GenAiAttr.USAGE_INPUT_TOKENS]: result.usage.prompt_tokens ?? 0,
						[GenAiAttr.USAGE_OUTPUT_TOKENS]: result.usage.completion_tokens ?? 0,
						...(result.usage.prompt_tokens_details?.cached_tokens
							? { [GenAiAttr.USAGE_CACHE_READ_INPUT_TOKENS]: result.usage.prompt_tokens_details.cached_tokens }
							: {}),
						[GenAiAttr.RESPONSE_MODEL]: model.id,
						[GenAiAttr.RESPONSE_ID]: requestId,
						[GenAiAttr.RESPONSE_FINISH_REASONS]: ['stop'],
						[GenAiAttr.CONVERSATION_ID]: requestId,
						...(result.ttft ? { [CopilotChatAttr.TIME_TO_FIRST_TOKEN]: result.ttft } : {}),
						[GenAiAttr.REQUEST_MAX_TOKENS]: model.maxOutputTokens ?? 0,
					});
					// Opt-in content capture
					if (this._otelService.config.captureContent) {
						const responseText = wrappedProgress.items
							.filter((p): p is LanguageModelTextPart => p instanceof LanguageModelTextPart)
							.map(p => p.value).join('');
						const toolCalls = wrappedProgress.items
							.filter((p): p is LanguageModelToolCallPart => p instanceof LanguageModelToolCallPart)
							.map(tc => ({ type: 'tool_call' as const, id: tc.callId, name: tc.name, arguments: tc.input }));
						const parts: Array<{ type: string; content?: string; id?: string; name?: string; arguments?: unknown }> = [];
						if (responseText) { parts.push({ type: 'text', content: responseText }); }
						parts.push(...toolCalls);
						if (parts.length > 0) {
							otelSpan.setAttribute(GenAiAttr.OUTPUT_MESSAGES, truncateForOTel(JSON.stringify([{ role: 'assistant', parts }])));
						}
					}
				}

				// Record OTel metrics for this Anthropic LLM call
				if (result.usage) {
					const durationSec = (Date.now() - issuedTime) / 1000;
					const metricAttrs = { operationName: GenAiOperationName.CHAT, providerName: 'anthropic', requestModel: model.id, responseModel: model.id };
					GenAiMetrics.recordOperationDuration(this._otelService, durationSec, metricAttrs);
					if (result.usage.prompt_tokens) { GenAiMetrics.recordTokenUsage(this._otelService, result.usage.prompt_tokens, 'input', metricAttrs); }
					if (result.usage.completion_tokens) { GenAiMetrics.recordTokenUsage(this._otelService, result.usage.completion_tokens, 'output', metricAttrs); }
					if (result.ttft) { GenAiMetrics.recordTimeToFirstToken(this._otelService, model.id, result.ttft / 1000); }
				}

				// Emit OTel inference details event
				emitInferenceDetailsEvent(
					this._otelService,
					{ model: model.id, maxTokens: model.maxOutputTokens },
					result.usage ? {
						id: requestId,
						model: model.id,
						finishReasons: ['stop'],
						inputTokens: result.usage.prompt_tokens,
						outputTokens: result.usage.completion_tokens,
					} : undefined,
				);

				// Send success telemetry matching response.success format
				/* __GDPR__
					"response.success" : {
						"owner": "digitarald",
						"comment": "Report quality details for a successful service response.",
						"reason": { "classification": "SystemMetaData", "purpose": "PerformanceAndHealth", "comment": "Reason for why a response finished" },
						"filterReason": { "classification": "SystemMetaData", "purpose": "PerformanceAndHealth", "comment": "Reason for why a response was filtered" },
						"source": { "classification": "SystemMetaData", "purpose": "PerformanceAndHealth", "comment": "Source of the initial request" },
						"initiatorType": { "classification": "SystemMetaData", "purpose": "FeatureInsight", "comment": "Whether the request was initiated by a user or an agent" },
						"model": { "classification": "SystemMetaData", "purpose": "PerformanceAndHealth", "comment": "Model selection for the response" },
						"modelInvoked": { "classification": "SystemMetaData", "purpose": "PerformanceAndHealth", "comment": "Actual model invoked for the response" },
						"apiType": { "classification": "SystemMetaData", "purpose": "PerformanceAndHealth", "comment": "API type for the response- chat completions or responses" },
						"requestId": { "classification": "SystemMetaData", "purpose": "PerformanceAndHealth", "comment": "Id of the current turn request" },
						"gitHubRequestId": { "classification": "SystemMetaData", "purpose": "PerformanceAndHealth", "comment": "GitHub request id if available" },
						"associatedRequestId": { "classification": "SystemMetaData", "purpose": "FeatureInsight", "comment": "Another request ID that this request is associated with (eg, the originating request of a summarization request)." },
						"reasoningEffort": { "classification": "SystemMetaData", "purpose": "PerformanceAndHealth", "comment": "Reasoning effort level" },
						"reasoningSummary": { "classification": "SystemMetaData", "purpose": "PerformanceAndHealth", "comment": "Reasoning summary level" },
						"fetcher": { "classification": "SystemMetaData", "purpose": "PerformanceAndHealth", "comment": "The fetcher used for the request" },
						"transport": { "classification": "SystemMetaData", "purpose": "PerformanceAndHealth", "comment": "The transport used for the request (http or websocket)" },
						"totalTokenMax": { "classification": "SystemMetaData", "purpose": "PerformanceAndHealth", "comment": "Maximum total token window", "isMeasurement": true },
						"clientPromptTokenCount": { "classification": "SystemMetaData", "purpose": "PerformanceAndHealth", "comment": "Number of prompt tokens, locally counted", "isMeasurement": true },
						"promptTokenCount": { "classification": "SystemMetaData", "purpose": "PerformanceAndHealth", "comment": "Number of prompt tokens, server side counted", "isMeasurement": true },
						"promptCacheTokenCount": { "classification": "SystemMetaData", "purpose": "PerformanceAndHealth", "comment": "Number of prompt tokens hitting cache as reported by server", "isMeasurement": true },
						"tokenCountMax": { "classification": "SystemMetaData", "purpose": "PerformanceAndHealth", "comment": "Maximum generated tokens", "isMeasurement": true },
						"tokenCount": { "classification": "SystemMetaData", "purpose": "PerformanceAndHealth", "comment": "Number of generated tokens", "isMeasurement": true },
						"reasoningTokens": { "classification": "SystemMetaData", "purpose": "PerformanceAndHealth", "comment": "Number of reasoning tokens", "isMeasurement": true },
						"acceptedPredictionTokens": { "classification": "SystemMetaData", "purpose": "FeatureInsight", "comment": "Number of tokens in the prediction that appeared in the completion", "isMeasurement": true },
						"rejectedPredictionTokens": { "classification": "SystemMetaData", "purpose": "FeatureInsight", "comment": "Number of tokens in the prediction that appeared in the completion", "isMeasurement": true },
						"completionTokens": { "classification": "SystemMetaData", "purpose": "FeatureInsight", "comment": "Number of tokens in the output", "isMeasurement": true },
						"timeToFirstToken": { "classification": "SystemMetaData", "purpose": "PerformanceAndHealth", "comment": "Time to first token", "isMeasurement": true },
						"timeToFirstTokenEmitted": { "classification": "SystemMetaData", "purpose": "PerformanceAndHealth", "comment": "Time to first token emitted (visible text)", "isMeasurement": true },
						"timeToComplete": { "classification": "SystemMetaData", "purpose": "PerformanceAndHealth", "comment": "Time to complete the request", "isMeasurement": true },
						"issuedTime": { "classification": "SystemMetaData", "purpose": "PerformanceAndHealth", "comment": "Timestamp when the request was issued", "isMeasurement": true },
						"isVisionRequest": { "classification": "SystemMetaData", "purpose": "PerformanceAndHealth", "comment": "Whether the request was for a vision model", "isMeasurement": true },
						"isBYOK": { "classification": "SystemMetaData", "purpose": "FeatureInsight", "comment": "Whether the request was for a BYOK model", "isMeasurement": true },
						"isAuto": { "classification": "SystemMetaData", "purpose": "FeatureInsight", "comment": "Whether the request was for an Auto model", "isMeasurement": true },
						"bytesReceived": { "classification": "SystemMetaData", "purpose": "PerformanceAndHealth", "comment": "Number of bytes received in the response", "isMeasurement": true },
						"retryAfterError": { "classification": "SystemMetaData", "purpose": "FeatureInsight", "comment": "Error of the original request." },
						"retryAfterErrorGitHubRequestId": { "classification": "SystemMetaData", "purpose": "PerformanceAndHealth", "comment": "GitHub request id of the original request if available" },
						"connectivityTestError": { "classification": "SystemMetaData", "purpose": "FeatureInsight", "comment": "Error of the connectivity test." },
						"connectivityTestErrorGitHubRequestId": { "classification": "SystemMetaData", "purpose": "PerformanceAndHealth", "comment": "GitHub request id of the connectivity test request if available" },
						"retryAfterFilterCategory": { "classification": "SystemMetaData", "purpose": "FeatureInsight", "comment": "If the response was filtered and this is a retry attempt, this contains the original filtered content category." },
						"suspendEventSeen": { "classification": "SystemMetaData", "purpose": "PerformanceAndHealth", "comment": "Whether a system suspend event was seen during the request", "isMeasurement": true },
						"resumeEventSeen": { "classification": "SystemMetaData", "purpose": "PerformanceAndHealth", "comment": "Whether a system resume event was seen during the request", "isMeasurement": true }
					}
				*/
				this._telemetryService.sendTelemetryEvent('response.success', { github: true, microsoft: true }, {
					source: 'byok.anthropic',
					model: model.id,
					requestId,
				}, {
					totalTokenMax: model.maxInputTokens ?? -1,
					tokenCountMax: model.maxOutputTokens ?? -1,
					promptTokenCount: result.usage?.prompt_tokens,
					promptCacheTokenCount: result.usage?.prompt_tokens_details?.cached_tokens,
					tokenCount: result.usage?.total_tokens,
					completionTokens: result.usage?.completion_tokens,
					timeToFirstToken: result.ttft,
					timeToFirstTokenEmitted: result.ttfte,
					timeToComplete: Date.now() - issuedTime,
					issuedTime,
					isBYOK: 1,
				});
			} catch (err) {
				this._logService.error(`BYOK Anthropic error: ${toErrorMessage(err, true)}`);
				pendingLoggedChatRequest.resolve({
					type: ChatFetchResponseType.Unknown,
					requestId,
					serverRequestId: requestId,
					reason: err.message
				}, wrappedProgress.items.map((i): IResponseDelta => {
					if (i instanceof LanguageModelTextPart) {
						return { text: i.value };
					} else if (i instanceof LanguageModelToolCallPart) {
						return {
							text: '',
							copilotToolCalls: [{
								name: i.name,
								arguments: JSON.stringify(i.input),
								id: i.callId
							}]
						};
					} else if (i instanceof LanguageModelToolResultPart) {
						// Handle tool results - extract text from content
						const resultText = i.content.map(c => c instanceof LanguageModelTextPart ? c.value : '').join('');
						return {
							text: `[Tool Result ${i.callId}]: ${resultText}`
						};
					} else {
						return { text: '' };
					}
				}));
				throw err;
			}
		};

		// Create OTel span and execute with trace context + CapturingToken
		const executeRequest = async () => {
			otelSpan = this._otelService.startSpan(`chat ${model.id}`, {
				kind: SpanKind.CLIENT,
				attributes: {
					[GenAiAttr.OPERATION_NAME]: GenAiOperationName.CHAT,
					[GenAiAttr.PROVIDER_NAME]: GenAiProviderName.ANTHROPIC,
					[GenAiAttr.REQUEST_MODEL]: model.id,
					[GenAiAttr.AGENT_NAME]: 'AnthropicBYOK',
					[CopilotChatAttr.MAX_PROMPT_TOKENS]: model.maxInputTokens,
					[StdAttr.SERVER_ADDRESS]: 'api.anthropic.com',
				},
			});
			// Opt-in: capture input messages in OTel GenAI format
			if (this._otelService.config.captureContent) {
				// Tool definitions on the chat span (issue #299934) with `parameters`
				// per OTel GenAI semantic conventions (issue #300318).
				const toolDefs = toToolDefinitions(options.tools);
				if (toolDefs) {
					otelSpan.setAttribute(GenAiAttr.TOOL_DEFINITIONS, truncateForOTel(JSON.stringify(toolDefs)));
				}
				try {
					const roleNames: Record<number, string> = { 1: 'user', 2: 'assistant', 3: 'system' };
					const inputMsgs = messages.map(m => {
						const msg = m as LanguageModelChatMessage;
						const role = roleNames[msg.role] ?? String(msg.role);
						const parts: Array<{ type: string; content?: string | unknown; id?: string; name?: string; arguments?: unknown; response?: unknown }> = [];
						if (Array.isArray(msg.content)) {
							for (const p of msg.content) {
								if (p instanceof LanguageModelTextPart) {
									parts.push({ type: 'text', content: p.value });
								} else if (p instanceof LanguageModelToolCallPart) {
									parts.push({ type: 'tool_call', id: p.callId, name: p.name, arguments: p.input });
								} else if (p instanceof LanguageModelToolResultPart) {
									const resultText = p.content.map((c: unknown) => c instanceof LanguageModelTextPart ? c.value : '').join('');
									parts.push({ type: 'tool_call_response', id: p.callId, response: resultText });
								}
							}
						}
						if (parts.length === 0) {
							parts.push({ type: 'text', content: '[non-text content]' });
						}
						return { role, parts };
					});
					otelSpan.setAttribute(GenAiAttr.INPUT_MESSAGES, truncateForOTel(JSON.stringify(inputMsgs)));
				} catch { /* swallow */ }
			}
			try {
				const result = capturingToken
					? await runWithCapturingToken(capturingToken, doRequest)
					: await doRequest();
				otelSpan.setStatus(SpanStatusCode.OK);
				return result;
			} catch (err) {
				otelSpan.setStatus(SpanStatusCode.ERROR, err instanceof Error ? err.message : String(err));
				throw err;
			} finally {
				otelSpan.end();
			}
		};

		if (parentTraceContext) {
			return this._otelService.runWithTraceContext(parentTraceContext, executeRequest);
		}
		return executeRequest();
	}

	// ─── BYOK CUSTOM PATCH: self-calibrating chars-per-token ratio ────────────
	// Preserved by .github/scripts/apply-byok-patches.sh. Do not remove.
	// Upstream returns `Math.ceil(text.length / 4)`, which is optimistic for
	// Claude (actual ratio is closer to 3.3 for code/JSON, 3.8 for English).
	// Calling Anthropic's `/messages/count_tokens` endpoint on every
	// `provideTokenCount` invocation would be unusable (this method is hot —
	// VS Code calls it dozens of times per turn for UI sizing), so instead
	// we seed each model with a tighter baseline (3.5) and self-calibrate
	// from the real `usage.input_tokens` that every response returns. After
	// 2-3 turns the ratio converges to ground-truth for the specific
	// conversation style (code-heavy vs prose vs tool-call-heavy).
	//
	// The UI context-window indicator and auto-compaction thresholds
	// (Patches 4, 6) both flow from this number, so accuracy here directly
	// determines whether "we'll run out without noticing" or get a timely
	// warning before the hard cap.
	private static readonly _INITIAL_CHARS_PER_TOKEN = 3.5;
	private readonly _charsPerTokenByModel = new Map<string, number>();
	private _recordActualInputTokens(modelId: string, promptChars: number, actualInputTokens: number): void {
		if (!modelId || promptChars <= 0 || actualInputTokens <= 0) {
			return;
		}
		const observed = promptChars / actualInputTokens;
		// Reject pathological observations (empty prompts, cache-only hits,
		// count_tokens mismatches from context editing) that would otherwise
		// yank the running average around. 1.5–8.0 brackets every realistic
		// tokenizer ratio across English, code, and heavily-nested JSON.
		if (!isFinite(observed) || observed < 1.5 || observed > 8.0) {
			return;
		}
		const prior = this._charsPerTokenByModel.get(modelId) ?? AnthropicLMProvider._INITIAL_CHARS_PER_TOKEN;
		// EMA with α=0.3 — recent turns dominate but a single weird turn can't
		// overwrite the prior. Converges visibly within ~3 turns.
		const smoothed = prior * 0.7 + observed * 0.3;
		this._charsPerTokenByModel.set(modelId, smoothed);
		this._logService.trace(`[BYOK Anthropic] token-ratio calibrated for ${modelId}: chars/token=${smoothed.toFixed(2)} (observed ${observed.toFixed(2)}, ${actualInputTokens} real tokens for ${promptChars} chars)`);
	}

	async provideTokenCount(model: LanguageModelChatInformation, text: string | LanguageModelChatMessage | LanguageModelChatMessage2, token: CancellationToken): Promise<number> {
		const ratio = this._charsPerTokenByModel.get(model.id) ?? AnthropicLMProvider._INITIAL_CHARS_PER_TOKEN;
		return Math.ceil(text.toString().length / ratio);
	}
	// ─── END BYOK CUSTOM PATCH ────────────────────────────────────────────────

	private async _makeRequest(anthropicClient: Anthropic, progress: RecordedProgress<LMResponsePart>, params: Anthropic.Beta.Messages.MessageCreateParamsStreaming, betas: string[], token: CancellationToken, issuedTime: number, retryCount = 0): Promise<{ ttft: number | undefined; ttfte: number | undefined; usage: APIUsage | undefined; contextManagement: ContextManagementResponse | undefined }> {
		// ─── BYOK CUSTOM PATCH: retry + readable-error constants ──────────────────
		// Preserved by .github/scripts/apply-byok-patches.sh. Do not remove.
		// Budget: 5s, 10s, 20s, 40s → 75s cumulative worst case. Matches the
		// Gemini resilience patch (Patch 8) but capped tighter since
		// (a) Anthropic has a real failover target (Vertex) for non-Vertex
		//     primaries, so burning a full Gemini-style 6-retry budget here
		//     delays the failover unnecessarily, and
		// (b) VertexAnthropic primaries (the common BYOK case) have no
		//     failover — 4 retries is enough to smooth out a single
		//     overloaded_error blip without making the chat UI feel hung.
		const MAX_RETRIES = 4;
		// ─── END BYOK CUSTOM PATCH ─────────────────────────────────────────
		const start = Date.now();
		let ttft: number | undefined;
		let ttfte: number | undefined;

		// ─── BYOK CUSTOM PATCH: capture prompt chars for token ratio calibration ──
		// Preserved by .github/scripts/apply-byok-patches.sh. Do not remove.
		// Serialize the outgoing prompt once so that after the response returns
		// we can divide promptChars / actual input_tokens to derive a real
		// chars-per-token ratio for this model. JSON.stringify is a reasonable
		// proxy for "what the tokenizer sees" — it captures both message text
		// and the boilerplate (role markers, tool schemas, etc.) that
		// contribute to the prompt size.
		const promptChars = (() => {
			try {
				return JSON.stringify({ system: params.system, messages: params.messages }).length;
			} catch {
				return 0;
			}
		})();
		// ─── END BYOK CUSTOM PATCH ────────────────────────────────────────────────

		// ─── BYOK CUSTOM PATCH: retry + readable-error wrapping ─────────────────
		// Preserved by .github/scripts/apply-byok-patches.sh. Do not remove.
		// Wrap the stream create + consume in try/catch so overloaded_error /
		// rate limits / transient 5xx recover transparently instead of dumping
		// a raw JSON blob into chat. Only retry when `ttft === undefined` —
		// once we've started emitting tokens, retrying would produce
		// duplicated output.
		try {
		const stream = await anthropicClient.beta.messages.create({
			...params,
			...(betas.length > 0 && { betas })
		});

		let pendingToolCall: {
			toolId?: string;
			name?: string;
			jsonInput?: string;
		} | undefined;
		let pendingThinking: {
			thinking?: string;
			signature?: string;
		} | undefined;
		let pendingRedactedThinking: {
			data: string;
		} | undefined;
		let pendingServerToolCall: {
			toolId?: string;
			name?: string;
			jsonInput?: string;
			type?: string;
		} | undefined;
		let usage: APIUsage | undefined;
		let contextManagementResponse: ContextManagementResponse | undefined;

		let hasText = false;
		for await (const chunk of stream) {
			if (token.isCancellationRequested) {
				break;
			}

			if (ttft === undefined) {
				ttft = Date.now() - start;
			}
			this._logService.trace(`chunk: ${JSON.stringify(chunk)}`);

			if (chunk.type === 'content_block_start') {
				if ('content_block' in chunk && chunk.content_block.type === 'tool_use') {
					pendingToolCall = {
						toolId: chunk.content_block.id,
						name: chunk.content_block.name,
						jsonInput: ''
					};
				} else if ('content_block' in chunk && chunk.content_block.type === 'server_tool_use') {
					// Handle server-side tool use (e.g., web_search)
					pendingServerToolCall = {
						toolId: chunk.content_block.id,
						name: chunk.content_block.name,
						jsonInput: '',
						type: chunk.content_block.name
					};
					progress.report(new LanguageModelTextPart('\n'));

				} else if ('content_block' in chunk && chunk.content_block.type === 'thinking') {
					pendingThinking = {
						thinking: '',
						signature: ''
					};
				} else if ('content_block' in chunk && chunk.content_block.type === 'redacted_thinking') {
					const redactedBlock = chunk.content_block as Anthropic.Messages.RedactedThinkingBlock;
					pendingRedactedThinking = {
						data: redactedBlock.data
					};
				} else if ('content_block' in chunk && chunk.content_block.type === 'web_search_tool_result') {
					if (!pendingServerToolCall || !pendingServerToolCall.toolId) {
						continue;
					}

					const resultBlock = chunk.content_block as Anthropic.Messages.WebSearchToolResultBlock;
					// Handle potential error in web search
					if (!Array.isArray(resultBlock.content)) {
						this._logService.error(`Web search error: ${(resultBlock.content as Anthropic.Messages.WebSearchToolResultError).error_code}`);
						continue;
					}

					const results = resultBlock.content.map((result: Anthropic.Messages.WebSearchResultBlock) => ({
						type: 'web_search_result',
						url: result.url,
						title: result.title,
						page_age: result.page_age,
						encrypted_content: result.encrypted_content
					}));

					// Format according to Anthropic's web_search_tool_result specification
					const toolResult = {
						type: 'web_search_tool_result',
						tool_use_id: pendingServerToolCall.toolId,
						content: results
					};

					const searchResults = JSON.stringify(toolResult, null, 2);

					// TODO: @bhavyaus - instead of just pushing text, create a specialized WebSearchResult part
					progress.report(new LanguageModelToolResultPart(
						pendingServerToolCall.toolId!,
						[new LanguageModelTextPart(searchResults)]
					));
					pendingServerToolCall = undefined;
				}
				continue;
			}

			if (chunk.type === 'content_block_delta') {
				if (chunk.delta.type === 'text_delta') {
					progress.report(new LanguageModelTextPart(chunk.delta.text || ''));
					if (!hasText && chunk.delta.text?.length > 0) {
						ttfte = Date.now() - issuedTime;
					}
					hasText ||= chunk.delta.text?.length > 0;
				} else if (chunk.delta.type === 'citations_delta') {
					if ('citation' in chunk.delta) {
						// TODO: @bhavyaus - instead of just pushing text, create a specialized Citation part
						const citation = chunk.delta.citation as Anthropic.Messages.CitationsWebSearchResultLocation;
						if (citation.type === 'web_search_result_location') {
							// Format citation according to Anthropic specification
							const citationData = {
								type: 'web_search_result_location',
								url: citation.url,
								title: citation.title,
								encrypted_index: citation.encrypted_index,
								cited_text: citation.cited_text
							};

							// Format citation as readable blockquote with source link
							const referenceText = `\n> "${citation.cited_text}" — [${vscode.l10n.t('Source')}](${citation.url})\n\n`;

							// Report formatted reference text to user
							progress.report(new LanguageModelTextPart(referenceText));

							// Store the citation data in the correct format for multi-turn conversations
							progress.report(new LanguageModelToolResultPart(
								'citation',
								[new LanguageModelTextPart(JSON.stringify(citationData, null, 2))]
							));
						}
					}
				} else if (chunk.delta.type === 'thinking_delta') {
					if (pendingThinking) {
						pendingThinking.thinking = (pendingThinking.thinking || '') + (chunk.delta.thinking || '');
						progress.report(new LanguageModelThinkingPart(chunk.delta.thinking || ''));
					}
				} else if (chunk.delta.type === 'signature_delta') {
					// Accumulate signature
					if (pendingThinking) {
						pendingThinking.signature = (pendingThinking.signature || '') + (chunk.delta.signature || '');
					}
				} else if (chunk.delta.type === 'input_json_delta' && pendingToolCall) {
					pendingToolCall.jsonInput = (pendingToolCall.jsonInput || '') + (chunk.delta.partial_json || '');

					try {
						// Try to parse the accumulated JSON to see if it's complete
						const parsedJson = JSON.parse(pendingToolCall.jsonInput);
						progress.report(new LanguageModelToolCallPart(
							pendingToolCall.toolId!,
							pendingToolCall.name!,
							parsedJson
						));
						pendingToolCall = undefined;
					} catch {
						// JSON is not complete yet, continue accumulating
						continue;
					}
				} else if (chunk.delta.type === 'input_json_delta' && pendingServerToolCall) {
					pendingServerToolCall.jsonInput = (pendingServerToolCall.jsonInput || '') + (chunk.delta.partial_json || '');
				}
			}

			if (chunk.type === 'content_block_stop') {
				if (pendingToolCall) {
					try {
						const parsedJson = JSON.parse(pendingToolCall.jsonInput || '{}');
						progress.report(
							new LanguageModelToolCallPart(
								pendingToolCall.toolId!,
								pendingToolCall.name!,
								parsedJson
							)
						);
					} catch (e) {
						console.error('Failed to parse tool call JSON:', e);
					}
					pendingToolCall = undefined;
				} else if (pendingThinking) {
					if (pendingThinking.signature) {
						const finalThinkingPart = new LanguageModelThinkingPart('');
						finalThinkingPart.metadata = {
							signature: pendingThinking.signature,
							_completeThinking: pendingThinking.thinking
						};
						progress.report(finalThinkingPart);
					}
					pendingThinking = undefined;
				} else if (pendingRedactedThinking) {
					pendingRedactedThinking = undefined;
				}
			}

			if (chunk.type === 'message_start') {
				// TODO final output tokens: {"type":"message_delta","delta":{"stop_reason":"end_turn","stop_sequence":null},"usage":{"output_tokens":46}}
				usage = {
					completion_tokens: -1,
					prompt_tokens: chunk.message.usage.input_tokens + (chunk.message.usage.cache_creation_input_tokens ?? 0) + (chunk.message.usage.cache_read_input_tokens ?? 0),
					total_tokens: -1,
					// Cast needed: Anthropic returns cache_creation_input_tokens which APIUsage.prompt_tokens_details doesn't define
					prompt_tokens_details: {
						cached_tokens: chunk.message.usage.cache_read_input_tokens ?? 0,
						cache_creation_input_tokens: chunk.message.usage.cache_creation_input_tokens
					} as any
				};
			} else if (usage && chunk.type === 'message_delta') {
				if (chunk.usage.output_tokens) {
					usage.completion_tokens = chunk.usage.output_tokens;
					usage.total_tokens = usage.prompt_tokens + chunk.usage.output_tokens;
				}
				// Handle context management response
				if ('context_management' in chunk && chunk.context_management) {
					contextManagementResponse = chunk.context_management as ContextManagementResponse;
					const totalClearedTokens = contextManagementResponse.applied_edits.reduce(
						(sum, edit) => sum + (edit.cleared_input_tokens || 0),
						0
					);
					this._logService.info(`BYOK Anthropic context editing applied: cleared ${totalClearedTokens} tokens across ${contextManagementResponse.applied_edits.length} edits`);
					// Emit context management via LanguageModelDataPart so it flows through to toolCallingLoop
					progress.report(new LanguageModelDataPart(
						new TextEncoder().encode(JSON.stringify(contextManagementResponse)),
						CustomDataPartMimeTypes.ContextManagement
					));
				}
			}
		}

		// ─── BYOK CUSTOM PATCH: calibrate chars-per-token from real usage ─────────
		// Preserved by .github/scripts/apply-byok-patches.sh. Do not remove.
		// `usage.prompt_tokens` here already folds in cache-creation and
		// cache-read tokens (see `message_start` handling above), which is what
		// Anthropic actually billed and what their tokenizer produced. Using it
		// to calibrate `provideTokenCount` keeps the UI context indicator and
		// auto-compaction thresholds honest over the life of the conversation.
		if (usage && usage.prompt_tokens > 0) {
			this._recordActualInputTokens(params.model, promptChars, usage.prompt_tokens);
		}
		// ─── END BYOK CUSTOM PATCH ────────────────────────────────────────────────

		// ─── BYOK CUSTOM PATCH: per-request TokenBudget info log ──────────────────
		// Preserved by .github/scripts/apply-byok-patches.sh. Do not remove.
		// Emits one info-level line per completed request so context-window
		// behaviour is visible without enabling trace logging. Works for both
		// direct Anthropic and Vertex-routed Anthropic (the subclass overrides
		// `providerName`, so the log tag tells us which path ran). Grep the
		// extension log for `[BYOK TokenBudget]` to audit every turn.
		if (usage && usage.prompt_tokens > 0) {
			try {
				const providerTag = (this.constructor as typeof AnthropicLMProvider).providerName;
				const caps = this._resolveAnthropicCapabilities(params.model);
				const max = caps?.maxInputTokens ?? 0;
				const pct = max > 0 ? ((usage.prompt_tokens / max) * 100).toFixed(1) : 'n/a';
				const ratio = this._charsPerTokenByModel.get(params.model) ?? AnthropicLMProvider._INITIAL_CHARS_PER_TOKEN;
				const estimated = Math.ceil(promptChars / ratio);
				const delta = usage.prompt_tokens - estimated;
				const editsApplied = contextManagementResponse?.applied_edits?.length ?? 0;
				const out = usage.completion_tokens > 0 ? usage.completion_tokens : 0;
				this._logService.info(
					`[BYOK TokenBudget] provider=${providerTag} model=${params.model} ` +
					`prompt_tokens=${usage.prompt_tokens} output_tokens=${out} ` +
					`max_input=${max} pct_used=${pct}% ` +
					`estimated=${estimated} delta=${delta} ratio=${ratio.toFixed(2)} ` +
					`promptChars=${promptChars} contextEdits=${editsApplied}`
				);
			} catch {
				// Never let instrumentation break the request path.
			}
		}
		// ─── END BYOK CUSTOM PATCH ────────────────────────────────────────────────

		return { ttft, ttfte, usage, contextManagement: contextManagementResponse };
		} catch (error) {
			if ((error as { name?: string })?.name === 'AbortError' || token.isCancellationRequested) {
				throw error;
			}
			const retryKind = classifyRetryableAnthropicError(error);
			// Only retry when no tokens have been emitted yet. Mid-stream
			// failures on the same request can't be safely retried without
			// duplicating output.
			if (retryKind && retryCount < MAX_RETRIES && ttft === undefined) {
				const delay = Math.min(5000 * Math.pow(2, retryCount), 60_000);
				const label = retryKind === 'overloaded'
					? '[Overloaded] Anthropic is busy'
					: retryKind === 'rate-limit'
						? '[Rate limit] 429'
						: retryKind === 'unavailable'
							? '[Service unavailable]'
							: retryKind === 'server-error'
								? '[Server error]'
								: '[Network error]';
				const providerTag = (this.constructor as typeof AnthropicLMProvider).providerName;
				this._logService.warn(`${providerTag} ${retryKind} error, retrying in ${delay}ms (${retryCount + 1}/${MAX_RETRIES}): ${extractReadableAnthropicMessage(error)}`);
				progress.report(new LanguageModelThinkingPart(`${label} — retry ${retryCount + 1}/${MAX_RETRIES}: waiting ~${Math.ceil(delay / 1000)}s...\n`));
				await new Promise(resolve => setTimeout(resolve, delay));
				if (token.isCancellationRequested) {
					throw error;
				}
				return this._makeRequest(anthropicClient, progress, params, betas, token, issuedTime, retryCount + 1);
			}
			this._logService.error(`${(this.constructor as typeof AnthropicLMProvider).providerName} streaming error: ${toErrorMessage(error, true)}`);
			throw new Error(extractReadableAnthropicMessage(error), { cause: error });
		}
	}
}
