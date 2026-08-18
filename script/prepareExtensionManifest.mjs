/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import fs from 'node:fs';
import path from 'node:path';

const [extensionRoot, upstreamVersion, upstreamEngine, vscodeCommit] = process.argv.slice(2);

if (!extensionRoot || !upstreamVersion || !upstreamEngine || !vscodeCommit) {
	console.error('Usage: node script/prepareExtensionManifest.mjs <extension-root> <upstream-version> <upstream-engine> <vscode-commit>');
	process.exit(2);
}

function parseVersion(value, label) {
	const match = /^(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/.exec(value);
	if (!match) {
		throw new Error(`Invalid ${label} version: ${value}`);
	}

	return match.slice(1).map(Number);
}

function compareVersions(left, right) {
	for (let index = 0; index < 3; index++) {
		if (left[index] !== right[index]) {
			return left[index] - right[index];
		}
	}

	return 0;
}

const packagePath = path.join(extensionRoot, 'package.json');
const packageLockPath = path.join(extensionRoot, 'package-lock.json');
const packageJson = JSON.parse(fs.readFileSync(packagePath, 'utf8'));
const sourceVersion = parseVersion(packageJson.version, 'fork');
const builtinVersion = parseVersion(upstreamVersion, 'built-in');

const packagedVersion = compareVersions(sourceVersion, builtinVersion) > 0
	? sourceVersion
	: [builtinVersion[0], builtinVersion[1], builtinVersion[2] + 1];
const packagedVersionString = packagedVersion.join('.');

packageJson.version = packagedVersionString;
packageJson.engines ??= {};
packageJson.engines.vscode = upstreamEngine;
packageJson.vscodeCommit = vscodeCommit;
fs.writeFileSync(packagePath, `${JSON.stringify(packageJson, null, '\t')}\n`);

if (fs.existsSync(packageLockPath)) {
	const packageLock = JSON.parse(fs.readFileSync(packageLockPath, 'utf8'));
	packageLock.version = packagedVersionString;
	if (packageLock.packages?.['']) {
		packageLock.packages[''].version = packagedVersionString;
		packageLock.packages[''].engines ??= {};
		packageLock.packages[''].engines.vscode = upstreamEngine;
	}
	fs.writeFileSync(packageLockPath, `${JSON.stringify(packageLock, null, '\t')}\n`);
}

console.log(`Prepared Copilot Full BYOK ${packagedVersionString} for VS Code ${upstreamEngine} (${vscodeCommit}).`);
