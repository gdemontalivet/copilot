/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { ApiError, Content, GenerateContentParameters, GoogleGenAI, Tool, Type } from '@google/genai';
import { CancellationToken, LanguageModelChatInformation, LanguageModelChatMessage, LanguageModelChatMessage2, LanguageModelResponsePart2, LanguageModelTextPart, LanguageModelThinkingPart, LanguageModelToolCallPart, Progress, ProvideLanguageModelChatResponseOptions } from 'vscode';
import { ChatFetchResponseType, ChatLocation } from '../../../platform/chat/common/commonTypes';
import { ILogService } from '../../../platform/log/common/logService';
import { IResponseDelta, OpenAiFunctionTool } from '../../../platform/networking/common/fetch';
import { APIUsage } from '../../../platform/networking/common/openai';
import { CopilotChatAttr, emitInferenceDetailsEvent, GenAiAttr, GenAiMetrics, GenAiOperationName, type OTelModelOptions, StdAttr, truncateForOTel } from '../../../platform/otel/common/index';
import { IOTelService, SpanKind, SpanStatusCode } from '../../../platform/otel/common/otelService';
import { IRequestLogger } from '../../../platform/requestLogger/common/requestLogger';
import { retrieveCapturingTokenByCorrelation, runWithCapturingToken } from '../../../platform/requestLogger/node/requestLogger';
import { ITelemetryService } from '../../../platform/telemetry/common/telemetry';
import { toErrorMessage } from '../../../util/common/errorMessage';
import { RecordedProgress } from '../../../util/common/progressRecorder';
import { generateUuid } from '../../../util/vs/base/common/uuid';
import { BYOKKnownModels, byokKnownModelsToAPIInfo, BYOKModelCapabilities, LMResponsePart } from '../common/byokProvider';
import { toGeminiFunction as toGeminiFunctionDeclaration, ToolJsonSchema } from '../common/geminiFunctionDeclarationConverter';
import { apiMessageToGeminiMessage, geminiMessagesToRawMessagesForLogging } from '../common/geminiMessageConverter';
import { AbstractLanguageModelChatProvider, ExtendedLanguageModelChatInformation, LanguageModelChatConfiguration } from './abstractLanguageModelChatProvider';
import { IBYOKStorageService } from './byokStorageService';

/**
 * Self-calibrating token estimator for Gemini BYOK.
 *
 * The base `getApproximateTokenCount` helper uses a naive `chars/4` heuristic, which
 * significantly under-counts symbol-dense payloads (code, JSON tool outputs, base64
 * inline images). That mismatch lets prompt-tsx believe we are well under the model's
 * context budget while Gemini has actually passed its limit, producing the 400
 * "input token count exceeds …" error before auto-compact gets a chance to kick in.
 *
 * This calibrator observes the real `usageMetadata.promptTokenCount` returned by
 * Gemini for each successful request, compares it to what the base estimator would
 * have predicted for the same payload, and maintains an exponential moving average
 * of the ratio per model. `provideTokenCount` then multiplies the raw estimate by
 * that factor, making prompt-tsx's budget math — and by extension the built-in
 * auto-compact threshold — track the true token count.
 */
class GeminiTokenCalibrator {
	private static readonly INITIAL_FACTOR = 1.0;
	private static readonly MIN_FACTOR = 0.9;
	private static readonly MAX_FACTOR = 3.0;
	private static readonly FAST_ALPHA = 0.5;
	private static readonly SLOW_ALPHA = 0.25;
	private static readonly FAST_SAMPLES = 5;

	private readonly _factors = new Map<string, { factor: number; samples: number }>();

	constructor(private readonly _logService: ILogService) { }

	getFactor(modelId: string): number {
		return this._factors.get(modelId)?.factor ?? GeminiTokenCalibrator.INITIAL_FACTOR;
	}

	calibrate(modelId: string, rawEstimate: number, actualPromptTokens: number): void {
		if (!Number.isFinite(rawEstimate) || rawEstimate <= 0) { return; }
		if (!Number.isFinite(actualPromptTokens) || actualPromptTokens <= 0) { return; }

		const sample = this._clamp(actualPromptTokens / rawEstimate);
		const current = this._factors.get(modelId);
		if (!current) {
			this._factors.set(modelId, { factor: sample, samples: 1 });
			this._logService.trace(`[GeminiCalibrator] ${modelId}: initial factor=${sample.toFixed(3)} (est=${rawEstimate}, actual=${actualPromptTokens})`);
			return;
		}

		const alpha = current.samples < GeminiTokenCalibrator.FAST_SAMPLES
			? GeminiTokenCalibrator.FAST_ALPHA
			: GeminiTokenCalibrator.SLOW_ALPHA;
		const nextFactor = this._clamp(current.factor * (1 - alpha) + sample * alpha);
		this._factors.set(modelId, { factor: nextFactor, samples: current.samples + 1 });
		this._logService.trace(`[GeminiCalibrator] ${modelId}: factor=${nextFactor.toFixed(3)} (sample=${sample.toFixed(3)}, samples=${current.samples + 1}, est=${rawEstimate}, actual=${actualPromptTokens})`);
	}

	private _clamp(value: number): number {
		return Math.max(GeminiTokenCalibrator.MIN_FACTOR, Math.min(GeminiTokenCalibrator.MAX_FACTOR, value));
	}
}

/**
 * Estimate (uncalibrated) the token count of a Gemini request payload using the
 * same base heuristic as `provideTokenCount`. Used only to feed the calibrator so
 * that sample ratios are comparable to what `provideTokenCount` returns for
 * prompt-tsx. Pragmatically stringifies parts/tools — exact fidelity with
 * per-message counts is not required because both sides use the same rule.
 */
export function estimateGeminiPayloadRawTokens(params: GenerateContentParameters): number {
	let total = 0;
	const sys = params.config?.systemInstruction;
	if (sys) {
		total += getApproximateTokenCount(typeof sys === 'string' ? sys : JSON.stringify(sys));
	}
	const contents = params.contents;
	if (Array.isArray(contents)) {
		for (const c of contents as Array<{ parts?: unknown[] }>) {
			const parts = c?.parts;
			if (Array.isArray(parts)) {
				for (const p of parts) {
					total += getApproximateTokenCount(typeof p === 'string' ? p : JSON.stringify(p));
				}
			}
		}
	} else if (typeof contents === 'string') {
		total += getApproximateTokenCount(contents);
	}
	const tools = params.config?.tools;
	if (tools) {
		total += getApproximateTokenCount(JSON.stringify(tools));
	}
	return Math.max(1, total);
}

export function resolveGeminiKnownModelId(apiResourceName: string, knownModels: BYOKKnownModels | undefined): string | undefined {
	if (!knownModels) {
		return undefined;
	}
	const trimmed = apiResourceName.trim();
	if (!trimmed) {
		return undefined;
	}
	if (knownModels[trimmed]) {
		return trimmed;
	}
	const shortId = trimmed.includes('/') ? trimmed.slice(trimmed.lastIndexOf('/') + 1) : trimmed;
	if (!shortId) {
		return undefined;
	}
	const modelsPrefixed = `models/${shortId}`;
	if (knownModels[modelsPrefixed]) {
		return modelsPrefixed;
	}
	if (knownModels[shortId]) {
		return shortId;
	}
	return undefined;
}

export class GeminiNativeBYOKLMProvider extends AbstractLanguageModelChatProvider {

	public static readonly providerName = 'Gemini';

	private readonly _tokenCalibrator: GeminiTokenCalibrator;

	constructor(
		knownModels: BYOKKnownModels | undefined,
		byokStorageService: IBYOKStorageService,
		@ILogService logService: ILogService,
		@IRequestLogger private readonly _requestLogger: IRequestLogger,
		@ITelemetryService private readonly _telemetryService: ITelemetryService,
		@IOTelService private readonly _otelService: IOTelService,
	) {
		super(GeminiNativeBYOKLMProvider.providerName.toLowerCase(), GeminiNativeBYOKLMProvider.providerName, knownModels, byokStorageService, logService);
		this._tokenCalibrator = new GeminiTokenCalibrator(logService);
	}

	protected async getAllModels(silent: boolean, apiKey: string | undefined): Promise<ExtendedLanguageModelChatInformation<LanguageModelChatConfiguration>[]> {
		if (!apiKey && silent) {
			return [];
		}

		try {
			const client = new GoogleGenAI({ apiKey });
			const models = await client.models.list();
			const modelList: Record<string, BYOKModelCapabilities> = {};

			for await (const model of models) {
				const modelId = model.name;
				if (!modelId) {
					continue; // Skip models without names
				}

				// Enable only known models.
				if (this._knownModels && this._knownModels[modelId]) {
					modelList[modelId] = this._knownModels[modelId];
				}
			}
			return byokKnownModelsToAPIInfo(this._name, modelList);
		} catch (e) {
			let error: Error;
			if (e instanceof ApiError) {
				let message = e.message;
				try { message = JSON.parse(message).error?.message; } catch { /* ignore */ }
				error = new Error(message ?? e.message, { cause: e });
			} else {
				error = new Error(toErrorMessage(e, true));
			}
			this._logService.error(error, `Error fetching available ${GeminiNativeBYOKLMProvider.providerName} models`);
			throw error;
		}
	}

	async provideLanguageModelChatResponse(model: ExtendedLanguageModelChatInformation<LanguageModelChatConfiguration>, messages: Array<LanguageModelChatMessage | LanguageModelChatMessage2>, options: ProvideLanguageModelChatResponseOptions, progress: Progress<LanguageModelResponsePart2>, token: CancellationToken): Promise<any> {
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

			const client = new GoogleGenAI({ apiKey });
			// Convert the messages from the API format into messages that we can use against Gemini
			const { contents, systemInstruction } = apiMessageToGeminiMessage(messages as LanguageModelChatMessage[]);

			const requestId = generateUuid();
			const pendingLoggedChatRequest = this._requestLogger.logChatRequest(
				'GeminiNativeBYOK',
				{
					model: model.id,
					modelMaxPromptTokens: model.maxInputTokens,
					urlOrRequestMetadata: 'https://generativelanguage.googleapis.com',
				},
				{
					model: model.id,
					messages: geminiMessagesToRawMessagesForLogging(contents, systemInstruction),
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
					}
				});

			// Convert VS Code tools to Gemini function declarations
			const tools: Tool[] = (options.tools ?? []).length > 0 ? [{
				functionDeclarations: (options.tools ?? []).map(tool => {
					if (!tool.inputSchema) {
						return {
							name: tool.name,
							description: tool.description,
							parameters: {
								type: Type.OBJECT,
								properties: {},
								required: []
							}
						};
					}

					// Transform the input schema to match Gemini's expectations
					const finalTool = toGeminiFunctionDeclaration(tool.name, tool.description, tool.inputSchema as ToolJsonSchema);
					finalTool.description = tool.description || finalTool.description;
					return finalTool;
				})
			}] : [];

			// Bridge VS Code cancellation token to Gemini abortSignal for early network termination
			const abortController = new AbortController();
			const cancelSub = token.onCancellationRequested(() => {
				abortController.abort();
				this._logService.trace('Gemini request aborted via VS Code cancellation token');
			});

			const params: GenerateContentParameters = {
				model: model.id,
				contents: contents,
				config: {
					systemInstruction: systemInstruction,
					tools: tools.length > 0 ? tools : undefined,
					maxOutputTokens: model.maxOutputTokens,
					thinkingConfig: {
						includeThoughts: true,
					},
					abortSignal: abortController.signal
				}
			};

			const wrappedProgress = new RecordedProgress(progress);

			try {
				const result = await this._makeRequest(client, wrappedProgress, params, token, issuedTime);
				if (result.ttft) {
					pendingLoggedChatRequest.markTimeToFirstToken(result.ttft);
				}
				if (result.usage) {
					progress.report(new LanguageModelDataPart(
						new TextEncoder().encode(JSON.stringify(result.usage)),
						CustomDataPartMimeTypes.TokenUsage
					));
				}
				// Feed the self-calibrating estimator with the ground-truth prompt token
				// count returned by Gemini so future `provideTokenCount` calls become more
				// accurate and auto-compact triggers before we blow the context window.
				if (result.usage && typeof result.usage.prompt_tokens === 'number' && result.usage.prompt_tokens > 0) {
					try {
						const rawEstimate = estimateGeminiPayloadRawTokens(params);
						this._tokenCalibrator.calibrate(model.id, rawEstimate, result.usage.prompt_tokens);
					} catch (calibrationError) {
						this._logService.trace(`Gemini token calibration skipped: ${toErrorMessage(calibrationError)}`);
					}
				}
				pendingLoggedChatRequest.resolve({
					type: ChatFetchResponseType.Success,
					requestId,
					serverRequestId: requestId,
					usage: result.usage,
					resolvedModel: model.id,
					value: ['value'],
				}, wrappedProgress.items.map((i): IResponseDelta => {
					return {
						text: i instanceof LanguageModelTextPart ? i.value : '',
						copilotToolCalls: i instanceof LanguageModelToolCallPart ? [{
							name: i.name,
							arguments: JSON.stringify(i.input),
							id: i.callId
						}] : undefined,
					};
				}));

				// Enrich OTel span with usage data from the Gemini response
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

				// Record OTel metrics for this Gemini LLM call
				if (result.usage) {
					const durationSec = (Date.now() - issuedTime) / 1000;
					const metricAttrs = { operationName: GenAiOperationName.CHAT, providerName: 'gemini', requestModel: model.id, responseModel: model.id };
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
					source: 'byok.gemini',
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
				this._logService.error(`BYOK GeminiNative error: ${toErrorMessage(err, true)}`);
				pendingLoggedChatRequest.resolve({
					type: token.isCancellationRequested ? ChatFetchResponseType.Canceled : ChatFetchResponseType.Unknown,
					requestId,
					serverRequestId: requestId,
					reason: token.isCancellationRequested ? 'cancelled' : toErrorMessage(err)
				}, wrappedProgress.items.map((i): IResponseDelta => {
					return {
						text: i instanceof LanguageModelTextPart ? i.value : '',
						copilotToolCalls: i instanceof LanguageModelToolCallPart ? [{
							name: i.name,
							arguments: JSON.stringify(i.input),
							id: i.callId
						}] : undefined,
					};
				}));
				throw err;
			} finally {
				cancelSub.dispose();
			}
		};

		// Create OTel span and execute with trace context + CapturingToken
		const executeRequest = async () => {
			otelSpan = this._otelService.startSpan(`chat ${model.id}`, {
				kind: SpanKind.CLIENT,
				attributes: {
					[GenAiAttr.OPERATION_NAME]: GenAiOperationName.CHAT,
					[GenAiAttr.PROVIDER_NAME]: 'gemini',
					[GenAiAttr.REQUEST_MODEL]: model.id,
					[GenAiAttr.AGENT_NAME]: 'GeminiBYOK',
					[CopilotChatAttr.MAX_PROMPT_TOKENS]: model.maxInputTokens,
					[StdAttr.SERVER_ADDRESS]: 'generativelanguage.googleapis.com',
				},
			});
			// Opt-in: capture input messages in OTel GenAI format
			if (this._otelService.config.captureContent) {
				try {
					const roleNames: Record<number, string> = { 1: 'user', 2: 'assistant', 3: 'system' };
					const inputMsgs = messages.map(m => {
						const msg = m as LanguageModelChatMessage;
						const role = roleNames[msg.role] ?? String(msg.role);
						const parts: Array<{ type: string; content?: string; id?: string; name?: string; arguments?: unknown }> = [];
						if (Array.isArray(msg.content)) {
							for (const p of msg.content) {
								if (p instanceof LanguageModelTextPart) {
									parts.push({ type: 'text', content: p.value });
								} else if (p instanceof LanguageModelToolCallPart) {
									parts.push({ type: 'tool_call', id: p.callId, name: p.name, arguments: p.input });
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

	async provideTokenCount(model: LanguageModelChatInformation, text: string | LanguageModelChatMessage | LanguageModelChatMessage2, token: CancellationToken): Promise<number> {
		// Base estimator is `chars/4`. Multiply by the per-model calibration factor
		// learned from prior `usageMetadata.promptTokenCount` responses so prompt-tsx's
		// context budget tracks Gemini's actual tokenizer instead of undercounting and
		// triggering 400 "input token count exceeds" before auto-compact can fire.
		const raw = getApproximateTokenCount(text);
		const factor = this._tokenCalibrator.getFactor(model.id);
		return Math.ceil(raw * factor);
	}

	/**
	 * Call Gemini's countTokens API to get the exact token count for a payload.
	 * Used by the tiered auto-compact system to verify estimates before deciding
	 * whether to trigger compaction. Also feeds the calibrator with ground truth.
	 *
	 * Returns `undefined` if the API call fails (caller should fall back to estimate).
	 */
	async countTokensViaAPI(
		apiKey: string,
		modelId: string,
		contents: Content[],
		systemInstruction?: Content,
		tools?: Tool[],
	): Promise<number | undefined> {
		try {
			const client = new GoogleGenAI({ apiKey });
			const response = await client.models.countTokens({
				model: modelId,
				contents,
			});
			const totalTokens = response.totalTokens;
			if (typeof totalTokens === 'number' && totalTokens > 0) {
				// Feed calibrator with ground truth from countTokens API
				const rawEstimate = estimateGeminiPayloadRawTokens({
					model: modelId,
					contents,
					config: { systemInstruction, tools },
				} as GenerateContentParameters);
				this._tokenCalibrator.calibrate(modelId, rawEstimate, totalTokens);
				this._logService.debug(`[AutoCompact] countTokens API: ${totalTokens} tokens for ${modelId}`);
			}
			return totalTokens ?? undefined;
		} catch (e) {
			this._logService.warn(`[AutoCompact] countTokens API failed: ${toErrorMessage(e)}`);
			return undefined;
		}
	}

	private async _makeRequest(client: GoogleGenAI, progress: Progress<LMResponsePart>, params: GenerateContentParameters, token: CancellationToken, issuedTime: number): Promise<{ ttft: number | undefined; ttfte: number | undefined; usage: APIUsage | undefined }> {
		const start = Date.now();
		let ttft: number | undefined;
		let ttfte: number | undefined;
		let usage: APIUsage | undefined;

		try {
			const stream = await client.models.generateContentStream(params);

			let pendingThinkingSignature: string | undefined;

			for await (const chunk of stream) {
				if (token.isCancellationRequested) {
					break;
				}

				if (ttft === undefined) {
					ttft = Date.now() - start;
				}

				this._logService.trace(`Gemini chunk: ${JSON.stringify(chunk)}`);

				// Process the streaming response chunks
				if (chunk.candidates && chunk.candidates.length > 0) {
					// choose the primary candidate
					const candidate = chunk.candidates[0];

					if (candidate.content && candidate.content.parts) {
						for (const part of candidate.content.parts) {
							// First, capture thought signature from this part (if present)
							if ('thoughtSignature' in part && part.thoughtSignature) {
								pendingThinkingSignature = part.thoughtSignature as string;
							}
							// Now handle the actual content parts
							if ('thought' in part && part.thought === true && part.text) {
								// Handle thinking/reasoning content from Gemini API
								if (ttfte === undefined) {
									ttfte = Date.now() - issuedTime;
								}
								progress.report(new LanguageModelThinkingPart(part.text));
							} else if (part.text) {
								if (ttfte === undefined) {
									ttfte = Date.now() - issuedTime;
								}
								progress.report(new LanguageModelTextPart(part.text));
							} else if (part.functionCall && part.functionCall.name) {
								// Gemini 3 includes thought signatures for function calling
								// If we have a pending signature, emit it as a thinking part with metadata.signature
								if (pendingThinkingSignature) {
									const thinkingPart = new LanguageModelThinkingPart('', undefined, { signature: pendingThinkingSignature });
									progress.report(thinkingPart);
									pendingThinkingSignature = undefined;
								}

								if (ttfte === undefined) {
									ttfte = Date.now() - issuedTime;
								}
								progress.report(new LanguageModelToolCallPart(
									generateUuid(),
									part.functionCall.name,
									part.functionCall.args || {}
								));
							}
						}
					}
				}

				// Extract usage information if available in the chunk
				// Initialize on first chunk with usageMetadata, then update incrementally
				// This ensures we capture prompt token info even if stream is cancelled mid-way
				if (chunk.usageMetadata) {
					const promptTokens = chunk.usageMetadata.promptTokenCount;
					// For thinking models (e.g., gemini-3-pro-high), candidatesTokenCount only includes
					// regular output tokens. thoughtsTokenCount contains the thinking/reasoning tokens.
					// We include both in the completion token count.
					const candidateTokens = chunk.usageMetadata.candidatesTokenCount ?? 0;
					const thoughtTokens = chunk.usageMetadata.thoughtsTokenCount ?? 0;
					const completionTokens = candidateTokens + thoughtTokens > 0 ? candidateTokens + thoughtTokens : undefined;
					const cachedTokens = chunk.usageMetadata.cachedContentTokenCount;

					if (!usage) {
						// Initialize usage on first chunk - use -1 as sentinel for unavailable values
						usage = {
							completion_tokens: completionTokens ?? -1,
							prompt_tokens: promptTokens ?? -1,
							total_tokens: chunk.usageMetadata.totalTokenCount ?? -1,
							prompt_tokens_details: {
								cached_tokens: cachedTokens ?? 0,
							}
						};
					} else {
						// Update with latest values, preserving existing non-sentinel values
						if (promptTokens !== undefined) {
							usage.prompt_tokens = promptTokens;
						}
						if (completionTokens !== undefined) {
							usage.completion_tokens = completionTokens;
						}
						if (chunk.usageMetadata.totalTokenCount !== undefined) {
							usage.total_tokens = chunk.usageMetadata.totalTokenCount;
						} else if (usage.prompt_tokens !== -1 && usage.completion_tokens !== -1) {
							usage.total_tokens = usage.prompt_tokens + usage.completion_tokens;
						}
						if (cachedTokens !== undefined) {
							usage.prompt_tokens_details!.cached_tokens = cachedTokens;
						}
					}
				}
			}

			return { ttft, ttfte, usage };
		} catch (error) {
			if ((error as any)?.name === 'AbortError' || token.isCancellationRequested) {
				this._logService.trace('Gemini streaming aborted');
				// Return partial usage data collected before cancellation
				return { ttft, ttfte, usage };
			}
			this._logService.error(`Gemini streaming error: ${toErrorMessage(error, true)}`);
			throw error;
		}
	}
}
