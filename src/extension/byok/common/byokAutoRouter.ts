/*---------------------------------------------------------------------------------------------
 *  BYOK CUSTOM FILE (Patch 40). Canonical copy under
 *  `.github/byok-patches/files/byokAutoRouter.ts` and installed into
 *  `src/extension/byok/common/` by `.github/scripts/apply-byok-patches.sh`
 *  on every upstream sync. Do not edit the installed copy directly.
 *
 *  Pure-logic file — zero network, zero VS Code API, no SDK deps. Lives
 *  under `common/` so the router can be unit-tested without pulling in
 *  `@google/genai`, `@anthropic-ai/sdk`, or `vscode`. The provider
 *  (`byokAutoProvider.ts`, vscode-node/) wires it up with live models.
 *--------------------------------------------------------------------------------------------*/

import type { ClassificationResult, TaskComplexity, TaskType } from './byokRoutingClassifier.types';

/**
 * Minimal structural view of a `LanguageModelChat` — the fields the router
 * uses to rank candidates. Keeping this narrow (instead of importing the
 * real `vscode.LanguageModelChat` interface) is deliberate: the router is
 * pure logic and must compile in `common/` without the vscode type stubs.
 *
 * At runtime the provider passes the actual `LanguageModelChat` objects
 * through `routeToTarget`; structural typing lets the real objects satisfy
 * this shape without any casts.
 */
export interface RoutableModel {
	readonly vendor: string;
	readonly id: string;
	readonly family?: string;
	readonly name?: string;
	/**
	 * Upstream VS Code LM API exposes `capabilities.imageInput` on the
	 * resolved model object. Router reads it to satisfy `needs_vision`
	 * without hitting the wire.
	 */
	readonly capabilities?: {
		readonly imageInput?: boolean;
		readonly toolCalling?: boolean;
	};
	readonly maxInputTokens?: number;
}

/**
 * A single entry in the routing table: an ordered list of preferred
 * model "needles" (matched case-insensitively against `id` / `family` /
 * `name`) for a given (complexity, task_type) cell.
 *
 * Order matters — earlier entries win when multiple candidates match.
 * The last entry should generally be a safe mid-tier model so the cell
 * always resolves.
 */
export type RoutingPreferences = readonly string[];

/**
 * The full routing table: `table[complexity][task_type] = RoutingPreferences`.
 * A missing cell falls back to `table[complexity]['*']` (the complexity
 * default), and finally to the global `DEFAULT_MODEL_PREFERENCES` list.
 */
export type RoutingTable = {
	readonly [K in TaskComplexity]?: {
		readonly [T in TaskType | '*']?: RoutingPreferences;
	};
};

/**
 * Baseline routing table. Tuned for the user's actual BYOK lineup:
 *   - `gemini-3-flash` and `gemini-3.1-pro-preview` via the direct Gemini key.
 *   - `claude-sonnet-4.6` / `claude-opus-4` / `claude-haiku` via Anthropic
 *     direct or Vertex.
 *
 * Strings are substrings — matched against the model's `id` / `family` /
 * `name` with `String.includes` (lowercased on both sides). So `'gemini-3-flash'`
 * matches `models/gemini-3-flash-preview` as well as a cleaner `gemini-3-flash`
 * id. This tolerance is important because each vendor spells its ids
 * differently (`models/` prefix for direct Gemini, bare names for Vertex).
 *
 * Cheapest-first within each cell: the router walks left-to-right and
 * picks the first registered match. If nothing in the row is registered,
 * it falls through to the complexity-level `'*'` default, then to the
 * global `DEFAULT_MODEL_PREFERENCES`, and finally to the vendor-priority
 * auto-discovery inside the provider (Patch 39).
 */
export const DEFAULT_ROUTING_TABLE: RoutingTable = {
	trivial: {
		// Needle strategy: use bare family names (`haiku`, `sonnet`,
		// `opus`, `flash`, `pro`) as the primary match token. This
		// matches across both direct-API and Vertex id shapes — e.g.
		// Anthropic's `claude-haiku-4-5` AND Vertex's
		// `claude-3-5-haiku@20241022` both contain `haiku`; direct
		// Gemini's `models/gemini-3.1-pro-preview` AND Vertex's
		// `gemini-3.1-pro-preview` both contain `gemini-3.1-pro`.
		// Listed cheapest-first within each cell.
		'*': ['gemini-3-flash', 'gemini-2.0-flash', 'flash', 'haiku', 'gemini-3.1-pro'],
		shell: ['gemini-3-flash', 'flash', 'haiku'],
		chat: ['gemini-3-flash', 'flash', 'haiku'],
	},
	simple: {
		'*': ['gemini-3-flash', 'flash', 'gemini-3.1-pro', 'sonnet', 'haiku'],
		code_gen: ['gemini-3.1-pro', 'gemini-3-flash', 'sonnet', 'flash'],
		explain: ['gemini-3-flash', 'flash', 'gemini-3.1-pro', 'haiku'],
		chat: ['gemini-3-flash', 'flash', 'haiku', 'gemini-3.1-pro'],
	},
	moderate: {
		'*': ['gemini-3.1-pro', 'sonnet', 'gemini-3-flash', 'flash'],
		code_gen: ['gemini-3.1-pro', 'sonnet'],
		debug: ['sonnet', 'gemini-3.1-pro'],
		refactor: ['sonnet', 'gemini-3.1-pro'],
		sql: ['gemini-3.1-pro', 'sonnet'],
		test: ['gemini-3.1-pro', 'sonnet'],
	},
	complex: {
		'*': ['sonnet', 'opus', 'gemini-3.1-pro'],
		plan: ['opus', 'sonnet', 'gemini-3.1-pro'],
		debug: ['sonnet', 'opus'],
		refactor: ['opus', 'sonnet'],
	},
};

/**
 * Last-resort preference list used when the routing table has no match
 * for the (complexity, task_type) cell and no `'*'` default either.
 * Mirrors `BYOKAutoLMProvider.AUTO_DISCOVERY_MODEL_PREFERENCE` (Patch 39)
 * so static vs classifier mode behave consistently when nothing is
 * configured.
 */
export const DEFAULT_MODEL_PREFERENCES: readonly string[] = [
	'gemini-3.1-pro',
	'gemini-3-pro',
	'gemini-3-flash',
	'gemini-2.5-pro',
	'gemini-2.0-flash',
	'claude-sonnet-4',
	'claude-opus-4',
	'claude-haiku',
	'gpt-5',
	'gpt-4.1',
];

/** Options consumed by {@link routeToTarget}. */
export interface RouteOptions {
	/**
	 * Routing table to use. Defaults to {@link DEFAULT_ROUTING_TABLE}.
	 * Callers may pass a user-override parsed from
	 * `chat.byok.auto.routingTable`.
	 */
	readonly table?: RoutingTable;
	/**
	 * Global fallback preference list. Defaults to
	 * {@link DEFAULT_MODEL_PREFERENCES}.
	 */
	readonly fallbackPreferences?: readonly string[];
	/**
	 * When true, drop models whose `capabilities.imageInput !== true`
	 * before ranking. Driven by `ClassificationResult.needs_vision`.
	 * Defaults to honouring the classification.
	 */
	readonly enforceVision?: boolean;
	/**
	 * Vendor id of the `BYOKAutoLMProvider` itself. Excluded from the
	 * candidate pool to prevent infinite recursion. Defaults to the
	 * canonical string `'byokauto'`.
	 */
	readonly selfVendorId?: string;
}

/** What {@link routeToTarget} returned and why. */
export interface RoutingDecision<T extends RoutableModel = RoutableModel> {
	readonly target: T;
	/**
	 * Which rule selected the target:
	 *   - `'table'`        — an entry in the routing table matched.
	 *   - `'table-default'`— the complexity-level `'*'` default matched.
	 *   - `'fallback'`     — neither cell nor default matched; used
	 *                        `DEFAULT_MODEL_PREFERENCES`.
	 *   - `'first-of-kind'`— nothing preferred matched; picked first
	 *                        remaining candidate (preserves input order).
	 */
	readonly rule: 'table' | 'table-default' | 'fallback' | 'first-of-kind';
	/**
	 * The substring needle that matched the chosen target, or
	 * `undefined` for `'first-of-kind'`.
	 */
	readonly matchedNeedle?: string;
}

/**
 * Route a classified prompt to the best available model from `candidates`.
 *
 * Algorithm:
 *   1. Drop `selfVendorId` (byokauto itself) and any model whose
 *      `capabilities.imageInput !== true` when the classifier said
 *      `needs_vision: true`.
 *   2. Look up `table[complexity][task_type]`; walk the list and return
 *      the first candidate matching any needle (rule `'table'`).
 *   3. If empty, look up `table[complexity]['*']`; same walk (rule
 *      `'table-default'`).
 *   4. If still empty, walk {@link DEFAULT_MODEL_PREFERENCES} (rule
 *      `'fallback'`).
 *   5. If *still* empty, return the first remaining candidate (rule
 *      `'first-of-kind'`).
 *   6. Return `undefined` only when the candidate pool is empty after
 *      vision filtering — caller decides whether to retry without
 *      vision, log, or throw.
 */
export function routeToTarget<T extends RoutableModel>(
	classification: Pick<ClassificationResult, 'complexity' | 'task_type' | 'needs_vision'>,
	candidates: readonly T[],
	options: RouteOptions = {},
): RoutingDecision<T> | undefined {
	const table = options.table ?? DEFAULT_ROUTING_TABLE;
	const fallback = options.fallbackPreferences ?? DEFAULT_MODEL_PREFERENCES;
	const selfVendorId = options.selfVendorId ?? 'byokauto';
	const enforceVision = options.enforceVision ?? classification.needs_vision;

	let pool = candidates.filter(m => m.vendor !== selfVendorId);
	if (enforceVision) {
		const withVision = pool.filter(m => m.capabilities?.imageInput === true);
		// Only collapse to vision-capable models if at least one exists.
		// If none advertise `imageInput`, fall back to the full pool so
		// the turn still runs — the downstream model will reject the
		// image part itself, which gives a better error surface than
		// "no model available" from the router.
		if (withVision.length > 0) {
			pool = withVision;
		}
	}

	if (pool.length === 0) {
		return undefined;
	}

	const cell = table[classification.complexity]?.[classification.task_type];
	if (cell) {
		const hit = findFirstMatch(pool, cell);
		if (hit) {
			return { target: hit.model, rule: 'table', matchedNeedle: hit.needle };
		}
	}

	const cellDefault = table[classification.complexity]?.['*'];
	if (cellDefault) {
		const hit = findFirstMatch(pool, cellDefault);
		if (hit) {
			return { target: hit.model, rule: 'table-default', matchedNeedle: hit.needle };
		}
	}

	const fallbackHit = findFirstMatch(pool, fallback);
	if (fallbackHit) {
		return { target: fallbackHit.model, rule: 'fallback', matchedNeedle: fallbackHit.needle };
	}

	return { target: pool[0], rule: 'first-of-kind' };
}

/**
 * Walk `needles` left-to-right; return the first `candidate` whose
 * id / family / name (lowercased) contains the needle. Exposed so tests
 * and the provider's static-mode fallback can share the same matching
 * semantics.
 */
export function findFirstMatch<T extends RoutableModel>(
	candidates: readonly T[],
	needles: readonly string[],
): { model: T; needle: string } | undefined {
	for (const raw of needles) {
		const needle = raw.toLowerCase();
		if (!needle) {
			continue;
		}
		const model = candidates.find(m => matchesNeedle(m, needle));
		if (model) {
			return { model, needle: raw };
		}
	}
	return undefined;
}

function matchesNeedle(model: RoutableModel, needle: string): boolean {
	const id = (model.id ?? '').toLowerCase();
	const family = (model.family ?? '').toLowerCase();
	const name = (model.name ?? '').toLowerCase();
	return id.includes(needle) || family.includes(needle) || name.includes(needle);
}

/**
 * Merge a user-supplied override into the {@link DEFAULT_ROUTING_TABLE}.
 * Override wins on conflict; missing cells are filled from the default.
 * Rejects malformed input (non-object / wrong shape) by returning the
 * default untouched — the caller is expected to log the validation
 * failure rather than throwing here, so a bad setting never blocks a
 * chat turn.
 */
export function mergeRoutingTable(
	override: unknown,
	base: RoutingTable = DEFAULT_ROUTING_TABLE,
): RoutingTable {
	if (!override || typeof override !== 'object' || Array.isArray(override)) {
		return base;
	}
	const merged: { [K in TaskComplexity]?: { [T in TaskType | '*']?: RoutingPreferences } } = {};
	const complexities: TaskComplexity[] = ['trivial', 'simple', 'moderate', 'complex'];

	for (const c of complexities) {
		const baseRow = base[c];
		const overrideRow = (override as Record<string, unknown>)[c];
		if (baseRow) {
			merged[c] = { ...baseRow };
		}
		if (overrideRow && typeof overrideRow === 'object' && !Array.isArray(overrideRow)) {
			merged[c] = { ...(merged[c] ?? {}) };
			for (const [key, value] of Object.entries(overrideRow)) {
				if (Array.isArray(value) && value.every(v => typeof v === 'string')) {
					(merged[c] as Record<string, RoutingPreferences>)[key] = value as RoutingPreferences;
				}
			}
		}
	}
	return merged;
}
