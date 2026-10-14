#!/usr/bin/env bash

#---------------------------------------------------------------------------------------------
#  Copyright (c) Microsoft Corporation. All rights reserved.
#  Licensed under the MIT License. See License.txt in the project root for license information.
#---------------------------------------------------------------------------------------------

set -euo pipefail

if [[ $# -ne 1 ]]; then
	echo "Usage: $0 <new-vscode-checkout-directory>" >&2
	exit 2
fi

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
target="$1"
commit="$(tr -d '[:space:]' < "$repo_root/UPSTREAM_VSCODE_COMMIT")"
target_vscode_version="$(tr -d '[:space:]' < "$repo_root/TARGET_VSCODE_VERSION")"
builtin_copilot_version="$(tr -d '[:space:]' < "$repo_root/TARGET_BUILTIN_COPILOT_VERSION")"

if [[ -z "$target" || "$target" == "/" || "$target" == "$repo_root" || -e "$target" ]]; then
	echo "Target must be a new, dedicated checkout directory: $target" >&2
	exit 2
fi

git init -q --initial-branch=main "$target"
git -C "$target" remote add origin https://github.com/microsoft/vscode.git
git -C "$target" config remote.origin.promisor true
git -C "$target" config remote.origin.partialclonefilter blob:none
git -C "$target" sparse-checkout init --cone
git -C "$target" sparse-checkout set extensions/copilot src/typings src/vscode-dts
git -C "$target" fetch --depth=1 origin "$commit"
GIT_LFS_SKIP_SMUDGE=1 git -C "$target" checkout --detach FETCH_HEAD

# Read the upstream manifest before the fork overlay replaces it. Release
# metadata can be stale; the package must also beat the checked-out version.
checkout_copilot_version="$(node -p "require(require('node:path').resolve(process.argv[1])).version" "$target/extensions/copilot/package.json")"
checkout_vscode_engine="$(node -p "require(require('node:path').resolve(process.argv[1])).engines.vscode" "$target/extensions/copilot/package.json")"

rsync -a --delete \
	--exclude='.git' \
	--exclude='.agents' \
	--exclude='.codex' \
	--exclude='.cursor' \
	--exclude='.build' \
	--exclude='.simulation' \
	--exclude='coverage' \
	--exclude='dist' \
	--exclude='dist-sourcemaps' \
	--exclude='node_modules' \
	--exclude='*.vsix' \
	"$repo_root/" "$target/extensions/copilot/"

node "$repo_root/script/prepareExtensionManifest.mjs" \
	"$target/extensions/copilot" \
	"$builtin_copilot_version" \
	"^$target_vscode_version" \
	"$commit" \
	"$checkout_copilot_version" \
	"$checkout_vscode_engine"

echo "$target/extensions/copilot"
