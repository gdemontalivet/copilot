/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it, vi } from 'vitest';
import {
	buildUserPrompt,
	ByokRoutingClassifier,
	parseAndValidate,
} from '../byokRoutingClassifier';
import type { ClassificationCore, ClassificationInput, ClassifierOptions, ClassifierTestOverrides } from '../../common/byokRoutingClassifier.types';

/** Minimal ILogService stub — the classifier only calls `trace`. */
const fakeLog = {
	trace: vi.fn(),
	debug: vi.fn(),
	info: vi.fn(),
	warn: vi.fn(),
	error: vi.fn(),
	show: vi.fn(),
	logger: undefined,
	onDidChangeLogLevel: undefined,
} as unknown as import('../../../../platform/log/common/logService').ILogService;

const GOOD_CORE: ClassificationCore = {
	complexity: 'simple',
	task_type: 'code_gen',
	topic_changed: false,
	needs_vision: false,
	confidence: 0.9,
};

function makeClassifier(overrides: ClassifierTestOverrides, extraOpts: Partial<ClassifierOptions> = {}) {
	return new ByokRoutingClassifier(
		{
			geminiApiKey: 'fake-gemini-key',
			vertexConfig: { apiKey: 'fake-vertex-key', projectId: 'p', locationId: 'us-east5' },
			primaryTimeoutMs: 50,
			failoverTimeoutMs: 50,
			...extraOpts,
		},
		fakeLog,
		overrides,
	);
}

describe('buildUserPrompt', () => {
	it('includes the prompt and reference count', () => {
		const text = buildUserPrompt({ prompt: 'hi', referenceCount: 3 });
		expect(text).toContain('<prompt>\nhi\n</prompt>');
		expect(text).toContain('references: 3');
		expect(text).toContain('has_image: false');
	});

	it('includes recent history when provided', () => {
		const text = buildUserPrompt({ prompt: 'p', recentHistory: 'earlier stuff' });
		expect(text).toContain('<recent_history>\nearlier stuff\n</recent_history>');
	});

	it('truncates very long input', () => {
		const longPrompt = 'a'.repeat(5000);
		const text = buildUserPrompt({ prompt: longPrompt });
		expect(text.length).toBeLessThan(longPrompt.length);
		expect(text).toContain('truncated');
	});
});

describe('parseAndValidate', () => {
	const inp: ClassificationInput = { prompt: 'push' };

	it('parses a clean JSON response', () => {
		const core = parseAndValidate(JSON.stringify(GOOD_CORE), inp);
		expect(core).toEqual(GOOD_CORE);
	});

	it('strips markdown fences', () => {
		const core = parseAndValidate('```json\n' + JSON.stringify(GOOD_CORE) + '\n```', inp);
		expect(core.complexity).toBe('simple');
	});

	it('ignores prose before / after the JSON object', () => {
		const core = parseAndValidate(`Sure! Here it is: ${JSON.stringify(GOOD_CORE)} — done.`, inp);
		expect(core.task_type).toBe('code_gen');
	});

	it('repairs missing fields with heuristic values', () => {
		const core = parseAndValidate('{"complexity":"complex"}', inp);
		expect(core.complexity).toBe('complex');
		// Missing fields populated from heuristic (prompt "push" → trivial/shell).
		expect(core.task_type).toBe('shell');
		expect(typeof core.confidence).toBe('number');
	});

	it('coerces unknown enum values to heuristic defaults', () => {
		const core = parseAndValidate('{"complexity":"EXTRA_LARGE","task_type":"?","topic_changed":false,"needs_vision":false,"confidence":0.5}', inp);
		expect(['trivial', 'simple', 'moderate', 'complex']).toContain(core.complexity);
		expect(['code_gen', 'debug', 'refactor', 'plan', 'shell', 'sql', 'explain', 'test', 'chat']).toContain(core.task_type);
	});

	it('clamps confidence to [0, 1]', () => {
		const high = parseAndValidate('{"complexity":"simple","task_type":"chat","topic_changed":false,"needs_vision":false,"confidence":5}', inp);
		expect(high.confidence).toBe(1);
		const low = parseAndValidate('{"complexity":"simple","task_type":"chat","topic_changed":false,"needs_vision":false,"confidence":-2}', inp);
		expect(low.confidence).toBe(0);
	});

	it('throws on completely unparseable input', () => {
		expect(() => parseAndValidate('not json at all', inp)).toThrow(/no JSON object/i);
	});
});

describe('ByokRoutingClassifier cascade', () => {
	it('returns Tier-1 result when Gemini succeeds', async () => {
		const gemini = vi.fn().mockResolvedValue(GOOD_CORE);
		const haiku = vi.fn();
		const classifier = makeClassifier({ gemini, haiku });
		const r = await classifier.classify({ prompt: 'add a test' });
		expect(r.source).toBe('gemini-flash');
		expect(r.complexity).toBe('simple');
		expect(gemini).toHaveBeenCalledTimes(1);
		expect(haiku).not.toHaveBeenCalled();
	});

	it('falls over to Haiku when Gemini rejects', async () => {
		const gemini = vi.fn().mockRejectedValue(new Error('429 rate limit'));
		const haiku = vi.fn().mockResolvedValue({ ...GOOD_CORE, complexity: 'complex' });
		const classifier = makeClassifier({ gemini, haiku });
		const r = await classifier.classify({ prompt: 'refactor everything' });
		expect(r.source).toBe('claude-haiku');
		expect(r.complexity).toBe('complex');
		expect(gemini).toHaveBeenCalledTimes(1);
		expect(haiku).toHaveBeenCalledTimes(1);
	});

	it('falls through to heuristic when both Gemini and Haiku fail', async () => {
		const gemini = vi.fn().mockRejectedValue(new Error('boom'));
		const haiku = vi.fn().mockRejectedValue(new Error('also boom'));
		const classifier = makeClassifier({ gemini, haiku });
		const r = await classifier.classify({ prompt: 'push to branch' });
		expect(r.source).toBe('heuristic');
		expect(r.complexity).toBe('trivial');
	});

	it('falls over to Haiku when Gemini times out', async () => {
		const gemini = vi.fn().mockImplementation(() => new Promise(() => { /* never resolves */ }));
		const haiku = vi.fn().mockResolvedValue(GOOD_CORE);
		const classifier = makeClassifier({ gemini, haiku }, { primaryTimeoutMs: 20 });
		const r = await classifier.classify({ prompt: 'add a test' });
		expect(r.source).toBe('claude-haiku');
	});

	it('falls through to heuristic when no Gemini key and no Vertex config are configured', async () => {
		const classifier = new ByokRoutingClassifier(
			{ geminiApiKey: undefined, vertexConfig: undefined },
			fakeLog,
		);
		const r = await classifier.classify({ prompt: 'git push' });
		expect(r.source).toBe('heuristic');
		expect(r.complexity).toBe('trivial');
	});

	it('populates latencyMs using the injected clock', async () => {
		let t = 1000;
		const classifier = makeClassifier({
			gemini: async () => GOOD_CORE,
			haiku: async () => GOOD_CORE,
			now: () => { const v = t; t += 42; return v; },
		});
		const r = await classifier.classify({ prompt: 'hi' });
		expect(r.latencyMs).toBe(42);
	});

	it('skips Tier 1 when Gemini key is absent but Vertex is configured', async () => {
		const haiku = vi.fn().mockResolvedValue(GOOD_CORE);
		const classifier = new ByokRoutingClassifier(
			{ vertexConfig: { apiKey: 'k', projectId: 'p', locationId: 'us-east5' } },
			fakeLog,
			{ haiku },
		);
		const r = await classifier.classify({ prompt: 'hi' });
		expect(r.source).toBe('claude-haiku');
		expect(haiku).toHaveBeenCalledTimes(1);
	});
});
