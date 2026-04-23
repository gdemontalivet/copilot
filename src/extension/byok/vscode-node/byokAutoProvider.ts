/*---------------------------------------------------------------------------------------------
 *  BYOK CUSTOM FILE (Patch 34). Canonical copy under
 *  `.github/byok-patches/files/byokAutoProvider.ts` and installed into
 *  `src/extension/byok/vscode-node/` by `.github/scripts/apply-byok-patches.sh`
 *  on every upstream sync. Do not edit the installed copy directly.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import {
	CancellationToken,
	LanguageModelChat,
	LanguageModelChatInformation,
	LanguageModelChatMessage,
	LanguageModelChatMessage2,
	LanguageModelChatProvider,
	LanguageModelResponsePart2,
	LanguageModelTextPart,
	PrepareLanguageModelChatModelOptions,
	Progress,
	ProvideLanguageModelChatResponseOptions,
} from 'vscode';
import { ConfigKey, IConfigurationService } from '../../../platform/configuration/common/configurationService';
import { ILogService } from '../../../platform/log/common/logService';

/**
 * Synthetic "Auto" model that lives in the BYOK world.
 *
 * Upstream Copilot Chat exposes `copilot/auto` as a pseudo-model backed by
 * `AutomodeService`, which POSTs to a CAPI `auto_mode` endpoint with the
 * Copilot session token to decide which real model to dispatch to. That path
 * does not survive the BYOK fake-token bypass (Patch 1): CAPI rejects the
 * fake token, the throw in `AutomodeService.resolveAutoModeEndpoint`
 * propagates through VS Code's `LanguageModelProxy.getModelForRequest`, and
 * the UI surfaces it as "Language model unavailable" on every turn.
 *
 * This provider registers a parallel `byokauto` vendor so the picker shows a
 * "BYOK Auto" entry that resolves entirely client-side. On each request it
 * reads `chat.byok.auto.defaultModel` (formatted as `vendor/modelId`, e.g.
 * `vertexgemini/gemini-3.1-pro-preview`), resolves the target model via
 * `vscode.lm.selectChatModels`, and forwards the request through
 * `model.sendRequest(...)` — which re-enters the VS Code LM API and delegates
 * to the target provider's own `provideLanguageModelChatResponse`. The
 * response stream is piped back to the caller's `progress` reporter
 * unchanged.
 *
 * This is intentionally the "simple" stage (B2 in the design):
 *   - No classifier. Every request goes to the configured default model.
 *   - No routing table. The default model is a single setting value.
 *   - No topic-change detection or auto-compaction.
 *
 * It exists so users can actually *pick* Auto in the picker today and get a
 * working request flow while the full classifier-driven router (Patch 30's
 * `ByokRoutingClassifier` + a routing table) lands on top later (B3). The
 * public contract of this class is deliberately narrow so the B3 follow-up
 * can swap the resolution step (`_resolveTargetModel`) for classifier-driven
 * logic without touching the registration wire-up or the request plumbing.
 */
export class BYOKAutoLMProvider implements LanguageModelChatProvider<LanguageModelChatInformation> {

	public static readonly providerName: string = 'BYOKAuto';
	public static readonly vendorId: string = 'byokauto';
	public static readonly modelId: string = 'auto';

	/**
	 * Default fallback when `chat.byok.auto.defaultModel` is not configured.
	 *
	 * Chosen because the Vertex Gemini provider (Patch 26-29) is present in
	 * every BYOK install that enables this provider, has the widest context
	 * window in the free-tier, and supports vision + tools. If the user has
	 * not provisioned Vertex access, resolution will fail with a clear error
	 * telling them which setting to populate.
	 */
	private static readonly DEFAULT_TARGET = 'vertexgemini/gemini-3.1-pro-preview';

	private readonly _onDidChange = new vscode.EventEmitter<void>();
	public readonly onDidChangeLanguageModelChatInformation = this._onDidChange.event;

	constructor(
		@IConfigurationService private readonly _configurationService: IConfigurationService,
		@ILogService private readonly _logService: ILogService,
	) { }

	dispose(): void {
		this._onDidChange.dispose();
	}

	async provideLanguageModelChatInformation(
		_options: PrepareLanguageModelChatModelOptions,
		_token: CancellationToken,
	): Promise<LanguageModelChatInformation[]> {
		// Surface a single synthetic model. Capability flags are copied to be
		// maximally permissive — the real enforcement happens when we delegate
		// to the underlying target model, which advertises its own accurate
		// capabilities. Leaving these fields tight here would cause the UI to
		// hide features like tool-calling for users on providers that do
		// support them.
		return [{
			id: BYOKAutoLMProvider.modelId,
			name: 'BYOK Auto',
			family: 'byok-auto',
			version: '1.0.0',
			maxInputTokens: 1_000_000,
			maxOutputTokens: 64_000,
			tooltip: 'Routes to the model configured in `chat.byok.auto.defaultModel`. Future versions will classify each prompt and pick the cheapest capable model.',
			detail: this._describeConfiguredTarget(),
			category: { label: '', order: Number.MIN_SAFE_INTEGER },
			capabilities: {
				toolCalling: true,
				imageInput: true,
			},
		} satisfies LanguageModelChatInformation];
	}

	async provideLanguageModelChatResponse(
		_model: LanguageModelChatInformation,
		messages: Array<LanguageModelChatMessage | LanguageModelChatMessage2>,
		options: ProvideLanguageModelChatResponseOptions,
		progress: Progress<LanguageModelResponsePart2>,
		token: CancellationToken,
	): Promise<void> {
		const target = await this._resolveTargetModel(token);
		this._logService.trace(`[BYOKAutoLMProvider] Delegating to ${target.vendor}/${target.id} (${target.name})`);

		// Emit a one-line routing hint as the very first stream part so the
		// user can see which concrete model Auto picked for this turn. The
		// picker header stays "BYOK Auto" regardless of where we route, which
		// is actively confusing once the B3 classifier starts picking
		// different models per prompt. A text part here renders as markdown
		// in the chat UI and is cheap: one line, ~6 tokens, and costs zero
		// extra LLM calls. Gated behind `chat.byok.auto.showRoutingHint`
		// (default on) so users who want their chat transcript pristine can
		// turn it off without losing routing visibility — the same info is
		// still written to the log at trace level.
		if (this._readShowRoutingHint()) {
			progress.report(new LanguageModelTextPart(`_via \`${target.vendor}/${target.id}\`_\n\n`));
		}

		const response = await target.sendRequest(
			messages,
			{
				modelOptions: options.modelOptions,
				toolMode: options.toolMode,
				tools: options.tools,
				justification: 'BYOK Auto delegating to configured default model',
			},
			token,
		);

		// `response.stream` yields parts that are structurally compatible with
		// `LanguageModelResponsePart2` — text, tool calls, thinking, data
		// parts. We forward unchanged so the caller observes the raw target
		// stream: tool-call ids, thinking blocks, and cache markers all reach
		// the agent loop intact.
		for await (const part of response.stream) {
			if (token.isCancellationRequested) {
				return;
			}
			progress.report(part as LanguageModelResponsePart2);
		}
	}

	async provideTokenCount(
		_model: LanguageModelChatInformation,
		text: string | LanguageModelChatMessage | LanguageModelChatMessage2,
		token: CancellationToken,
	): Promise<number> {
		// Token counting needs to reflect the *target* model's tokenizer or
		// the agent's budget math will be wildly off. Defer to the target.
		// If resolution fails, fall back to a 4-chars-per-token heuristic
		// rather than throwing — token-count failures otherwise take down
		// entire turns in callers that don't guard the call.
		try {
			const target = await this._resolveTargetModel(token);
			return target.countTokens(text as LanguageModelChatMessage, token);
		} catch (err) {
			const s = typeof text === 'string' ? text : this._stringifyMessage(text);
			this._logService.warn(`[BYOKAutoLMProvider] provideTokenCount fallback (heuristic): ${(err as Error).message}`);
			return Math.ceil(s.length / 4);
		}
	}

	/**
	 * Read `chat.byok.auto.defaultModel` and resolve the matching
	 * `LanguageModelChat`. Exposed as a protected seam so the future B3
	 * patch can override with classifier-driven selection without touching
	 * the rest of the provider.
	 */
	protected async _resolveTargetModel(_token: CancellationToken): Promise<LanguageModelChat> {
		const raw = this._readDefaultModelSetting();
		const parsed = this._parseTargetSpec(raw);
		if (!parsed) {
			throw new Error(
				`BYOK Auto: \`chat.byok.auto.defaultModel\` is not a valid 'vendor/modelId' string (got: ${JSON.stringify(raw)}). ` +
				`Example: "vertexgemini/gemini-3.1-pro-preview".`,
			);
		}

		const { vendor, id } = parsed;
		if (vendor === BYOKAutoLMProvider.vendorId) {
			// Catch the obvious infinite-loop trap. The picker lists
			// BYOK Auto itself, so a user typo like `byokauto/auto` in the
			// setting would otherwise dispatch back to this provider and
			// blow the stack.
			throw new Error(
				`BYOK Auto: cannot route to itself. Set \`chat.byok.auto.defaultModel\` to a concrete model like 'vertexgemini/gemini-3.1-pro-preview'.`,
			);
		}

		const candidates = await vscode.lm.selectChatModels({ vendor, id });
		if (candidates.length === 0) {
			throw new Error(
				`BYOK Auto: no chat model matches vendor='${vendor}', id='${id}'. ` +
				`Check that the BYOK provider is enabled and the model id is spelled correctly in \`chat.byok.auto.defaultModel\`.`,
			);
		}
		return candidates[0];
	}

	private _readShowRoutingHint(): boolean {
		// Setting defaults to `true` (Patch 38). Any non-false value enables
		// the hint; unit-test stubs that don't know the key fall through and
		// we default to enabled so it's visible out of the box.
		try {
			const value = this._configurationService.getConfig(ConfigKey.ByokAutoShowRoutingHint);
			return value !== false;
		} catch {
			return true;
		}
	}

	private _readDefaultModelSetting(): string {
		// Use the ConfigurationService (Patch 35 setting). Falls back to the
		// compiled-in default when the user hasn't set anything, so a fresh
		// BYOK install still has a working Auto out of the box (provided the
		// Vertex Gemini provider is configured).
		try {
			const value = this._configurationService.getConfig(ConfigKey.ByokAutoDefaultModel);
			if (typeof value === 'string' && value.trim().length > 0) {
				return value.trim();
			}
		} catch {
			// ConfigKey might not exist in unit-test stubs; fall through.
		}
		return BYOKAutoLMProvider.DEFAULT_TARGET;
	}

	private _parseTargetSpec(raw: string): { vendor: string; id: string } | undefined {
		if (typeof raw !== 'string') {
			return undefined;
		}
		// Format: `vendor/modelId`. The modelId can contain slashes itself
		// (e.g. `openrouter/anthropic/claude-3.7-sonnet`) so split only on
		// the first `/`.
		const idx = raw.indexOf('/');
		if (idx < 1 || idx === raw.length - 1) {
			return undefined;
		}
		const vendor = raw.slice(0, idx).trim();
		const id = raw.slice(idx + 1).trim();
		if (!vendor || !id) {
			return undefined;
		}
		return { vendor, id };
	}

	private _describeConfiguredTarget(): string {
		const raw = this._readDefaultModelSetting();
		const parsed = this._parseTargetSpec(raw);
		if (!parsed) {
			return 'no default configured';
		}
		return `→ ${parsed.vendor}/${parsed.id}`;
	}

	private _stringifyMessage(msg: LanguageModelChatMessage | LanguageModelChatMessage2): string {
		const content = (msg as { content?: unknown }).content;
		if (typeof content === 'string') {
			return content;
		}
		if (Array.isArray(content)) {
			return content
				.map(p => {
					if (typeof p === 'string') {
						return p;
					}
					if (p && typeof p === 'object' && 'value' in p && typeof (p as { value: unknown }).value === 'string') {
						return (p as { value: string }).value;
					}
					return '';
				})
				.join('');
		}
		return '';
	}
}
