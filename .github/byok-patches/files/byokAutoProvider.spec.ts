/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/* eslint-disable @typescript-eslint/no-explicit-any */

import { beforeEach, describe, expect, it, vi } from 'vitest';

// `vscode.lm.selectChatModels` is the seam the provider uses to resolve its
// delegation target. In unit tests the real vscode module is not loaded, so
// hoist a mock before the SUT imports it.
const { mockSelectChatModels, mockEventEmitter } = vi.hoisted(() => ({
	mockSelectChatModels: vi.fn(),
	mockEventEmitter: vi.fn(),
}));

vi.mock('vscode', () => ({
	lm: {
		selectChatModels: mockSelectChatModels,
	},
	EventEmitter: class {
		event = () => ({ dispose() { /* no-op */ } });
		fire = vi.fn();
		dispose = vi.fn();
	},
	// The provider `new`s `LanguageModelTextPart(string)` to emit the routing
	// hint (Patch 38). Mock as a plain wrapper so tests can identify it by
	// shape without pulling the real class in.
	LanguageModelTextPart: class {
		constructor(public value: string) { }
	},
}));

// Must import the SUT AFTER `vi.mock` registration; it dereferences
// `vscode.lm` at import time through the top-level `import * as vscode`.
import { BYOKAutoLMProvider } from '../byokAutoProvider';

function makeProvider(opts: {
	setting?: string;
	throwOnRead?: boolean;
	showRoutingHint?: boolean;
	routingMode?: 'static' | 'classifier';
} = {}) {
	const configService = {
		// Multiple BYOK Auto settings now live in the ConfigurationService:
		// `ByokAutoDefaultModel` (Patch 35, string), `ByokAutoShowRoutingHint`
		// (Patch 38, boolean), `ByokAutoRoutingMode` (Patch 40,
		// `'static' | 'classifier'`), `ByokAutoRoutingTable` (Patch 40,
		// record). Dispatch on the key's `id` so tests can drive each
		// independently without stubbing the whole ConfigKey namespace.
		//
		// `routingMode` defaults to `'static'` in this suite so
		// pre-Patch-40 tests don't accidentally exercise the classifier
		// pipeline (which would then hit `selectChatModels` twice and
		// break the mock accounting). Tests that care about classifier
		// mode set it explicitly.
		getConfig: vi.fn((key: any) => {
			if (opts.throwOnRead) {
				throw new Error('config read failed');
			}
			const id = key?.id ?? '';
			if (id === 'chat.byok.auto.showRoutingHint') {
				return opts.showRoutingHint ?? true;
			}
			if (id === 'chat.byok.auto.routingMode') {
				return opts.routingMode ?? 'static';
			}
			if (id === 'chat.byok.auto.routingTable') {
				return {};
			}
			if (id === 'chat.vertexAnthropicModels') {
				return {};
			}
			return opts.setting ?? '';
		}),
	} as any;

	const logService = {
		trace: vi.fn(),
		debug: vi.fn(),
		info: vi.fn(),
		warn: vi.fn(),
		error: vi.fn(),
	} as any;

	// Patch 40 added `IBYOKStorageService` as the first positional
	// constructor arg. Minimal mock — each suite that exercises the
	// classifier path overrides `getAPIKey` in-place to simulate the
	// presence/absence of credentials.
	const storageService = {
		getAPIKey: vi.fn(async () => undefined),
	} as any;

	return new BYOKAutoLMProvider(storageService, configService, logService);
}

describe('BYOKAutoLMProvider', () => {
	beforeEach(() => {
		mockSelectChatModels.mockReset();
		mockEventEmitter.mockReset();
	});

	describe('provideLanguageModelChatInformation', () => {
		it('returns exactly one synthetic Auto model', async () => {
			const provider = makeProvider();
			const info = await provider.provideLanguageModelChatInformation(
				{ silent: true } as any,
				{ isCancellationRequested: false } as any,
			);
			expect(info).toHaveLength(1);
			expect(info[0].id).toBe('auto');
			expect(info[0].name).toBe('BYOK Auto');
			expect(info[0].family).toBe('byok-auto');
		});

		it('advertises tool-calling and image-input capabilities so the UI does not hide them', async () => {
			const provider = makeProvider();
			const [info] = await provider.provideLanguageModelChatInformation(
				{ silent: true } as any,
				{ isCancellationRequested: false } as any,
			);
			expect(info.capabilities).toEqual({ toolCalling: true, imageInput: true });
		});

		it('surfaces the configured target in the `detail` field', async () => {
			const provider = makeProvider({ setting: 'vertexgemini/gemini-3.1-pro-preview' });
			const [info] = await provider.provideLanguageModelChatInformation(
				{ silent: true } as any,
				{ isCancellationRequested: false } as any,
			);
			expect(info.detail).toBe('→ vertexgemini/gemini-3.1-pro-preview');
		});
	});

	describe('provideLanguageModelChatResponse delegation', () => {
		const stubToken = { isCancellationRequested: false } as any;

		it('selects the configured target and forwards all stream parts to progress', async () => {
			const targetResponse = {
				stream: (async function* () {
					yield { type: 'text', value: 'hello' };
					yield { type: 'text', value: 'world' };
				})(),
			};
			const targetModel = {
				vendor: 'vertexgemini',
				id: 'gemini-3.1-pro-preview',
				name: 'Gemini 3.1 Pro',
				sendRequest: vi.fn().mockResolvedValue(targetResponse),
			};
			mockSelectChatModels.mockResolvedValue([targetModel]);

			// Disable the routing hint (Patch 38) here so the assertion below
			// can pin down the forwarded-stream contract without the hint
			// polluting the reported list. A dedicated test further down
			// covers the hint behaviour itself.
			const provider = makeProvider({ setting: 'vertexgemini/gemini-3.1-pro-preview', showRoutingHint: false });
			const reported: unknown[] = [];
			const progress = { report: (p: unknown) => reported.push(p) };

			await provider.provideLanguageModelChatResponse(
				{ id: 'auto' } as any,
				[{ role: 'user', content: 'hi' } as any],
				{ modelOptions: { temperature: 0.3 } } as any,
				progress as any,
				stubToken,
			);

			expect(mockSelectChatModels).toHaveBeenCalledWith({ vendor: 'vertexgemini', id: 'gemini-3.1-pro-preview' });
			expect(targetModel.sendRequest).toHaveBeenCalledTimes(1);
			const [sentMessages, sentOpts] = targetModel.sendRequest.mock.calls[0];
			expect(sentMessages).toEqual([{ role: 'user', content: 'hi' }]);
			expect(sentOpts.modelOptions).toEqual({ temperature: 0.3 });
			expect(sentOpts.justification).toMatch(/BYOK Auto/);
			expect(reported).toEqual([
				{ type: 'text', value: 'hello' },
				{ type: 'text', value: 'world' },
			]);
		});

		it('prepends a one-line routing hint by default that names the concrete target', async () => {
			const targetModel = {
				vendor: 'vertexgemini',
				id: 'gemini-3.1-pro-preview',
				name: 'Gemini 3.1 Pro',
				sendRequest: vi.fn().mockResolvedValue({
					stream: (async function* () {
						yield { type: 'text', value: 'hi' };
					})(),
				}),
			};
			mockSelectChatModels.mockResolvedValue([targetModel]);

			// showRoutingHint defaults to true — omit explicitly to prove the
			// default-on behaviour.
			const provider = makeProvider({ setting: 'vertexgemini/gemini-3.1-pro-preview' });
			const reported: any[] = [];
			await provider.provideLanguageModelChatResponse(
				{ id: 'auto' } as any,
				[],
				{} as any,
				{ report: (p: unknown) => reported.push(p) } as any,
				stubToken,
			);

			expect(reported).toHaveLength(2);
			// First part is the hint, a `LanguageModelTextPart` whose value
			// must include the routed vendor/id pair so users can see where
			// their prompt went — it's not enough to put this in the log.
			expect(reported[0].value).toBe('_via `vertexgemini/gemini-3.1-pro-preview`_\n\n');
			// Followed by the actual target stream, unchanged.
			expect(reported[1]).toEqual({ type: 'text', value: 'hi' });
		});

		it('suppresses the routing hint when chat.byok.auto.showRoutingHint is false', async () => {
			const targetModel = {
				vendor: 'vertexgemini',
				id: 'gemini-3.1-pro-preview',
				sendRequest: vi.fn().mockResolvedValue({
					stream: (async function* () {
						yield { type: 'text', value: 'hi' };
					})(),
				}),
			};
			mockSelectChatModels.mockResolvedValue([targetModel]);

			const provider = makeProvider({ setting: 'vertexgemini/gemini-3.1-pro-preview', showRoutingHint: false });
			const reported: any[] = [];
			await provider.provideLanguageModelChatResponse(
				{ id: 'auto' } as any,
				[],
				{} as any,
				{ report: (p: unknown) => reported.push(p) } as any,
				stubToken,
			);

			// Only the downstream stream parts — no hint prefix.
			expect(reported).toEqual([{ type: 'text', value: 'hi' }]);
		});

		it('auto-discovers a target via unfiltered selectChatModels when the setting is empty (Patch 39)', async () => {
			// Patch 39 replaced the compiled-in default with vendor-priority
			// auto-discovery. An unset setting must call
			// `selectChatModels()` with NO filter so the provider can rank
			// vendors itself — a filtered call by vendor/id would skip the
			// discovery step entirely.
			const geminiModel = {
				vendor: 'gemini',
				id: 'gemini-3.1-pro-preview',
				family: 'gemini',
				sendRequest: vi.fn().mockResolvedValue({ stream: (async function* () { /* empty */ })() }),
			};
			mockSelectChatModels.mockResolvedValue([
				{ vendor: 'openai', id: 'gpt-4.1', family: 'gpt' } as any,
				geminiModel,
				{ vendor: 'anthropic', id: 'claude-sonnet-4' } as any,
			]);
			const provider = makeProvider({ setting: '' });

			await provider.provideLanguageModelChatResponse(
				{ id: 'auto' } as any,
				[],
				{} as any,
				{ report: () => { /* no-op */ } } as any,
				stubToken,
			);

			expect(mockSelectChatModels).toHaveBeenCalledWith();
			// `gemini` wins over `openai` and `anthropic` because it's the
			// highest-priority vendor in AUTO_DISCOVERY_VENDOR_PRIORITY.
			expect(geminiModel.sendRequest).toHaveBeenCalledTimes(1);
		});

		it('auto-discovery prefers vertexgemini over anthropic when gemini is unavailable', async () => {
			const vertexGemini = {
				vendor: 'vertexgemini',
				id: 'gemini-3.1-pro-preview',
				sendRequest: vi.fn().mockResolvedValue({ stream: (async function* () { /* empty */ })() }),
			};
			mockSelectChatModels.mockResolvedValue([
				{ vendor: 'anthropic', id: 'claude-sonnet-4' } as any,
				vertexGemini,
				{ vendor: 'openai', id: 'gpt-4.1' } as any,
			]);
			const provider = makeProvider({ setting: '' });

			await provider.provideLanguageModelChatResponse(
				{ id: 'auto' } as any,
				[],
				{} as any,
				{ report: () => { /* no-op */ } } as any,
				stubToken,
			);

			expect(vertexGemini.sendRequest).toHaveBeenCalledTimes(1);
		});

		it('auto-discovery falls through to non-priority vendors when no preferred vendor is registered', async () => {
			const openaiModel = {
				vendor: 'openai',
				id: 'gpt-4.1',
				sendRequest: vi.fn().mockResolvedValue({ stream: (async function* () { /* empty */ })() }),
			};
			mockSelectChatModels.mockResolvedValue([openaiModel]);
			const provider = makeProvider({ setting: '' });

			await provider.provideLanguageModelChatResponse(
				{ id: 'auto' } as any,
				[],
				{} as any,
				{ report: () => { /* no-op */ } } as any,
				stubToken,
			);

			expect(openaiModel.sendRequest).toHaveBeenCalledTimes(1);
		});

		it('auto-discovery within a vendor prefers capable models over the first advertised', async () => {
			// Vendor returns a small model FIRST (simulating a provider
			// that lists models alphabetically). The pro-preview entry
			// should still win because it matches the model-preference
			// list. Prevents a regression where Auto picked a tiny legacy
			// Gemini model just because the provider sorted it first.
			const proPreview = {
				vendor: 'gemini',
				id: 'gemini-3.1-pro-preview',
				family: 'gemini',
				sendRequest: vi.fn().mockResolvedValue({ stream: (async function* () { /* empty */ })() }),
			};
			mockSelectChatModels.mockResolvedValue([
				{ vendor: 'gemini', id: 'gemini-1.0-pro', family: 'gemini' } as any,
				proPreview,
				{ vendor: 'gemini', id: 'gemini-embedding-001', family: 'gemini' } as any,
			]);
			const provider = makeProvider({ setting: '' });

			await provider.provideLanguageModelChatResponse(
				{ id: 'auto' } as any,
				[],
				{} as any,
				{ report: () => { /* no-op */ } } as any,
				stubToken,
			);

			expect(proPreview.sendRequest).toHaveBeenCalledTimes(1);
		});

		it('falls back to auto-discovery when the configured target is no longer registered', async () => {
			// User configured `vertexgemini/...` but later rotated to the
			// direct `gemini` vendor. Patch 39 must not fail the turn —
			// it logs a warning and discovers the next best target.
			const fallback = {
				vendor: 'gemini',
				id: 'gemini-3.1-pro-preview',
				family: 'gemini',
				sendRequest: vi.fn().mockResolvedValue({ stream: (async function* () { /* empty */ })() }),
			};
			mockSelectChatModels
				.mockResolvedValueOnce([]) // explicit lookup misses
				.mockResolvedValueOnce([fallback]); // discovery finds gemini

			const provider = makeProvider({ setting: 'vertexgemini/gemini-3.1-pro-preview' });
			await provider.provideLanguageModelChatResponse(
				{ id: 'auto' } as any,
				[],
				{} as any,
				{ report: () => { /* no-op */ } } as any,
				stubToken,
			);

			expect(mockSelectChatModels).toHaveBeenNthCalledWith(1, {
				vendor: 'vertexgemini',
				id: 'gemini-3.1-pro-preview',
			});
			expect(mockSelectChatModels).toHaveBeenNthCalledWith(2);
			expect(fallback.sendRequest).toHaveBeenCalledTimes(1);
		});

		it('raises an actionable error only when no non-byokauto model exists anywhere', async () => {
			mockSelectChatModels.mockResolvedValue([
				// The provider should skip its own entry to avoid
				// infinite recursion, so this must NOT be picked.
				{ vendor: 'byokauto', id: 'auto' } as any,
			]);
			const provider = makeProvider({ setting: '' });

			await expect(
				provider.provideLanguageModelChatResponse(
					{ id: 'auto' } as any,
					[],
					{} as any,
					{ report: () => { /* no-op */ } } as any,
					stubToken,
				),
			).rejects.toThrow(/no BYOK models are registered/);
		});

		it('stops reporting once cancellation is requested', async () => {
			let cancelled = false;
			const token = {
				get isCancellationRequested() { return cancelled; },
			} as any;

			const targetModel = {
				sendRequest: vi.fn().mockResolvedValue({
					stream: (async function* () {
						yield { type: 'text', value: 'a' };
						cancelled = true;
						yield { type: 'text', value: 'b' };
						yield { type: 'text', value: 'c' };
					})(),
				}),
			};
			mockSelectChatModels.mockResolvedValue([targetModel]);

			// Suppress the routing hint so this test focuses solely on the
			// cancellation-propagation contract. The hint is emitted
			// synchronously before the stream starts, which would otherwise
			// show up as `reported[0]` and make the assertion noisy.
			const provider = makeProvider({ setting: 'vertexgemini/foo', showRoutingHint: false });
			const reported: unknown[] = [];
			await provider.provideLanguageModelChatResponse(
				{ id: 'auto' } as any,
				[],
				{} as any,
				{ report: (p: unknown) => reported.push(p) } as any,
				token,
			);

			// After cancellation we stop reporting — the first part gets through,
			// the others are dropped even though the stream kept yielding. This
			// matches the pattern used by other BYOK providers: we respect the
			// cancellation token but do not forcibly close the upstream stream
			// (the SDK does that when its own cancellation hook fires).
			expect(reported).toEqual([{ type: 'text', value: 'a' }]);
		});

		it('rejects a target spec that points back at byokauto to avoid infinite loops', async () => {
			const provider = makeProvider({ setting: 'byokauto/auto' });
			await expect(
				provider.provideLanguageModelChatResponse(
					{ id: 'auto' } as any,
					[],
					{} as any,
					{ report: () => { /* no-op */ } } as any,
					stubToken,
				),
			).rejects.toThrow(/cannot route to itself/);
			expect(mockSelectChatModels).not.toHaveBeenCalled();
		});

		it('falls back to auto-discovery for malformed setting strings instead of throwing', async () => {
			// Before Patch 39 a malformed setting threw
			// `.../vendor\/modelId/`. Now we warn and auto-discover so a
			// typo never bricks the picker.
			const fallback = {
				vendor: 'gemini',
				id: 'gemini-3.1-pro-preview',
				sendRequest: vi.fn().mockResolvedValue({ stream: (async function* () { /* empty */ })() }),
			};
			mockSelectChatModels.mockResolvedValue([fallback]);

			const provider = makeProvider({ setting: 'no-slash-here' });
			await provider.provideLanguageModelChatResponse(
				{ id: 'auto' } as any,
				[],
				{} as any,
				{ report: () => { /* no-op */ } } as any,
				stubToken,
			);
			expect(fallback.sendRequest).toHaveBeenCalledTimes(1);
		});

		it('preserves slashes inside the model id portion (for openrouter-style ids)', async () => {
			const targetModel = {
				sendRequest: vi.fn().mockResolvedValue({ stream: (async function* () { /* empty */ })() }),
			};
			mockSelectChatModels.mockResolvedValue([targetModel]);

			const provider = makeProvider({ setting: 'openrouter/anthropic/claude-3.7-sonnet' });
			await provider.provideLanguageModelChatResponse(
				{ id: 'auto' } as any,
				[],
				{} as any,
				{ report: () => { /* no-op */ } } as any,
				stubToken,
			);

			expect(mockSelectChatModels).toHaveBeenCalledWith({
				vendor: 'openrouter',
				id: 'anthropic/claude-3.7-sonnet',
			});
		});
	});

	describe('provideTokenCount', () => {
		it('defers to the target model so agent budget math stays accurate', async () => {
			const countTokens = vi.fn().mockResolvedValue(42);
			mockSelectChatModels.mockResolvedValue([{ vendor: 'v', id: 'm', countTokens } as any]);
			const provider = makeProvider({ setting: 'v/m' });
			const count = await provider.provideTokenCount(
				{ id: 'auto' } as any,
				'hello world',
				{ isCancellationRequested: false } as any,
			);
			expect(count).toBe(42);
			expect(countTokens).toHaveBeenCalled();
		});

		it('falls back to a 4-chars-per-token heuristic when resolution throws', async () => {
			// Both the explicit lookup AND auto-discovery must return
			// nothing for resolution to truly throw. Patch 39 made the
			// provider much more forgiving, so simulate a totally empty
			// BYOK registry here.
			mockSelectChatModels.mockResolvedValue([]);
			const provider = makeProvider({ setting: 'v/missing' });
			const count = await provider.provideTokenCount(
				{ id: 'auto' } as any,
				'1234567890ab', // 12 chars → 3 tokens at 4-chars/token
				{ isCancellationRequested: false } as any,
			);
			expect(count).toBe(3);
		});
	});

	describe('setting read resilience', () => {
		it('still resolves via auto-discovery when getConfig throws (e.g. test stub without the key)', async () => {
			// Patch 39 made an empty/throwing config equivalent — both go
			// straight to unfiltered `selectChatModels()`. Stubs that
			// don't know the ConfigKey must therefore see a no-arg call.
			const fallback = {
				vendor: 'gemini',
				id: 'gemini-3.1-pro-preview',
				sendRequest: vi.fn().mockResolvedValue({ stream: (async function* () { /* empty */ })() }),
			} as any;
			mockSelectChatModels.mockResolvedValue([fallback]);
			const provider = makeProvider({ throwOnRead: true });
			await provider.provideLanguageModelChatResponse(
				{ id: 'auto' } as any,
				[],
				{} as any,
				{ report: () => { /* no-op */ } } as any,
				{ isCancellationRequested: false } as any,
			);
			expect(mockSelectChatModels).toHaveBeenCalledWith();
			expect(fallback.sendRequest).toHaveBeenCalledTimes(1);
		});
	});

	/* ─────────────────── Patch 40: classifier routing ─────────────────── */

	describe('classifier routing mode (Patch 40)', () => {
		/**
		 * Build a provider that exercises the classifier path WITHOUT
		 * actually constructing `ByokRoutingClassifier` — we override
		 * the protected seam `_getOrCreateClassifier` to return a stub
		 * that resolves to whatever classification the test wants. This
		 * keeps the test hermetic (no network, no SDK imports).
		 */
		function makeClassifierProvider(
			classification: any,
			opts: {
				setting?: string;
				showRoutingHint?: boolean;
				routingTable?: any;
			} = {},
		): BYOKAutoLMProvider {
			const configService = {
				getConfig: vi.fn((key: any) => {
					const id = key?.id ?? '';
					if (id === 'chat.byok.auto.showRoutingHint') { return opts.showRoutingHint ?? true; }
					if (id === 'chat.byok.auto.routingMode') { return 'classifier'; }
					if (id === 'chat.byok.auto.routingTable') { return opts.routingTable ?? {}; }
					if (id === 'chat.vertexAnthropicModels') { return {}; }
					return opts.setting ?? '';
				}),
			} as any;
			const logService = {
				trace: vi.fn(), debug: vi.fn(), info: vi.fn(),
				warn: vi.fn(), error: vi.fn(),
			} as any;
			const storageService = {
				getAPIKey: vi.fn(async (name: string) => name === 'gemini' ? 'fake-gemini-key' : undefined),
			} as any;

			const provider = new BYOKAutoLMProvider(storageService, configService, logService);
			// Subclassing around the instance via prototype override
			// keeps the test from having to export a dedicated subclass.
			// `fixedClassifier` is a single shared stub so tests can
			// assert on its spies after the turn runs (returning a new
			// object each call would break `toHaveBeenCalled` because
			// the in-flight call used a different instance).
			const fixedClassifier = {
				classify: vi.fn(async () => classification),
			};
			(provider as any)._getOrCreateClassifier = vi.fn(async () => fixedClassifier);
			return provider;
		}

		it('classifies the last user message and routes via the table', async () => {
			// User message is moderate code_gen ⇒ table should pick
			// gemini-3.1-pro (first entry in the moderate.code_gen cell).
			const pro = {
				vendor: 'gemini',
				id: 'models/gemini-3.1-pro-preview',
				capabilities: { imageInput: true, toolCalling: true },
				sendRequest: vi.fn().mockResolvedValue({ stream: (async function* () { /* empty */ })() }),
			} as any;
			const flash = {
				vendor: 'gemini',
				id: 'models/gemini-3-flash',
				capabilities: { imageInput: true, toolCalling: true },
				sendRequest: vi.fn().mockResolvedValue({ stream: (async function* () { /* empty */ })() }),
			} as any;
			mockSelectChatModels.mockResolvedValue([flash, pro]);

			const provider = makeClassifierProvider({
				complexity: 'moderate',
				task_type: 'code_gen',
				topic_changed: false,
				needs_vision: false,
				confidence: 0.9,
				source: 'gemini-flash',
				latencyMs: 120,
			});

			await provider.provideLanguageModelChatResponse(
				{ id: 'auto' } as any,
				[{ role: 1, content: 'please refactor the router' }] as any,
				{} as any,
				{ report: () => { /* no-op */ } } as any,
				{ isCancellationRequested: false } as any,
			);
			// Pro should win the moderate.code_gen cell even though
			// flash was advertised first in the candidate list.
			expect(pro.sendRequest).toHaveBeenCalledTimes(1);
			expect(flash.sendRequest).not.toHaveBeenCalled();
		});

		it('surfaces classifier info in the routing hint (Patch 40 extension of Patch 38)', async () => {
			const reported: any[] = [];
			const target = {
				vendor: 'gemini',
				id: 'models/gemini-3-flash',
				capabilities: { imageInput: true, toolCalling: true },
				sendRequest: vi.fn().mockResolvedValue({ stream: (async function* () { /* empty */ })() }),
			} as any;
			mockSelectChatModels.mockResolvedValue([target]);

			const provider = makeClassifierProvider({
				complexity: 'trivial',
				task_type: 'shell',
				topic_changed: false,
				needs_vision: false,
				confidence: 0.95,
				source: 'heuristic',
				latencyMs: 0,
			});

			await provider.provideLanguageModelChatResponse(
				{ id: 'auto' } as any,
				[{ role: 1, content: 'push to branch' }] as any,
				{} as any,
				{ report: (p: any) => reported.push(p) } as any,
				{ isCancellationRequested: false } as any,
			);
			// The hint should carry complexity + task + source info —
			// we want this visible so users can spot when the
			// classifier routed to something cheaper than expected.
			const hint = reported[0]?.value ?? '';
			expect(hint).toContain('complexity=trivial');
			expect(hint).toContain('task=shell');
			expect(hint).toContain('source=heuristic');
			expect(hint).toContain('gemini/models/gemini-3-flash');
		});

		it('falls back to static resolution when the router finds no candidates', async () => {
			// Classifier says vision needed, but neither candidate has
			// `imageInput: true`. The router's "all-or-nothing" vision
			// guard reopens the pool, so a candidate still wins —
			// *static fallback should not trigger* in that case. This
			// test exercises the truly empty-pool path instead.
			mockSelectChatModels.mockResolvedValue([]);

			const provider = makeClassifierProvider({
				complexity: 'simple',
				task_type: 'chat',
				topic_changed: false,
				needs_vision: false,
				confidence: 0.8,
				source: 'gemini-flash',
				latencyMs: 100,
			});

			// `selectChatModels()` returns [] for BOTH calls (classifier
			// routing empties, then static fallback also empties) so
			// the final resolution throws — that's the correct
			// terminal behaviour when the user has no BYOK models.
			await expect(
				provider.provideLanguageModelChatResponse(
					{ id: 'auto' } as any,
					[{ role: 1, content: 'hi there' }] as any,
					{} as any,
					{ report: () => { /* no-op */ } } as any,
					{ isCancellationRequested: false } as any,
				),
			).rejects.toThrow(/no BYOK models are registered/i);
		});

		it('falls back to static mode when the classifier throws', async () => {
			const target = {
				vendor: 'gemini',
				id: 'models/gemini-3.1-pro-preview',
				capabilities: { imageInput: true, toolCalling: true },
				sendRequest: vi.fn().mockResolvedValue({ stream: (async function* () { /* empty */ })() }),
			} as any;
			mockSelectChatModels.mockResolvedValue([target]);

			const configService = {
				getConfig: vi.fn((key: any) => {
					const id = key?.id ?? '';
					if (id === 'chat.byok.auto.routingMode') { return 'classifier'; }
					if (id === 'chat.byok.auto.showRoutingHint') { return false; }
					if (id === 'chat.byok.auto.routingTable') { return {}; }
					if (id === 'chat.vertexAnthropicModels') { return {}; }
					return '';
				}),
			} as any;
			const logService = {
				trace: vi.fn(), debug: vi.fn(), info: vi.fn(),
				warn: vi.fn(), error: vi.fn(),
			} as any;
			const storageService = {
				getAPIKey: vi.fn(async () => 'fake-key'),
			} as any;
			const provider = new BYOKAutoLMProvider(storageService, configService, logService);
			(provider as any)._getOrCreateClassifier = vi.fn(async () => ({
				classify: vi.fn().mockRejectedValue(new Error('boom')),
			}));

			await provider.provideLanguageModelChatResponse(
				{ id: 'auto' } as any,
				[{ role: 1, content: 'hello' }] as any,
				{} as any,
				{ report: () => { /* no-op */ } } as any,
				{ isCancellationRequested: false } as any,
			);
			// Classifier exploded, static path took over, target was
			// still reachable through auto-discovery.
			expect(target.sendRequest).toHaveBeenCalledTimes(1);
			expect(logService.warn).toHaveBeenCalledWith(
				expect.stringContaining('Classifier routing failed'),
			);
		});

		it('skips Tier-1/2 classifier calls for trivial continuations', async () => {
			// `KW.trivial` matches "push", "go", "yes", etc. For those
			// prompts we should route via the heuristic ONLY — no
			// network call. Assert by installing a classifier whose
			// `classify` throws; if the router ever reaches it the
			// test would fail.
			const target = {
				vendor: 'gemini',
				id: 'models/gemini-3-flash',
				capabilities: { imageInput: true, toolCalling: true },
				sendRequest: vi.fn().mockResolvedValue({ stream: (async function* () { /* empty */ })() }),
			} as any;
			mockSelectChatModels.mockResolvedValue([target]);

			const provider = makeClassifierProvider({
				// This classification would be returned by the stubbed
				// classifier if it was called — but for trivial prompts
				// it should NEVER be called.
				complexity: 'moderate',
				task_type: 'code_gen',
				topic_changed: false,
				needs_vision: false,
				confidence: 0.9,
				source: 'gemini-flash',
				latencyMs: 120,
			});
			const classifierInstance = await (provider as any)._getOrCreateClassifier();
			classifierInstance.classify = vi.fn().mockRejectedValue(new Error('classifier should not run'));

			await provider.provideLanguageModelChatResponse(
				{ id: 'auto' } as any,
				[{ role: 1, content: 'push to branch' }] as any,
				{} as any,
				{ report: () => { /* no-op */ } } as any,
				{ isCancellationRequested: false } as any,
			);
			expect(classifierInstance.classify).not.toHaveBeenCalled();
			expect(target.sendRequest).toHaveBeenCalledTimes(1);
		});

		it('counts references attached to the last user message', async () => {
			// Structural detector: messages may carry file / symbol
			// references either as `{ mimeType: 'vscode/reference...' }`
			// parts or as `{ uri: ... }` parts. Both count.
			const target = {
				vendor: 'gemini',
				id: 'models/gemini-3.1-pro-preview',
				capabilities: { imageInput: true, toolCalling: true },
				sendRequest: vi.fn().mockResolvedValue({ stream: (async function* () { /* empty */ })() }),
			} as any;
			mockSelectChatModels.mockResolvedValue([target]);

			const provider = makeClassifierProvider({
				complexity: 'moderate',
				task_type: 'code_gen',
				topic_changed: false,
				needs_vision: false,
				confidence: 0.9,
				source: 'gemini-flash',
				latencyMs: 50,
			});
			const classifierInstance = await (provider as any)._getOrCreateClassifier();
			const classifySpy = vi.spyOn(classifierInstance, 'classify');

			await provider.provideLanguageModelChatResponse(
				{ id: 'auto' } as any,
				[{
					role: 1,
					content: [
						{ value: 'please look at these files' },
						{ mimeType: 'vscode/reference.file', data: new Uint8Array() },
						{ mimeType: 'vscode/reference.symbol', data: new Uint8Array() },
						{ uri: { path: '/some/file.ts' } },
					],
				}] as any,
				{} as any,
				{ report: () => { /* no-op */ } } as any,
				{ isCancellationRequested: false } as any,
			);
			// 2 mimeType refs + 1 uri ref = 3 total.
			expect(classifySpy).toHaveBeenCalledWith(
				expect.objectContaining({ referenceCount: 3 }),
			);
		});

		it('skips classifier construction entirely when NO credentials are configured', async () => {
			const target = {
				vendor: 'gemini',
				id: 'models/gemini-3.1-pro-preview',
				capabilities: { imageInput: true, toolCalling: true },
				sendRequest: vi.fn().mockResolvedValue({ stream: (async function* () { /* empty */ })() }),
			} as any;
			mockSelectChatModels.mockResolvedValue([target]);

			const configService = {
				getConfig: vi.fn((key: any) => {
					const id = key?.id ?? '';
					if (id === 'chat.byok.auto.routingMode') { return 'classifier'; }
					if (id === 'chat.byok.auto.showRoutingHint') { return false; }
					if (id === 'chat.byok.auto.routingTable') { return {}; }
					if (id === 'chat.vertexAnthropicModels') { return {}; }
					return '';
				}),
			} as any;
			const logService = {
				trace: vi.fn(), debug: vi.fn(), info: vi.fn(),
				warn: vi.fn(), error: vi.fn(),
			} as any;
			// No Gemini, no Vertex — classifier construction must
			// return undefined so we never attempt to import the heavy
			// classifier module.
			const storageService = {
				getAPIKey: vi.fn(async () => undefined),
			} as any;
			const provider = new BYOKAutoLMProvider(storageService, configService, logService);

			await provider.provideLanguageModelChatResponse(
				{ id: 'auto' } as any,
				[{ role: 1, content: 'hello' }] as any,
				{} as any,
				{ report: () => { /* no-op */ } } as any,
				{ isCancellationRequested: false } as any,
			);
			// Static fallback kicked in; target still invoked.
			expect(target.sendRequest).toHaveBeenCalledTimes(1);
			// Log trace tells the user why classifier was skipped so
			// misconfiguration is debuggable from the Output channel.
			expect(logService.trace).toHaveBeenCalledWith(
				expect.stringContaining('no credentials available'),
			);
		});
	});
});
