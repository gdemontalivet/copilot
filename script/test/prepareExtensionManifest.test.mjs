/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const repoRoot = fileURLToPath(new URL('../../', import.meta.url));
const script = path.join(repoRoot, 'script/prepareExtensionManifest.mjs');

function createFixture(t, manifest = { version: '0.60.1', engines: { vscode: '^1.131.0' } }) {
	const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'byok-manifest-'));
	t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
	fs.writeFileSync(path.join(directory, 'package.json'), JSON.stringify(manifest));
	fs.writeFileSync(path.join(directory, 'package-lock.json'), JSON.stringify({
		version: manifest.version,
		lockfileVersion: 3,
		packages: { '': { version: manifest.version, engines: manifest.engines } },
	}));
	return directory;
}

function prepare(directory, builtin, engine, checkoutVersion, checkoutEngine) {
	const args = [script, directory, builtin, engine, 'test-commit'];
	if (checkoutVersion) {
		args.push(checkoutVersion, checkoutEngine);
	}
	const result = spawnSync(process.execPath, args, { encoding: 'utf8' });
	assert.equal(result.status, 0, result.stderr);
	const manifest = JSON.parse(fs.readFileSync(path.join(directory, 'package.json'), 'utf8'));
	const lock = JSON.parse(fs.readFileSync(path.join(directory, 'package-lock.json'), 'utf8'));
	assert.equal(lock.version, manifest.version);
	assert.equal(lock.packages[''].version, manifest.version);
	assert.equal(lock.packages[''].engines.vscode, manifest.engines.vscode);
	assert.equal(manifest.vscodeCommit, 'test-commit');
	return manifest;
}

test('stale release targets cannot package below the checked-out Copilot or editor', t => {
	const directory = createFixture(t);
	const manifest = prepare(directory, '0.67.0', '^1.139.1', '0.69.0', '^1.141.0');
	assert.equal(manifest.version, '0.69.1');
	assert.equal(manifest.engines.vscode, '^1.141.0');
});

test('released built-in metadata can be newer than the source checkout', t => {
	const directory = createFixture(t);
	const manifest = prepare(directory, '0.69.0', '^1.141.0', '0.60.0', '^1.132.0');
	assert.equal(manifest.version, '0.69.1');
	assert.equal(manifest.engines.vscode, '^1.141.0');
});

test('a newer fork keeps its version and editor requirement', t => {
	const directory = createFixture(t, { version: '0.70.2', engines: { vscode: '^1.142.0' } });
	const manifest = prepare(directory, '0.69.0', '^1.141.0', '0.69.0', '^1.141.0');
	assert.equal(manifest.version, '0.70.2');
	assert.equal(manifest.engines.vscode, '^1.142.0');
});

test('packaging is repeatable when the fork equals the built-in version', t => {
	const directory = createFixture(t, { version: '0.69.0', engines: { vscode: '^1.141.0' } });
	const manifest = prepare(directory, '0.69.0', '^1.141.0');
	assert.equal(manifest.version, '0.69.1');
	assert.deepEqual(prepare(directory, '0.69.0', '^1.141.0'), manifest);
});

test('the release manifest retains all local provider contributions', t => {
	const source = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8'));
	const builtin = fs.readFileSync(path.join(repoRoot, 'TARGET_BUILTIN_COPILOT_VERSION'), 'utf8').trim();
	const engine = `^${fs.readFileSync(path.join(repoRoot, 'TARGET_VSCODE_VERSION'), 'utf8').trim()}`;
	const directory = createFixture(t, source);
	const manifest = prepare(directory, builtin, engine);
	assert.deepEqual(manifest.contributes, source.contributes);
	const vendors = new Set(manifest.contributes.languageModelChatProviders.map(provider => provider.vendor));
	for (const vendor of ['gemini', 'geminiadc', 'vertexgemini', 'vertexanthropic', 'deepseek', 'byokauto', 'byokfusion', 'ollama']) {
		assert.ok(vendors.has(vendor), `Missing provider: ${vendor}`);
	}
	assert.equal(manifest.version, source.version, 'The committed fork version must already beat the target built-in');
	assert.equal(manifest.engines.vscode, source.engines.vscode);
});
