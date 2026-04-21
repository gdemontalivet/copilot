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

# Patch 3: Rename extension and bump version
node -e '
const fs = require("fs");
const pkg = JSON.parse(fs.readFileSync("package.json", "utf8"));
pkg.displayName = "Copilot Full BYOK";
pkg.description = "AI chat features powered by Copilot — Full Bring Your Own Key edition";
const parts = pkg.version.split(".").map(Number);
pkg.version = parts[0] + "." + parts[1] + "." + (parts[2] + 1);
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
