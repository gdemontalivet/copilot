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
import {
	DEFAULT_ROUTING_TABLE,
	mergeRoutingTable,
	RoutableModel,
	routeToTarget,
	RoutingTable,
} from '../common/byokAutoRouter';
import type {
	ClassificationInput,
	ClassificationResult,
	IByokRoutingClassifier,
	VertexClassifierConfig,
} from '../common/byokRoutingClassifier.types';
import { classifyByHeuristic, isTrivialPrompt } from '../common/byokRoutingHeuristics';
import type { IBYOKStorageService } from './byokStorageService';

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
	// IMPORTANT: must NOT be `'auto'`. VS Code's chat model picker at the
	// bottom of the chat box de-duplicates the model list by `metadata.id`
	// *without* vendor qualification. Upstream Copilot already reserves
	// `id: 'auto'` (for `copilot/auto`), which means any other model that
	// also advertises `id: 'auto'` is silently filtered out of the picker.
	// The global Language Models settings panel uses the fully-qualified
	// identifier (`vendor/group/id`) and is unaffected — that asymmetry is
	// exactly what was observed: the entry showed up under "Language Models"
	// but never appeared in the in-chat selector.
	public static readonly modelId: string = 'byok-auto';

	/**
	 * Vendor preference order for auto-discovery (Patch 39). When
	 * `chat.byok.auto.defaultModel` is unset, we walk this list and pick
	 * the first vendor that has at least one registered model. Rationale:
	 *
	 *   1. `gemini` — the user's primary BYOK key. Wide context, cheap,
	 *      vision + tool calling. This is the default "just works" target.
	 *   2. `vertexgemini` — same model family via GCP service account, used
	 *      when the direct Gemini key isn't configured.
	 *   3. `anthropic` — Claude direct API (BYOK Anthropic provider).
	 *   4. `vertexanthropic` — Claude on Vertex, used as the Anthropic
	 *      failover target (Patch 21) and the classifier fallback (Patch 30).
	 *   5. Anything else (OpenAI / xAI / OpenRouter / etc.) — last resort
	 *      so Auto still resolves on BYOK installs that don't run Gemini
	 *      or Anthropic.
	 *
	 * The old compiled-in default (`vertexgemini/gemini-3.1-pro-preview`)
	 * assumed every install had Vertex configured, which is false — most
	 * users have the direct `gemini` vendor instead. That mismatch is what
	 * surfaced as "Language model unavailable" before Patch 39.
	 */
	private static readonly AUTO_DISCOVERY_VENDOR_PRIORITY: readonly string[] = [
		'gemini',
		'vertexgemini',
		'anthropic',
		'vertexanthropic',
	];

	/**
	 * Within a vendor, prefer models that look "capable enough for agent
	 * work" over tiny/legacy variants. Matching is case-insensitive and
	 * uses substring containment on the model's `id` and `family`. Order
	 * matters: the first match wins. If nothing matches, we fall back to
	 * the first model the vendor advertised (VS Code typically lists the
	 * newest/default first anyway).
	 */
	private static readonly AUTO_DISCOVERY_MODEL_PREFERENCE: readonly string[] = [
		'gemini-3.1-pro',
		'gemini-3-pro',
		'gemini-3-flash',
		'gemini-2.5-pro',
		'gemini-2.0-flash',
		'claude-sonnet-4',
		'claude-opus-4',
		'claude-haiku',
		'gpt-5',
		'gpt-4.1',
	];

	private readonly _onDidChange = new vscode.EventEmitter<void>();
	public readonly onDidChangeLanguageModelChatInformation = this._onDidChange.event;

	/**
	 * Lazily-constructed classifier shared across turns. Re-built when
	 * credentials change (Gemini key rotation, Vertex config edit). The
	 * shape `{ credentialFingerprint, classifier }` lets us invalidate
	 * the cache cheaply without re-reading credentials on every hot-path
	 * call — we only reach for storage/config again when the fingerprint
	 * from the current read differs from the cached one.
	 */
	private _cachedClassifier: {
		readonly credentialFingerprint: string;
		readonly classifier: IByokRoutingClassifier;
	} | undefined;

	constructor(
		// Positional non-DI params match the pattern used by the other
		// BYOK providers (see `GeminiNativeBYOKLMProvider`,
		// `AnthropicLMProvider`). `IBYOKStorageService` is not a DI
		// decorator — `byokContribution.ts` constructs it once and
		// passes it to every provider explicitly.
		private readonly _byokStorageService: IBYOKStorageService,
		@IConfigurationService private readonly _configurationService: IConfigurationService,
		@ILogService private readonly _logService: ILogService,
	) { }

	dispose(): void {
		this._onDidChange.dispose();
		this._cachedClassifier = undefined;
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
			// `isUserSelectable: true` is REQUIRED for VS Code's chat
			// model picker to enable the entry for selection. Without
			// it the picker renders the model in the list but greys it
			// out / ignores clicks — the exact symptom reported when
			// "BYOK Auto" shows up but can't be chosen. Every other
			// BYOK model sets this via `byokKnownModelToAPIInfo` in
			// `byokProvider.ts`; upstream's `copilot/auto` sets it in
			// `copilotCli.ts`'s `buildAutoModel`.
			isUserSelectable: true,
			// `multiplierNumeric: 0` marks this as "not metered" so the
			// picker doesn't render the "X × pricing" chip (we're not a
			// billable first-party model). Matches `byokKnownModelToAPIInfo`.
			multiplierNumeric: 0,
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
		// Patch 40: routing mode selects between the static target
		// (Patches 34–39) and the classifier-driven router. Resolution
		// happens per-turn because the classifier's output depends on
		// the message payload.
		const resolution = await this._resolveRouting(messages as any, token);
		const target = resolution.target;
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
			progress.report(new LanguageModelTextPart(this._formatRoutingHint(resolution)));
		}

		const response = await target.sendRequest(
			messages as any,
			{
				modelOptions: options.modelOptions,
				toolMode: options.toolMode,
				tools: options.tools as any,
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
		//
		// `provideTokenCount` doesn't receive the message history, so we
		// skip the classifier and resolve against the static path —
		// token counting happens per-part and misrouting here would be
		// expensive (every part would reclassify). The actual routing
		// decision for the turn still runs in
		// `provideLanguageModelChatResponse`.
		try {
			const target = await this._resolveStaticTarget(token);
			return target.countTokens(text as LanguageModelChatMessage, token);
		} catch (err) {
			const s = typeof text === 'string' ? text : this._stringifyMessage(text);
			this._logService.warn(`[BYOKAutoLMProvider] provideTokenCount fallback (heuristic): ${(err as Error).message}`);
			return Math.ceil(s.length / 4);
		}
	}

	/**
	 * Patch 40 top-level resolution entry point. Dispatches on
	 * `chat.byok.auto.routingMode`:
	 *   - `'static'`     → Patch 39 static pipeline (setting or
	 *                      vendor-priority auto-discovery).
	 *   - `'classifier'` → Patch 40 classifier + router pipeline, with
	 *                      the static path as a safety net if the
	 *                      classifier is misconfigured or the router
	 *                      can't find a target.
	 *
	 * Returns a {@link RoutingResolution} carrying enough metadata for
	 * the routing hint (Patch 38 / 40) to describe *why* we picked the
	 * target. That metadata is deliberately held here rather than
	 * re-computed in the hint formatter so the trace log and the hint
	 * line stay consistent.
	 */
	protected async _resolveRouting(
		messages: ReadonlyArray<LanguageModelChatMessage | LanguageModelChatMessage2>,
		token: CancellationToken,
	): Promise<RoutingResolution> {
		const mode = this._readRoutingMode();
		if (mode === 'classifier') {
			const classifier = await this._getOrCreateClassifier();
			if (classifier) {
				try {
					const resolution = await this._resolveViaClassifier(classifier, messages as any, token);
					if (resolution) {
						return resolution;
					}
				} catch (err) {
					// Anything escaping `_resolveViaClassifier` is a
					// bug-or-degradation signal. Log it and fall
					// through to static mode — the worst-case behaviour
					// in classifier mode should never be worse than the
					// static path.
					this._logService.warn(
						`[BYOKAutoLMProvider] Classifier routing failed, falling back to static path: ${(err as Error).message}`,
					);
				}
			} else {
				this._logService.trace(`[BYOKAutoLMProvider] Classifier mode enabled but no credentials available — using static path.`);
			}
		}

		const target = await this._resolveStaticTarget(token);
		return { target, mode: 'static' };
	}

	/**
	 * Read `chat.byok.auto.defaultModel` and resolve the matching
	 * `LanguageModelChat`. Exposed as a protected seam so the classifier
	 * mode (Patch 40) can fall back here when it can't produce a
	 * routing decision.
	 *
	 * Resolution order (Patch 39):
	 *   1. If the setting is a well-formed `vendor/modelId` string, try it
	 *      first. On hit → use it. On miss (no matching model registered)
	 *      we fall through to auto-discovery rather than throwing, so a
	 *      stale user setting (e.g. pointing at a vendor they later
	 *      disabled) never bricks Auto mode.
	 *   2. If the setting is empty/malformed OR step 1 missed, walk
	 *      `AUTO_DISCOVERY_VENDOR_PRIORITY` and pick the first vendor with
	 *      at least one registered model. Within that vendor, prefer a
	 *      model from `AUTO_DISCOVERY_MODEL_PREFERENCE`; fall back to the
	 *      first one advertised.
	 *   3. Only if *no* non-`byokauto` model is registered at all do we
	 *      throw with an actionable message.
	 */
	protected async _resolveStaticTarget(_token: CancellationToken): Promise<LanguageModelChat> {
		const raw = this._readDefaultModelSetting();
		const parsed = raw ? this._parseTargetSpec(raw) : undefined;

		if (parsed) {
			if (parsed.vendor === BYOKAutoLMProvider.vendorId) {
				// Catch the obvious infinite-loop trap. The picker lists
				// BYOK Auto itself, so a user typo like `byokauto/auto`
				// would otherwise dispatch back to this provider and blow
				// the stack.
				throw new Error(
					`BYOK Auto: cannot route to itself. Set \`chat.byok.auto.defaultModel\` to a concrete model like 'gemini/gemini-3.1-pro-preview', or clear the setting to let BYOK Auto pick one for you.`,
				);
			}

			const explicit = await vscode.lm.selectChatModels({ vendor: parsed.vendor, id: parsed.id });
			if (explicit.length > 0) {
				return explicit[0];
			}

			// Setting points at a model that isn't currently registered.
			// Rather than failing the turn, log and fall through to
			// auto-discovery. This keeps BYOK Auto resilient to users who
			// rotate vendors without clearing the setting.
			this._logService.warn(
				`[BYOKAutoLMProvider] Configured target '${parsed.vendor}/${parsed.id}' is not registered; falling back to auto-discovery.`,
			);
		} else if (raw) {
			this._logService.warn(
				`[BYOKAutoLMProvider] \`chat.byok.auto.defaultModel\` is not a valid 'vendor/modelId' (got: ${JSON.stringify(raw)}); using auto-discovery.`,
			);
		}

		const discovered = await this._autoDiscoverTarget();
		if (discovered) {
			return discovered;
		}

		throw new Error(
			`BYOK Auto: no BYOK models are registered. Enable at least one BYOK provider (Gemini, Anthropic, OpenAI, …) from the model picker, or set \`chat.byok.auto.defaultModel\` to 'vendor/modelId'.`,
		);
	}

	/**
	 * Walk `AUTO_DISCOVERY_VENDOR_PRIORITY` and return the first viable
	 * target. Separated from `_resolveTargetModel` so the B3 classifier
	 * patch can reuse it as its "prompt class had no rule → use default"
	 * path without re-implementing the vendor preference logic.
	 */
	protected async _autoDiscoverTarget(): Promise<LanguageModelChat | undefined> {
		// One unfiltered call rather than N filtered calls — cheaper, and
		// matches how the model picker itself enumerates providers.
		let all: LanguageModelChat[];
		try {
			all = await vscode.lm.selectChatModels();
		} catch (err) {
			this._logService.warn(`[BYOKAutoLMProvider] auto-discovery enumeration failed: ${(err as Error).message}`);
			return undefined;
		}

		const byVendor = new Map<string, LanguageModelChat[]>();
		for (const model of all) {
			if (model.vendor === BYOKAutoLMProvider.vendorId) {
				continue;
			}
			const bucket = byVendor.get(model.vendor) ?? [];
			bucket.push(model);
			byVendor.set(model.vendor, bucket);
		}

		const visited = new Set<string>();
		const orderedVendors: string[] = [];
		for (const preferred of BYOKAutoLMProvider.AUTO_DISCOVERY_VENDOR_PRIORITY) {
			if (byVendor.has(preferred)) {
				orderedVendors.push(preferred);
				visited.add(preferred);
			}
		}
		for (const vendor of byVendor.keys()) {
			if (!visited.has(vendor)) {
				orderedVendors.push(vendor);
			}
		}

		for (const vendor of orderedVendors) {
			const models = byVendor.get(vendor)!;
			const picked = this._pickPreferredModel(models);
			if (picked) {
				this._logService.trace(
					`[BYOKAutoLMProvider] auto-discovered target ${picked.vendor}/${picked.id} (${picked.name}) from ${models.length} ${vendor} model(s).`,
				);
				return picked;
			}
		}

		return undefined;
	}

	private _pickPreferredModel(models: readonly LanguageModelChat[]): LanguageModelChat | undefined {
		if (models.length === 0) {
			return undefined;
		}
		for (const needle of BYOKAutoLMProvider.AUTO_DISCOVERY_MODEL_PREFERENCE) {
			const hit = models.find(m => {
				const id = (m.id ?? '').toLowerCase();
				const family = (m.family ?? '').toLowerCase();
				return id.includes(needle) || family.includes(needle);
			});
			if (hit) {
				return hit;
			}
		}
		return models[0];
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
		// Patch 39: return '' when unset. Resolution now falls through to
		// auto-discovery (`_autoDiscoverTarget`) instead of a hard-coded
		// vendor/id. Returning a stale compiled-in default here would
		// short-circuit auto-discovery and re-introduce the "no chat model
		// matches vendor='vertexgemini'" failure on installs that only
		// run the direct `gemini` vendor.
		try {
			const value = this._configurationService.getConfig(ConfigKey.ByokAutoDefaultModel);
			if (typeof value === 'string' && value.trim().length > 0) {
				return value.trim();
			}
		} catch {
			// ConfigKey might not exist in unit-test stubs; fall through.
		}
		return '';
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
		if (!raw) {
			// Patch 39: when unset we auto-discover. Signal that in the
			// picker so users know Auto isn't broken — it just picks a
			// vendor dynamically.
			return '→ auto-discovered (prefers Gemini)';
		}
		const parsed = this._parseTargetSpec(raw);
		if (!parsed) {
			return 'invalid configuration';
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

	/* ─── Patch 40: classifier-driven routing ────────────────────── */

	private _readRoutingMode(): 'static' | 'classifier' {
		try {
			const raw = this._configurationService.getConfig(ConfigKey.ByokAutoRoutingMode);
			if (raw === 'static' || raw === 'classifier') {
				return raw;
			}
		} catch {
			// Setting may be absent in test stubs — fall through.
		}
		// Default to classifier mode now that the safety net (fallback
		// to static on any error / missing credentials) is wired up.
		// Users who want the cheap Patch 34 behaviour back can flip
		// `chat.byok.auto.routingMode` to `'static'`.
		return 'classifier';
	}

	private _readRoutingTable(): RoutingTable {
		try {
			const raw = this._configurationService.getConfig(ConfigKey.ByokAutoRoutingTable);
			return mergeRoutingTable(raw);
		} catch {
			return DEFAULT_ROUTING_TABLE;
		}
	}

	/**
	 * Pull the user's Gemini key (from BYOK storage) + any Vertex
	 * Anthropic config (from `chat.vertexAnthropicModels`) and build a
	 * classifier. Returns `undefined` when *both* are missing — at
	 * that point classifier mode cannot meaningfully run and we should
	 * fall through to static routing.
	 *
	 * The cache is keyed by a cheap credential fingerprint so key
	 * rotation reliably invalidates the cached instance without
	 * per-call storage round-trips on every turn. Empty fingerprint
	 * (no credentials present) is a distinct case — we return
	 * `undefined` and make no classifier.
	 */
	protected async _getOrCreateClassifier(): Promise<IByokRoutingClassifier | undefined> {
		const { options, fingerprint } = await this._buildClassifierOptions();
		if (!fingerprint) {
			return undefined;
		}
		if (this._cachedClassifier && this._cachedClassifier.credentialFingerprint === fingerprint) {
			return this._cachedClassifier.classifier;
		}
		// Dynamic import keeps the `@google/genai` + `@anthropic-ai/sdk`
		// load off the cold-start path for users on static mode.
		const { ByokRoutingClassifier } = await import('./byokRoutingClassifier');
		const classifier = new ByokRoutingClassifier(options, this._logService);
		this._cachedClassifier = { credentialFingerprint: fingerprint, classifier };
		return classifier;
	}

	private async _buildClassifierOptions(): Promise<{
		options: {
			geminiApiKey?: string;
			vertexConfig?: VertexClassifierConfig;
			primaryTimeoutMs?: number;
			failoverTimeoutMs?: number;
		};
		fingerprint: string;
	}> {
		// Gemini key: provider-level storage. Lower-cased provider name
		// matches `GeminiNativeBYOKLMProvider.providerName.toLowerCase()`.
		let geminiApiKey: string | undefined;
		try {
			geminiApiKey = await this._byokStorageService.getAPIKey('gemini');
		} catch (err) {
			this._logService.trace(`[BYOKAutoLMProvider] Could not read Gemini key for classifier: ${(err as Error).message}`);
		}

		// Vertex config: pick the first entry in `chat.vertexAnthropicModels`.
		// The classifier only needs *any* Vertex endpoint to call Haiku;
		// we don't need the user's per-model map, just a project+location
		// we can authenticate against. The stored API key lives under
		// `vertexanthropic` provider storage (global key auth).
		let vertexConfig: VertexClassifierConfig | undefined;
		try {
			const vertexModels = this._configurationService.getConfig(ConfigKey.VertexAnthropicModels);
			const firstEntry = vertexModels && typeof vertexModels === 'object'
				? Object.values(vertexModels as Record<string, { projectId?: string; locationId?: string }>)[0]
				: undefined;
			if (firstEntry?.projectId && firstEntry?.locationId) {
				const vertexApiKey = await this._byokStorageService.getAPIKey('vertexanthropic');
				if (vertexApiKey) {
					vertexConfig = {
						apiKey: vertexApiKey,
						projectId: firstEntry.projectId,
						// Haiku 3.5 lives in region-specific endpoints
						// (us-east5 / us-central1). Honour whatever the
						// user has configured rather than hardcoding.
						locationId: firstEntry.locationId,
					};
				}
			}
		} catch (err) {
			this._logService.trace(`[BYOKAutoLMProvider] Could not read Vertex config for classifier: ${(err as Error).message}`);
		}

		// Fingerprint only needs to change when *something* that would
		// alter classifier behaviour changes. Hash-like concatenation
		// of the relevant fields keeps it cheap and test-stable.
		const fingerprintParts = [
			geminiApiKey ? `g:${geminiApiKey.length}:${geminiApiKey.slice(0, 4)}` : '',
			vertexConfig ? `v:${vertexConfig.projectId}:${vertexConfig.locationId}:${vertexConfig.apiKey.length}` : '',
		];
		const fingerprint = fingerprintParts.filter(Boolean).join('|');

		return {
			options: { geminiApiKey, vertexConfig },
			fingerprint,
		};
	}

	/**
	 * Classifier + router pipeline. Returns `undefined` when the router
	 * can't produce a decision (empty candidate pool) so the caller can
	 * fall through to the static path.
	 *
	 * Short continuations like "go" / "yes" / "push to branch" are
	 * routed through the offline heuristic only — we skip the network
	 * tiers entirely because (a) the user's VS Code history shows
	 * ~30-40% of turns match this pattern, and (b) even a 120ms Gemini
	 * Flash call is pure latency when the answer is deterministic from
	 * regex. Users can force full classification by disabling the skip
	 * via `chat.byok.auto.routingMode = 'static'` or by writing a
	 * non-trivial prompt.
	 */
	protected async _resolveViaClassifier(
		classifier: IByokRoutingClassifier,
		messages: ReadonlyArray<LanguageModelChatMessage | LanguageModelChatMessage2>,
		_token: CancellationToken,
	): Promise<RoutingResolution | undefined> {
		const input = this._extractClassificationInput(messages);
		let classification: ClassificationResult;
		if (isTrivialPrompt(input.prompt)) {
			// Heuristic is instant — bypass the classifier plumbing.
			const core = classifyByHeuristic(input);
			classification = { ...core, source: 'heuristic', latencyMs: 0 };
			this._logService.trace(
				`[BYOKAutoLMProvider] trivial prompt — skipped Tier-1/2 classifiers`,
			);
		} else {
			classification = await classifier.classify(input);
		}
		this._logService.trace(
			`[BYOKAutoLMProvider] classification: complexity=${classification.complexity} task=${classification.task_type} ` +
			`topic_changed=${classification.topic_changed} needs_vision=${classification.needs_vision} ` +
			`source=${classification.source} latency=${classification.latencyMs}ms confidence=${classification.confidence}`,
		);

		const candidates = await vscode.lm.selectChatModels();
		const decision = routeToTarget(
			classification,
			candidates as unknown as readonly RoutableModel[],
			{ table: this._readRoutingTable(), selfVendorId: 'byokauto' },
		);
		if (!decision) {
			return undefined;
		}
		// `routeToTarget` operates on the structural `RoutableModel`
		// view; the returned target is the same runtime object we got
		// from `selectChatModels()` so the cast back is safe.
		return {
			target: decision.target as unknown as LanguageModelChat,
			mode: 'classifier',
			classification,
			rule: decision.rule,
			matchedNeedle: decision.matchedNeedle,
		};
	}

	/**
	 * Extract the classifier input from a conversation. Pulls the last
	 * user message's text (prompt), the previous 4 non-tool messages
	 * (recentHistory, capped at 2000 chars so long-running chats don't
	 * blow the classifier's token budget), the number of attached
	 * references (file / symbol citations, counted structurally), and
	 * whether any image part is present.
	 */
	protected _extractClassificationInput(
		messages: ReadonlyArray<LanguageModelChatMessage | LanguageModelChatMessage2>,
	): ClassificationInput {
		let lastUserIdx = -1;
		for (let i = messages.length - 1; i >= 0; i--) {
			const role = (messages[i] as { role?: unknown }).role;
			// VS Code's `LanguageModelChatMessageRole.User` is enum value
			// 1 — use the numeric check for compatibility with both
			// `LanguageModelChatMessage` and `LanguageModelChatMessage2`.
			if (role === 1 || role === 'user') {
				lastUserIdx = i;
				break;
			}
		}
		const lastUser = lastUserIdx >= 0 ? messages[lastUserIdx] : undefined;
		const prompt = lastUser ? this._stringifyMessage(lastUser) : '';
		const historyMessages = lastUserIdx >= 0 ? messages.slice(Math.max(0, lastUserIdx - 4), lastUserIdx) : [];
		const recentHistory = historyMessages
			.map(m => this._stringifyMessage(m))
			.filter(s => s.length > 0)
			.join('\n---\n')
			.slice(0, 2000) || undefined;
		return {
			prompt,
			recentHistory,
			hasImageAttachment: this._detectImageAttachment(lastUser),
			referenceCount: this._countReferences(lastUser),
		};
	}

	/**
	 * Count file/symbol references attached to the message. The VS
	 * Code LM API carries these as `LanguageModelDataPart` entries
	 * with a `mimeType` starting `vscode/reference` or as bare objects
	 * with a `uri` field. We only need a rough count — the heuristic
	 * classifier bumps complexity above 5 / 10 refs — so a permissive
	 * structural detector is enough.
	 */
	private _countReferences(msg: LanguageModelChatMessage | LanguageModelChatMessage2 | undefined): number {
		if (!msg) {
			return 0;
		}
		const content = (msg as { content?: unknown }).content;
		if (!Array.isArray(content)) {
			return 0;
		}
		let count = 0;
		for (const p of content) {
			if (!p || typeof p !== 'object') {
				continue;
			}
			const mimeType = (p as { mimeType?: unknown }).mimeType;
			if (typeof mimeType === 'string' && mimeType.startsWith('vscode/reference')) {
				count++;
				continue;
			}
			if ('uri' in p && (p as { uri: unknown }).uri) {
				count++;
			}
		}
		return count;
	}

	private _detectImageAttachment(msg: LanguageModelChatMessage | LanguageModelChatMessage2 | undefined): boolean {
		if (!msg) {
			return false;
		}
		const content = (msg as { content?: unknown }).content;
		if (!Array.isArray(content)) {
			return false;
		}
		// `LanguageModelDataPart` / `LanguageModelImagePart` carry an
		// `data` / `mimeType` pair. Detection here is structural so we
		// match both shapes without depending on the enum.
		return content.some(p =>
			p && typeof p === 'object' &&
			('mimeType' in p && typeof (p as { mimeType: unknown }).mimeType === 'string' &&
				(p as { mimeType: string }).mimeType.startsWith('image/'))
		);
	}

	private _formatRoutingHint(resolution: RoutingResolution): string {
		const target = `${resolution.target.vendor}/${resolution.target.id}`;
		if (resolution.mode === 'static' || !resolution.classification) {
			return `_via \`${target}\`_\n\n`;
		}
		const c = resolution.classification;
		const ruleSuffix = resolution.rule ? ` • rule=${resolution.rule}` : '';
		const topicSuffix = c.topic_changed ? ' • topic_changed' : '';
		return (
			`_via \`${target}\` • complexity=${c.complexity}, task=${c.task_type}, ` +
			`source=${c.source} (${Math.round(c.latencyMs)}ms)${ruleSuffix}${topicSuffix}_\n\n`
		);
	}
}

/**
 * Metadata returned by {@link BYOKAutoLMProvider._resolveRouting}.
 * Carries enough information for the routing hint (Patch 38 / 40) to
 * describe the decision without re-running any logic.
 */
export interface RoutingResolution {
	readonly target: LanguageModelChat;
	readonly mode: 'static' | 'classifier';
	readonly classification?: ClassificationResult;
	readonly rule?: 'table' | 'table-default' | 'fallback' | 'first-of-kind';
	readonly matchedNeedle?: string;
}
