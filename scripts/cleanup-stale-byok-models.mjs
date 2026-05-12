#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────────────
// cleanup-stale-byok-models.mjs
//
// One-shot cleanup for stale BYOK model entries in VS Code's persistent
// chat-picker cache (`chat.cachedLanguageModels.v2`).
//
// Why this exists: when you remove a vendor from `chatLanguageModels.json`,
// VS Code does NOT prune the corresponding entries from
// `chat.cachedLanguageModels.v2`. The picker keeps showing the removed
// models, and they can collide by bare `metadata.id` with newly-added
// vendors (upstream bug microsoft/vscode#312908) — which silently hides
// the new models from the picker entirely.
//
// What this script does:
//   1. Reads `chat.cachedLanguageModels.v2` from VS Code's globalStorage DB.
//   2. Drops every model whose `metadata.vendor` is not in the keep-list
//      below (which is read from your current `chatLanguageModels.json`).
//   3. Writes the trimmed list back atomically.
//   4. Prints a summary of what was removed.
//
// IMPORTANT: VS Code must be COMPLETELY CLOSED before running this script,
// or SQLite will be locked and the write will fail.
//
//   Usage:
//     1. Quit VS Code (Cmd+Q, not just close window — make sure the dock
//        icon is gone).
//     2. Run:  node scripts/cleanup-stale-byok-models.mjs
//     3. Optionally pass --dry-run to preview without writing.
//     4. Re-open VS Code.
//
// ─────────────────────────────────────────────────────────────────────────────

import { execSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const dryRun = process.argv.includes('--dry-run');

const DB_PATH = join(
	homedir(),
	'Library',
	'Application Support',
	'Code',
	'User',
	'globalStorage',
	'state.vscdb',
);

const CHAT_LM_CONFIG = join(
	homedir(),
	'Library',
	'Application Support',
	'Code',
	'User',
	'chatLanguageModels.json',
);

if (!existsSync(DB_PATH)) {
	console.error(`State DB not found: ${DB_PATH}`);
	process.exit(1);
}

if (!existsSync(CHAT_LM_CONFIG)) {
	console.error(`chatLanguageModels.json not found: ${CHAT_LM_CONFIG}`);
	process.exit(1);
}

// Sanity check: refuse to run if VS Code looks like it's running (only when
// actually writing — dry-run is read-only so it's always safe).
if (!dryRun) {
	try {
		const pgrep = execSync('pgrep -fl "Visual Studio Code"', { encoding: 'utf8' }).trim();
		if (pgrep) {
			console.error('VS Code appears to be running. Please quit it completely (Cmd+Q) before running this script.');
			console.error('(Pass --dry-run to preview without writing while VS Code is open.)');
			process.exit(1);
		}
	} catch {
		// pgrep exits non-zero when no match — that's what we want.
	}
}

// Read the active vendor list from chatLanguageModels.json. Anything NOT in
// here will be pruned from the cache.
const config = JSON.parse(readFileSync(CHAT_LM_CONFIG, 'utf8'));
const activeVendors = new Set(config.map(e => e.vendor));
// Always keep these — they're either first-party copilot vendors or BYOK
// vendors we want to keep around regardless of chatLanguageModels.json.
activeVendors.add('copilot');
activeVendors.add('copilot-edits');
activeVendors.add('copilotcli'); // GitHub Copilot CLI bundled models — not in chatLanguageModels.json
activeVendors.add('ollama');  // local; not represented in chatLanguageModels.json
activeVendors.add('byokauto'); // BYOK Auto vendor

console.log(`Active vendors (keep): ${[...activeVendors].sort().join(', ')}`);

// Read the cached language models row.
const sqlRead = `SELECT value FROM ItemTable WHERE key='chat.cachedLanguageModels.v2'`;
const raw = execSync(`sqlite3 "${DB_PATH}" "${sqlRead}"`, { encoding: 'utf8' }).trim();
if (!raw) {
	console.log('No chat.cachedLanguageModels.v2 row found. Nothing to clean.');
	process.exit(0);
}

const models = JSON.parse(raw);
const total = models.length;

const keep = [];
const dropByVendor = new Map();
for (const m of models) {
	const vendor = m.metadata?.vendor;
	if (!vendor || activeVendors.has(vendor)) {
		keep.push(m);
	} else {
		const arr = dropByVendor.get(vendor) ?? [];
		arr.push(`${m.metadata.id} (${m.metadata.name ?? '?'})`);
		dropByVendor.set(vendor, arr);
	}
}

console.log(`Total models cached: ${total}`);
console.log(`Would drop: ${total - keep.length}`);
for (const [vendor, items] of dropByVendor) {
	console.log(`  ${vendor} (${items.length}):`);
	for (const item of items) {
		console.log(`    - ${item}`);
	}
}
console.log(`Would keep: ${keep.length}`);

if (dryRun) {
	console.log('\n--dry-run was passed; no write performed.');
	process.exit(0);
}

if (keep.length === total) {
	console.log('\nNothing to remove — all cached models belong to active vendors.');
	process.exit(0);
}

const trimmed = JSON.stringify(keep);
// Escape single quotes for the SQL literal.
const escaped = trimmed.replace(/'/g, "''");
const sqlWrite = `UPDATE ItemTable SET value='${escaped}' WHERE key='chat.cachedLanguageModels.v2'`;

// sqlite3's command-line tool truncates very long arguments via the shell;
// stuff the SQL into a temp file and execute it via .read for safety.
const tmpSqlFile = join(homedir(), '.tmp-vscode-clean.sql');
writeFileSync(tmpSqlFile, sqlWrite);
try {
	execSync(`sqlite3 "${DB_PATH}" < "${tmpSqlFile}"`, { encoding: 'utf8' });
	console.log(`\nWrote trimmed cache: ${keep.length} models (was ${total}).`);
	console.log('Re-open VS Code; the picker should now show only models from active vendors.');
} finally {
	execSync(`rm -f "${tmpSqlFile}"`);
}
