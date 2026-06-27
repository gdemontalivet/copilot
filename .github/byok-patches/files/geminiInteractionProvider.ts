/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// ─── BYOK CUSTOM PATCH: Gemini Interactions API provider (Patch 60) ──────────
// Preserved by .github/scripts/apply-byok-patches.sh. Do not remove.
//
// Google's Interactions API is the forward-looking endpoint for the Gemini
// family.  New models and capabilities (e.g. gemini-3.5-flash) will launch
// exclusively here and not on the legacy generateContent path.
//
// This provider (vendor `geminiia`) extends GeminiNativeBYOKLMProvider and
// replaces the generateContentStream call with client.interactions.create().
// Everything else — model listing, client construction, OTel instrumentation,
// error extraction, Patch-59 dynamic model discovery — is inherited unchanged.
//
// Key design choices:
//
//   • Stateful chaining via previous_interaction_id.  Each VS Code conversation
//     is identified by a djb2 fingerprint of its first message.  Turn N+1
//     sends only the latest user input (text or tool results); the server holds
//     the history.  This means our auto-compaction patches (4/6/23) have no
//     effect on this provider — Google manages context.  Users who hit limits
//     simply start a new chat.
//
//   • Tool results are detected when the last user message contains
//     LanguageModelToolResultPart items and converted to FunctionResultStep[].
//
//   • Thinking: thinking_summaries="auto" lets the model decide per request.
//     ThoughtSummaryDelta events → LanguageModelThinkingPart.
//     ThoughtSignatureDelta events are embedded in the next tool callId so
//     the VS Code transcript can round-trip the signature back on future turns.
//
//   • Retry: 6 retries with 5→10→20→40→60→60 s backoff on 429/503/network,
//     identical to Patch 8 on the native provider.
//
// Requires @google/genai ≥ 2.3.0 (client.interactions.create available).
// The patch script (Patch 5b) bumps the dependency from ^1.22.0 to ^2.10.0.
//
// Vendor: `geminiia` (lowercase of providerName).
// ─────────────────────────────────────────────────────────────────────────────

import { ApiError } from '@google/genai';
import {
	CancellationToken,
	LanguageModelChatMessage,
	LanguageModelChatMessage2,
	LanguageModelChatMessageRole,
	LanguageModelDataPart,
	LanguageModelResponsePart2,
	LanguageModelTextPart,
	LanguageModelThinkingPart,
	LanguageModelToolCallPart,
	LanguageModelToolResultPart,
	Progress,
	ProvideLanguageModelChatResponseOptions,
} from 'vscode';
import { ChatFetchResponseType, ChatLocation } from '../../../platform/chat/common/commonTypes';
import { ILogService } from '../../../platform/log/common/logService';
import { IResponseDelta, OpenAiFunctionTool } from '../../../platform/networking/common/fetch';
import { APIUsage } from '../../../platform/networking/common/openai';
import { CustomDataPartMimeTypes } from '../../../platform/endpoint/common/endpointTypes';
import {
	CopilotChatAttr,
	emitInferenceDetailsEvent,
	GenAiAttr,
	GenAiMetrics,
	GenAiOperationName,
	GenAiProviderName,
	type OTelModelOptions,
	SpanKind,
	SpanStatusCode,
	StdAttr,
	stringifyToolDefinitionsForOTel,
	truncateForOTel,
} from '../../../platform/otel/common/index';
import { IOTelService } from '../../../platform/otel/common/otelService';
import { IRequestLogger } from '../../../platform/requestLogger/common/requestLogger';
import { retrieveCapturingTokenByCorrelation, runWithCapturingToken } from '../../../platform/requestLogger/node/requestLogger';
import { ITelemetryService } from '../../../platform/telemetry/common/telemetry';
import { toErrorMessage } from '../../../util/common/errorMessage';
import { buildOTelInputFromChatMessages } from './byokOTelHelpers';
import { RecordedProgress } from '../../../util/common/progressRecorder';
import { generateUuid } from '../../../util/vs/base/common/uuid';
import { BYOKKnownModels, LMResponsePart } from '../common/byokProvider';
import { apiMessageToGeminiMessage, geminiMessagesToRawMessagesForLogging } from '../common/geminiMessageConverter';
import { ExtendedLanguageModelChatInformation, LanguageModelChatConfiguration } from './abstractLanguageModelChatProvider';
import { IBYOKStorageService } from './byokStorageService';
import { GeminiNativeBYOKLMProvider } from './geminiNativeProvider';
import { toGeminiFunction, ToolJsonSchema } from '../common/geminiFunctionDeclarationConverter';

// ─── Error helpers (mirrors Patch 7/8 in geminiNativeProvider.ts) ────────────

function _extractReadableGeminiMessage(err: unknown): string {
	if (err instanceof ApiError) {
		try {
			const parsed = JSON.parse(err.message);
			const inner = parsed?.error?.message ?? parsed?.message;
			if (inner) { return String(inner); }
		} catch { /* fall through */ }
		return err.message.split('\n')[0];
	}
	return toErrorMessage(err, false).split('\n')[0];
}

function _classifyRetryableError(err: unknown): 'rate-limit' | 'unavailable' | 'network' | null {
	if (err instanceof ApiError) {
		if (err.status === 429) { return 'rate-limit'; }
		if (err.status === 503 || err.status === 502 || err.status === 504) { return 'unavailable'; }
		return null;
	}
	const msg = String((err as any)?.message ?? '').toLowerCase();
	const code = String((err as any)?.code ?? '');
	if (['ECONNRESET', 'ENOTFOUND', 'ETIMEDOUT', 'ECONNREFUSED', 'ERR_NETWORK'].includes(code) ||
		msg.includes('fetch failed') || msg.includes('network error') || msg.includes('socket hang up')) {
		return 'network';
	}
	return null;
}

// ─── Conversation fingerprint ─────────────────────────────────────────────────

/** djb2 hash of the first message's text — stable for the life of a VS Code conversation. */
function _fingerprint(messages: Array<LanguageModelChatMessage | LanguageModelChatMessage2>): string {
	const first = messages[0];
	let src: string;
	if (typeof (first as any).content === 'string') {
		src = (first as any).content;
	} else {
		const parts: unknown[] = Array.isArray((first as any).content) ? (first as any).content : [];
		src = parts
			.filter((p): p is LanguageModelTextPart => p instanceof LanguageModelTextPart)
			.map(p => p.value)
			.join('')
			.slice(0, 300);
	}
	let h = 5381;
	for (let i = 0; i < src.length; i++) { h = ((h << 5) + h) ^ src.charCodeAt(i); }
	return (h >>> 0).toString(36);
}

// ─── Input builder ────────────────────────────────────────────────────────────

/**
 * Build the Interactions API `input` for the latest turn.
 *
 * - If the last message has LanguageModelToolResultPart items → FunctionResultStep[].
 * - Otherwise → text string from the last user message.
 */
function _buildInput(messages: Array<LanguageModelChatMessage | LanguageModelChatMessage2>): string | unknown[] {
	const last = messages[messages.length - 1];
	const content = Array.isArray((last as any).content) ? (last as any).content as unknown[] : [];

	// Detect tool results
	const toolResults = content.filter(p => p instanceof LanguageModelToolResultPart) as LanguageModelToolResultPart[];
	if (toolResults.length > 0) {
		return toolResults.map(tr => {
			let resultText: string;
			if (typeof tr.content === 'string') {
				resultText = tr.content;
			} else if (Array.isArray(tr.content)) {
				resultText = (tr.content as unknown[])
					.filter((c): c is LanguageModelTextPart => c instanceof LanguageModelTextPart)
					.map(c => c.value)
					.join('\n');
			} else {
				resultText = '';
			}
			return {
				type: 'function_result',
				call_id: tr.callId,
				result: resultText,
			};
		});
	}

	// Text input — join all text parts from the last user message
	const textParts = content
		.filter((p): p is LanguageModelTextPart => p instanceof LanguageModelTextPart)
		.map(p => p.value);
	if (textParts.length > 0) { return textParts.join('\n'); }
	if (typeof (last as any).content === 'string') { return (last as any).content as string; }
	return '';
}

// ─── Known Interactions-only models ──────────────────────────────────────────

const KNOWN_GEMINIA_MODELS: BYOKKnownModels = {
	// Interactions-API-first models (not available on generateContent)
	'gemini-3.5-flash': {
		maxInputTokens: 1_000_000,
		maxOutputTokens: 65_536,
		toolCalling: true,
		vision: true,
		thinking: true,
	},
	// Include 3.x mainline so users don't need to configure both gemini + geminiia
	'gemini-3.1-pro-preview': {
		maxInputTokens: 1_000_000,
		maxOutputTokens: 64_000,
		toolCalling: true,
		vision: true,
		thinking: true,
	},
	'gemini-3.1-flash': {
		maxInputTokens: 1_000_000,
		maxOutputTokens: 64_000,
		toolCalling: true,
		vision: true,
		thinking: true,
	},
	'gemini-3.1-flash-lite-preview': {
		maxInputTokens: 1_000_000,
		maxOutputTokens: 64_000,
		toolCalling: true,
		vision: true,
		thinking: false,
	},
};

// ─── Provider ─────────────────────────────────────────────────────────────────

export class GeminiInteractionLMProvider extends GeminiNativeBYOKLMProvider {
	// ─── BYOK CUSTOM PATCH: subclassable providerName ──────────────────────────
	public static override readonly providerName: string = 'GeminiIA';
	public static override readonly providerId = GeminiInteractionLMProvider.providerName.toLowerCase();
	// ─── END BYOK CUSTOM PATCH ─────────────────────────────────────────────────

	/** fingerprint → latest Interactions API interactionId for that conversation */
	private readonly _interactions = new Map<string, string>();

	constructor(
		knownModels: BYOKKnownModels | undefined,
		byokStorageService: IBYOKStorageService,
		logService: ILogService,
		requestLogger: IRequestLogger,
		telemetryService: ITelemetryService,
		otelService: IOTelService,
	) {
		// Merge caller-supplied knownModels with our Interactions-only defaults so
		// the model picker shows gemini-3.5-flash even if the base model list
		// doesn't include it.
		super(
			{ ...KNOWN_GEMINIA_MODELS, ...(knownModels ?? {}) },
			byokStorageService,
			logService,
			requestLogger,
			telemetryService,
			otelService,
		);
		// The parent chain hardcodes GeminiNativeBYOKLMProvider.providerId ('gemini')
		// and providerName ('Gemini') into the abstract-class constructor, so the
		// instance _id/_name fields are wrong until we override them here.
		// Without this: _byokModelListCacheKey() starts with 'gemini::' for both the
		// native Gemini and GeminiIA providers → they share a cache entry when using
		// the same API key → stale reads / incorrect model lists.  Same pattern as
		// GeminiADCLMProvider.
		(this as unknown as { _name: string })._name = GeminiInteractionLMProvider.providerName;
		(this as unknown as { _id: string })._id = GeminiInteractionLMProvider.providerName.toLowerCase();
	}

	override async provideLanguageModelChatResponse(
		model: ExtendedLanguageModelChatInformation<LanguageModelChatConfiguration>,
		messages: Array<LanguageModelChatMessage | LanguageModelChatMessage2>,
		options: ProvideLanguageModelChatResponseOptions,
		progress: Progress<LanguageModelResponsePart2>,
		token: CancellationToken,
	): Promise<any> {
		const correlationId = (options as { modelOptions?: OTelModelOptions }).modelOptions?._capturingTokenCorrelationId;
		const capturingToken = correlationId ? retrieveCapturingTokenByCorrelation(correlationId) : undefined;
		const telemetryTurn = (options as { modelOptions?: OTelModelOptions }).modelOptions?._telemetryTurn;
		const parentTraceContext = (options as { modelOptions?: OTelModelOptions }).modelOptions?._otelTraceContext ?? undefined;
		let otelSpan: ReturnType<typeof this._otelService.startSpan> | undefined;

		const doRequest = async () => {
			const issuedTime = Date.now();
			const apiKey = model.configuration?.apiKey;
			if (!apiKey) { throw new Error('API key not found for the model'); }

			const client = this.createClient(apiKey, model);
			const { contents, systemInstruction } = apiMessageToGeminiMessage(messages as LanguageModelChatMessage[]);

			// Extract plain-text system instruction (Interactions API takes a string, not Content)
			const systemText = (systemInstruction as any)?.parts
				?.filter((p: any) => p.text)
				.map((p: any) => p.text as string)
				.join('\n') ?? '';

			// Conversation identity
			const fingerprint = _fingerprint(messages);
			const previousInteractionId = this._interactions.get(fingerprint);

			// Build the latest-turn input
			const input = _buildInput(messages);

			// Convert VS Code tools → Interactions API FunctionT[]
			const tools = (options.tools ?? []).map(tool => ({
				type: 'function' as const,
				name: tool.name,
				description: tool.description,
				parameters: tool.inputSchema ?? { type: 'object', properties: {} },
			}));

			const requestId = generateUuid();
			const pendingLoggedChatRequest = this._requestLogger.logChatRequest(
				'GeminiIA',
				{
					model: model.id,
					modelMaxPromptTokens: model.maxInputTokens,
					urlOrRequestMetadata: 'https://generativelanguage.googleapis.com/v1beta/interactions',
				},
				{
					model: model.id,
					messages: geminiMessagesToRawMessagesForLogging(contents, systemInstruction),
					ourRequestId: requestId,
					location: ChatLocation.Other,
					body: {
						tools: options.tools?.map((tool): OpenAiFunctionTool => ({
							type: 'function',
							function: { name: tool.name, description: tool.description, parameters: tool.inputSchema },
						})),
					},
				},
			);

			const abortController = new AbortController();
			const cancelSub = token.onCancellationRequested(() => {
				abortController.abort();
				this._logService.trace('GeminiIA request aborted');
			});

			const wrappedProgress = new RecordedProgress(progress);

			try {
				const result = await this._makeInteractionRequest(
					client, wrappedProgress, {
						model: model.id,
						input,
						store: true,
						previous_interaction_id: previousInteractionId,
						system_instruction: systemText || undefined,
						tools: tools.length > 0 ? tools : undefined,
						generation_config: {
							max_output_tokens: model.maxOutputTokens,
							thinking_summaries: 'auto',
						},
						stream: true,
					},
					token, issuedTime, fingerprint,
				);

				if (result.ttft) { pendingLoggedChatRequest.markTimeToFirstToken(result.ttft); }
				pendingLoggedChatRequest.resolve(
					{
						type: ChatFetchResponseType.Success,
						requestId,
						serverRequestId: requestId,
						usage: result.usage,
						resolvedModel: model.id,
						value: ['value'],
					},
					wrappedProgress.items.map((i): IResponseDelta => ({
						text: i instanceof LanguageModelTextPart ? i.value : '',
						copilotToolCalls: i instanceof LanguageModelToolCallPart ? [{
							name: i.name,
							arguments: JSON.stringify(i.input),
							id: i.callId,
						}] : undefined,
					})),
				);

				if (result.usage) {
					wrappedProgress.report(new LanguageModelDataPart(
						new TextEncoder().encode(JSON.stringify(result.usage)),
						CustomDataPartMimeTypes.Usage,
					));
				}

				if (otelSpan && result.usage) {
					otelSpan.setAttributes({
						[GenAiAttr.USAGE_INPUT_TOKENS]: result.usage.prompt_tokens ?? 0,
						[GenAiAttr.USAGE_OUTPUT_TOKENS]: result.usage.completion_tokens ?? 0,
						[GenAiAttr.RESPONSE_MODEL]: model.id,
						[GenAiAttr.RESPONSE_ID]: requestId,
						[GenAiAttr.RESPONSE_FINISH_REASONS]: ['stop'],
						[GenAiAttr.REQUEST_STREAM]: true,
						...(result.ttft ? { [CopilotChatAttr.TIME_TO_FIRST_TOKEN]: result.ttft } : {}),
					});
				}

				if (result.usage) {
					const durationSec = (Date.now() - issuedTime) / 1000;
					const metricAttrs = { operationName: GenAiOperationName.CHAT, providerName: 'geminiia', requestModel: model.id, responseModel: model.id };
					GenAiMetrics.recordOperationDuration(this._otelService, durationSec, metricAttrs);
					if (result.usage.prompt_tokens) { GenAiMetrics.recordTokenUsage(this._otelService, result.usage.prompt_tokens, 'input', metricAttrs); }
					if (result.usage.completion_tokens) { GenAiMetrics.recordTokenUsage(this._otelService, result.usage.completion_tokens, 'output', metricAttrs); }
				}

				emitInferenceDetailsEvent(this._otelService, { model: model.id, maxTokens: model.maxOutputTokens },
					result.usage ? {
						id: requestId, model: model.id, finishReasons: ['stop'],
						inputTokens: result.usage.prompt_tokens, outputTokens: result.usage.completion_tokens,
					} : undefined,
				);

				this._telemetryService.sendTelemetryEvent('response.success', { github: true, microsoft: true }, {
					source: 'byok.geminiia', model: model.id, requestId,
				}, {
					totalTokenMax: model.maxInputTokens ?? -1,
					...(telemetryTurn !== undefined ? { turn: telemetryTurn } : {}),
					tokenCountMax: model.maxOutputTokens ?? -1,
					promptTokenCount: result.usage?.prompt_tokens,
					tokenCount: result.usage?.total_tokens,
					completionTokens: result.usage?.completion_tokens,
					timeToFirstToken: result.ttft,
					timeToFirstTokenEmitted: result.ttfte,
					timeToComplete: Date.now() - issuedTime,
					issuedTime,
					isBYOK: 1,
				});
			} catch (err) {
				this._logService.error(`BYOK GeminiIA error: ${toErrorMessage(err, true)}`);
				const readableReason = token.isCancellationRequested ? 'cancelled' : _extractReadableGeminiMessage(err);
				pendingLoggedChatRequest.resolve({
					type: token.isCancellationRequested ? ChatFetchResponseType.Canceled : ChatFetchResponseType.Unknown,
					requestId, serverRequestId: requestId, reason: readableReason,
				}, wrappedProgress.items.map((i): IResponseDelta => ({
					text: i instanceof LanguageModelTextPart ? i.value : '',
					copilotToolCalls: i instanceof LanguageModelToolCallPart ? [{
						name: i.name, arguments: JSON.stringify(i.input), id: i.callId,
					}] : undefined,
				})));
				if (token.isCancellationRequested || (err instanceof Error && err.name === 'AbortError')) { throw err; }
				throw new Error(readableReason, { cause: err });
			} finally {
				cancelSub.dispose();
			}
		};

		const executeRequest = async () => {
			otelSpan = this._otelService.startSpan(`chat ${model.id}`, {
				kind: SpanKind.CLIENT,
				attributes: {
					[GenAiAttr.OPERATION_NAME]: GenAiOperationName.CHAT,
					[GenAiAttr.PROVIDER_NAME]: GenAiProviderName.GEMINI,
					[GenAiAttr.REQUEST_MODEL]: model.id,
					[GenAiAttr.AGENT_NAME]: 'GeminiIABYOK',
					[CopilotChatAttr.MAX_PROMPT_TOKENS]: model.maxInputTokens,
					[StdAttr.SERVER_ADDRESS]: 'generativelanguage.googleapis.com',
				},
			});
			if (this._otelService.config.captureContent) {
				const toolDefsJson = stringifyToolDefinitionsForOTel(options.tools);
				if (toolDefsJson) {
					otelSpan.setAttribute(GenAiAttr.TOOL_DEFINITIONS, truncateForOTel(toolDefsJson, this._otelService.config.maxAttributeSizeChars));
				}
				try {
					const { systemTexts, inputMsgs } = buildOTelInputFromChatMessages(messages);
					otelSpan.setAttributes({ ...systemTexts, ...inputMsgs });
				} catch { /* non-fatal */ }
			}
			try {
				await doRequest();
				otelSpan.setStatus({ code: SpanStatusCode.OK });
			} catch (err) {
				otelSpan.recordException(err as Error);
				otelSpan.setStatus({ code: SpanStatusCode.ERROR });
				throw err;
			} finally {
				otelSpan.end();
			}
		};

		if (capturingToken) {
			return runWithCapturingToken(capturingToken, () =>
				parentTraceContext
					? this._otelService.runWithContext(parentTraceContext, executeRequest)
					: executeRequest()
			);
		}
		return parentTraceContext
			? this._otelService.runWithContext(parentTraceContext, executeRequest)
			: executeRequest();
	}

	// ─── Core streaming request ───────────────────────────────────────────────

	private async _makeInteractionRequest(
		client: unknown,
		progress: Progress<LMResponsePart>,
		params: Record<string, unknown>,
		token: CancellationToken,
		issuedTime: number,
		conversationFingerprint: string,
		retryCount = 0,
	): Promise<{ ttft: number | undefined; ttfte: number | undefined; usage: APIUsage | undefined }> {
		const MAX_RETRIES = 6;
		const CONNECT_TIMEOUT_MS = 120_000;
		const start = Date.now();
		let ttft: number | undefined;
		let ttfte: number | undefined;
		let usage: APIUsage | undefined;

		try {
			// client.interactions is available in @google/genai ≥ 2.3.0
			// We use `any` because the local SDK (1.x) doesn't have this property;
			// the patch script upgrades to ^2.10.0 before CI compiles.
			const interactions = (client as any).interactions;

			let stream: AsyncIterable<unknown>;
			const connectTimeout = new Promise<never>((_, reject) =>
				setTimeout(
					() => reject(new TypeError('GeminiIA connect timeout waiting for stream')),
					CONNECT_TIMEOUT_MS,
				)
			);
			stream = await Promise.race([
				interactions.create(params) as Promise<AsyncIterable<unknown>>,
				connectTimeout,
			]);

			let pendingThinkingSignature: string | undefined;

			for await (const rawEvent of stream) {
				if (token.isCancellationRequested) { break; }

				const e = rawEvent as Record<string, any>;
				const eventType: string = e['event_type'] ?? '';

				if (ttft === undefined && eventType !== '') {
					ttft = Date.now() - start;
				}

				if (eventType === 'interaction.created') {
					// Capture interaction ID for stateful chaining on the next turn
					const id: string | undefined = e['interaction']?.['id'];
					if (id) { this._interactions.set(conversationFingerprint, id); }

				} else if (eventType === 'step.start') {
					const step: Record<string, any> = e['step'] ?? {};
					const stepType: string = step['type'] ?? '';

					if (stepType === 'function_call') {
						// Emit immediately — full args are present at step.start
						if (ttfte === undefined) { ttfte = Date.now() - issuedTime; }
						let callId: string = step['id'] ?? generateUuid();
						if (pendingThinkingSignature) {
							callId = `${callId}|${pendingThinkingSignature}`;
							progress.report(new LanguageModelThinkingPart('', undefined, { signature: pendingThinkingSignature }));
							pendingThinkingSignature = undefined;
						}
						progress.report(new LanguageModelToolCallPart(callId, step['name'] ?? '', step['arguments'] ?? {}));

					} else if (stepType === 'thought') {
						if (step['signature']) { pendingThinkingSignature = step['signature'] as string; }
					}

				} else if (eventType === 'step.delta') {
					const delta: Record<string, any> = e['delta'] ?? {};
					const deltaType: string = delta['type'] ?? '';

					if (deltaType === 'text' && delta['text']) {
						if (ttfte === undefined) { ttfte = Date.now() - issuedTime; }
						progress.report(new LanguageModelTextPart(delta['text'] as string));

					} else if (deltaType === 'thought_summary') {
						if (ttfte === undefined) { ttfte = Date.now() - issuedTime; }
						// content is Array<TextContent | ImageContent> — extract text
						const contentArr: Array<Record<string, any>> = Array.isArray(delta['content'])
							? delta['content']
							: delta['content'] ? [delta['content']] : [];
						const thinkingText = contentArr
							.filter(c => c['type'] === 'text' && c['text'])
							.map(c => c['text'] as string)
							.join('');
						if (thinkingText) { progress.report(new LanguageModelThinkingPart(thinkingText)); }

					} else if (deltaType === 'thought_signature' && delta['signature']) {
						pendingThinkingSignature = delta['signature'] as string;
					}
					// 'arguments_delta': we already emitted the tool call at step.start

				} else if (eventType === 'step.stop') {
					// Accumulate usage from the most recent step.stop that has it
					const u: Record<string, any> | undefined = e['usage'] ?? e['metadata']?.['total_usage'];
					if (u) {
						const inputTok = (u['total_input_tokens'] as number | undefined) ?? -1;
						const outputTok = (u['total_output_tokens'] as number | undefined) ?? -1;
						usage = {
							prompt_tokens: inputTok,
							completion_tokens: outputTok,
							total_tokens: inputTok >= 0 && outputTok >= 0 ? inputTok + outputTok : -1,
							prompt_tokens_details: {
								cached_tokens: (u['total_cached_tokens'] as number | undefined) ?? 0,
							},
						};
					}

				} else if (eventType === 'interaction.completed') {
					// Also available here if the interaction.created event didn't fire yet
					const id: string | undefined = e['interaction']?.['id'];
					if (id && !this._interactions.has(conversationFingerprint)) {
						this._interactions.set(conversationFingerprint, id);
					}
				}
			}

			return { ttft, ttfte, usage };

		} catch (error) {
			if ((error as any)?.name === 'AbortError' || token.isCancellationRequested) {
				return { ttft, ttfte, usage };
			}

			// ─── BYOK CUSTOM PATCH: retry on transient errors ─────────────
			const retryKind = _classifyRetryableError(error);
			if (retryKind && retryCount < MAX_RETRIES) {
				const delay = Math.min(5000 * Math.pow(2, retryCount), 60_000);
				const label = retryKind === 'rate-limit' ? '[Rate limit] 429'
					: retryKind === 'unavailable' ? '[Service unavailable]'
					: '[Network error]';
				this._logService.warn(`GeminiIA ${retryKind}, retry ${retryCount + 1}/${MAX_RETRIES} in ${delay}ms: ${_extractReadableGeminiMessage(error)}`);
				progress.report(new LanguageModelThinkingPart(`${label} retry ${retryCount + 1}/${MAX_RETRIES}: waiting ~${Math.ceil(delay / 1000)}s…\n`));
				await new Promise(resolve => setTimeout(resolve, delay));
				if (token.isCancellationRequested) { return { ttft, ttfte, usage }; }
				return this._makeInteractionRequest(client, progress, params, token, issuedTime, conversationFingerprint, retryCount + 1);
			}
			// ─── END BYOK CUSTOM PATCH ────────────────────────────────────

			this._logService.error(`GeminiIA streaming error: ${toErrorMessage(error, true)}`);
			throw error;
		}
	}
}
