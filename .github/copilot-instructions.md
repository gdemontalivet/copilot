# Copilot Full BYOK instructions

## Project identity

This repository is a local-model/BYOK fork of `microsoft/vscode/extensions/copilot`.
`UPSTREAM_VSCODE_COMMIT` is the exact upstream source revision. The package version is
the upstream extension version plus a deterministic local patch version.

The extension must work while signed out of GitHub. Use upstream's native signed-out
BYOK activation and model-provider registration. Never create a fake Copilot token,
pretend that the user has a paid SKU, or add bypasses keyed to a synthetic token.

## Source-of-truth rules

- `src/` is the only source of truth for implementation and tests.
- Do not recreate `.github/byok-patches`, generated canonical copies, or a text-rewrite
  patch script.
- Changes to upstream files and local provider files are normal committed source edits.
- Prefer upstream provider abstractions and utilities before adding fork-specific code.
- Keep upstream implementations for providers that upstream already supports, including
  OpenRouter, unless the fork requires a tested behavioral difference.

The genuinely local features currently include Vertex Anthropic, Vertex Gemini,
Gemini ADC/Interactions, DeepSeek-specific handling, BYOK Auto/Fusion routing, provider
failover, and the context-window indicator.

## Updating upstream

1. Compare the pinned commit with the desired `microsoft/vscode` commit.
2. Rebase the local feature delta onto `extensions/copilot` as source changes.
3. Update `UPSTREAM_VSCODE_COMMIT`.
4. Set `package.json` to the upstream version plus one deterministic local patch version.
5. Keep `engines.vscode` at the upstream requirement; never clamp it to an older VS Code.
6. Run the monorepo-context validation below before declaring the update complete.

## Validation

The standalone directory intentionally references VS Code monorepo type declarations.
For typechecking or packaging, assemble a pinned sparse checkout:

```bash
bash script/prepareUpstreamCheckout.sh /tmp/vscode-byok
cd /tmp/vscode-byok/extensions/copilot
npm ci
npm run typecheck
```

Run the smallest relevant Vitest specs after typechecking. The PR and VSIX workflows
perform monorepo-context typechecking and the local BYOK regression suite.

## Coding standards

- Use tabs in TypeScript and preserve Microsoft copyright headers.
- Prefer dependency-injected services over direct VS Code or Node APIs.
- Register disposables immediately.
- Avoid `any`, broad casts, duplicated imports, and duplicated helpers.
- Use existing provider model discovery, capability resolution, retry middleware, and
  utility-model selection where they fit.
- Localize user-facing strings through the existing localization mechanism.
- Add or update a focused test for every behavior change.
