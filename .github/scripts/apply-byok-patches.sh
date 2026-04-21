#!/bin/bash
set -e

# Patch 1: Fake token to bypass subscription
node -e '
const fs = require("fs");
const f = "src/platform/authentication/vscode-node/copilotTokenManager.ts";
let code = fs.readFileSync(f, "utf8");

code = code.replace(
  "import { CopilotToken, ExtendedTokenInfo,",
  "import { CopilotToken, createTestExtendedTokenInfo, ExtendedTokenInfo,"
);

const original = /async getCopilotToken\(force\?: boolean\): Promise<CopilotToken> \{[\s\S]*?return new CopilotToken\(this\.copilotToken\);\s*\}/;
const replacement = `async getCopilotToken(force?: boolean): Promise<CopilotToken> {
\t\tconst fakeTokenInfo = createTestExtendedTokenInfo({
\t\t\ttoken: "fake-token",
\t\t\texpires_at: 9999999999,
\t\t\trefresh_in: 9999999999,
\t\t\tsku: "individual",
\t\t\tindividual: true,
\t\t\tusername: "offline-user",
\t\t\tcopilot_plan: "individual",
\t\t});
\t\tif (!this.copilotToken) {
\t\t\tthis.copilotToken = fakeTokenInfo;
\t\t}
\t\treturn new CopilotToken(fakeTokenInfo);
\t}`;
code = code.replace(original, replacement);
fs.writeFileSync(f, code);
console.log("Patched: fake token");
'

# Patch 2: getPrimaryType for Gemini union types
node << 'PATCH2_EOF'
const fs = require("fs");
const f = "src/extension/byok/common/geminiFunctionDeclarationConverter.ts";
let code = fs.readFileSync(f, "utf8");

if (code.includes("getPrimaryType")) {
  console.log("getPrimaryType already present, skipping");
  process.exit(0);
}

// 1. Widen type field to accept string arrays
code = code.replace("type?: string;", "type?: string | string[];");

// 2. Add getPrimaryType helper before mapType
code = code.replace(
  "// Map JSON schema types to Gemini Type enum",
  `function getPrimaryType(type?: string | string[]): string | undefined {
\tif (Array.isArray(type)) {
\t\treturn type.find((t) => t !== 'null');
\t}
\tif (typeof type === 'string' && type.includes(',')) {
\t\treturn type.split(',').find((t) => t.trim() !== 'null')?.trim();
\t}
\treturn type;
}

// Map JSON schema types to Gemini Type enum`
);

// 3. Use getPrimaryType in toGeminiFunction
code = code.replace(
  "const target = schema.type === 'array' && schema.items ? schema.items : schema;",
  "const typeStr = getPrimaryType(schema.type);\n\tconst target = typeStr === 'array' && schema.items ? schema.items : schema;"
);

// 4. Use getPrimaryType in transformProperties type resolution block
code = code.replace(
  "const transformed: any = {\n\t\t\t// If type is undefined, throw an error to avoid incorrect assumptions\n\t\t\ttype: effectiveValue.type\n\t\t\t\t? mapType(effectiveValue.type)\n\t\t\t\t: Type.OBJECT\n\t\t};",
  "const typeStr = getPrimaryType(effectiveValue.type);\n\n\t\tconst transformed: any = {\n\t\t\ttype: typeStr\n\t\t\t\t? mapType(typeStr)\n\t\t\t\t: Type.OBJECT\n\t\t};"
);

// 5. Replace direct type comparisons with typeStr
code = code.replace(
  "if (effectiveValue.type === 'object' && effectiveValue.properties)",
  "if (typeStr === 'object' && effectiveValue.properties)"
);
code = code.replace(
  "} else if (effectiveValue.type === 'array' && effectiveValue.items)",
  "} else if (typeStr === 'array' && effectiveValue.items)"
);

// 6. Replace items type resolution with getPrimaryType
code = code.replace(
  "const itemType = effectiveValue.items.type === 'object' ? Type.OBJECT : mapType(effectiveValue.items.type ?? 'object');",
  "const itemTypeStr = getPrimaryType(effectiveValue.items.type) ?? 'object';\n\t\t\tconst itemType = itemTypeStr === 'object' ? Type.OBJECT : mapType(itemTypeStr);"
);

fs.writeFileSync(f, code);
console.log("Patched: getPrimaryType");
PATCH2_EOF

# Patch 3: Rename extension, bump version, clamp VS Code engine
# engines.vscode: upstream bumps this to track VS Code Insiders, which prevents
# install on Stable. Clamp to ^1.116.0 so the extension installs on current
# stable builds. Idempotent — always sets the same value.
node -e '
const fs = require("fs");
const pkg = JSON.parse(fs.readFileSync("package.json", "utf8"));
pkg.displayName = "Copilot Full BYOK";
pkg.description = "AI chat features powered by Copilot — Full Bring Your Own Key edition";
const parts = pkg.version.split(".").map(Number);
pkg.version = parts[0] + "." + parts[1] + "." + (parts[2] + 1);
if (pkg.engines && pkg.engines.vscode && pkg.engines.vscode !== "^1.116.0") {
  const previous = pkg.engines.vscode;
  pkg.engines.vscode = "^1.116.0";
  console.log("Clamped engines.vscode: " + previous + " -> " + pkg.engines.vscode);
}
fs.writeFileSync("package.json", JSON.stringify(pkg, null, "\t") + "\n");
console.log("Renamed to: " + pkg.displayName + ", version: " + pkg.version);
'

# Patch 4: Tiered auto-compaction helpers in backgroundSummarizer.ts
# Adds CompactionTier / TieredCompactionThresholds / getCompactionTier /
# getConfirmedCompactionTier exports alongside the upstream
# shouldKickOffBackgroundSummarization. Uses an append-at-EOF strategy so
# upstream edits to the existing exports do not collide with our patch.
node << 'PATCH4_EOF'
const fs = require("fs");
const f = "src/extension/prompts/node/agent/backgroundSummarizer.ts";
let code = fs.readFileSync(f, "utf8");

if (code.includes("BYOK CUSTOM PATCH: Tiered auto-compaction")) {
  console.log("tiered compaction already present, skipping");
  process.exit(0);
}

const block = `
// ─── BYOK CUSTOM PATCH: Tiered auto-compaction ──────────────────────────────
// The following exports are preserved across upstream syncs by
// .github/scripts/apply-byok-patches.sh. Do not remove.

/**
 * Compaction urgency tier:
 *   0 = no action
 *   1 = start background compaction
 *   2 = start urgent background compaction (log warning)
 *   3 = block synchronously on background compaction before next LLM call
 */
export type CompactionTier = 0 | 1 | 2 | 3;

/**
 * Tiered thresholds used to preempt context window overflow. Unlike the single
 * \`BackgroundSummarizationThresholds.base\` gate, these fire at lower estimate
 * ratios so compaction starts well before we hit Gemini's 1M input-token cap.
 */
export const TieredCompactionThresholds = {
	tier1Estimate: 0.70,
	tier2Estimate: 0.80,
	tier3Estimate: 0.90,
	tier1Confirmed: 0.65,
	tier2Confirmed: 0.75,
	tier3Confirmed: 0.85,
} as const;

/**
 * Map a post-render context ratio to a compaction tier.
 *
 * Inline path (cache parity matters): cold cache only triggers tier 3, warm
 * cache uses the full tiered ladder.
 *
 * Non-inline path (no cache benefit): full tiered ladder regardless.
 */
export function getCompactionTier(
	postRenderRatio: number,
	useInlineSummarization: boolean,
	cacheWarm: boolean,
): CompactionTier {
	const t = TieredCompactionThresholds;
	if (!useInlineSummarization) {
		if (postRenderRatio >= t.tier3Estimate) { return 3; }
		if (postRenderRatio >= t.tier2Estimate) { return 2; }
		if (postRenderRatio >= t.tier1Estimate) { return 1; }
		return 0;
	}
	if (!cacheWarm) {
		return postRenderRatio >= t.tier3Estimate ? 3 : 0;
	}
	if (postRenderRatio >= t.tier3Estimate) { return 3; }
	if (postRenderRatio >= t.tier2Estimate) { return 2; }
	if (postRenderRatio >= t.tier1Estimate) { return 1; }
	return 0;
}

/**
 * Map an API-confirmed ratio (from Gemini countTokens) to a compaction tier.
 * Reserved for future use once the countTokens gate is wired in.
 */
export function getConfirmedCompactionTier(trueRatio: number): CompactionTier {
	const t = TieredCompactionThresholds;
	if (trueRatio >= t.tier3Confirmed) { return 3; }
	if (trueRatio >= t.tier2Confirmed) { return 2; }
	if (trueRatio >= t.tier1Confirmed) { return 1; }
	return 0;
}
// ─── END BYOK CUSTOM PATCH ──────────────────────────────────────────────────
`;

if (!code.endsWith("\n")) { code += "\n"; }
code += block;
fs.writeFileSync(f, code);
console.log("Patched: tiered compaction helpers");
PATCH4_EOF

# Patch 5: Fake-token bypass + 1-min backoff in modelMetadataFetcher.ts
# Avoids 401 spam and hot-loop retries against the Copilot API when running
# in BYOK-only mode with the fake offline token.
#
# IMPORTANT: the bypass must NOT fire `_onDidModelRefresh` and must remember
# that it already short-circuited. Otherwise `_shouldRefreshModels()` returns
# `true` on every call (because `_familyMap.size === 0` in BYOK-only mode)
# and the event triggers a feedback loop with `languageModelAccess`'s model
# change listener — cheap per-call but cumulatively slows VS Code.
node << 'PATCH5_EOF'
const fs = require("fs");
const f = "src/platform/endpoint/node/modelMetadataFetcher.ts";
let code = fs.readFileSync(f, "utf8");

if (code.includes("BYOK CUSTOM PATCH: fake-token early-out")) {
  console.log("modelMetadataFetcher bypass already present, skipping");
  process.exit(0);
}

// Step 1: add the short-circuit flag as a new class field.
const fieldAnchor = "private _lastFetchError: any;";
if (!code.includes(fieldAnchor)) {
  console.warn("WARN: _lastFetchError anchor not found — skipping modelMetadataFetcher patch");
  process.exit(0);
}
code = code.replace(
  fieldAnchor,
  `${fieldAnchor}
	// BYOK CUSTOM PATCH: remember that we've already short-circuited on the fake token,
	// so subsequent calls don't re-await \`getCopilotToken()\` or re-enter the bypass.
	private _fakeTokenShortCircuited: boolean = false;`
);

// Step 2: reset the flag on auth change so a transition from fake → real token re-evaluates.
const authChangeAnchor = `this._authService.onDidAuthenticationChange(() => {
			// Auth changed so next fetch should be forced to get a new list
			this._familyMap.clear();
			this._completionsFamilyMap.clear();
			this._lastFetchTime = 0;`;
if (code.includes(authChangeAnchor)) {
  code = code.replace(
    authChangeAnchor,
    `${authChangeAnchor}
			// BYOK CUSTOM PATCH: auth changed, so let the next fetch re-evaluate
			// whether we're still on the fake token.
			this._fakeTokenShortCircuited = false;`
  );
}

// Step 3: inject the early-out at the top of `_fetchModels` BEFORE _shouldRefreshModels
// (which would otherwise return true because _familyMap is empty).
const fetchAnchor = "private async _fetchModels(force?: boolean): Promise<void> {\n\t\tif (!force && !this._shouldRefreshModels()) {";
if (!code.includes(fetchAnchor)) {
  console.warn("WARN: _fetchModels anchor not found — skipping modelMetadataFetcher patch");
  process.exit(0);
}
code = code.replace(
  fetchAnchor,
  `private async _fetchModels(force?: boolean): Promise<void> {
		// ─── BYOK CUSTOM PATCH: fake-token early-out ─────────────────────
		// Preserved by .github/scripts/apply-byok-patches.sh. Do not remove.
		// Once we've confirmed we're running with the offline fake token there
		// is nothing to refresh here — \`_familyMap\` stays empty by design, so
		// \`_shouldRefreshModels()\` below would otherwise return \`true\` on every
		// call, re-awaiting \`getCopilotToken()\` and re-firing the refresh event
		// (which triggers a feedback loop with \`languageModelAccess\`'s model
		// change listener). Skip the whole body on subsequent calls.
		if (this._fakeTokenShortCircuited) {
			return;
		}
		// ─── END BYOK CUSTOM PATCH ───────────────────────────────────────
		if (!force && !this._shouldRefreshModels()) {`
);

// Step 4: inject the fake-token bypass after `const copilotToken = (await this._authService.getCopilotToken()).token;`
//         (flag set + NO event fire).
const tokenAnchor = "const copilotToken = (await this._authService.getCopilotToken()).token;";
if (!code.includes(tokenAnchor)) {
  console.warn("WARN: copilotToken anchor not found — skipping modelMetadataFetcher patch");
  process.exit(0);
}
code = code.replace(
  tokenAnchor,
  `${tokenAnchor}

		// ─── BYOK CUSTOM PATCH: fake-token bypass ─────────────────────
		// Preserved by .github/scripts/apply-byok-patches.sh. Do not remove.
		// Skip the API call when using a fake/offline token (BYOK-only mode).
		// The fake token will always 401 against the Copilot API, so avoid
		// the network round-trip and error log spam. Crucially, do NOT fire
		// \`_onDidModelRefresh\` — nothing was actually refreshed, and firing
		// triggers \`languageModelAccess\` to re-query models, which re-enters
		// this function and firehoses a feedback loop.
		if (copilotToken === 'fake-token') {
			this._fakeTokenShortCircuited = true;
			this._lastFetchTime = Date.now();
			return;
		}
		// ─── END BYOK CUSTOM PATCH ────────────────────────────────────`
);

// Step 5: 1-min backoff instead of hot-loop retry on failure.
const retryAnchor = "this._lastFetchError = e;\n\t\t\tthis._lastFetchTime = 0;";
if (code.includes(retryAnchor)) {
  code = code.replace(
    retryAnchor,
    "this._lastFetchError = e;\n\t\t\t// BYOK CUSTOM PATCH: 1-min backoff instead of hot-loop retry\n\t\t\tthis._lastFetchTime = Date.now() - 9 * 60 * 1000;\n\t\t\tthis._onDidModelRefresh.fire();"
  );
}

fs.writeFileSync(f, code);
console.log("Patched: modelMetadataFetcher fake-token bypass (no event fire + early-out)");
PATCH5_EOF

# Patch 6: Wire tiered compaction into agentIntent.ts
# Adds getCompactionTier to the existing backgroundSummarizer import and
# injects a tier-3 synchronous compaction block before the existing post-render
# kick-off logic.  We anchor on the stable `shouldKickOffBackgroundSummarization`
# call that has been in upstream for a long time. If upstream renames it the
# patch exits gracefully and logs a warning — do NOT let this fail the sync.
node << 'PATCH6_EOF'
const fs = require("fs");
const f = "src/extension/intents/node/agentIntent.ts";
let code = fs.readFileSync(f, "utf8");

if (code.includes("BYOK CUSTOM PATCH: Tier 3 synchronous compaction")) {
  console.log("tiered compaction (agentIntent) already present, skipping");
  process.exit(0);
}

// Step 1: add getCompactionTier to the import
const importAnchor = "import { BackgroundSummarizationState, BackgroundSummarizer,";
if (!code.includes(importAnchor)) {
  console.warn("WARN: backgroundSummarizer import anchor not found — skipping agentIntent tier patch");
  process.exit(0);
}
if (!code.includes("getCompactionTier")) {
  code = code.replace(importAnchor, "import { BackgroundSummarizationState, BackgroundSummarizer, getCompactionTier,");
}

// Step 2: inject tier-3 block before the `const kickOff = shouldKickOffBackgroundSummarization(` line
// and adjust kickOff to skip when tier 3 already compacted.
const kickOffAnchor = "const kickOff = shouldKickOffBackgroundSummarization(postRenderRatio, useInlineSummarization, cacheWarm, this._thresholdRng);";
if (!code.includes(kickOffAnchor)) {
  console.warn("WARN: kickOff anchor not found — skipping agentIntent tier patch");
  process.exit(0);
}

const tier3Block = `// ─── BYOK CUSTOM PATCH: Tier 3 synchronous compaction ─────────
			// Preserved by .github/scripts/apply-byok-patches.sh. Do not remove.
			//
			// At >= 90% context usage we block synchronously on background
			// compaction BEFORE the next LLM call, to avoid hitting Gemini's
			// 1M input-token cap. Mirrors the proven BudgetExceededError flow
			// (wait -> apply -> re-render) but triggered proactively on
			// estimate rather than reactively on a 400 error.
			const __byokTier = getCompactionTier(postRenderRatio, useInlineSummarization, cacheWarm);
			if (__byokTier >= 3) {
				this.logService.warn(\`[AutoCompact] tier 3 — ratio \${(postRenderRatio * 100).toFixed(1)}% — blocking on compaction\`);
				if (idleOrFailed) {
					if (useInlineSummarization) {
						const strippedMessages = ToolCallingLoop.stripInternalToolCallIds(result.messages);
						const rawEffort = this.request.modelConfiguration?.reasoningEffort;
						const isSubagent = !!this.request.subAgentInvocationId;
						this._lastModelCapabilities = {
							enableThinking: !isAnthropicFamily(this.endpoint) || ToolCallingLoop.messagesContainThinking(strippedMessages),
							reasoningEffort: typeof rawEffort === 'string' ? rawEffort : undefined,
							enableToolSearch: !isSubagent && !!this.endpoint.supportsToolSearch,
							enableContextEditing: !isSubagent && isAnthropicContextEditingEnabled(this.endpoint, this.configurationService, this.expService),
						};
					}
					this._startBackgroundSummarization(backgroundSummarizer, result.messages, promptContext, props, token, postRenderRatio, useInlineSummarization);
				}
				const inFlight = backgroundSummarizer.state === BackgroundSummarizationState.InProgress
					|| backgroundSummarizer.state === BackgroundSummarizationState.Completed;
				if (inFlight) {
					let tier3Trigger: string;
					if (backgroundSummarizer.state === BackgroundSummarizationState.InProgress) {
						tier3Trigger = 'tier3Waited';
						const summaryPromise = backgroundSummarizer.waitForCompletion();
						progress.report(new ChatResponseProgressPart2(
							l10n.t('Compacting conversation ({0}%)...', Math.round(postRenderRatio * 100)),
							async () => { try { await summaryPromise; } catch { } return l10n.t('Compacted conversation'); },
						));
						try { await summaryPromise; } catch { }
					} else {
						tier3Trigger = 'tier3Ready';
						progress.report(new ChatResponseProgressPart2(l10n.t('Compacted conversation'), async () => l10n.t('Compacted conversation')));
					}
					const bgResult = backgroundSummarizer.consumeAndReset();
					if (bgResult) {
						this._applySummaryToRounds(bgResult, promptContext);
						this._persistSummaryOnTurn(bgResult, promptContext, contextLengthBefore);
						this._sendBackgroundCompactionTelemetry(tier3Trigger, 'applied', postRenderRatio, promptContext);
						didSummarizeThisIteration = true;
						try {
							const reRenderer = PromptRenderer.create(this.instantiationService, endpoint, this.prompt, { ...props, promptContext });
							result = await reRenderer.render(progress, token);
							this._lastRenderTokenCount = result.tokenCount;
						} catch (e) {
							this.logService.warn(\`[AutoCompact] tier 3 re-render failed: \${e instanceof Error ? e.message : String(e)} — continuing\`);
						}
					} else {
						this._recordBackgroundCompactionFailure(promptContext, tier3Trigger);
					}
				}
			}
			// ─── END BYOK CUSTOM PATCH ────────────────────────────────────

			// Skip the legacy kick-off if tier 3 already ran compaction.
			const kickOff = !didSummarizeThisIteration
				&& (__byokTier >= 1 || shouldKickOffBackgroundSummarization(postRenderRatio, useInlineSummarization, cacheWarm, this._thresholdRng));`;

code = code.replace(kickOffAnchor, tier3Block);

// Step 3: guard the existing `if (kickOff && idleOrFailed) {` with !didSummarizeThisIteration
const ifAnchor = "if (kickOff && idleOrFailed) {";
if (code.includes(ifAnchor)) {
  code = code.replace(ifAnchor, "if (kickOff && idleOrFailed && !didSummarizeThisIteration) {");
}

fs.writeFileSync(f, code);
console.log("Patched: tier 3 synchronous compaction in agentIntent");
PATCH6_EOF

# Patch 7: Readable Gemini errors
# The Gemini SDK throws ApiError with a JSON-stringified body as `.message`.
# Surfacing it directly in chat produces ugly output like:
#   "Reason: { \"error\": { \"code\": 503, \"message\": \"...\" } }"
# This patch extracts the nested `error.message` and re-throws with a clean
# message so the chat UI shows only the human-readable part.
node << 'PATCH7_EOF'
const fs = require("fs");
const f = "src/extension/byok/vscode-node/geminiNativeProvider.ts";
let code = fs.readFileSync(f, "utf8");

if (code.includes("BYOK CUSTOM PATCH: readable Gemini errors")) {
  console.log("readable Gemini errors already present, skipping");
  process.exit(0);
}

// Step 1: insert helper function after IBYOKStorageService import
const helperAnchor = "import { IBYOKStorageService } from './byokStorageService';";
if (!code.includes(helperAnchor)) {
  console.warn("WARN: IBYOKStorageService import anchor not found — skipping readable Gemini errors patch");
  process.exit(0);
}

const helperBlock = `${helperAnchor}

// ─── BYOK CUSTOM PATCH: readable Gemini errors ──────────────────────────────
// Preserved by .github/scripts/apply-byok-patches.sh. Do not remove.
// The Gemini SDK (\`@google/genai\`) throws \`ApiError\` whose \`message\` is the
// raw JSON body (e.g. \`{"error":{"code":503,"message":"...","status":"..."}}\`).
// Surfacing that JSON in chat UI is noisy — extract the nested \`error.message\`.
function extractReadableGeminiMessage(err: unknown): string {
	if (err instanceof ApiError) {
		try {
			const parsed = JSON.parse(err.message);
			const nested = parsed?.error?.message;
			if (typeof nested === 'string' && nested.length > 0) {
				return nested;
			}
		} catch { /* fall through */ }
		return err.message;
	}
	return toErrorMessage(err);
}
// ─── END BYOK CUSTOM PATCH ──────────────────────────────────────────────────`;

code = code.replace(helperAnchor, helperBlock);

// Step 2: replace the `reason:` assignment + rethrow in doRequest's catch block
const reasonAnchor = "reason: token.isCancellationRequested ? 'cancelled' : toErrorMessage(err)";
if (code.includes(reasonAnchor)) {
  // Inject a local `readableReason` variable before pendingLoggedChatRequest.resolve
  const resolveAnchor = "pendingLoggedChatRequest.resolve({\n\t\t\t\t\ttype: token.isCancellationRequested ? ChatFetchResponseType.Canceled : ChatFetchResponseType.Unknown,\n\t\t\t\t\trequestId,\n\t\t\t\t\tserverRequestId: requestId,\n\t\t\t\t\treason: token.isCancellationRequested ? 'cancelled' : toErrorMessage(err)";
  const resolveReplacement = "const readableReason = token.isCancellationRequested ? 'cancelled' : extractReadableGeminiMessage(err);\n\t\t\t\tpendingLoggedChatRequest.resolve({\n\t\t\t\t\ttype: token.isCancellationRequested ? ChatFetchResponseType.Canceled : ChatFetchResponseType.Unknown,\n\t\t\t\t\trequestId,\n\t\t\t\t\tserverRequestId: requestId,\n\t\t\t\t\treason: readableReason";
  if (code.includes(resolveAnchor)) {
    code = code.replace(resolveAnchor, resolveReplacement);
  } else {
    console.warn("WARN: pendingLoggedChatRequest.resolve anchor not found — skipping reason replacement");
  }
}

// Step 3: replace `throw err;` at the end of doRequest's catch with wrapped throw
const throwAnchor = "}));\n\t\t\t\tthrow err;\n\t\t\t} finally {\n\t\t\t\tcancelSub.dispose();";
if (code.includes(throwAnchor)) {
  const throwReplacement = "}));\n\t\t\t\tif (token.isCancellationRequested || err instanceof Error && err.name === 'AbortError') {\n\t\t\t\t\tthrow err;\n\t\t\t\t}\n\t\t\t\t// Re-throw with a clean message so the chat UI shows the human-readable\n\t\t\t\t// error (not the raw Gemini JSON blob). Preserve the original via `cause`.\n\t\t\t\tthrow new Error(readableReason, { cause: err });\n\t\t\t} finally {\n\t\t\t\tcancelSub.dispose();";
  code = code.replace(throwAnchor, throwReplacement);
}

// Step 4: clean up the final throw inside _makeRequest too
const makeRequestAnchor = "this._logService.error(`Gemini streaming error: ${toErrorMessage(error, true)}`);\n\t\t\tthrow error;";
if (code.includes(makeRequestAnchor)) {
  const makeRequestReplacement = "this._logService.error(`Gemini streaming error: ${toErrorMessage(error, true)}`);\n\t\t\tif ((error as any)?.name === 'AbortError' || token.isCancellationRequested) {\n\t\t\t\tthrow error;\n\t\t\t}\n\t\t\tthrow new Error(extractReadableGeminiMessage(error), { cause: error });";
  code = code.replace(makeRequestAnchor, makeRequestReplacement);
}

fs.writeFileSync(f, code);
console.log("Patched: readable Gemini errors");
PATCH7_EOF

# Patch 8: Gemini retry / timeout resilience
# Gemini API 503s (model overloaded) and 429s (rate limits) are common. Without
# retries the chat UI just errors out. This patch adds:
#   - `retryCount` parameter + MAX_RETRIES = 6 with exponential backoff up to 60s
#   - 120s connect timeout on `generateContentStream` to avoid 5-minute hangs
#   - Progress messages to the user during retries
#   - Retries on 429, 502, 503, 504 and transient network errors (ECONNRESET etc.)
# Depends on Patch 7 (uses `extractReadableGeminiMessage` + the BYOK patch marker
# as an anchor) — make sure Patch 7 runs first.
node << 'PATCH8_EOF'
const fs = require("fs");
const f = "src/extension/byok/vscode-node/geminiNativeProvider.ts";
let code = fs.readFileSync(f, "utf8");

if (code.includes("BYOK CUSTOM PATCH: Gemini retry resilience")) {
  console.log("Gemini retry resilience already present, skipping");
  process.exit(0);
}

// Require Patch 7 to have been applied — we reuse its marker as anchor.
const patch7Marker = "// ─── END BYOK CUSTOM PATCH ──────────────────────────────────────────────────";
if (!code.includes(patch7Marker)) {
  console.warn("WARN: Patch 7 marker not found — skipping Gemini retry resilience patch");
  process.exit(0);
}

// Step 1: inject retry helper immediately after Patch 7's END marker.
// Use indexOf so we only replace the FIRST occurrence (Patch 7 in this file).
const helperBlock = `${patch7Marker}

// ─── BYOK CUSTOM PATCH: Gemini retry resilience ─────────────────────────────
// Preserved by .github/scripts/apply-byok-patches.sh. Do not remove.
// Classify SDK / transport errors as retryable. Returns a label used in
// progress messages, or null if the error is terminal.
function classifyRetryableGeminiError(err: unknown): 'rate-limit' | 'unavailable' | 'network' | null {
	if (err instanceof ApiError) {
		if (err.status === 429) { return 'rate-limit'; }
		if (err.status === 502 || err.status === 503 || err.status === 504) { return 'unavailable'; }
		return null;
	}
	const e = err as any;
	const code = typeof e?.code === 'string' ? e.code : (typeof e?.cause?.code === 'string' ? e.cause.code : undefined);
	const transientCodes = new Set(['ECONNRESET', 'ETIMEDOUT', 'EAI_AGAIN', 'ECONNREFUSED', 'ENETUNREACH', 'EHOSTUNREACH', 'UND_ERR_SOCKET', 'UND_ERR_CONNECT_TIMEOUT']);
	if (code && transientCodes.has(code)) { return 'network'; }
	const msg = typeof e?.message === 'string' ? e.message.toLowerCase() : '';
	if (/fetch failed|network error|timed? ?out|socket hang up/.test(msg)) { return 'network'; }
	return null;
}
// ─── END BYOK CUSTOM PATCH ──────────────────────────────────────────────────`;

// Replace only the first occurrence of the marker.
const firstMarkerIdx = code.indexOf(patch7Marker);
code = code.slice(0, firstMarkerIdx) + helperBlock + code.slice(firstMarkerIdx + patch7Marker.length);

// Step 2: add `retryCount = 0` parameter + MAX_RETRIES / CONNECT_TIMEOUT_MS constants.
const sigAnchor = "private async _makeRequest(client: GoogleGenAI, progress: Progress<LMResponsePart>, params: GenerateContentParameters, token: CancellationToken, issuedTime: number): Promise<{ ttft: number | undefined; ttfte: number | undefined; usage: APIUsage | undefined }> {\n\t\tconst start = Date.now();";
if (!code.includes(sigAnchor)) {
  console.warn("WARN: _makeRequest signature anchor not found — skipping Gemini retry resilience patch");
  process.exit(0);
}
const sigReplacement = "private async _makeRequest(client: GoogleGenAI, progress: Progress<LMResponsePart>, params: GenerateContentParameters, token: CancellationToken, issuedTime: number, retryCount = 0): Promise<{ ttft: number | undefined; ttfte: number | undefined; usage: APIUsage | undefined }> {\n\t\t// BYOK CUSTOM PATCH: retry + connect-timeout constants\n\t\tconst MAX_RETRIES = 6;\n\t\tconst CONNECT_TIMEOUT_MS = 120_000;\n\t\tconst start = Date.now();";
code = code.replace(sigAnchor, sigReplacement);

// Step 3: wrap `generateContentStream` in a connect timeout so hung requests
// don't stall the whole chat turn for 5 minutes.
const streamAnchor = "const stream = await client.models.generateContentStream(params);";
if (code.includes(streamAnchor)) {
  const streamReplacement = "let __byokConnectTimer: ReturnType<typeof setTimeout> | undefined;\n\t\t\tconst stream = await Promise.race([\n\t\t\t\tclient.models.generateContentStream(params),\n\t\t\t\tnew Promise<never>((_, reject) => {\n\t\t\t\t\t__byokConnectTimer = setTimeout(\n\t\t\t\t\t\t() => reject(new TypeError('Gemini API request timed out waiting for initial response')),\n\t\t\t\t\t\tCONNECT_TIMEOUT_MS\n\t\t\t\t\t);\n\t\t\t\t})\n\t\t\t]).finally(() => clearTimeout(__byokConnectTimer));";
  code = code.replace(streamAnchor, streamReplacement);
} else {
  console.warn("WARN: generateContentStream anchor not found — skipping connect timeout");
}

// Step 4: inject retry logic in the catch block, before the final log/throw.
// Anchor picks up the post-Patch-7 shape.
const catchAnchor = "\t\t\treturn { ttft, ttfte, usage };\n\t\t} catch (error) {\n\t\t\tif ((error as any)?.name === 'AbortError' || token.isCancellationRequested) {\n\t\t\t\tthis._logService.trace('Gemini streaming aborted');\n\t\t\t\t// Return partial usage data collected before cancellation\n\t\t\t\treturn { ttft, ttfte, usage };\n\t\t\t}\n\t\t\tthis._logService.error(`Gemini streaming error: ${toErrorMessage(error, true)}`);";
if (!code.includes(catchAnchor)) {
  console.warn("WARN: _makeRequest catch anchor not found — skipping retry injection");
  fs.writeFileSync(f, code);
  process.exit(0);
}
const catchReplacement = "\t\t\treturn { ttft, ttfte, usage };\n\t\t} catch (error) {\n\t\t\tif ((error as any)?.name === 'AbortError' || token.isCancellationRequested) {\n\t\t\t\tthis._logService.trace('Gemini streaming aborted');\n\t\t\t\t// Return partial usage data collected before cancellation\n\t\t\t\treturn { ttft, ttfte, usage };\n\t\t\t}\n\t\t\t// ─── BYOK CUSTOM PATCH: retry on transient errors ─────────────\n\t\t\t// Preserved by .github/scripts/apply-byok-patches.sh. Do not remove.\n\t\t\tconst __byokRetryKind = classifyRetryableGeminiError(error);\n\t\t\tif (__byokRetryKind && retryCount < MAX_RETRIES) {\n\t\t\t\tconst __byokDelay = Math.min(5000 * Math.pow(2, retryCount), 60_000);\n\t\t\t\tconst __byokLabel = __byokRetryKind === 'rate-limit'\n\t\t\t\t\t? '[Rate limit] 429'\n\t\t\t\t\t: __byokRetryKind === 'unavailable'\n\t\t\t\t\t\t? '[Service unavailable] 503'\n\t\t\t\t\t\t: '[Network error]';\n\t\t\t\tthis._logService.warn(`Gemini ${__byokRetryKind} error, retrying in ${__byokDelay}ms (${retryCount + 1}/${MAX_RETRIES}): ${extractReadableGeminiMessage(error)}`);\n\t\t\t\tprogress.report(new LanguageModelThinkingPart(`${__byokLabel} retry ${retryCount + 1}/${MAX_RETRIES}: waiting ~${Math.ceil(__byokDelay / 1000)}s...\\n`));\n\t\t\t\tawait new Promise(resolve => setTimeout(resolve, __byokDelay));\n\t\t\t\tif (token.isCancellationRequested) {\n\t\t\t\t\treturn { ttft, ttfte, usage };\n\t\t\t\t}\n\t\t\t\treturn this._makeRequest(client, progress, params, token, issuedTime, retryCount + 1);\n\t\t\t}\n\t\t\t// ─── END BYOK CUSTOM PATCH ────────────────────────────────────\n\t\t\tthis._logService.error(`Gemini streaming error: ${toErrorMessage(error, true)}`);";
code = code.replace(catchAnchor, catchReplacement);

fs.writeFileSync(f, code);
console.log("Patched: Gemini retry resilience");
PATCH8_EOF

# Patch 9: Reinstall BYOK-only files that don't exist upstream
# The sync workflow rsync's with --delete, which wipes any file not present in
# microsoft/vscode. For files we add on top of the upstream tree, we keep a
# canonical copy under `.github/byok-patches/files/` (excluded from --delete)
# and re-install them here.
install_byok_file() {
  local src="$1"
  local dest="$2"
  if [ ! -f "$src" ]; then
    echo "WARN: canonical BYOK file missing: $src"
    return
  fi
  mkdir -p "$(dirname "$dest")"
  if [ -f "$dest" ] && cmp -s "$src" "$dest"; then
    echo "BYOK file up-to-date: $dest"
    return
  fi
  cp "$src" "$dest"
  echo "Installed BYOK file: $dest"
}

install_byok_file \
  ".github/byok-patches/files/vertexAnthropicProvider.ts" \
  "src/extension/byok/vscode-node/vertexAnthropicProvider.ts"

install_byok_file \
  ".github/byok-patches/files/byokFailover.ts" \
  "src/extension/byok/common/byokFailover.ts"

install_byok_file \
  ".github/byok-patches/files/byokFailover.spec.ts" \
  "src/extension/byok/common/test/byokFailover.spec.ts"

# Patch 10: Anthropic provider — createClient() hook + fail-over wrapper
# Required so VertexAnthropicLMProvider can subclass it and reuse the stream
# handling, and so the primary Anthropic path can transparently failover to
# Vertex on rate-limit / server / auth errors.
node << 'PATCH10_EOF'
const fs = require("fs");
const f = "src/extension/byok/vscode-node/anthropicProvider.ts";
let code = fs.readFileSync(f, "utf8");

if (code.includes("setFailoverTarget")) {
  console.log("Anthropic failover wrapper already present, skipping");
  process.exit(0);
}

// Step 1: allow providerName override by subclasses.
code = code.replace(
  "public static readonly providerName = 'Anthropic';",
  "// Typed as `string` so subclasses (VertexAnthropicLMProvider) can override.\n\tpublic static readonly providerName: string = 'Anthropic';"
);

// Step 2: expose _configurationService to subclasses.
code = code.replace(
  "@IConfigurationService private readonly _configurationService: IConfigurationService,",
  "@IConfigurationService protected readonly _configurationService: IConfigurationService,"
);

// Step 3: import failover helpers.
const importAnchor = "import { anthropicMessagesToRawMessagesForLogging, apiMessageToAnthropicMessage } from '../common/anthropicMessageConverter';";
if (code.includes(importAnchor) && !code.includes("byokFailover")) {
  code = code.replace(
    importAnchor,
    `${importAnchor}\nimport { anthropicPrimaryPool, classifyAnthropicError, DeferredProgress, isFailoverTrigger, keyFingerprint } from '../common/byokFailover';`
  );
}

// Step 4: inject IAnthropicFailoverTarget interface + setFailoverTarget field.
const classAnchor = "export class AnthropicLMProvider extends AbstractLanguageModelChatProvider {";
const classReplacement = `export interface IAnthropicFailoverTarget {
	resolveFailoverModel(primaryModelId: string): Promise<ExtendedLanguageModelChatInformation<LanguageModelChatConfiguration> | undefined>;
	provideLanguageModelChatResponse(model: ExtendedLanguageModelChatInformation<LanguageModelChatConfiguration>, messages: Array<LanguageModelChatMessage | LanguageModelChatMessage2>, options: ProvideLanguageModelChatResponseOptions, progress: Progress<LanguageModelResponsePart2>, token: CancellationToken): Promise<void>;
}

export class AnthropicLMProvider extends AbstractLanguageModelChatProvider {

	// BYOK CUSTOM PATCH — optional sibling provider (Vertex) used as a failover target.
	private _failoverTarget: IAnthropicFailoverTarget | undefined;
	setFailoverTarget(target: IAnthropicFailoverTarget | undefined): void { this._failoverTarget = target; }`;
if (!code.includes("IAnthropicFailoverTarget")) {
  code = code.replace(classAnchor, classReplacement);
}

// Step 5: replace `new Anthropic({ apiKey })` with `this.createClient(apiKey, model)`
// and add the default createClient hook just before provideLanguageModelChatResponse.
const createClientAnchor = "const anthropicClient = new Anthropic({ apiKey });";
if (code.includes(createClientAnchor)) {
  code = code.replace(createClientAnchor, "const anthropicClient = this.createClient(apiKey, model);");
}

const hookAnchor = "async provideLanguageModelChatResponse(model: ExtendedLanguageModelChatInformation<LanguageModelChatConfiguration>";
if (!code.includes("protected createClient(apiKey: string")) {
  code = code.replace(
    hookAnchor,
    `/** Hook for subclasses (e.g. Vertex) to replace the Anthropic client. */\n\tprotected createClient(apiKey: string, _model: ExtendedLanguageModelChatInformation<LanguageModelChatConfiguration>): Anthropic {\n\t\treturn new Anthropic({ apiKey });\n\t}\n\n\t${hookAnchor}`
  );
}

// Step 6: wrap provideLanguageModelChatResponse with failover logic. We rename
// the existing implementation to _doProvideLanguageModelChatResponse and add
// a thin router as the new public method.
const publicMethodSignature = "async provideLanguageModelChatResponse(model: ExtendedLanguageModelChatInformation<LanguageModelChatConfiguration>, messages: Array<LanguageModelChatMessage | LanguageModelChatMessage2>, options: ProvideLanguageModelChatResponseOptions, progress: Progress<LanguageModelResponsePart2>, token: CancellationToken): Promise<void> {";
// Only apply once — second occurrence is the wrapper we create.
const firstIdx = code.indexOf(publicMethodSignature);
const lastIdx = code.lastIndexOf(publicMethodSignature);
if (firstIdx !== -1 && firstIdx === lastIdx) {
  const wrapper = `async provideLanguageModelChatResponse(model: ExtendedLanguageModelChatInformation<LanguageModelChatConfiguration>, messages: Array<LanguageModelChatMessage | LanguageModelChatMessage2>, options: ProvideLanguageModelChatResponseOptions, progress: Progress<LanguageModelResponsePart2>, token: CancellationToken): Promise<void> {
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
				this._logService.warn(\`[BYOK failover] No Vertex fallback configured for \${model.id}; surfacing primary error.\`);
				throw new Error(\`Anthropic failover requested (\${reason}) but no Vertex fallback is configured for \${model.id}\`);
			}
			this._logService.info(\`[BYOK failover] Routing \${model.id} via VertexAnthropic (\${reason}).\`);
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

	private async _doProvideLanguageModelChatResponse(model: ExtendedLanguageModelChatInformation<LanguageModelChatConfiguration>, messages: Array<LanguageModelChatMessage | LanguageModelChatMessage2>, options: ProvideLanguageModelChatResponseOptions, progress: Progress<LanguageModelResponsePart2>, token: CancellationToken): Promise<void> {`;
  code = code.substring(0, firstIdx) + wrapper + code.substring(firstIdx + publicMethodSignature.length);
}

fs.writeFileSync(f, code);
console.log("Patched: Anthropic createClient + failover wrapper");
PATCH10_EOF

# Patch 11: Register VertexAnthropic + wire failover in byokContribution.ts
node << 'PATCH11_EOF'
const fs = require("fs");
const f = "src/extension/byok/vscode-node/byokContribution.ts";
let code = fs.readFileSync(f, "utf8");

if (code.includes("VertexAnthropicLMProvider")) {
  console.log("VertexAnthropic already registered, skipping");
  process.exit(0);
}

// Step 1: import.
const xaiImport = "import { XAIBYOKLMProvider } from './xAIProvider';";
if (code.includes(xaiImport)) {
  code = code.replace(xaiImport, "import { VertexAnthropicLMProvider } from './vertexAnthropicProvider';\n" + xaiImport);
}

// Step 2: expand Anthropic provider set and add Vertex + wire failover.
const anthropicLine = "this._providers.set(AnthropicLMProvider.providerName.toLowerCase(), instantiationService.createInstance(AnthropicLMProvider, knownModels[AnthropicLMProvider.providerName], this._byokStorageService));";
const replacement = "const anthropicProvider = instantiationService.createInstance(AnthropicLMProvider, knownModels[AnthropicLMProvider.providerName], this._byokStorageService);\n\t\t\tthis._providers.set(AnthropicLMProvider.providerName.toLowerCase(), anthropicProvider);\n\t\t\t// BYOK CUSTOM PATCH: Vertex-hosted Anthropic, registered as a separate vendor so it has\n\t\t\t// independent API key / quota / concurrency state. Also wired as a failover target for\n\t\t\t// the direct Anthropic provider (gated by chat.byok.anthropic.fallback.enabled).\n\t\t\tconst vertexAnthropicProvider = instantiationService.createInstance(VertexAnthropicLMProvider, knownModels[AnthropicLMProvider.providerName], this._byokStorageService);\n\t\t\tthis._providers.set(VertexAnthropicLMProvider.providerName.toLowerCase(), vertexAnthropicProvider);\n\t\t\tanthropicProvider.setFailoverTarget(vertexAnthropicProvider);";
if (code.includes(anthropicLine)) {
  code = code.replace(anthropicLine, replacement);
} else {
  console.warn("WARN: AnthropicLMProvider registration anchor not found — skipping");
}

fs.writeFileSync(f, code);
console.log("Patched: byokContribution (VertexAnthropic + failover wire-up)");
PATCH11_EOF

# Patch 12: VertexAnthropic + Anthropic fallback settings in configurationService.ts
node << 'PATCH12_EOF'
const fs = require("fs");
const f = "src/platform/configuration/common/configurationService.ts";
let code = fs.readFileSync(f, "utf8");

if (code.includes("VertexAnthropicModels")) {
  console.log("VertexAnthropicModels / fallback settings already present, skipping");
  process.exit(0);
}

const anchor = "/**\n\t * Deprecated settings that are no longer in use.";
if (!code.includes(anchor)) {
  console.warn("WARN: Deprecated settings anchor not found — skipping");
  process.exit(0);
}

const block = `/**
	 * User-configured Vertex-hosted Anthropic models. Keyed by the full Vertex model id
	 * (e.g. \`claude-sonnet-4-5@20250629\`).
	 */
	export const VertexAnthropicModels = defineSetting<Record<string, { name: string; projectId: string; locationId: string; maxInputTokens?: number; maxOutputTokens?: number }>>('chat.vertexAnthropicModels', ConfigType.Simple, {});

	/** Failover policy for the Anthropic (direct) BYOK provider. */
	export const ByokAnthropicFallbackEnabled = defineSetting<boolean>('chat.byok.anthropic.fallback.enabled', ConfigType.Simple, false);
	/** Anthropic model id → Vertex model id override. */
	export const ByokAnthropicFallbackModelMap = defineSetting<Record<string, string>>('chat.byok.anthropic.fallback.modelMap', ConfigType.Simple, {});
	/** Max concurrent direct-Anthropic requests before routing to Vertex (0 = unlimited). */
	export const ByokAnthropicMaxConcurrency = defineSetting<number>('chat.byok.anthropic.fallback.maxConcurrency', ConfigType.Simple, 0);
	/** Cooldown (seconds) skipping direct Anthropic after a failover event. */
	export const ByokAnthropicCooldownSeconds = defineSetting<number>('chat.byok.anthropic.fallback.cooldownSeconds', ConfigType.Simple, 60);

	` + anchor;
code = code.replace(anchor, block);

fs.writeFileSync(f, code);
console.log("Patched: configurationService (VertexAnthropicModels + fallback settings)");
PATCH12_EOF

# Patch 13: Ensure google-auth-library is a direct dependency.
# Installed transitively by @google/genai, but we surface it so upstream
# dependency pruning doesn't silently break Vertex auth.
node << 'PATCH13_EOF'
const fs = require("fs");
const f = "package.json";
const pkg = JSON.parse(fs.readFileSync(f, "utf8"));
pkg.dependencies = pkg.dependencies || {};
if (pkg.dependencies["google-auth-library"]) {
  console.log("google-auth-library already in package.json dependencies, skipping");
  process.exit(0);
}
pkg.dependencies["google-auth-library"] = "^9.15.1";
// Keep dependencies alphabetically sorted to match the existing style.
const sorted = Object.keys(pkg.dependencies).sort().reduce((acc, k) => {
  acc[k] = pkg.dependencies[k];
  return acc;
}, {});
pkg.dependencies = sorted;
fs.writeFileSync(f, JSON.stringify(pkg, null, "\t") + "\n");
console.log("Patched: google-auth-library pinned in package.json");
PATCH13_EOF

# Patch 14: Declare VertexAnthropic as a known languageModelChatProviders vendor.
# Without this, VS Code refuses the registration at runtime with
# "Chat model provider uses UNKNOWN vendor vertexanthropic", which in turn
# breaks downstream `copilot-base` / family resolution for the primary chat
# participant. The entry is placed right after the `anthropic` entry so the
# two providers stay adjacent in the manifest.
node << 'PATCH14_EOF'
const fs = require("fs");
const f = "package.json";
const pkg = JSON.parse(fs.readFileSync(f, "utf8"));
const contributes = pkg.contributes || {};
const providers = contributes.languageModelChatProviders;
if (!Array.isArray(providers)) {
  console.log("languageModelChatProviders missing, skipping VertexAnthropic registration");
  process.exit(0);
}
// Vendor name must be lowercase to match `providerName.toLowerCase()` used in
// `byokContribution.ts` when calling `lm.registerLanguageModelChatProvider()`.
// Any past camelCase variants are normalised here so a bad manifest doesn't
// linger after a patch-script upgrade.
for (const p of providers) {
  if (p && typeof p.vendor === "string" && p.vendor.toLowerCase() === "vertexanthropic" && p.vendor !== "vertexanthropic") {
    console.log("Normalising existing VertexAnthropic vendor casing (" + p.vendor + " -> vertexanthropic)");
    p.vendor = "vertexanthropic";
  }
}
if (providers.some(p => p && p.vendor === "vertexanthropic")) {
  contributes.languageModelChatProviders = providers;
  pkg.contributes = contributes;
  fs.writeFileSync(f, JSON.stringify(pkg, null, "\t") + "\n");
  console.log("VertexAnthropic vendor already declared, ensured lowercase");
  process.exit(0);
}
const anthropicIdx = providers.findIndex(p => p && p.vendor === "anthropic");
const entry = {
  vendor: "vertexanthropic",
  displayName: "Anthropic (Vertex AI)",
  configuration: {
    properties: {
      apiKey: {
        type: "string",
        secret: true,
        description: "Google Cloud service-account JSON or access token for the Vertex AI project that hosts the Claude model family.",
        title: "Vertex AI credentials"
      }
    },
    required: ["apiKey"]
  }
};
if (anthropicIdx >= 0) {
  providers.splice(anthropicIdx + 1, 0, entry);
} else {
  providers.push(entry);
}
contributes.languageModelChatProviders = providers;
pkg.contributes = contributes;
fs.writeFileSync(f, JSON.stringify(pkg, null, "\t") + "\n");
console.log("Patched: VertexAnthropic vendor declared in package.json");
PATCH14_EOF

# Patch 15: Short-circuit switchToBaseModel() for BYOK / free / non-copilot
# requests BEFORE resolving the copilot-base endpoint.
#
# Upstream unconditionally calls `getChatEndpoint('copilot-base')` at the top
# of the method, which throws in BYOK-only mode (our fake-token bypass leaves
# `_copilotBaseModel` undefined and the rest of the function never gets to
# run). Since the existing guard already returns `request` unchanged for
# non-copilot vendors / 0x or undefined multipliers, move that guard *above*
# the base-endpoint lookup so BYOK requests never trigger the failed fetch.
#
# Symptom fixed (from exthost.log):
#   [error] Error: Unable to resolve chat model with family selection: copilot-base
#     at SS.getChatModelFromFamily (…)
#     at async n$.getChatEndpoint (…)
#     at async r4e.switchToBaseModel (…)
node << 'PATCH15_EOF'
const fs = require("fs");
const f = "src/extension/conversation/vscode-node/chatParticipants.ts";
let code = fs.readFileSync(f, "utf8");

if (code.includes("BYOK CUSTOM PATCH: skip copilot-base lookup for BYOK / free requests")) {
  console.log("switchToBaseModel BYOK guard already present, skipping");
  process.exit(0);
}

const original = `private async switchToBaseModel(request: vscode.ChatRequest, stream: vscode.ChatResponseStream): Promise<ChatRequest> {
\t\tconst endpoint = await this.endpointProvider.getChatEndpoint(request);
\t\tconst baseEndpoint = await this.endpointProvider.getChatEndpoint('copilot-base');
\t\t// If it has a 0x multipler, it's free so don't switch them. If it's BYOK, it's free so don't switch them.
\t\tif (endpoint.multiplier === 0 || request.model.vendor !== 'copilot' || endpoint.multiplier === undefined) {
\t\t\treturn request;
\t\t}
\t\tif (this._chatQuotaService.overagesEnabled || !this._chatQuotaService.quotaExhausted) {
\t\t\treturn request;
\t\t}
\t\tconst baseLmModel = (await vscode.lm.selectChatModels({ id: baseEndpoint.model, family: baseEndpoint.family, vendor: 'copilot' }))[0];`;

const replacement = `private async switchToBaseModel(request: vscode.ChatRequest, stream: vscode.ChatResponseStream): Promise<ChatRequest> {
\t\tconst endpoint = await this.endpointProvider.getChatEndpoint(request);
\t\t// ─── BYOK CUSTOM PATCH: skip copilot-base lookup for BYOK / free requests ───
\t\t// Preserved by .github/scripts/apply-byok-patches.sh. Do not remove.
\t\t// Upstream unconditionally calls \`getChatEndpoint('copilot-base')\` here, which
\t\t// throws in BYOK-only mode (fake-token bypass leaves \`_copilotBaseModel\`
\t\t// unset). Since we short-circuit below for non-copilot / 0x / undefined-
\t\t// multiplier requests anyway, do the guard *before* the base-endpoint
\t\t// resolution to avoid the unnecessary (and failure-prone) lookup.
\t\tif (endpoint.multiplier === 0 || request.model.vendor !== 'copilot' || endpoint.multiplier === undefined) {
\t\t\treturn request;
\t\t}
\t\t// ─── END BYOK CUSTOM PATCH ──────────────────────────────────────────────────
\t\tif (this._chatQuotaService.overagesEnabled || !this._chatQuotaService.quotaExhausted) {
\t\t\treturn request;
\t\t}
\t\tconst baseEndpoint = await this.endpointProvider.getChatEndpoint('copilot-base');
\t\tconst baseLmModel = (await vscode.lm.selectChatModels({ id: baseEndpoint.model, family: baseEndpoint.family, vendor: 'copilot' }))[0];`;

if (!code.includes(original)) {
  console.error("ERROR: switchToBaseModel source did not match expected shape; skipping patch 15");
  console.error("       Inspect chatParticipants.ts and update apply-byok-patches.sh to match.");
  process.exit(0);
}
code = code.replace(original, replacement);
fs.writeFileSync(f, code);
console.log("Patched: switchToBaseModel BYOK short-circuit");
PATCH15_EOF

# Patch 16: Tolerate copilot-fast unavailability in VirtualToolGrouper.
#
# `_generateBulkGroupDescriptions` unconditionally calls
# `getChatEndpoint('copilot-fast' → 'gpt-4o-mini')` to have an internal model
# summarize MCP / extension tool groups. In BYOK-only mode the fake-token
# bypass in modelMetadataFetcher leaves `_familyMap` empty, so the lookup
# throws — and the exception bubbles all the way out of `addGroups`, taking
# down the whole chat turn. This only surfaces when a workspace registers
# enough tools to cross START_BUILTIN_GROUPING_AFTER_TOOL_COUNT (≈128), which
# is easy to hit with Pylance + Looker + Tableau MCP servers loaded.
#
# Symptom fixed (from exthost.log):
#   [error] Error: Unable to resolve chat model with family selection: gpt-4o-mini
#     at async VirtualToolGrouper._generateBulkGroupDescriptions (…)
#
# Fix: wrap the endpoint lookup in try/catch, short-circuit when nothing
# needs describing, and iterate over `missing` instead of `described.length`
# so every missing entry still gets a deterministic fallback description.
node << 'PATCH16_EOF'
const fs = require("fs");
const f = "src/extension/tools/common/virtualTools/virtualToolGrouper.ts";
let code = fs.readFileSync(f, "utf8");

if (code.includes("BYOK CUSTOM PATCH: tolerate copilot-fast unavailability")) {
  console.log("VirtualToolGrouper BYOK guard already present, skipping");
  process.exit(0);
}

const original = `\t\tconst endpoint = await this._endpointProvider.getChatEndpoint(CATEGORIZATION_ENDPOINT);
\t\tconst described = await describeBulkToolGroups(endpoint, missing.map(m => m.tools), token);
\t\tlet missed = 0;
\t\tfor (let i = 0; i < described.length; i++) {`;

const replacement = `\t\t// ─── BYOK CUSTOM PATCH: tolerate copilot-fast unavailability ──────────────
\t\t// Preserved by .github/scripts/apply-byok-patches.sh. Do not remove.
\t\t// In BYOK-only mode the fake-token bypass in modelMetadataFetcher leaves
\t\t// \`_familyMap\` empty, so \`getChatEndpoint('copilot-fast' → 'gpt-4o-mini')\`
\t\t// throws. Without this guard, any chat turn that triggers virtual-tool
\t\t// grouping (≳128 tools, i.e. any MCP-heavy workspace like Looker +
\t\t// Tableau + Pylance) crashes entirely. We also short-circuit when nothing
\t\t// needs describing, and iterate over \`missing\` (not \`described.length\`)
\t\t// so each missing entry always gets a deterministic fallback description
\t\t// even when the LLM call returned a shorter array.
\t\tif (missing.length === 0) {
\t\t\treturn { groups: output, missed: 0 };
\t\t}

\t\tlet described: (ISummarizedToolCategory | undefined)[] = [];
\t\ttry {
\t\t\tconst endpoint = await this._endpointProvider.getChatEndpoint(CATEGORIZATION_ENDPOINT);
\t\t\tdescribed = await describeBulkToolGroups(endpoint, missing.map(m => m.tools), token);
\t\t} catch (e) {
\t\t\tthis._logService.warn(\`[virtual-tools] \${CATEGORIZATION_ENDPOINT} unavailable, using deterministic group descriptions: \${e}\`);
\t\t}
\t\t// ─── END BYOK CUSTOM PATCH ────────────────────────────────────────────────

\t\tlet missed = 0;
\t\tfor (let i = 0; i < missing.length; i++) {`;

if (!code.includes(original)) {
  console.error("ERROR: _generateBulkGroupDescriptions source did not match expected shape; skipping patch 16");
  console.error("       Inspect virtualToolGrouper.ts and update apply-byok-patches.sh to match.");
  process.exit(0);
}
code = code.replace(original, replacement);
fs.writeFileSync(f, code);
console.log("Patched: VirtualToolGrouper copilot-fast resilience");
PATCH16_EOF

# Patch 17: Sanitise cross-provider tool_use ids in anthropicMessageConverter.ts.
#
# Anthropic's API validates `tool_use.id` and `tool_result.tool_use_id` against
# `^[a-zA-Z0-9_-]+$`. Other providers (notably Gemini) emit call ids that can
# contain `.`, `/`, `:`, etc. When the user switches mid-conversation from
# Gemini to Claude, the historical tool-call ids flow through unchanged and
# Anthropic rejects the request with:
#
#   400 invalid_request_error: messages.N.content.M.tool_use.id:
#   String should match pattern '^[a-zA-Z0-9_-]+$'
#
# Fix: export a deterministic `sanitizeAnthropicToolId` helper (valid-through,
# invalid chars → `_` plus an FNV-1a hash suffix for collision resistance) and
# wrap the two passthrough sites (tool_use block + tool_result block).
node << 'PATCH17_EOF'
const fs = require("fs");
const f = "src/extension/byok/common/anthropicMessageConverter.ts";
let code = fs.readFileSync(f, "utf8");

if (code.includes("export function sanitizeAnthropicToolId")) {
  console.log("sanitizeAnthropicToolId already present, skipping");
  process.exit(0);
}

// Step 1: inject the helper just before `function apiContentToAnthropicContent`.
const fnAnchor = "function apiContentToAnthropicContent(";
if (!code.includes(fnAnchor)) {
  console.warn("WARN: apiContentToAnthropicContent anchor not found — skipping patch 17");
  process.exit(0);
}

const helper = `/**
 * Anthropic's API validates \`tool_use.id\` and \`tool_result.tool_use_id\` against
 * the pattern \`^[a-zA-Z0-9_-]+$\`. Other providers (notably Gemini) emit call IDs
 * that can contain \`.\`, \`/\`, \`:\`, etc., so when a user switches mid-conversation
 * from Gemini to Claude the historical tool-call IDs blow up the request with:
 *
 *   400 invalid_request_error: messages.N.content.M.tool_use.id:
 *   String should match pattern '^[a-zA-Z0-9_-]+$'
 *
 * This helper deterministically rewrites any call ID to satisfy Anthropic's
 * pattern. Rules:
 *   - Already-valid IDs pass through unchanged.
 *   - Invalid characters are replaced with \`_\`; if any character was replaced
 *     (or the result becomes empty), a short FNV-1a hash of the original is
 *     appended so two different offending IDs don't collapse to the same
 *     sanitized string in the same conversation.
 *
 * Must be deterministic and idempotent: the assistant's \`tool_use.id\` and the
 * user's subsequent \`tool_result.tool_use_id\` go through this helper
 * independently and MUST produce the same output for the same input.
 */
export function sanitizeAnthropicToolId(id: string): string {
\tif (/^[a-zA-Z0-9_-]+$/.test(id)) {
\t\treturn id;
\t}
\tconst replaced = id.replace(/[^a-zA-Z0-9_-]/g, '_');
\tlet h = 2166136261;
\tfor (let i = 0; i < id.length; i++) {
\t\th ^= id.charCodeAt(i);
\t\th = Math.imul(h, 16777619);
\t}
\tconst suffix = (h >>> 0).toString(16).padStart(8, '0');
\tconst base = replaced.length > 0 ? replaced : 'toolcall';
\treturn \`\${base}_\${suffix}\`;
}

`;

code = code.replace(fnAnchor, helper + fnAnchor);

// Step 2: wrap the tool_use id passthrough.
const toolUseAnchor = "type: 'tool_use',\n\t\t\t\tid: part.callId,";
if (!code.includes(toolUseAnchor)) {
  console.warn("WARN: tool_use id anchor not found — skipping patch 17 (tool_use leg)");
} else {
  code = code.replace(
    toolUseAnchor,
    "type: 'tool_use',\n\t\t\t\tid: sanitizeAnthropicToolId(part.callId),"
  );
}

// Step 3: wrap the tool_result tool_use_id passthrough.
const toolResultAnchor = "type: 'tool_result',\n\t\t\t\ttool_use_id: part.callId,";
if (!code.includes(toolResultAnchor)) {
  console.warn("WARN: tool_result tool_use_id anchor not found — skipping patch 17 (tool_result leg)");
} else {
  code = code.replace(
    toolResultAnchor,
    "type: 'tool_result',\n\t\t\t\ttool_use_id: sanitizeAnthropicToolId(part.callId),"
  );
}

fs.writeFileSync(f, code);
console.log("Patched: sanitizeAnthropicToolId (cross-provider tool id fix)");
PATCH17_EOF

# Patch 18: renderPromptElementJSON copilot-base fallback.
#
# `renderPromptElementJSON` in src/extension/prompts/node/base/promptRenderer.ts
# is the common trunk every file/edit tool goes through to render its result
# into a prompt-tsx tree (read_file, list_dir, file_search, grep_search,
# get_errors, replace_string_in_file via codeMapper, etc.). Upstream hardcodes
# `getChatEndpoint('copilot-base')` there. In BYOK-only mode the fake-token
# bypass leaves `_copilotBaseModel` unset, so that lookup throws and every
# tool invocation fails with:
#
#   [error] Error from tool read_file with args {...}:
#   Unable to resolve chat model with family selection: copilot-base
#
# Patches 15 and 16 fixed two other call sites; this is the one that took down
# all the built-in tools simultaneously. The endpoint here is only consumed
# for `modelMaxPromptTokens` (overridden by `tokenOptions.tokenBudget` when
# present, which every tool passes) and as an `IPromptEndpoint` DI value, so
# any registered endpoint is a safe substitute.
node << 'PATCH18_EOF'
const fs = require("fs");
const f = "src/extension/prompts/node/base/promptRenderer.ts";
let code = fs.readFileSync(f, "utf8");

if (code.includes("BYOK CUSTOM PATCH: renderPromptElementJSON copilot-base fallback")) {
  console.log("renderPromptElementJSON BYOK fallback already present, skipping");
  process.exit(0);
}

const original = `	const endpoint = await instantiationService.invokeFunction(async (accessor) => {
		const endpointProvider = accessor.get(IEndpointProvider);
		return await endpointProvider.getChatEndpoint('copilot-base');
	});`;

const replacement = `	const endpoint = await instantiationService.invokeFunction(async (accessor) => {
		const endpointProvider = accessor.get(IEndpointProvider);
		// ─── BYOK CUSTOM PATCH: renderPromptElementJSON copilot-base fallback ──────
		// Preserved by .github/scripts/apply-byok-patches.sh. Do not remove.
		// Upstream unconditionally resolves \`copilot-base\` here. In BYOK-only mode
		// the fake-token bypass leaves \`_copilotBaseModel\` unset, so the lookup
		// throws and every tool that renders its result through this helper
		// (read_file, list_dir, file_search, grep_search, get_errors, edit tools
		// via codeMapper, etc.) errors with "Unable to resolve chat model with
		// family selection: copilot-base". Fall back to any registered chat
		// endpoint — this value is only used for \`modelMaxPromptTokens\` (which
		// \`tokenOptions.tokenBudget\` overrides when present) and as an
		// \`IPromptEndpoint\` DI fallback.
		try {
			return await endpointProvider.getChatEndpoint('copilot-base');
		} catch {
			const all = await endpointProvider.getAllChatEndpoints();
			if (all.length > 0) {
				return all[0];
			}
			throw new Error('No chat endpoints available (BYOK fallback in renderPromptElementJSON)');
		}
		// ─── END BYOK CUSTOM PATCH ────────────────────────────────────────────────
	});`;

if (!code.includes(original)) {
  console.warn("WARN: renderPromptElementJSON anchor not found — skipping patch 18");
  process.exit(0);
}
code = code.replace(original, replacement);
fs.writeFileSync(f, code);
console.log("Patched: renderPromptElementJSON copilot-base fallback");
PATCH18_EOF

# Patch 19: VertexAnthropic context defaults + known Claude capability table.
#
# Upstream hard-codes TWO wrong things for every Vertex-hosted Claude model:
#
#   1. `maxInputTokens` defaults to 100K when a Vertex model config omits it —
#      that's half the real 200K context window of modern Claude models, and
#      because `maxInputTokens` is a hard client-side cap in VS Code's LM API,
#      prompts past 100K get rejected before they ever reach Vertex.
#
#   2. `vision: false` is hard-coded, so users see
#      "vision is not supported by the current model or is disabled by your
#      organization" even though every Claude model except Claude 3.5 Haiku
#      supports image input natively.
#
# The fix is a single `resolveVertexAnthropicLimits` helper backed by a
# static per-family capability table, plus a new optional `vision?: boolean`
# field on `VertexAnthropicModelConfig` so users who want to force-disable
# vision for a specific entry still can.
node << 'PATCH19_EOF'
const fs = require("fs");
const f = "src/extension/byok/vscode-node/vertexAnthropicProvider.ts";
let code = fs.readFileSync(f, "utf8");

if (code.includes("BYOK CUSTOM PATCH: vertex anthropic sensible context defaults")) {
  console.log("VertexAnthropic context defaults already present, skipping");
  process.exit(0);
}

const modelConfigAnchor = `export interface VertexAnthropicModelConfig {\n\tname: string;\n\tprojectId: string;\n\tlocationId: string;\n\tmaxInputTokens?: number;\n\tmaxOutputTokens?: number;\n}`;
const modelConfigReplacement = `export interface VertexAnthropicModelConfig {\n\tname: string;\n\tprojectId: string;\n\tlocationId: string;\n\tmaxInputTokens?: number;\n\tmaxOutputTokens?: number;\n\t/**\n\t * Override the default vision capability for this model. When omitted,\n\t * vision defaults to whatever the known-models table says for the model\n\t * ID (true for all modern Claude models except Claude 3.5 Haiku).\n\t */\n\tvision?: boolean;\n}`;
if (!code.includes(modelConfigAnchor)) {
  console.warn("WARN: VertexAnthropicModelConfig anchor not found — skipping patch 19 vision override field");
} else {
  code = code.replace(modelConfigAnchor, modelConfigReplacement);
}

const interfaceAnchor = `export interface VertexAnthropicProviderConfig extends LanguageModelChatConfiguration {\n\tmodels?: (VertexAnthropicModelConfig & { id: string })[];\n}`;
const interfaceReplacement = `export interface VertexAnthropicProviderConfig extends LanguageModelChatConfiguration {\n\tmodels?: (VertexAnthropicModelConfig & { id: string })[];\n}\n\n// ─── BYOK CUSTOM PATCH: vertex anthropic sensible context defaults ────────────\n// Preserved by .github/scripts/apply-byok-patches.sh. Do not remove.\n// Upstream falls back to 100 000 when a Vertex model config omits\n// \`maxInputTokens\` and hard-codes \`vision: false\` for every Claude model,\n// which breaks two things:\n//   1. \`maxInputTokens=100000\` is half modern Claude's real 200K context;\n//      VS Code's LM API treats it as a hard cap and rejects prompts past\n//      100K before they ever reach Vertex.\n//   2. \`vision: false\` surfaces to the user as\n//      \"vision is not supported by the current model or is disabled by\n//      your organization\" — even though every Claude model except\n//      Claude 3.5 Haiku supports image input natively.\n// We provide a small static lookup so users can drop a model ID into\n// \`chatLanguageModels.json\` without manually recalculating limits or\n// flipping capability flags every time Anthropic ships a new release.\nconst DEFAULT_VERTEX_ANTHROPIC_MAX_INPUT_TOKENS = 200_000;\nconst DEFAULT_VERTEX_ANTHROPIC_MAX_OUTPUT_TOKENS = 8_192;\ninterface KnownVertexAnthropicModel { maxInputTokens: number; maxOutputTokens: number; vision: boolean }\nconst KNOWN_VERTEX_ANTHROPIC_MODELS: Record<string, KnownVertexAnthropicModel> = {\n\t'claude-opus-4-6': { maxInputTokens: 200_000, maxOutputTokens: 32_000, vision: true },\n\t'claude-opus-4-5': { maxInputTokens: 200_000, maxOutputTokens: 32_000, vision: true },\n\t'claude-opus-4': { maxInputTokens: 200_000, maxOutputTokens: 32_000, vision: true },\n\t'claude-sonnet-4-5': { maxInputTokens: 200_000, maxOutputTokens: 64_000, vision: true },\n\t'claude-sonnet-4': { maxInputTokens: 200_000, maxOutputTokens: 64_000, vision: true },\n\t'claude-3-7-sonnet': { maxInputTokens: 200_000, maxOutputTokens: 64_000, vision: true },\n\t'claude-3-5-sonnet': { maxInputTokens: 200_000, maxOutputTokens: 8_192, vision: true },\n\t// Claude 3.5 Haiku is the one modern Claude that does NOT accept images.\n\t'claude-3-5-haiku': { maxInputTokens: 200_000, maxOutputTokens: 8_192, vision: false },\n\t'claude-3-opus': { maxInputTokens: 200_000, maxOutputTokens: 4_096, vision: true },\n\t'claude-3-haiku': { maxInputTokens: 200_000, maxOutputTokens: 4_096, vision: true },\n};\ninterface ResolvedVertexAnthropicLimits { maxInputTokens: number; maxOutputTokens: number; vision: boolean }\nfunction resolveVertexAnthropicLimits(modelId: string, cfg: { maxInputTokens?: number; maxOutputTokens?: number; vision?: boolean }): ResolvedVertexAnthropicLimits {\n\t// Strip the \`@YYYYMMDD\` date suffix Vertex uses so \`claude-sonnet-4@20250629\`\n\t// matches the \`claude-sonnet-4\` known entry. Longest-prefix wins so\n\t// \`claude-3-5-sonnet-…\` hits the 3.5 entry rather than the bare \`claude-3-\`.\n\tconst stripped = modelId.replace(/@.*$/, '');\n\tlet known: KnownVertexAnthropicModel | undefined;\n\tlet bestPrefix = '';\n\tfor (const [prefix, limits] of Object.entries(KNOWN_VERTEX_ANTHROPIC_MODELS)) {\n\t\tif ((stripped === prefix || stripped.startsWith(\`\${prefix}-\`) || stripped.startsWith(\`\${prefix}_\`)) && prefix.length > bestPrefix.length) {\n\t\t\tknown = limits;\n\t\t\tbestPrefix = prefix;\n\t\t}\n\t}\n\treturn {\n\t\tmaxInputTokens: cfg.maxInputTokens ?? known?.maxInputTokens ?? DEFAULT_VERTEX_ANTHROPIC_MAX_INPUT_TOKENS,\n\t\tmaxOutputTokens: cfg.maxOutputTokens ?? known?.maxOutputTokens ?? DEFAULT_VERTEX_ANTHROPIC_MAX_OUTPUT_TOKENS,\n\t\t// Unknown models default to vision-on — modern Claude is multimodal\n\t\t// by default and the cost of a false positive (a harmless 400 on\n\t\t// image input) is far lower than the current false negative\n\t\t// (\"vision is not supported by the current model\").\n\t\tvision: cfg.vision ?? known?.vision ?? true,\n\t};\n}\n// ─── END BYOK CUSTOM PATCH ────────────────────────────────────────────────────`;

if (!code.includes(interfaceAnchor)) {
  console.warn("WARN: VertexAnthropicProviderConfig anchor not found — skipping patch 19");
  process.exit(0);
}
code = code.replace(interfaceAnchor, interfaceReplacement);

const failoverAnchor = `\t\tconst baseInfo = byokKnownModelToAPIInfo(this._name, vertexId, {\n\t\t\tname: cfg.name || vertexId,\n\t\t\tmaxInputTokens: cfg.maxInputTokens || 100000,\n\t\t\tmaxOutputTokens: cfg.maxOutputTokens || 8192,\n\t\t\ttoolCalling: true,\n\t\t\tvision: false,\n\t\t});`;
const failoverReplacement = `\t\tconst { maxInputTokens, maxOutputTokens, vision } = resolveVertexAnthropicLimits(vertexId, cfg);\n\t\tconst baseInfo = byokKnownModelToAPIInfo(this._name, vertexId, {\n\t\t\tname: cfg.name || vertexId,\n\t\t\tmaxInputTokens,\n\t\t\tmaxOutputTokens,\n\t\t\ttoolCalling: true,\n\t\t\tvision,\n\t\t});`;
if (!code.includes(failoverAnchor)) {
  console.warn("WARN: resolveFailoverModel 100K literal not found — skipping patch 19 failover site");
} else {
  code = code.replace(failoverAnchor, failoverReplacement);
}

const listAnchor = `\t\tconst models: ExtendedLanguageModelChatInformation<VertexAnthropicProviderConfig>[] = [];\n\t\tfor (const modelConfig of modelConfigs) {\n\t\t\tconst modelId = modelConfig.id;\n\t\t\tmodels.push({\n\t\t\t\t...byokKnownModelToAPIInfo(this._name, modelId, {\n\t\t\t\t\tname: modelConfig.name || modelId,\n\t\t\t\t\tmaxInputTokens: modelConfig.maxInputTokens || 100000,\n\t\t\t\t\tmaxOutputTokens: modelConfig.maxOutputTokens || 8192,\n\t\t\t\t\ttoolCalling: true,\n\t\t\t\t\tvision: false\n\t\t\t\t}),\n\t\t\t\tconfiguration: {\n\t\t\t\t\tmodels: [{ ...modelConfig }]\n\t\t\t\t}\n\t\t\t});\n\t\t}\n\t\treturn models;`;
const listReplacement = `\t\tconst models: ExtendedLanguageModelChatInformation<VertexAnthropicProviderConfig>[] = [];\n\t\tfor (const modelConfig of modelConfigs) {\n\t\t\tconst modelId = modelConfig.id;\n\t\t\tconst { maxInputTokens, maxOutputTokens, vision } = resolveVertexAnthropicLimits(modelId, modelConfig);\n\t\t\tmodels.push({\n\t\t\t\t...byokKnownModelToAPIInfo(this._name, modelId, {\n\t\t\t\t\tname: modelConfig.name || modelId,\n\t\t\t\t\tmaxInputTokens,\n\t\t\t\t\tmaxOutputTokens,\n\t\t\t\t\ttoolCalling: true,\n\t\t\t\t\tvision\n\t\t\t\t}),\n\t\t\t\tconfiguration: {\n\t\t\t\t\tmodels: [{ ...modelConfig }]\n\t\t\t\t}\n\t\t\t});\n\t\t}\n\t\treturn models;`;
if (!code.includes(listAnchor)) {
  console.warn("WARN: getAllModels 100K literal not found — skipping patch 19 list site");
} else {
  code = code.replace(listAnchor, listReplacement);
}

fs.writeFileSync(f, code);
console.log("Patched: VertexAnthropic context defaults + known Claude model table");
PATCH19_EOF

# Patch 20: Self-calibrating chars-per-token ratio for Anthropic/Vertex.
#
# Upstream's `provideTokenCount` returns `Math.ceil(text.length / 4)`, which
# is optimistic for Claude — actual ratio is closer to 3.3 for code/JSON,
# ~3.8 for English. That heuristic drives the VS Code chat UI's context
# window indicator *and* our tiered auto-compaction thresholds (patches
# 4, 6), so an optimistic count means the user can silently approach the
# true model cap without a warning. Calling Anthropic's
# `/messages/count_tokens` endpoint per invocation would be prohibitively
# expensive (this method is hot), so instead we seed each model with a
# tighter baseline (3.5) and self-calibrate from the real `usage.input_tokens`
# every streamed response returns. After 2-3 turns the ratio converges to
# ground truth for the actual conversation style.
node << 'PATCH20_EOF'
const fs = require("fs");
const f = "src/extension/byok/vscode-node/anthropicProvider.ts";
let code = fs.readFileSync(f, "utf8");

if (code.includes("BYOK CUSTOM PATCH: self-calibrating chars-per-token ratio")) {
  console.log("Anthropic token-ratio calibration already present, skipping");
  process.exit(0);
}

const provideTokenCountAnchor = `\tasync provideTokenCount(model: LanguageModelChatInformation, text: string | LanguageModelChatMessage | LanguageModelChatMessage2, token: CancellationToken): Promise<number> {\n\t\t// Simple estimation - actual token count would require Claude's tokenizer\n\t\treturn Math.ceil(text.toString().length / 4);\n\t}`;
const provideTokenCountReplacement = `\t// ─── BYOK CUSTOM PATCH: self-calibrating chars-per-token ratio ────────────\n\t// Preserved by .github/scripts/apply-byok-patches.sh. Do not remove.\n\t// Upstream returns \`Math.ceil(text.length / 4)\`, which is optimistic for\n\t// Claude (actual ratio is closer to 3.3 for code/JSON, 3.8 for English).\n\t// Calling Anthropic's \`/messages/count_tokens\` endpoint on every\n\t// \`provideTokenCount\` invocation would be unusable (this method is hot —\n\t// VS Code calls it dozens of times per turn for UI sizing), so instead\n\t// we seed each model with a tighter baseline (3.5) and self-calibrate\n\t// from the real \`usage.input_tokens\` that every response returns. After\n\t// 2-3 turns the ratio converges to ground-truth for the specific\n\t// conversation style (code-heavy vs prose vs tool-call-heavy).\n\t//\n\t// The UI context-window indicator and auto-compaction thresholds\n\t// (Patches 4, 6) both flow from this number, so accuracy here directly\n\t// determines whether "we'll run out without noticing" or get a timely\n\t// warning before the hard cap.\n\tprivate static readonly _INITIAL_CHARS_PER_TOKEN = 3.5;\n\tprivate readonly _charsPerTokenByModel = new Map<string, number>();\n\tprivate _recordActualInputTokens(modelId: string, promptChars: number, actualInputTokens: number): void {\n\t\tif (!modelId || promptChars <= 0 || actualInputTokens <= 0) {\n\t\t\treturn;\n\t\t}\n\t\tconst observed = promptChars / actualInputTokens;\n\t\t// Reject pathological observations (empty prompts, cache-only hits,\n\t\t// count_tokens mismatches from context editing) that would otherwise\n\t\t// yank the running average around. 1.5–8.0 brackets every realistic\n\t\t// tokenizer ratio across English, code, and heavily-nested JSON.\n\t\tif (!isFinite(observed) || observed < 1.5 || observed > 8.0) {\n\t\t\treturn;\n\t\t}\n\t\tconst prior = this._charsPerTokenByModel.get(modelId) ?? AnthropicLMProvider._INITIAL_CHARS_PER_TOKEN;\n\t\t// EMA with α=0.3 — recent turns dominate but a single weird turn can't\n\t\t// overwrite the prior. Converges visibly within ~3 turns.\n\t\tconst smoothed = prior * 0.7 + observed * 0.3;\n\t\tthis._charsPerTokenByModel.set(modelId, smoothed);\n\t\tthis._logService.trace(\`[BYOK Anthropic] token-ratio calibrated for \${modelId}: chars/token=\${smoothed.toFixed(2)} (observed \${observed.toFixed(2)}, \${actualInputTokens} real tokens for \${promptChars} chars)\`);\n\t}\n\n\tasync provideTokenCount(model: LanguageModelChatInformation, text: string | LanguageModelChatMessage | LanguageModelChatMessage2, token: CancellationToken): Promise<number> {\n\t\tconst ratio = this._charsPerTokenByModel.get(model.id) ?? AnthropicLMProvider._INITIAL_CHARS_PER_TOKEN;\n\t\treturn Math.ceil(text.toString().length / ratio);\n\t}\n\t// ─── END BYOK CUSTOM PATCH ────────────────────────────────────────────────`;
if (!code.includes(provideTokenCountAnchor)) {
  console.warn("WARN: provideTokenCount anchor not found — skipping patch 20");
  process.exit(0);
}
code = code.replace(provideTokenCountAnchor, provideTokenCountReplacement);

const makeRequestAnchor = `\tprivate async _makeRequest(anthropicClient: Anthropic, progress: RecordedProgress<LMResponsePart>, params: Anthropic.Beta.Messages.MessageCreateParamsStreaming, betas: string[], token: CancellationToken, issuedTime: number): Promise<{ ttft: number | undefined; ttfte: number | undefined; usage: APIUsage | undefined; contextManagement: ContextManagementResponse | undefined }> {\n\t\tconst start = Date.now();\n\t\tlet ttft: number | undefined;\n\t\tlet ttfte: number | undefined;\n\n\t\tconst stream = await anthropicClient.beta.messages.create({`;
const makeRequestReplacement = `\tprivate async _makeRequest(anthropicClient: Anthropic, progress: RecordedProgress<LMResponsePart>, params: Anthropic.Beta.Messages.MessageCreateParamsStreaming, betas: string[], token: CancellationToken, issuedTime: number): Promise<{ ttft: number | undefined; ttfte: number | undefined; usage: APIUsage | undefined; contextManagement: ContextManagementResponse | undefined }> {\n\t\tconst start = Date.now();\n\t\tlet ttft: number | undefined;\n\t\tlet ttfte: number | undefined;\n\n\t\t// ─── BYOK CUSTOM PATCH: capture prompt chars for token ratio calibration ──\n\t\t// Preserved by .github/scripts/apply-byok-patches.sh. Do not remove.\n\t\t// Serialize the outgoing prompt once so that after the response returns\n\t\t// we can divide promptChars / actual input_tokens to derive a real\n\t\t// chars-per-token ratio for this model. JSON.stringify is a reasonable\n\t\t// proxy for \"what the tokenizer sees\" — it captures both message text\n\t\t// and the boilerplate (role markers, tool schemas, etc.) that\n\t\t// contribute to the prompt size.\n\t\tconst promptChars = (() => {\n\t\t\ttry {\n\t\t\t\treturn JSON.stringify({ system: params.system, messages: params.messages }).length;\n\t\t\t} catch {\n\t\t\t\treturn 0;\n\t\t\t}\n\t\t})();\n\t\t// ─── END BYOK CUSTOM PATCH ────────────────────────────────────────────────\n\n\t\tconst stream = await anthropicClient.beta.messages.create({`;
if (!code.includes(makeRequestAnchor)) {
  console.warn("WARN: _makeRequest stream-start anchor not found — skipping patch 20 promptChars site");
} else {
  code = code.replace(makeRequestAnchor, makeRequestReplacement);
}

const returnAnchor = `\t\treturn { ttft, ttfte, usage, contextManagement: contextManagementResponse };\n\t}\n}`;
const returnReplacement = `\t\t// ─── BYOK CUSTOM PATCH: calibrate chars-per-token from real usage ─────────\n\t\t// Preserved by .github/scripts/apply-byok-patches.sh. Do not remove.\n\t\t// \`usage.prompt_tokens\` here already folds in cache-creation and\n\t\t// cache-read tokens (see \`message_start\` handling above), which is what\n\t\t// Anthropic actually billed and what their tokenizer produced. Using it\n\t\t// to calibrate \`provideTokenCount\` keeps the UI context indicator and\n\t\t// auto-compaction thresholds honest over the life of the conversation.\n\t\tif (usage && usage.prompt_tokens > 0) {\n\t\t\tthis._recordActualInputTokens(params.model, promptChars, usage.prompt_tokens);\n\t\t}\n\t\t// ─── END BYOK CUSTOM PATCH ────────────────────────────────────────────────\n\n\t\treturn { ttft, ttfte, usage, contextManagement: contextManagementResponse };\n\t}\n}`;
if (!code.includes(returnAnchor)) {
  console.warn("WARN: _makeRequest return anchor not found — skipping patch 20 calibration site");
} else {
  code = code.replace(returnAnchor, returnReplacement);
}

fs.writeFileSync(f, code);
console.log("Patched: self-calibrating chars-per-token ratio for Anthropic/Vertex");
PATCH20_EOF

# Patch 21: Anthropic generic fallback capability table (vision default).
#
# `AnthropicLMProvider.getAllModels` populates model capabilities by first
# checking `this._knownModels` (the GitHub-fetched Copilot BYOK list) and,
# for anything missing, using a hard-coded generic fallback:
#
#     maxInputTokens: 100000
#     vision: false
#     thinking: false
#
# Under the BYOK fake-token bypass `_knownModels` is almost always empty
# (the list is filtered by Copilot subscription entitlement, which we spoof
# as `individual`), so every Anthropic model falls into that fallback and
# the user sees "vision is not supported by the current model" even when
# chatting with Claude Opus 4.6 or Sonnet 4.5 — both of which accept images
# natively. Consult a small per-family static capability table first, and
# make the ultimate generic fallback vision-on since every modern Claude
# except 3.5 Haiku is multimodal.
node << 'PATCH21_EOF'
const fs = require("fs");
const f = "src/extension/byok/vscode-node/anthropicProvider.ts";
let code = fs.readFileSync(f, "utf8");

if (code.includes("BYOK CUSTOM PATCH: anthropic known-models capability fallback")) {
  console.log("Anthropic capability fallback already present, skipping");
  process.exit(0);
}

const anchor = `\t// Filters the byok known models based on what the anthropic API knows as well\n\tprotected async getAllModels(silent: boolean, apiKey: string | undefined): Promise<ExtendedLanguageModelChatInformation<LanguageModelChatConfiguration>[]> {\n\t\tif (!apiKey && silent) {\n\t\t\treturn [];\n\t\t}\n\n\t\ttry {\n\t\t\tconst response = await new Anthropic({ apiKey }).models.list();\n\t\t\tconst modelList: Record<string, BYOKModelCapabilities> = {};\n\t\t\tfor (const model of response.data) {\n\t\t\t\tif (this._knownModels && this._knownModels[model.id]) {\n\t\t\t\t\tmodelList[model.id] = this._knownModels[model.id];\n\t\t\t\t} else {\n\t\t\t\t\t// Mix in generic capabilities for models we don't know\n\t\t\t\t\tmodelList[model.id] = {\n\t\t\t\t\t\tmaxInputTokens: 100000,\n\t\t\t\t\t\tmaxOutputTokens: 16000,\n\t\t\t\t\t\tname: model.display_name,\n\t\t\t\t\t\ttoolCalling: true,\n\t\t\t\t\t\tvision: false,\n\t\t\t\t\t\tthinking: false\n\t\t\t\t\t};\n\t\t\t\t}\n\t\t\t}\n\t\t\treturn byokKnownModelsToAPIInfoWithEffort(this._name, modelList);`;
const replacement = `\t// ─── BYOK CUSTOM PATCH: anthropic known-models capability fallback ────────\n\t// Preserved by .github/scripts/apply-byok-patches.sh. Do not remove.\n\t// Upstream's generic fallback for models missing from \`_knownModels\`\n\t// hard-codes \`maxInputTokens: 100000\`, \`vision: false\`, \`thinking: false\`.\n\t// Under the BYOK fake-token bypass \`_knownModels\` is almost always empty\n\t// (the list is fetched from GitHub and filtered by Copilot subscription),\n\t// so every Anthropic model falls through to that fallback and the user\n\t// sees \"vision is not supported by the current model\" even when chatting\n\t// with Claude Opus 4.6 which natively accepts images. Consult a small\n\t// per-model-family capability table first.\n\tprivate static readonly _KNOWN_ANTHROPIC_CAPABILITIES: Record<string, { maxInputTokens: number; maxOutputTokens: number; vision: boolean; thinking: boolean }> = {\n\t\t'claude-opus-4-6': { maxInputTokens: 200_000, maxOutputTokens: 32_000, vision: true, thinking: true },\n\t\t'claude-opus-4-5': { maxInputTokens: 200_000, maxOutputTokens: 32_000, vision: true, thinking: true },\n\t\t'claude-opus-4': { maxInputTokens: 200_000, maxOutputTokens: 32_000, vision: true, thinking: true },\n\t\t'claude-sonnet-4-5': { maxInputTokens: 200_000, maxOutputTokens: 64_000, vision: true, thinking: true },\n\t\t'claude-sonnet-4': { maxInputTokens: 200_000, maxOutputTokens: 64_000, vision: true, thinking: true },\n\t\t'claude-3-7-sonnet': { maxInputTokens: 200_000, maxOutputTokens: 64_000, vision: true, thinking: true },\n\t\t'claude-3-5-sonnet': { maxInputTokens: 200_000, maxOutputTokens: 8_192, vision: true, thinking: false },\n\t\t// Claude 3.5 Haiku is the one modern Claude that does NOT accept images.\n\t\t'claude-3-5-haiku': { maxInputTokens: 200_000, maxOutputTokens: 8_192, vision: false, thinking: false },\n\t\t'claude-3-opus': { maxInputTokens: 200_000, maxOutputTokens: 4_096, vision: true, thinking: false },\n\t\t'claude-3-haiku': { maxInputTokens: 200_000, maxOutputTokens: 4_096, vision: true, thinking: false },\n\t};\n\tprivate _resolveAnthropicCapabilities(modelId: string): { maxInputTokens: number; maxOutputTokens: number; vision: boolean; thinking: boolean } | undefined {\n\t\t// Claude API IDs usually carry a \`-YYYYMMDD\` date suffix\n\t\t// (e.g. \`claude-sonnet-4-5-20250629\`). Longest-prefix match so\n\t\t// \`claude-3-5-sonnet-…\` matches the 3.5 entry rather than \`claude-3-…\`.\n\t\tlet best: { maxInputTokens: number; maxOutputTokens: number; vision: boolean; thinking: boolean } | undefined;\n\t\tlet bestPrefix = '';\n\t\tfor (const [prefix, caps] of Object.entries(AnthropicLMProvider._KNOWN_ANTHROPIC_CAPABILITIES)) {\n\t\t\tif ((modelId === prefix || modelId.startsWith(\`\${prefix}-\`) || modelId.startsWith(\`\${prefix}@\`) || modelId.startsWith(\`\${prefix}_\`)) && prefix.length > bestPrefix.length) {\n\t\t\t\tbest = caps;\n\t\t\t\tbestPrefix = prefix;\n\t\t\t}\n\t\t}\n\t\treturn best;\n\t}\n\t// ─── END BYOK CUSTOM PATCH ────────────────────────────────────────────────\n\n\t// Filters the byok known models based on what the anthropic API knows as well\n\tprotected async getAllModels(silent: boolean, apiKey: string | undefined): Promise<ExtendedLanguageModelChatInformation<LanguageModelChatConfiguration>[]> {\n\t\tif (!apiKey && silent) {\n\t\t\treturn [];\n\t\t}\n\n\t\ttry {\n\t\t\tconst response = await new Anthropic({ apiKey }).models.list();\n\t\t\tconst modelList: Record<string, BYOKModelCapabilities> = {};\n\t\t\tfor (const model of response.data) {\n\t\t\t\tif (this._knownModels && this._knownModels[model.id]) {\n\t\t\t\t\tmodelList[model.id] = this._knownModels[model.id];\n\t\t\t\t} else {\n\t\t\t\t\t// ─── BYOK CUSTOM PATCH: vision-aware generic fallback ──────────\n\t\t\t\t\t// Preserved by .github/scripts/apply-byok-patches.sh. Do not remove.\n\t\t\t\t\t// Consult the static known-capability table first; fall back to\n\t\t\t\t\t// a safe generic entry only if the model family is unrecognised.\n\t\t\t\t\tconst known = this._resolveAnthropicCapabilities(model.id);\n\t\t\t\t\tmodelList[model.id] = known\n\t\t\t\t\t\t? {\n\t\t\t\t\t\t\tmaxInputTokens: known.maxInputTokens,\n\t\t\t\t\t\t\tmaxOutputTokens: known.maxOutputTokens,\n\t\t\t\t\t\t\tname: model.display_name,\n\t\t\t\t\t\t\ttoolCalling: true,\n\t\t\t\t\t\t\tvision: known.vision,\n\t\t\t\t\t\t\tthinking: known.thinking,\n\t\t\t\t\t\t}\n\t\t\t\t\t\t: {\n\t\t\t\t\t\t\tmaxInputTokens: 200_000,\n\t\t\t\t\t\t\tmaxOutputTokens: 16_000,\n\t\t\t\t\t\t\tname: model.display_name,\n\t\t\t\t\t\t\ttoolCalling: true,\n\t\t\t\t\t\t\t// Modern Claude is multimodal by default; the cost of a\n\t\t\t\t\t\t\t// false positive (a 400 on image input against a text-only\n\t\t\t\t\t\t\t// model Anthropic ships later) is far lower than the false\n\t\t\t\t\t\t\t// negative (\"vision is not supported\") users hit today.\n\t\t\t\t\t\t\tvision: true,\n\t\t\t\t\t\t\tthinking: false,\n\t\t\t\t\t\t};\n\t\t\t\t\t// ─── END BYOK CUSTOM PATCH ──────────────────────────────────────\n\t\t\t\t}\n\t\t\t}\n\t\t\treturn byokKnownModelsToAPIInfoWithEffort(this._name, modelList);`;

if (!code.includes(anchor)) {
  console.warn("WARN: AnthropicLMProvider.getAllModels anchor not found — skipping patch 21");
  process.exit(0);
}
code = code.replace(anchor, replacement);
fs.writeFileSync(f, code);
console.log("Patched: Anthropic known-models capability fallback (vision-aware)");
PATCH21_EOF

# Patch 22: Per-request [BYOK TokenBudget] info log for Anthropic/Vertex.
#
# Patch 20's chars-per-token calibration logs at trace level, which is
# invisible under the default `info` log level. When a user asks "is the
# context window working on Vertex?" we have no way to answer without
# asking them to enable trace logging. Emit one info-level line per
# completed request containing the real usage numbers, so the log is
# self-service diagnosable.
#
# Schema (single line, grep for `[BYOK TokenBudget]`):
#
#   [BYOK TokenBudget] provider=<Anthropic|VertexAnthropic> model=<id>
#     prompt_tokens=<N> output_tokens=<N>
#     max_input=<cap> pct_used=<N>%
#     estimated=<est> delta=<real-est> ratio=<chars/token>
#     promptChars=<N> contextEdits=<N>
#
# `providerName` is static and overridden by VertexAnthropicLMProvider, so
# `(this.constructor as typeof AnthropicLMProvider).providerName` correctly
# labels Vertex-routed traffic vs direct Anthropic without duplicating
# the log statement in the subclass.
node << 'PATCH22_EOF'
const fs = require("fs");
const f = "src/extension/byok/vscode-node/anthropicProvider.ts";
let code = fs.readFileSync(f, "utf8");

if (code.includes("BYOK CUSTOM PATCH: per-request TokenBudget info log")) {
  console.log("TokenBudget info log already present, skipping");
  process.exit(0);
}

const anchor = `\t\tif (usage && usage.prompt_tokens > 0) {\n\t\t\tthis._recordActualInputTokens(params.model, promptChars, usage.prompt_tokens);\n\t\t}\n\t\t// ─── END BYOK CUSTOM PATCH ────────────────────────────────────────────────\n\n\t\treturn { ttft, ttfte, usage, contextManagement: contextManagementResponse };`;

const replacement = `\t\tif (usage && usage.prompt_tokens > 0) {\n\t\t\tthis._recordActualInputTokens(params.model, promptChars, usage.prompt_tokens);\n\t\t}\n\t\t// ─── END BYOK CUSTOM PATCH ────────────────────────────────────────────────\n\n\t\t// ─── BYOK CUSTOM PATCH: per-request TokenBudget info log ──────────────────\n\t\t// Preserved by .github/scripts/apply-byok-patches.sh. Do not remove.\n\t\t// Emits one info-level line per completed request so context-window\n\t\t// behaviour is visible without enabling trace logging. Works for both\n\t\t// direct Anthropic and Vertex-routed Anthropic (the subclass overrides\n\t\t// \`providerName\`, so the log tag tells us which path ran). Grep the\n\t\t// extension log for \`[BYOK TokenBudget]\` to audit every turn.\n\t\tif (usage && usage.prompt_tokens > 0) {\n\t\t\ttry {\n\t\t\t\tconst providerTag = (this.constructor as typeof AnthropicLMProvider).providerName;\n\t\t\t\tconst caps = this._resolveAnthropicCapabilities(params.model);\n\t\t\t\tconst max = caps?.maxInputTokens ?? 0;\n\t\t\t\tconst pct = max > 0 ? ((usage.prompt_tokens / max) * 100).toFixed(1) : 'n/a';\n\t\t\t\tconst ratio = this._charsPerTokenByModel.get(params.model) ?? AnthropicLMProvider._INITIAL_CHARS_PER_TOKEN;\n\t\t\t\tconst estimated = Math.ceil(promptChars / ratio);\n\t\t\t\tconst delta = usage.prompt_tokens - estimated;\n\t\t\t\tconst editsApplied = contextManagementResponse?.applied_edits?.length ?? 0;\n\t\t\t\tconst out = usage.completion_tokens > 0 ? usage.completion_tokens : 0;\n\t\t\t\tthis._logService.info(\n\t\t\t\t\t\`[BYOK TokenBudget] provider=\${providerTag} model=\${params.model} \` +\n\t\t\t\t\t\`prompt_tokens=\${usage.prompt_tokens} output_tokens=\${out} \` +\n\t\t\t\t\t\`max_input=\${max} pct_used=\${pct}% \` +\n\t\t\t\t\t\`estimated=\${estimated} delta=\${delta} ratio=\${ratio.toFixed(2)} \` +\n\t\t\t\t\t\`promptChars=\${promptChars} contextEdits=\${editsApplied}\`\n\t\t\t\t);\n\t\t\t} catch {\n\t\t\t\t// Never let instrumentation break the request path.\n\t\t\t}\n\t\t}\n\t\t// ─── END BYOK CUSTOM PATCH ────────────────────────────────────────────────\n\n\t\treturn { ttft, ttfte, usage, contextManagement: contextManagementResponse };`;

if (!code.includes(anchor)) {
  console.warn("WARN: TokenBudget anchor not found — skipping patch 22 (patch 20/21 may be missing)");
  process.exit(0);
}
code = code.replace(anchor, replacement);
fs.writeFileSync(f, code);
console.log("Patched: [BYOK TokenBudget] per-request info log");
PATCH22_EOF
