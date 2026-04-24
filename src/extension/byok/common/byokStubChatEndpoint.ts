/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// ─── BYOK CUSTOM PATCH: stub chat endpoint for renderPromptElementJSON (Patch 45) ──
// Preserved by .github/scripts/apply-byok-patches.sh. Do not remove.
//
// Purpose. Give `renderPromptElementJSON` in
// `src/extension/prompts/node/base/promptRenderer.ts` a safe last-resort
// value when (a) the `copilot-base` lookup throws because the fake-token
// bypass leaves `_copilotBaseModel` unset and (b) no BYOK provider has
// yet registered a chat endpoint either. Before this patch the fallback
// path threw `"No chat endpoints available (BYOK fallback in
// renderPromptElementJSON)"`, which propagated out of every tool that
// renders its result through that helper (read_file, list_dir,
// file_search, grep_search, get_errors, the edit tools via codeMapper,
// etc.), turning a transient "no model loaded yet" into a hard-stop
// tool error that surfaces as `Sorry, no response was returned.` in
// the chat.
//
// Scope. The endpoint is *only* used for:
//   1. `modelMaxPromptTokens` — read by `PromptRendererForJSON`'s ctor
//      to seed the tsx renderer's token budget. `tokenOptions.tokenBudget`
//      overrides it when present (and all tool callers that matter set
//      it), so the exact value is a soft ceiling.
//   2. `acquireTokenizer()` — used by the same renderer for `tokenLength`
//      / `countMessagesTokens`. Tool-result JSON rendering is rarely
//      close to the budget so a rough char-based estimate is fine.
//   3. Sitting in the DI container as `IPromptEndpoint` so prompt
//      elements can read `family` / `model` / `supportsVision` and
//      similar capability flags. All reads must return sensible defaults
//      that don't trigger model-specific code paths (e.g. `family` must
//      not start with `gpt-5.1-codex`, `model` must not start with
//      `claude-opus`, etc.).
//
// What the stub must NOT be used for: making actual chat requests.
// `makeChatRequest`, `makeChatRequest2`, `processResponseFromChatEndpoint`
// and `createRequestBody` therefore throw with a clear message instead
// of silently returning empty data.
// ─── END BYOK CUSTOM PATCH ─────────────────────

import { OutputMode, Raw } from '@vscode/prompt-tsx';
import type { LanguageModelChatTool } from 'vscode';
import { ChatLocation, ChatResponse } from '../../../platform/chat/common/commonTypes';
import { ILogService } from '../../../platform/log/common/logService';
import { FinishedCallback, OptionalChatRequestParams } from '../../../platform/networking/common/fetch';
import { Response } from '../../../platform/networking/common/fetcherService';
import type { IChatEndpoint, ICreateEndpointBodyOptions, IEndpointBody, IMakeChatRequestOptions } from '../../../platform/networking/common/networking';
import { ChatCompletion } from '../../../platform/networking/common/openai';
import { ITelemetryService, TelemetryProperties } from '../../../platform/telemetry/common/telemetry';
import { TelemetryData } from '../../../platform/telemetry/common/telemetryData';
import { ITokenizer, TokenizerType } from '../../../util/common/tokenizer';
import { AsyncIterableObject } from '../../../util/vs/base/common/async';
import { CancellationToken } from '../../../util/vs/base/common/cancellation';
import { Source } from '../../../platform/chat/common/chatMLFetcher';

/**
 * Rough character-based tokenizer used as a last-resort fallback when no real
 * endpoint (and therefore no real tokenizer) is available. Four characters per
 * token is the conventional OAI-family estimate; it is intentionally coarse —
 * the prompt-tsx rendering path typically has an explicit token budget
 * supplied by the caller, so this tokenizer's output is a soft ceiling rather
 * than a precise budget.
 */
class BYOKStubTokenizer implements ITokenizer {
	public readonly mode = OutputMode.Raw;

	private _approx(text: string): number {
		if (!text) {
			return 0;
		}
		return Math.ceil(text.length / 4);
	}

	async tokenLength(text: string | Raw.ChatCompletionContentPart): Promise<number> {
		if (typeof text === 'string') {
			return this._approx(text);
		}
		// Raw.ChatCompletionContentPartKind.Text = 0 in the enum, but importing
		// the namespace at runtime would drag the full prompt-tsx bundle into
		// `common/`. Instead pattern-match on the string-valued `type` field
		// exposed on every content part.
		const anyPart = text as { type?: unknown; text?: unknown; tokenUsage?: unknown };
		if (typeof anyPart.text === 'string') {
			return this._approx(anyPart.text);
		}
		if (typeof anyPart.tokenUsage === 'number') {
			return anyPart.tokenUsage;
		}
		return 1;
	}

	async countMessageTokens(message: Raw.ChatMessage): Promise<number> {
		let total = 3; // canonical role-header overhead
		const content = (message as { content?: unknown }).content;
		if (typeof content === 'string') {
			total += this._approx(content);
		} else if (Array.isArray(content)) {
			for (const part of content) {
				total += await this.tokenLength(part as Raw.ChatCompletionContentPart);
			}
		}
		return total;
	}

	async countMessagesTokens(messages: Raw.ChatMessage[]): Promise<number> {
		let total = 3;
		for (const m of messages) {
			total += await this.countMessageTokens(m);
		}
		return total;
	}

	async countToolTokens(tools: readonly LanguageModelChatTool[]): Promise<number> {
		let total = tools.length ? 16 : 0;
		for (const t of tools) {
			total += 8;
			total += this._approx(t.name ?? '');
			total += this._approx(t.description ?? '');
			if (t.inputSchema) {
				try {
					total += this._approx(JSON.stringify(t.inputSchema));
				} catch {
					// ignore non-serializable schemas
				}
			}
		}
		return Math.floor(total * 1.1);
	}
}

/**
 * Minimal `IChatEndpoint` implementation used *only* as a last-resort
 * fallback inside `renderPromptElementJSON` when neither the `copilot-base`
 * model nor any registered BYOK endpoint is available yet (typically the
 * very first tool invocation before any BYOK provider has finished
 * registering models). See the module-level header for the full rationale.
 */
export class BYOKStubChatEndpoint implements IChatEndpoint {
	public readonly urlOrRequestMetadata: string = 'byok-stub://no-endpoint';
	public readonly name: string = 'BYOK Stub';
	public readonly version: string = '1.0';
	public readonly family: string = 'byok-stub';
	public readonly tokenizer: TokenizerType = TokenizerType.O200K;
	public readonly modelMaxPromptTokens: number;
	public readonly maxOutputTokens: number = 4096;
	public readonly model: string = 'byok-stub';
	public readonly modelProvider: string = 'byok-stub';
	public readonly supportsToolCalls: boolean = true;
	public readonly supportsVision: boolean = false;
	public readonly supportsPrediction: boolean = false;
	public readonly showInModelPicker: boolean = false;
	public readonly isFallback: boolean = true;
	public readonly isPremium: boolean = false;
	public readonly multiplier: number = 0;
	public readonly maxPromptImages: number = 0;
	public readonly isExtensionContributed: boolean = false;

	private readonly _tokenizer = new BYOKStubTokenizer();

	constructor(modelMaxPromptTokens: number = 128_000) {
		this.modelMaxPromptTokens = modelMaxPromptTokens;
	}

	acquireTokenizer(): ITokenizer {
		return this._tokenizer;
	}

	processResponseFromChatEndpoint(
		_telemetryService: ITelemetryService,
		_logService: ILogService,
		_response: Response,
		_expectedNumChoices: number,
		_finishCallback: FinishedCallback,
		_telemetryData: TelemetryData,
		_cancellationToken?: CancellationToken,
		_location?: ChatLocation,
	): Promise<AsyncIterableObject<ChatCompletion>> {
		throw new Error('BYOKStubChatEndpoint: processResponseFromChatEndpoint is not supported (stub endpoint).');
	}

	makeChatRequest(
		_debugName: string,
		_messages: Raw.ChatMessage[],
		_finishedCb: FinishedCallback | undefined,
		_token: CancellationToken,
		_location: ChatLocation,
		_source?: Source,
		_requestOptions?: Omit<OptionalChatRequestParams, 'n'>,
		_userInitiatedRequest?: boolean,
		_telemetryProperties?: TelemetryProperties,
	): Promise<ChatResponse> {
		throw new Error('BYOKStubChatEndpoint: makeChatRequest is not supported (stub endpoint).');
	}

	makeChatRequest2(_options: IMakeChatRequestOptions, _token: CancellationToken): Promise<ChatResponse> {
		throw new Error('BYOKStubChatEndpoint: makeChatRequest2 is not supported (stub endpoint).');
	}

	createRequestBody(_options: ICreateEndpointBodyOptions): IEndpointBody {
		throw new Error('BYOKStubChatEndpoint: createRequestBody is not supported (stub endpoint).');
	}

	cloneWithTokenOverride(modelMaxPromptTokens: number): IChatEndpoint {
		return new BYOKStubChatEndpoint(modelMaxPromptTokens);
	}
}
