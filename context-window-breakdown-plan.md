# Context-Window Breakdown Plan (Reusable)

## 1) Confirmed Constraints

- VS Code does **not** expose an API to customize the context-ring popover (the one above chat input).
- The available extension surface is `vscode.window.createChatStatusItem(...)`.
- So the practical path is: keep ring behavior intact, add a parallel breakdown UI in chat status row.

## 2) MVP Scope (Path A)

Add a `ChatStatusItem` named `Context Window`:

- Collapsed: `Context: 42% (125K / 300K)`
- Expanded details:
  - System prompt
  - Tools
  - Summarized conversation
  - Conversation
  - Current message

This is the closest achievable mapping to the Cursor screenshot using VS Code APIs.

## 3) Patch Design (Patch 51)

### Step A — Canonical BYOK Files (nightly-safe)

Create canonical files under `.github/byok-patches/files/`:

1. `contextBreakdown.ts`
   - pure breakdown calculator from `Raw.ChatMessage[]`
   - helpers: `formatTokens()`, `contextPercent()`
2. `contextBreakdownChannel.ts`
   - singleton emitter channel (`reportContextBreakdown`, `onDidUpdateContextBreakdown`)
3. `contextWindowStatusItem.ts`
   - renders `ChatStatusItem` UI
4. `contextBreakdown.spec.ts`
   - focused unit tests for classification/formatting

Install via `install_byok_file` into:

- `src/extension/byok/common/contextBreakdown.ts`
- `src/extension/byok/common/contextBreakdownChannel.ts`
- `src/extension/byok/common/test/contextBreakdown.spec.ts`
- `src/extension/byok/vscode-node/contextWindowStatusItem.ts`

### Step B — Producer Hook in Prompt Pipeline

Patch `src/extension/intents/node/toolCallingLoop.ts` right after prompt build metrics are computed:

- use existing `tokenizer`, `promptTokenLength`, `toolTokenCount`
- read summary text from `SummarizedConversationHistoryMetadata?.text`
- compute breakdown and emit via channel
- wrap in best-effort `try/catch` so instrumentation never breaks a turn

### Step C — Register Chat Status Contribution

Patch `src/extension/extension/vscode-node/contributions.ts`:

- add import for `ContextWindowStatusItem`
- register `asContributionFactory(ContextWindowStatusItem)` in `vscodeNodeContributions`

### Step D — Persist Across Nightly Sync

Update `.github/scripts/apply-byok-patches.sh` with Patch 51 block:

- canonical file installs (`install_byok_file`)
- source tree edits (`toolCallingLoop.ts`, `contributions.ts`)
- idempotent sentinels + soft-fail anchors (`console.warn`, `exit 0`)

### Step E — Update Rule Documentation

Add Patch 51 entry to `.cursor/rules/byok-custom-patches.mdc`:

- purpose
- files touched
- ordering/anchor assumptions
- expected user-visible behavior

## 4) Validation Plan

1. Run patch apply:

```bash
bash .github/scripts/apply-byok-patches.sh
```

2. Verify idempotency:

```bash
bash .github/scripts/apply-byok-patches.sh
```

Patch 51 should report already-present/skipping on second run.

3. Run focused tests:

```bash
npx vitest run src/extension/byok/common/test/contextBreakdown.spec.ts
```

4. Optional typecheck:

```bash
npm run typecheck
```

## 5) Known Session Blocker

- Focused Vitest run failed locally because `rollup` was missing in `node_modules`.
- Install dependency or restore full workspace deps before executing Step 3.

## 6) Quick Checklist

- [ ] Canonical files added in `.github/byok-patches/files/`
- [ ] `install_byok_file` entries added in patch script
- [ ] `toolCallingLoop.ts` hook added
- [ ] `contributions.ts` import + contribution registration added
- [ ] Patch 51 scripted with sentinels/idempotency
- [ ] Rule doc updated (`byok-custom-patches.mdc`)
- [ ] Patch script run twice (fresh + idempotent)
- [ ] Focused Vitest spec passes

