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
node << 'PATCH5_EOF'
const fs = require("fs");
const f = "src/platform/endpoint/node/modelMetadataFetcher.ts";
let code = fs.readFileSync(f, "utf8");

if (code.includes("BYOK CUSTOM PATCH: fake-token bypass")) {
  console.log("modelMetadataFetcher bypass already present, skipping");
  process.exit(0);
}

// Step 1: inject fake-token bypass after `const copilotToken = (await this._authService.getCopilotToken()).token;`
const tokenAnchor = "const copilotToken = (await this._authService.getCopilotToken()).token;";
if (!code.includes(tokenAnchor)) {
  console.warn("WARN: copilotToken anchor not found — skipping modelMetadataFetcher patch");
  process.exit(0);
}

const bypass = `${tokenAnchor}

		// ─── BYOK CUSTOM PATCH: fake-token bypass ─────────────────────
		// Preserved by .github/scripts/apply-byok-patches.sh. Do not remove.
		// Skip API call when using a fake/offline token (BYOK-only mode).
		// The fake token will always 401 against the Copilot API, so avoid
		// the network round-trip and error log spam.
		if (copilotToken === 'fake-token') {
			this._lastFetchTime = Date.now();
			this._onDidModelRefresh.fire();
			return;
		}
		// ─── END BYOK CUSTOM PATCH ────────────────────────────────────`;

code = code.replace(tokenAnchor, bypass);

// Step 2: 1-min backoff instead of hot-loop retry on failure
const retryAnchor = "this._lastFetchError = e;\n\t\t\tthis._lastFetchTime = 0;";
if (code.includes(retryAnchor)) {
  code = code.replace(
    retryAnchor,
    "this._lastFetchError = e;\n\t\t\t// BYOK CUSTOM PATCH: 1-min backoff instead of hot-loop retry\n\t\t\tthis._lastFetchTime = Date.now() - 9 * 60 * 1000;\n\t\t\tthis._onDidModelRefresh.fire();"
  );
}

fs.writeFileSync(f, code);
console.log("Patched: modelMetadataFetcher fake-token bypass");
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
if (providers.some(p => p && p.vendor === "VertexAnthropic")) {
  console.log("VertexAnthropic vendor already declared, skipping");
  process.exit(0);
}
const anthropicIdx = providers.findIndex(p => p && p.vendor === "anthropic");
const entry = {
  vendor: "VertexAnthropic",
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
