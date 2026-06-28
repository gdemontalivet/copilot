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
// This provider (vendor `gemini`) extends GeminiNativeBYOKLMProvider and
// replaces the generateContentStream call with client.interactions.create().
// GeminiADCLMProvider extends this class to inherit the interactions pipeline
// while injecting ADC credentials.
//
// NOTE: VertexGeminiLMProvider was reverted to extend GeminiNativeBYOKLMProvider
// directly (generateContent path) because Vertex AI does not yet support the
// Interactions API. Update vertexGeminiProvider.ts once Vertex ships GA support.
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
// Vendor: `gemini` — this provider replaces GeminiNativeBYOKLMProvider as the
// primary Gemini vendor. GeminiADCLMProvider (geminiadc) and
// VertexGeminiLMProvider (vertexgemini) extend this class to inherit the
// Interactions API pipeline while injecting their own client credentials.
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

/**
 * Returns true when the API error signals a tool-call ordering constraint
 * violation: "function response turn must come immediately after a function
 * call turn."  This happens when the server's last stored turn was text (not
 * function calls) but we sent FunctionResultStep[] as input — typically after
 * a stale session eviction, a VS Code state/server state divergence, or an
 * unexpected replay of history.
 */
function _isToolOrderError(err: unknown): boolean {
	const msg = String((err as any)?.message ?? '');
	return /function response turn.*immediately after.*function call turn/i.test(msg) ||
		/function call turn.*function response turn/i.test(msg);
}

/**
 * Walk the messages array backwards and return the text of the last user
 * message that has actual text content.  Used as a fallback input when we
 * cannot send function results (session mismatch or fresh session).
 */
function _buildTextFallback(
	messages: Array<LanguageModelChatMessage | LanguageModelChatMessage2>,
): string {
	for (let i = messages.length - 1; i >= 0; i--) {
		const msg = messages[i];
		if ((msg as LanguageModelChatMessage).role !== LanguageModelChatMessageRole.User) { continue; }
		const content = Array.isArray((msg as any).content) ? (msg as any).content as unknown[] : [];
		const textParts = content
			.filter((p): p is LanguageModelTextPart => p instanceof LanguageModelTextPart)
			.map(p => p.value);
		if (textParts.length > 0) { return textParts.join('\n'); }
		if (typeof (msg as any).content === 'string' && (msg as any).content) {
			return (msg as any).content as string;
		}
	}
	return 'Please continue based on the previous context.';
}

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
	const status = (err as any)?.status as number | undefined;
	if (status === 429) { return 'rate-limit'; }
	if (status === 503 || status === 502 || status === 504) { return 'unavailable'; }
	const msg = String((err as any)?.message ?? '').toLowerCase();
	const code = String((err as any)?.code ?? '');
	if (['ECONNRESET', 'ENOTFOUND', 'ETIMEDOUT', 'ECONNREFUSED', 'ERR_NETWORK'].includes(code) ||
		msg.includes('fetch failed') || msg.includes('network error') || msg.includes('socket hang up')) {
		return 'network';
	}
	// The Interactions API streams error events that we rethrow as plain Error objects with
	// the API status code embedded in the message:
	//   "Gemini Interactions API error (too_many_requests): ..."
	//   "Gemini Interactions API error (quota_exceeded): ..."
	//   "Gemini Interactions API error (resource_exhausted): ..."
	// These never have a numeric .status, so the checks above all miss them.
	if (/too_many_requests|quota_exceeded|resource_exhausted/i.test(msg)) { return 'rate-limit'; }
	if (/service_unavailable|server_unavailable|unavailable|internal_error|server_error/i.test(msg) &&
		!/invalid|bad_request|not_found|permission/i.test(msg)) {
		return 'unavailable';
	}
	return null;
}

/**
 * Detects a 404 "not found" error regardless of the SDK wrapper class.
 *
 * The @google/genai SDK wraps errors in internal classes before throwing from
 * client.interactions.create(). At runtime in the minified bundle the error
 * may not be an `instanceof ApiError` even when it represents an HTTP 404,
 * because the bundler may produce a different class instance than the one our
 * import resolves to. We therefore check the numeric .status property first
 * and fall back to a message-content regex so the 404-eviction path is
 * reached regardless of the wrapper class.
 */
function _is404Error(err: unknown): boolean {
	if (err instanceof ApiError) { return err.status === 404; }
	const status = (err as any)?.status;
	if (status === 404) { return true; }
	if (err instanceof Error) {
		return /\b404\b/.test(err.message) && /not\s*found/i.test(err.message);
	}
	return false;
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
 *
 * @param callIdToName Optional map from callId → tool name, used to populate the
 *   required `name` field in FunctionResultStep (must match the FunctionCallStep name).
 */
function _buildInput(
	messages: Array<LanguageModelChatMessage | LanguageModelChatMessage2>,
	callIdToName: ReadonlyMap<string, string> = new Map(),
): string | unknown[] {
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
		// Strip any thinking signature appended to the callId (e.g. 'stepId|signature').
		// The Interactions API requires call_id to exactly match the function_call step's
		// id; the '|signature' suffix is only for Anthropic round-trip and must be dropped.
		const cleanCallId = tr.callId ? tr.callId.split('|')[0] : tr.callId;
		// Look up the tool name — the Interactions API requires 'name' in FunctionResultStep
		// to exactly match the 'name' from the corresponding FunctionCallStep.
		const toolName = callIdToName.get(cleanCallId);
		// The Interactions API rejects plain strings for 'result' — use Array<TextContent>.
		return {
			type: 'function_result',
			call_id: cleanCallId,
			...(toolName ? { name: toolName } : {}),
			result: [{ type: 'text', text: resultText }],
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
	// Include 3.x mainline so users always get the best-available models
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
	// Replaces GeminiNativeBYOKLMProvider ('Gemini'/'gemini') as the primary
	// Gemini vendor. Subclasses (VertexGeminiLMProvider, GeminiADCLMProvider)
	// inherit the Interactions API pipeline and override _name/_id in their
	// own constructors.
	public static override readonly providerName: string = 'Gemini';
	public static override readonly providerId = GeminiInteractionLMProvider.providerName.toLowerCase();
	// ─── END BYOK CUSTOM PATCH ─────────────────────────────────────────────────

	/** Dynamic label for logging/telemetry — picks up subclass _name correctly. */
	protected get _providerLabel(): string {
		return (this as unknown as { _name: string })._name ?? 'Gemini';
	}

	/** fingerprint → latest Interactions API interactionId for that conversation */
	private readonly _interactions = new Map<string, string>();

	/**
	 * callId → tool name, populated when a FunctionCallStep is emitted and
	 * consumed when the matching FunctionResultStep is sent back to the API.
	 * The API requires `name` in FunctionResultStep to match the FunctionCallStep.
	 */
	private readonly _callIdToName = new Map<string, string>();

	/**
	 * fingerprint → whether the most recently completed interaction turn ended
	 * with at least one function call step.
	 *
	 * The Interactions API's ordering constraint requires function_result input
	 * to immediately follow a function_call turn on the server side.  Tracking
	 * this lets us detect mismatches proactively (server thinks last turn was
	 * text, VS Code thinks last message is tool results) and fall back to a
	 * plain-text input instead of triggering an "invalid_request" error.
	 *
	 * Updated at each `interaction.completed` event so it always reflects the
	 * server's view of the PREVIOUS turn when we build the NEXT turn's input.
	 */
	private readonly _lastTurnHadCalls = new Map<string, boolean>();

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
		// providerName is now 'Gemini' (same as GeminiNativeBYOKLMProvider), so
		// _name/'gemini'/_id are already correct after the parent constructor runs.
		// Subclasses (VertexGeminiLMProvider, GeminiADCLMProvider) override _name/_id
		// in their own constructors to 'VertexGemini'/'vertexgemini' etc.
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
			// Only use the stored interaction ID if this conversation has prior
			// assistant exchanges. A brand-new chat whose first message happens to
			// share the same fingerprint as an old chat (same opening text) must
			// NOT inherit that old session — the Interactions API would 404 because
			// the stored ID belongs to an unrelated conversation thread.
			const hasAssistantHistory = messages.some(m =>
				(m as LanguageModelChatMessage).role === LanguageModelChatMessageRole.Assistant
			);
		const previousInteractionId = hasAssistantHistory
			? this._interactions.get(fingerprint)
			: undefined;
		if (!hasAssistantHistory && this._interactions.has(fingerprint)) {
			this._logService.info(
				`[${this._providerLabel}] session cache bypass — no assistant history in messages, treating as fresh conversation (fingerprint: ${fingerprint})`
			);
		}

		// ── History-recovery fallback ────────────────────────────────────────────
		// _interactions is in-memory only.  After a VS Code restart, extension
		// reload, or when the user reopens an old conversation, hasAssistantHistory
		// is true (VS Code passes the full message array) but previousInteractionId
		// is undefined (the session map is empty).  Sending only the last message
		// to a brand-new Interactions API session would give the model zero context.
		//
		// Recovery: delegate to the parent generateContentStream path which builds
		// the full history from the messages array via apiMessageToGeminiMessage.
		// The conversation stays on the generateContent path for its remaining turns
		// (since we never establish a session ID this way), which is the correct
		// behaviour — the user gets accurate responses instead of a context-less reply.
		if (hasAssistantHistory && !previousInteractionId) {
			this._logService.info(
				`[${this._providerLabel}] no session ID for existing conversation (restart/reload?) — falling back to generateContent with full history | fingerprint: ${fingerprint} | messages: ${messages.length}`
			);
			return super.provideLanguageModelChatResponse(model, messages, options, progress, token);
		}
		// ── END history-recovery fallback ────────────────────────────────────────

	// Proactively guard against tool-order constraint violations.
		// The Interactions API requires FunctionResultStep[] input ONLY when the
		// server's previous turn ended with function calls.  We track this via
		// _lastTurnHadCalls (committed at each interaction.completed).
		//   • No previousInteractionId → fresh session, server has no prior turn → text only.
		//   • previousInteractionId but _lastTurnHadCalls says last turn was text → text only.
		//   • previousInteractionId AND _lastTurnHadCalls says last turn had calls → allow tool results.
		//   • previousInteractionId but no _lastTurnHadCalls entry (first-ever tool-result turn for
		//     this fingerprint, e.g. after an extension reload) → we don't know → allow tool results
		//     and rely on the reactive fallback in _makeInteractionRequest's catch block.
		const lastTurnHadCallsEntry = this._lastTurnHadCalls.get(fingerprint);
		const serverExpectsToolResults = !!previousInteractionId &&
			(lastTurnHadCallsEntry === undefined || lastTurnHadCallsEntry === true);
		const rawInput = _buildInput(messages, this._callIdToName);
		const inputWouldBeToolResults = Array.isArray(rawInput) && rawInput.length > 0;
		let input: string | unknown[];
		let effectivePreviousInteractionId = previousInteractionId;
		if (inputWouldBeToolResults && !serverExpectsToolResults) {
			const reason = !previousInteractionId
				? 'no session (fresh start)'
				: `last turn was text (hadCalls=${lastTurnHadCallsEntry})`;
			this._logService.warn(
				`[${this._providerLabel}] tool-result guard: input has ${(rawInput as unknown[]).length} tool result(s) but server does not expect them (${reason}) — using text fallback to avoid ordering error`
			);
			this._interactions.delete(fingerprint);
			this._lastTurnHadCalls.delete(fingerprint);
			effectivePreviousInteractionId = undefined;
			input = _buildTextFallback(messages);
		} else {
			input = rawInput;
		}
		if (Array.isArray(input) && input.length > 0) {
			this._logService.info(
				`[${this._providerLabel}] tool-result input | ${input.length} result(s): ` +
				(input as Array<Record<string, unknown>>).map(r =>
					`call_id=${r['call_id']} name=${r['name'] ?? '(none)'} result="${String((r['result'] as any)?.[0]?.text ?? r['result']).slice(0, 80)}"`
				).join(' | ')
			);
		} else {
			this._logService.info(`[${this._providerLabel}] text input | "${String(input).slice(0, 80)}"`);
		}

			// Convert VS Code tools → Interactions API FunctionT[]
			const tools = (options.tools ?? []).map(tool => ({
				type: 'function' as const,
				name: tool.name,
				description: tool.description,
				parameters: tool.inputSchema ?? { type: 'object', properties: {} },
			}));

			const requestId = generateUuid();
			const pendingLoggedChatRequest = this._requestLogger.logChatRequest(
				this._providerLabel,
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
				this._logService.trace(`${this._providerLabel} request aborted`);
			});

			const wrappedProgress = new RecordedProgress(progress);

			try {
		const result = await this._makeInteractionRequest(
			client, wrappedProgress, {
				model: model.id,
				input,
				store: true,
				previous_interaction_id: effectivePreviousInteractionId,
					system_instruction: systemText || undefined,
					tools: tools.length > 0 ? tools : undefined,
					generation_config: {
						max_output_tokens: model.maxOutputTokens,
						thinking_summaries: 'auto',
					},
					stream: true,
				},
			token, abortController.signal, issuedTime, fingerprint,
			_buildTextFallback(messages),
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
					try {
						wrappedProgress.report(new LanguageModelDataPart(
							new TextEncoder().encode(JSON.stringify(result.usage)),
							CustomDataPartMimeTypes.Usage,
						));
					} catch {
						// VS Code closes the response stream after long requests (e.g. after
						// full retry exhaustion). The usage DataPart is non-fatal — only the
						// context-window ring indicator misses the update. Swallow silently.
					}
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
					const metricAttrs = { operationName: GenAiOperationName.CHAT, providerName: this._providerLabel.toLowerCase(), requestModel: model.id, responseModel: model.id };
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
					source: `byok.${this._providerLabel.toLowerCase()}`, model: model.id, requestId,
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
				this._logService.error(`BYOK ${this._providerLabel} error: ${toErrorMessage(err, true)}`);
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
					[GenAiAttr.AGENT_NAME]: `${this._providerLabel}BYOK`,
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
					? this._otelService.runWithTraceContext(parentTraceContext, executeRequest)
					: executeRequest()
			);
		}
		return parentTraceContext
			? this._otelService.runWithTraceContext(parentTraceContext, executeRequest)
			: executeRequest();
	}

	// ─── Core streaming request ───────────────────────────────────────────────

	private async _makeInteractionRequest(
		client: unknown,
		progress: Progress<LMResponsePart>,
		params: Record<string, unknown>,
		token: CancellationToken,
		signal: AbortSignal,
		issuedTime: number,
		conversationFingerprint: string,
		/** Text-only fallback input; used when the API rejects tool results due to ordering. */
		textFallback?: string,
		retryCount = 0,
	): Promise<{ ttft: number | undefined; ttfte: number | undefined; usage: APIUsage | undefined }> {
		const MAX_RETRIES = 6;
		const CONNECT_TIMEOUT_MS = 120_000;
		// 180s inactivity timeout: if no SSE events arrive within this window the
		// stream has silently stalled (network-level hang, model wedged, upstream
		// bug). Reset on every received event so long-running thinking turns are
		// not interrupted — only genuine silence triggers the abort.
		// 180s is chosen to be safely above observed legitimate deep-thinking turns
		// (gemini-3.5-flash has been seen to take ~102s on complex tasks while
		// still streaming thought_summary events throughout). Genuine hangs are
		// indefinite, not 100-110s, so 180s catches them without false positives.
		const INACTIVITY_TIMEOUT_MS = 180_000;
		const start = Date.now();
		let ttft: number | undefined;
		let ttfte: number | undefined;
		let usage: APIUsage | undefined;

		const hasPrevId = !!params['previous_interaction_id'];
		this._logService.info(
			`[${this._providerLabel}] session turn start | fingerprint: ${conversationFingerprint} | hasSession: ${hasPrevId} | model: ${params['model']}` +
			(hasPrevId ? ` | prevId: ${(params['previous_interaction_id'] as string).slice(0, 16)}…` : ' | prevId: none (fresh)')
		);

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
			// Pass AbortSignal as SDK options so user cancellation propagates into the HTTP layer.
			// The second-arg options shape matches @google/genai v2 (httpOptions.signal).
			stream = await Promise.race([
				interactions.create(params, { signal }) as Promise<AsyncIterable<unknown>>,
				connectTimeout,
			]);

	let pendingThinkingSignature: string | undefined;

	// Buffer for function calls whose arguments arrive via step.delta/arguments_delta.
	// Keyed by step INDEX (e['index'] from StepStart/StepDelta/StepStop events) because
	// StepStop carries index but NOT the step id — matching by index is the only reliable link.
	// Value: { callId (= step.id from FunctionCallStep), name, argsStr (accumulated JSON) }
	const pendingFnCalls = new Map<number, { callId: string; name: string; argsStr: string }>();

	// Track whether this turn emits at least one function call step.
	// Updated at step.stop (function_call) and committed to _lastTurnHadCalls
	// at interaction.completed so the NEXT turn can make the right input choice.
	let currentTurnHadCalls = false;

		// ─── Inactivity timeout around stream iteration ───────────────────
			// The connect timeout above only guards interactions.create() returning the
			// AsyncIterable. Once we have the stream, for-await blocks indefinitely if
			// events stop arriving (model hung, network half-open, upstream bug).
			// We race each iterator.next() against a 90s inactivity promise that resets
			// on every received event — long thinking turns are fine, only true silence
			// triggers the abort.
			let inactivityTimer: ReturnType<typeof setTimeout> | undefined;
			let inactivityReject: ((err: Error) => void) | undefined;
			const inactivityPromise = new Promise<never>((_, reject) => { inactivityReject = reject; });
			const resetInactivityTimer = () => {
				if (inactivityTimer) { clearTimeout(inactivityTimer); }
				inactivityTimer = setTimeout(() => {
					inactivityReject!(new TypeError(`GeminiIA stream inactivity timeout — no events for ${INACTIVITY_TIMEOUT_MS / 1000}s; the stream appears to have silently stalled`));
				}, INACTIVITY_TIMEOUT_MS);
			};
			resetInactivityTimer();

			const streamIterator = (stream as AsyncIterable<unknown>)[Symbol.asyncIterator]();
			try {
				while (true) {
					// Race the next event against the inactivity timeout.
					const iterResult = await Promise.race([
						streamIterator.next() as Promise<IteratorResult<unknown>>,
						inactivityPromise,
					]);
					if (iterResult.done) { break; }

					// Event received — reset the inactivity clock.
					resetInactivityTimer();

					if (token.isCancellationRequested) { break; }

				const e = iterResult.value as Record<string, any>;
				const eventType: string = e['event_type'] ?? '';

				if (ttft === undefined && eventType !== '') {
					ttft = Date.now() - start;
				}

				// Trace every event so we can diagnose tool-result turn silence
				this._logService.info(`[${this._providerLabel}] event | ${eventType || '(no event_type)'} | idx=${e['index'] ?? '-'} | keys=${Object.keys(e).join(',')}`);

				if (eventType === 'interaction.created') {
						// Capture interaction ID for stateful chaining on the next turn
						const id: string | undefined = e['interaction']?.['id'];
						if (id) {
							this._interactions.set(conversationFingerprint, id);
							this._logService.info(
								`[${this._providerLabel}] session created | id: ${id.slice(0, 20)}… | fingerprint: ${conversationFingerprint} | will use on next turn`
							);
						} else {
							this._logService.warn(
								`[${this._providerLabel}] interaction.created event has no id — stateful chaining unavailable for fingerprint: ${conversationFingerprint}`
							);
						}

					} else if (eventType === 'step.start') {
						const step: Record<string, any> = e['step'] ?? {};
						const stepType: string = step['type'] ?? '';

					if (stepType === 'function_call') {
						// Buffer function calls; emit only when step.stop fires for this index
						// (or at stream end). StepStop has 'index' but NOT 'step.id', so we key
						// by the numeric step index that all three event types share.
						const stepIndex: number = e['index'] as number ?? -1;
						// step.id is the call_id the Interactions API requires in function_result
						const stepId: string = (step['id'] as string | undefined) ?? generateUuid();
						let callId = stepId;
						if (pendingThinkingSignature) {
							callId = `${callId}|${pendingThinkingSignature}`;
							progress.report(new LanguageModelThinkingPart('', undefined, { signature: pendingThinkingSignature }));
							pendingThinkingSignature = undefined;
						}
						const seedArgs = step['arguments'];
						const seedStr = (seedArgs && typeof seedArgs === 'object' && Object.keys(seedArgs).length > 0)
							? JSON.stringify(seedArgs)
							: '';
						pendingFnCalls.set(stepIndex, { callId, name: step['name'] ?? '', argsStr: seedStr });
						this._logService.info(`[${this._providerLabel}] fn-call buffered | idx=${stepIndex} | step.id=${stepId} | name=${step['name'] ?? '?'} | seedArgs=${seedStr || '(streaming)'}`);

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

					} else if (deltaType === 'arguments_delta' && delta['arguments']) {
						// Accumulate streaming args for this step (keyed by index).
						const deltaIndex: number = e['index'] as number ?? -1;
						const deltaEntry = pendingFnCalls.get(deltaIndex);
						if (deltaEntry) { deltaEntry.argsStr += delta['arguments'] as string; }
					}

					} else if (eventType === 'step.stop') {
						// Match by step INDEX (StepStop has 'index' but no 'step.id' field).
						const stoppedIndex: number = e['index'] as number ?? -1;
						this._logService.info(`[${this._providerLabel}] step.stop | idx=${stoppedIndex} | pendingCalls=${pendingFnCalls.size}`);
						const stopEntry = pendingFnCalls.get(stoppedIndex);
						if (stopEntry) {
							pendingFnCalls.delete(stoppedIndex);
							let parsedArgs: Record<string, unknown> = {};
							try { parsedArgs = JSON.parse(stopEntry.argsStr || '{}'); } catch { parsedArgs = {}; }
							if (ttfte === undefined) { ttfte = Date.now() - issuedTime; }
						this._logService.info(`[${this._providerLabel}] fn-call emitted (step.stop) | callId=${stopEntry.callId} | name=${stopEntry.name} | args=${stopEntry.argsStr}`);
						// Store callId → name so _buildInput can include 'name' in the FunctionResultStep.
						this._callIdToName.set(stopEntry.callId, stopEntry.name);
						currentTurnHadCalls = true;
						progress.report(new LanguageModelToolCallPart(stopEntry.callId, stopEntry.name, parsedArgs));
						}

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

					} else if (eventType === 'error') {
						// The Interactions API streams an error event when it rejects the input
						// (e.g. invalid function_result call_id, malformed tool schema, etc.).
						// Log the full error payload and throw so the outer catch surfaces it
						// as a readable error rather than silently returning an empty success.
						const apiError: Record<string, any> = e['error'] ?? {};
						const msg: string = apiError['message'] ?? JSON.stringify(apiError);
						const code: string | number = apiError['code'] ?? apiError['status'] ?? '';
						this._logService.error(`[${this._providerLabel}] API error event | code=${code} | message=${msg} | raw=${JSON.stringify(apiError)}`);
						throw new Error(`Gemini Interactions API error${code ? ` (${code})` : ''}: ${msg}`);

				} else if (eventType === 'interaction.completed') {
					// Also available here if the interaction.created event didn't fire yet
					const id: string | undefined = e['interaction']?.['id'];
					if (id && !this._interactions.has(conversationFingerprint)) {
						this._interactions.set(conversationFingerprint, id);
						this._logService.info(
							`[${this._providerLabel}] session captured at interaction.completed | id: ${id.slice(0, 20)}… | fingerprint: ${conversationFingerprint}`
						);
					} else if (id) {
						this._logService.info(
							`[${this._providerLabel}] session completed | id: ${id.slice(0, 20)}… | fingerprint: ${conversationFingerprint} | ready for next turn`
						);
					}
					// Commit whether this turn ended with function calls so the NEXT
					// turn's input builder can decide proactively whether to send
					// FunctionResultStep[] or fall back to plain text.
					this._lastTurnHadCalls.set(conversationFingerprint, currentTurnHadCalls);
					this._logService.info(
						`[${this._providerLabel}] turn committed | fingerprint: ${conversationFingerprint} | hadCalls: ${currentTurnHadCalls}`
					);
				}
				}
			// ── Stream-end drain ──────────────────────────────────────────────
			// Some Interactions API versions close the stream after interaction.completed
			// without emitting step.stop for each function call (particularly
			// gemini-3.1-pro-preview in tool-calling mode). Drain any buffered calls
			// here so they are never silently dropped.
			if (pendingFnCalls.size > 0) {
				this._logService.info(`[${this._providerLabel}] stream-end drain | ${pendingFnCalls.size} buffered call(s) — emitting now`);
				for (const [, pending] of pendingFnCalls) {
					let parsedArgs: Record<string, unknown> = {};
					try { parsedArgs = JSON.parse(pending.argsStr || '{}'); } catch { parsedArgs = {}; }
					if (ttfte === undefined) { ttfte = Date.now() - issuedTime; }
				this._logService.info(`[${this._providerLabel}] fn-call emitted (drain) | name=${pending.name} | args=${pending.argsStr}`);
				// Store callId → name so _buildInput can include 'name' in the FunctionResultStep.
				this._callIdToName.set(pending.callId, pending.name);
				currentTurnHadCalls = true;
				progress.report(new LanguageModelToolCallPart(pending.callId, pending.name, parsedArgs));
				}
				pendingFnCalls.clear();
			}

			} finally {
				if (inactivityTimer) { clearTimeout(inactivityTimer); }
			}

			return { ttft, ttfte, usage };

		} catch (error) {
			if ((error as any)?.name === 'AbortError' || token.isCancellationRequested) {
				return { ttft, ttfte, usage };
			}

			// ─── 404 on expired / invalid previous_interaction_id ─────────────
			// Google's server-side interactions expire. When we sent a
			// previous_interaction_id and get back 404, the stale ID is evicted
			// and we IMMEDIATELY retry as a fresh session (no previous_interaction_id)
			// so the user never sees an error.
			//
			// IMPORTANT: we use _is404Error() rather than `instanceof ApiError`
			// because the @google/genai SDK wraps errors in internal classes before
			// throwing from interactions.create(). In the minified bundle the
			// wrapper class does NOT satisfy `instanceof ApiError`, so the old check
			// was silently skipped — the warn log never fired and the error bubbled
			// to the user. The helper checks .status === 404 and a message regex as
			// fallbacks (observed log pattern: "m4t: 404 Requested entity was not found").
			if (_is404Error(error) && params['previous_interaction_id']) {
				const staleId = params['previous_interaction_id'] as string;
				this._logService.warn(
					`[${this._providerLabel}] session expired (404) — stale id: ${staleId.slice(0, 20)}… | fingerprint: ${conversationFingerprint} | evicting and retrying as fresh session`
				);
				this._interactions.delete(conversationFingerprint);
				// Auto-retry as a fresh session without the stale ID.
				// Strip the stale ID so we don't loop; if this retry also 404s,
				// the second branch below fires and throws (model not supported).
			const freshParams = { ...params };
			delete freshParams['previous_interaction_id'];
			return this._makeInteractionRequest(client, progress, freshParams, token, signal, issuedTime, conversationFingerprint, textFallback, retryCount);
			}
			// 404 without a previous_interaction_id = model not supported on
			// Interactions API — log and surface a specific error message.
			if (_is404Error(error)) {
				this._logService.error(
					`[${this._providerLabel}] 404 without previous_interaction_id — model ${String(params['model'])} may not support the Interactions API. Consider routing through the generateContent-based provider.`
				);
				throw new Error(
					`The model ${String(params['model'])} returned 404 on the Gemini Interactions API. This model may not yet support stateful interactions — please try a different model or switch providers.`,
					{ cause: error }
				);
			}
		// ─── END 404 handling ─────────────────────────────────────────────

		// ─── Reactive tool-order fallback ─────────────────────────────────
		// If the API rejects with a function-response ordering error it means the
		// server's last stored turn was NOT a function call turn — our proactive
		// guard in provideLanguageModelChatResponse missed it (e.g. _lastTurnHadCalls
		// had no entry yet after an extension reload).  Evict the session, clear our
		// state, and immediately retry as a fresh text-input turn so the user never
		// sees the raw error.
		if (_isToolOrderError(error) && textFallback !== undefined) {
			this._logService.warn(
				`[${this._providerLabel}] tool-order error caught reactively — evicting session and retrying with text fallback | fingerprint: ${conversationFingerprint}`
			);
			this._interactions.delete(conversationFingerprint);
			this._lastTurnHadCalls.delete(conversationFingerprint);
			const freshParams = { ...params, input: textFallback };
			delete freshParams['previous_interaction_id'];
			// Pass undefined textFallback for the retry so a second ordering error
			// (shouldn't happen) surfaces normally rather than looping.
			return this._makeInteractionRequest(client, progress, freshParams, token, signal, issuedTime, conversationFingerprint, undefined, retryCount);
		}
		// ─── END reactive tool-order fallback ─────────────────────────────

		// ─── BYOK CUSTOM PATCH: retry on transient errors ─────────────
		const retryKind = _classifyRetryableError(error);
		if (retryKind && retryCount < MAX_RETRIES) {
			const delay = Math.min(5000 * Math.pow(2, retryCount), 60_000);
			const label = retryKind === 'rate-limit' ? '[Rate limit] 429'
				: retryKind === 'unavailable' ? '[Service unavailable]'
				: '[Network error]';
			this._logService.warn(`${this._providerLabel} ${retryKind}, retry ${retryCount + 1}/${MAX_RETRIES} in ${delay}ms: ${_extractReadableGeminiMessage(error)}`);
			progress.report(new LanguageModelThinkingPart(`${label} retry ${retryCount + 1}/${MAX_RETRIES}: waiting ~${Math.ceil(delay / 1000)}s…\n`));
			await new Promise(resolve => setTimeout(resolve, delay));
			if (token.isCancellationRequested) { return { ttft, ttfte, usage }; }
			return this._makeInteractionRequest(client, progress, params, token, signal, issuedTime, conversationFingerprint, textFallback, retryCount + 1);
		}
		// ─── END BYOK CUSTOM PATCH ────────────────────────────────────

			this._logService.error(`${this._providerLabel} streaming error: ${toErrorMessage(error, true)}`);
			throw error;
		}
	}
}
