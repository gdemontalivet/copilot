/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it } from 'vitest';
import {
	classifyByHeuristic,
	heuristicComplexity,
	heuristicNeedsVision,
	heuristicTaskType,
	heuristicTopicChanged,
} from '../byokRoutingHeuristics';

describe('heuristicTaskType', () => {
	it('flags planning verbs as plan', () => {
		expect(heuristicTaskType('Let\'s plan out the caching layer.')).toBe('plan');
		expect(heuristicTaskType('What\'s the best way to structure this service?')).toBe('plan');
	});

	it('flags bug reports as debug', () => {
		expect(heuristicTaskType('Why does this crash with a TypeError?')).toBe('debug');
		expect(heuristicTaskType('The test is failing on CI, please fix this')).toBe('debug');
	});

	it('flags refactor intent', () => {
		expect(heuristicTaskType('Refactor this function to use early returns.')).toBe('refactor');
		expect(heuristicTaskType('rename getCwd to getCurrentWorkingDirectory')).toBe('refactor');
	});

	it('flags SQL / LookML work', () => {
		expect(heuristicTaskType('SELECT user_id FROM events WHERE ts > now()')).toBe('sql');
		expect(heuristicTaskType('Add a dimension to the orders explore')).toBe('sql');
	});

	it('flags test authoring', () => {
		expect(heuristicTaskType('Write a vitest spec for the reducer')).toBe('test');
	});

	it('flags shell / git', () => {
		expect(heuristicTaskType('git push origin HEAD')).toBe('shell');
		expect(heuristicTaskType('run npm install and tell me the output')).toBe('shell');
	});

	it('flags explain prompts', () => {
		expect(heuristicTaskType('Explain what this regex matches')).toBe('explain');
	});

	it('falls back to code_gen for construction verbs', () => {
		expect(heuristicTaskType('Add a loading spinner to the header')).toBe('code_gen');
	});

	it('falls back to chat for everything else', () => {
		expect(heuristicTaskType('hmm')).toBe('chat');
	});
});

describe('heuristicComplexity', () => {
	it('marks trivial shell / continuation prompts as trivial', () => {
		expect(heuristicComplexity({ prompt: 'push' })).toBe('trivial');
		expect(heuristicComplexity({ prompt: 'continue' })).toBe('trivial');
		expect(heuristicComplexity({ prompt: 'go' })).toBe('trivial');
	});

	it('marks plan prompts as complex', () => {
		expect(heuristicComplexity({ prompt: 'Plan the migration to Postgres.' })).toBe('complex');
	});

	it('uses length buckets as baseline', () => {
		expect(heuristicComplexity({ prompt: 'add a test' })).toBe('trivial');
		expect(heuristicComplexity({ prompt: 'a'.repeat(80) })).toBe('simple');
		expect(heuristicComplexity({ prompt: 'a'.repeat(300) })).toBe('moderate');
		expect(heuristicComplexity({ prompt: 'a'.repeat(800) })).toBe('complex');
	});

	it('nudges complexity up with many references', () => {
		expect(heuristicComplexity({ prompt: 'refactor this', referenceCount: 12 })).toBe('complex');
		expect(heuristicComplexity({ prompt: 'add one thing', referenceCount: 6 })).toBe('simple');
	});
});

describe('heuristicTopicChanged', () => {
	it('returns false when no history', () => {
		expect(heuristicTopicChanged({ prompt: 'something new', recentHistory: undefined })).toBe(false);
	});

	it('returns false for continuations', () => {
		expect(heuristicTopicChanged({ prompt: 'go', recentHistory: 'prior' })).toBe(false);
		expect(heuristicTopicChanged({ prompt: 'yes continue', recentHistory: 'prior' })).toBe(false);
	});

	it('returns true on explicit pivots', () => {
		expect(heuristicTopicChanged({ prompt: 'new question: where is the SQL?', recentHistory: 'prior' })).toBe(true);
		expect(heuristicTopicChanged({ prompt: 'Unrelated — can you look at foo.ts', recentHistory: 'prior' })).toBe(true);
	});

	it('returns false when no explicit pivot', () => {
		expect(heuristicTopicChanged({ prompt: 'also bump the version', recentHistory: 'prior' })).toBe(false);
	});
});

describe('heuristicNeedsVision', () => {
	it('respects hasImageAttachment', () => {
		expect(heuristicNeedsVision({ prompt: 'hi', hasImageAttachment: true })).toBe(true);
	});

	it('matches vision keywords', () => {
		expect(heuristicNeedsVision({ prompt: 'Here\'s a screenshot of the bug.' })).toBe(true);
		expect(heuristicNeedsVision({ prompt: 'Look at this diagram' })).toBe(true);
	});

	it('returns false for plain text prompts', () => {
		expect(heuristicNeedsVision({ prompt: 'explain this function' })).toBe(false);
	});
});

describe('classifyByHeuristic', () => {
	it('produces a complete core result', () => {
		const r = classifyByHeuristic({ prompt: 'push to branch' });
		expect(r.complexity).toBe('trivial');
		expect(r.task_type).toBe('shell');
		expect(r.topic_changed).toBe(false);
		expect(r.needs_vision).toBe(false);
		expect(r.confidence).toBeGreaterThan(0);
	});

	it('uses higher confidence for clear trivial matches', () => {
		const trivial = classifyByHeuristic({ prompt: 'git push' });
		const ambiguous = classifyByHeuristic({ prompt: 'hmm' });
		expect(trivial.confidence).toBeGreaterThan(ambiguous.confidence);
	});
});
