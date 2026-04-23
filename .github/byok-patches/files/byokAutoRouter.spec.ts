/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it } from 'vitest';
import type { ClassificationResult } from '../byokRoutingClassifier.types';
import {
	DEFAULT_MODEL_PREFERENCES,
	DEFAULT_ROUTING_TABLE,
	findFirstMatch,
	mergeRoutingTable,
	RoutableModel,
	routeToTarget,
} from '../byokAutoRouter';

/**
 * Shorthand: build a fake `RoutableModel` that only carries the fields
 * the router reads. Anything else is elided so the tests stay focused
 * on the routing contract.
 */
function m(
	id: string,
	opts: Partial<RoutableModel> & { vendor?: string; vision?: boolean } = {},
): RoutableModel {
	return {
		vendor: opts.vendor ?? 'gemini',
		id,
		family: opts.family,
		name: opts.name,
		capabilities: {
			imageInput: opts.vision,
			toolCalling: opts.capabilities?.toolCalling,
		},
		maxInputTokens: opts.maxInputTokens,
	};
}

/**
 * Build a stub `ClassificationResult` inline so individual tests can
 * pin just the dimensions they care about without spelling out
 * `latencyMs`, `source`, and `confidence` every time.
 */
function classify(
	complexity: ClassificationResult['complexity'],
	task_type: ClassificationResult['task_type'],
	overrides: Partial<ClassificationResult> = {},
): ClassificationResult {
	return {
		complexity,
		task_type,
		topic_changed: overrides.topic_changed ?? false,
		needs_vision: overrides.needs_vision ?? false,
		confidence: overrides.confidence ?? 0.8,
		source: overrides.source ?? 'gemini-flash',
		latencyMs: overrides.latencyMs ?? 100,
	};
}

describe('routeToTarget', () => {
	describe('routing table lookup', () => {
		it('picks the first needle in the (complexity, task_type) cell that matches a candidate', () => {
			const pro = m('models/gemini-3.1-pro-preview');
			const flash = m('models/gemini-3-flash-preview');
			const decision = routeToTarget(classify('moderate', 'code_gen'), [flash, pro]);
			// `moderate.code_gen` lists `gemini-3.1-pro` before
			// `claude-sonnet-4` — pro must win even though flash was
			// advertised first.
			expect(decision?.target).toBe(pro);
			expect(decision?.rule).toBe('table');
			expect(decision?.matchedNeedle).toBe('gemini-3.1-pro');
		});

		it('falls back to the complexity-level default when the task_type cell has no match', () => {
			// Build a pool where ONLY a cheap Haiku is available. The
			// `moderate.code_gen` cell (pro → sonnet) has no match, but
			// the `moderate.*` default (pro → sonnet → flash) *still*
			// misses; that forces it into the global fallback (rule
			// `fallback`) rather than `table-default`. We want to
			// exercise `table-default` explicitly, so make the default
			// list include a model we *do* have.
			const haiku = m('claude-3-5-haiku', { vendor: 'anthropic' });
			const override = {
				moderate: {
					code_gen: ['gemini-nonexistent'],
					// Bare family name — matches both direct-API
					// (`claude-haiku-4-5`) and Vertex
					// (`claude-3-5-haiku@20241022`) id shapes.
					'*': ['haiku'],
				},
			};
			const decision = routeToTarget(
				classify('moderate', 'code_gen'),
				[haiku],
				{ table: override },
			);
			expect(decision?.target).toBe(haiku);
			expect(decision?.rule).toBe('table-default');
			expect(decision?.matchedNeedle).toBe('haiku');
		});

		it('falls through to DEFAULT_MODEL_PREFERENCES when the table row misses entirely', () => {
			// Only an OpenAI GPT model is available — no Gemini/Claude
			// in the pool. The `complex.plan` cell AND `complex.*` default
			// both only list Claude/Gemini needles, so the router must
			// advance to the global `DEFAULT_MODEL_PREFERENCES` list
			// (which includes `gpt-4.1`).
			const gpt = m('gpt-4.1', { vendor: 'openai' });
			const decision = routeToTarget(classify('complex', 'plan'), [gpt]);
			expect(decision?.target).toBe(gpt);
			expect(decision?.rule).toBe('fallback');
			expect(decision?.matchedNeedle).toBe('gpt-4.1');
		});

		it('returns the first remaining candidate when no preference list matches', () => {
			// A bespoke vendor the router has never heard of. None of
			// the routing table rows, the complexity defaults, or
			// DEFAULT_MODEL_PREFERENCES know about it — the router must
			// still make progress and return the first pool member.
			const weird = m('exotic-model-xyz', { vendor: 'someprovider' });
			const decision = routeToTarget(classify('moderate', 'code_gen'), [weird]);
			expect(decision?.target).toBe(weird);
			expect(decision?.rule).toBe('first-of-kind');
			expect(decision?.matchedNeedle).toBeUndefined();
		});

		it('returns undefined when the candidate pool is empty', () => {
			const decision = routeToTarget(classify('moderate', 'code_gen'), []);
			expect(decision).toBeUndefined();
		});
	});

	describe('vision gating', () => {
		it('drops non-vision models when needs_vision is true', () => {
			const textOnly = m('claude-haiku-text', { vendor: 'anthropic', vision: false });
			const visionCapable = m('models/gemini-3-flash', { vision: true });
			const decision = routeToTarget(
				classify('simple', 'explain', { needs_vision: true }),
				[textOnly, visionCapable],
			);
			expect(decision?.target).toBe(visionCapable);
		});

		it('falls back to the full pool when needs_vision is true but NO model advertises imageInput', () => {
			// Strict vision filtering would return `undefined` here,
			// which means no turn runs. That's worse than routing to a
			// text model and letting it surface the image-unsupported
			// error itself — so the router deliberately ignores
			// `needs_vision` when it would otherwise empty the pool.
			const textOnly = m('gpt-4.1-text', { vendor: 'openai', vision: false });
			const decision = routeToTarget(
				classify('simple', 'code_gen', { needs_vision: true }),
				[textOnly],
			);
			expect(decision?.target).toBe(textOnly);
		});

		it('ignores vision filter when classification says needs_vision is false', () => {
			const textOnly = m('models/gemini-3-flash', { vision: false });
			const decision = routeToTarget(classify('trivial', 'chat'), [textOnly]);
			expect(decision?.target).toBe(textOnly);
		});
	});

	describe('self-exclusion', () => {
		it('excludes byokauto itself from candidates to prevent infinite recursion', () => {
			const self = m('auto', { vendor: 'byokauto' });
			const gemini = m('models/gemini-3-flash');
			const decision = routeToTarget(classify('trivial', 'chat'), [self, gemini]);
			expect(decision?.target).toBe(gemini);
		});

		it('honours a custom selfVendorId override', () => {
			const self = m('auto', { vendor: 'my-custom-auto' });
			const gemini = m('models/gemini-3-flash');
			const decision = routeToTarget(
				classify('trivial', 'chat'),
				[self, gemini],
				{ selfVendorId: 'my-custom-auto' },
			);
			expect(decision?.target).toBe(gemini);
		});
	});

	describe('needle matching semantics', () => {
		it('matches needles against id, family, and name (case-insensitive)', () => {
			// id-only match — a legitimate one with no family set.
			const byId = m('GEMINI-3-FLASH-latest');
			// family-only match — id is opaque, family carries the
			// recognisable family string.
			const byFamily = m('abc123', { family: 'Gemini' });
			// name-only match — some BYOK providers only fill `name`
			// when `id` is a provider-internal identifier.
			const byName = m('internal-xyz', { name: 'Gemini 3 Flash Preview' });

			expect(findFirstMatch([byId], ['gemini-3-flash'])?.model).toBe(byId);
			// Family search: bare `gemini` lives in DEFAULT_MODEL_PREFERENCES
			// via `gemini-3-flash` etc., not as a naked `gemini`. Match on
			// a substring that exists in the actual family value.
			expect(findFirstMatch([byFamily], ['gemini'])?.model).toBe(byFamily);
			expect(findFirstMatch([byName], ['gemini 3 flash'])?.model).toBe(byName);
		});

		it('skips empty needles to tolerate sloppy user-supplied lists', () => {
			const model = m('models/gemini-3.1-pro-preview');
			// An empty string in the middle must not short-circuit the
			// walk. `'gemini-3.1-pro'` should still win.
			const hit = findFirstMatch([model], ['', 'gemini-3.1-pro']);
			expect(hit?.model).toBe(model);
			expect(hit?.needle).toBe('gemini-3.1-pro');
		});
	});
});

describe('DEFAULT_ROUTING_TABLE', () => {
	it('has non-empty preference lists for every declared (complexity, task_type) cell', () => {
		// Catch accidental empty arrays — they would silently skip the
		// `'table'` branch and fall through to `'table-default'`, which
		// is almost never what we want.
		for (const [complexity, row] of Object.entries(DEFAULT_ROUTING_TABLE)) {
			for (const [task, prefs] of Object.entries(row ?? {})) {
				expect(prefs, `${complexity}.${task}`).toBeDefined();
				expect(prefs!.length, `${complexity}.${task}`).toBeGreaterThan(0);
			}
		}
	});

	it('provides a `*` default for every complexity level so the table-default rule can always fire', () => {
		// If some complexity's `*` is missing, routing falls straight
		// to DEFAULT_MODEL_PREFERENCES — legal but wasteful. We want
		// every row to carry its own sensible default so user overrides
		// per-row still benefit from the complexity-level bias.
		for (const complexity of ['trivial', 'simple', 'moderate', 'complex'] as const) {
			const row = DEFAULT_ROUTING_TABLE[complexity];
			expect(row, complexity).toBeDefined();
			expect(row!['*'], `${complexity}.*`).toBeDefined();
		}
	});
});

describe('mergeRoutingTable', () => {
	it('returns the base untouched when the override is not an object', () => {
		expect(mergeRoutingTable(null)).toBe(DEFAULT_ROUTING_TABLE);
		expect(mergeRoutingTable(undefined)).toBe(DEFAULT_ROUTING_TABLE);
		expect(mergeRoutingTable('nope')).toBe(DEFAULT_ROUTING_TABLE);
		// Arrays are objects in JS but wrong shape — must be rejected
		// rather than silently enumerated by index.
		expect(mergeRoutingTable(['gemini'])).toBe(DEFAULT_ROUTING_TABLE);
	});

	it('overrides matching cells and leaves untouched cells as-is', () => {
		const override = {
			moderate: {
				code_gen: ['my-favourite-model'],
			},
		};
		const merged = mergeRoutingTable(override);
		expect(merged.moderate?.code_gen).toEqual(['my-favourite-model']);
		// `moderate.*` is inherited from the base since override didn't
		// touch it.
		expect(merged.moderate?.['*']).toEqual(DEFAULT_ROUTING_TABLE.moderate?.['*']);
		// Other complexity rows untouched.
		expect(merged.trivial).toEqual(DEFAULT_ROUTING_TABLE.trivial);
	});

	it('rejects non-string-array cell values without contaminating the merged table', () => {
		const override = {
			moderate: {
				code_gen: 'not-an-array',
				debug: ['valid', 'model', 'list'],
				refactor: [1, 2, 3], // mixed-type array
			},
		};
		const merged = mergeRoutingTable(override);
		// Good cell got merged.
		expect(merged.moderate?.debug).toEqual(['valid', 'model', 'list']);
		// Malformed cells fell back to base.
		expect(merged.moderate?.code_gen).toEqual(DEFAULT_ROUTING_TABLE.moderate?.code_gen);
		expect(merged.moderate?.refactor).toEqual(DEFAULT_ROUTING_TABLE.moderate?.refactor);
	});
});

describe('DEFAULT_MODEL_PREFERENCES shape', () => {
	it('keeps the top preferences aligned with the provider auto-discovery list (Patch 39)', () => {
		// Guardrail: if someone reorders DEFAULT_MODEL_PREFERENCES but
		// forgets the sibling list in `byokAutoProvider.ts`, static and
		// classifier modes will pick different fallbacks on the same
		// install. Pin the top 3 entries here so the divergence is
		// caught at test time, not at runtime.
		expect(DEFAULT_MODEL_PREFERENCES[0]).toBe('gemini-3.1-pro');
		expect(DEFAULT_MODEL_PREFERENCES[1]).toBe('gemini-3-pro');
		expect(DEFAULT_MODEL_PREFERENCES[2]).toBe('gemini-3-flash');
	});
});
