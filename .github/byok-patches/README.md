# BYOK custom-file canonical sources

The files under `files/` are the **canonical copies** of source files that this
fork adds on top of the upstream Copilot Chat extension but which **do not
exist in `microsoft/vscode`**. Every upstream sync runs `rsync -a --delete`,
which wipes anything in `src/` that isn't in the upstream tree. Without a
place outside of `src/` to keep these files, they would get deleted on every
sync.

`.github/` is excluded from the sync's `rsync --delete`, so files stored here
survive. `.github/scripts/apply-byok-patches.sh` copies them back into `src/`
immediately after the sync.

## Contents

| Canonical file                             | Installed to                                                   |
|--------------------------------------------|----------------------------------------------------------------|
| `files/vertexAnthropicProvider.ts`         | `src/extension/byok/vscode-node/vertexAnthropicProvider.ts`    |
| `files/byokFailover.ts`                    | `src/extension/byok/common/byokFailover.ts`                    |
| `files/byokFailover.spec.ts`               | `src/extension/byok/common/test/byokFailover.spec.ts`          |

## Workflow

- **Editing a restored file**: edit the copy under `files/` *and* the live
  copy under `src/`. Keeping both in sync lets `tsc --watch` and the IDE see
  changes immediately while also keeping the post-sync reinstall up to date.
- **Verification**: the PR workflow runs `diff` between the two locations and
  fails if they have drifted. If you see a failure, run:

    ```bash
    cp src/extension/byok/vscode-node/vertexAnthropicProvider.ts \
       .github/byok-patches/files/vertexAnthropicProvider.ts
    cp src/extension/byok/common/byokFailover.ts \
       .github/byok-patches/files/byokFailover.ts
    cp src/extension/byok/common/test/byokFailover.spec.ts \
       .github/byok-patches/files/byokFailover.spec.ts
    ```

- **Adding a new restored file**: drop the source under `files/`, add a row
  above, and extend the "Install BYOK-only files" patch block in
  `.github/scripts/apply-byok-patches.sh`.
