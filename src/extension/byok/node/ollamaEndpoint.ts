/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// ─── BYOK CUSTOM PATCH: Ollama think parameter mapping (Patch 62) ────────────
// Preserved by .github/scripts/apply-byok-patches.sh. Do not remove.
//
// Ollama uses a top-level `think` boolean to control Qwen3 (and future)
// reasoning models instead of OpenAI's `reasoning_effort` string. This
// subclass intercepts the body after the base OpenAIEndpoint builds it and:
//
//   reasoning_effort absent / "none"  →  think: false  (suppress reasoning)
//   reasoning_effort low/medium/high  →  think: true   (enable reasoning)
//
// This lets a single `qwen3.6:27b` model serve both use-cases — the user
// picks the effort level in the Copilot model picker and the extension maps
// it to the right Ollama parameter automatically.  No second *-think model
// is needed.
//
// The QwenThinkingStripper in stream.ts (Patch 61) extracts the <think>…
// </think> block from the content stream and routes it to reasoning_content,
// so the collapsible "Thinking" section in Copilot Chat is populated when
// think: true is in effect.
// ─────────────────────────────────────────────────────────────────────────────

import type { CancellationToken } from 'vscode';
import { IChatMLFetcher } from '../../../platform/chat/common/chatMLFetcher';
import { ChatFetchResponseType, ChatResponse } from '../../../platform/chat/common/commonTypes';
import { ConfigKey, IConfigurationService } from '../../../platform/configuration/common/configurationService';
import { IDomainService } from '../../../platform/endpoint/common/domainService';
import { IChatModelInformation } from '../../../platform/endpoint/common/endpointProvider';
import { ILogService } from '../../../platform/log/common/logService';
import { ICreateEndpointBodyOptions, IEndpointBody, IMakeChatRequestOptions } from '../../../platform/networking/common/networking';
import { IChatWebSocketManager } from '../../../platform/networking/node/chatWebSocketManager';
import { IExperimentationService } from '../../../platform/telemetry/common/nullExperimentationService';
import { IChatMLFetcher as _IChatMLFetcher } from '../../../platform/chat/common/chatMLFetcher';
import { ITokenizerProvider } from '../../../platform/tokenizer/node/tokenizer';
import { IInstantiationService } from '../../../util/vs/platform/instantiation/common/instantiation';
import { OpenAIEndpoint } from './openAIEndpoint';

export class OllamaEndpoint extends OpenAIEndpoint {

	private readonly _log: ILogService;

	constructor(
		modelMetadata: IChatModelInformation,
		apiKey: string,
		modelUrl: string,
		@IDomainService domainService: IDomainService,
		@IChatMLFetcher chatMLFetcher: IChatMLFetcher,
		@ITokenizerProvider tokenizerProvider: ITokenizerProvider,
		@IInstantiationService instantiationService: IInstantiationService,
		@IConfigurationService configurationService: IConfigurationService,
		@IExperimentationService expService: IExperimentationService,
		@IChatWebSocketManager chatWebSocketService: IChatWebSocketManager,
		@ILogService logService: ILogService
	) {
		super(
			modelMetadata,
			apiKey,
			modelUrl,
			domainService,
			chatMLFetcher,
			tokenizerProvider,
			instantiationService,
			configurationService,
			expService,
			chatWebSocketService,
			logService
		);
		this._log = logService;
	}

	override interceptBody(body: IEndpointBody | undefined): void {
		super.interceptBody(body);
		if (!body) {
			return;
		}

		// Map reasoning_effort → Ollama's think boolean.
		const effort = body.reasoning_effort as string | undefined;
		if (!effort || effort === 'none') {
			(body as any)['think'] = false;
		} else {
			(body as any)['think'] = true;
		}
		delete body.reasoning_effort;

		// Local 27B models have a 32K context window. VS Code's agent passes 80+
		// tool schemas which consumes ~15-20K tokens before any conversation.
		// Strip tools so the model can actually respond within its context budget.
		if (Array.isArray((body as any).tools)) {
			delete (body as any).tools;
			delete (body as any).tool_choice;
		}

		// ── DEBUG LOGGING ──────────────────────────────────────────────────────
		const preview = {
			model: (body as any).model,
			think: (body as any).think,
			stream: (body as any).stream,
			tools: Array.isArray((body as any).tools) ? `${(body as any).tools.length} tools` : 'none',
			messages: Array.isArray((body as any).messages)
				? (body as any).messages.map((m: any) => `[${m.role}] ${String(m.content ?? '').slice(0, 80)}`)
				: [],
		};
		this._log.info(`[OllamaEndpoint] → sending to Ollama: ${JSON.stringify(preview)}`);
		// ── END DEBUG LOGGING ──────────────────────────────────────────────────
	}
}
