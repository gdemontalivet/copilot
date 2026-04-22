/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type {
	ClassificationCore,
	ClassificationInput,
	TaskComplexity,
	TaskType,
} from './byokRoutingClassifier.types';

/**
 * Regex-based classifier used as the Tier-3 last-resort fallback when both
 * the Gemini Flash and Claude Haiku calls fail or are disabled.
 *
 * Design goals:
 *   - Zero network, zero async. Always returns a usable decision.
 *   - Deterministic — same input produces the same output, always.
 *   - Conservative — when uncertain, bias toward `moderate` / `code_gen` with
 *     low confidence so the router can still pick a reasonable mid-tier model.
 *
 * These heuristics were tuned against the user's actual VS Code Copilot chat
 * history in the `looker` workspace (see `.scratch/looker_auto_router_analysis.py`).
 */

/** Keyword patterns grouped by signal. Case-insensitive, word-boundary aware. */
const KW = {
	vision: /\b(screenshot|image|picture|diagram|mockup|ui of|see this|what.?s in this)\b/i,

	trivial: /^(?:\s*(?:push|commit|merge|rebase|stash|pop|run|ls|cd|cat|grep|clear|continue|go|yes|no|ok|okay|thanks|thx|y|n)\b[\s\S]{0,120})$/i,

	plan: /\b(plan|design|architect|architecture|propose|strategy|approach|discuss|compare|trade.?offs?|should we|what.?s the best way|how would you|think through)\b/i,

	debug: /\b(debug|error|exception|stack ?trace|traceback|crash|fail(?:ing|ure)?|broken|doesn.?t work|bug|fix(?:ing)?\s+(?:this|the)\b|why is|why does)\b/i,

	refactor: /\b(refactor|clean ?up|simplify|extract|rename|move|reorganize|consolidate|deduplicate|dry\b)/i,

	// Match both explicit "run <tool>" phrasing AND bare CLI-ish prompts
	// ("git push", "push to branch", "commit & rebase"). The second clause is
	// intentionally verb-led so it doesn't eat `refactor` / `plan` prompts.
	shell: /\b(?:run|execute|invoke)\b.{0,40}\b(?:command|terminal|shell|bash|zsh|npm|pnpm|yarn|git|docker|kubectl)\b|^\s*(?:npm|pnpm|yarn|git|docker|kubectl|make|cargo|go|python|node|tsx)\s|^\s*(?:push|pull|commit|merge|rebase|stash|checkout|branch|clone|fetch|tag)\b/i,

	sql: /\b(select\s+[\w*]|from\s+\w+|inner join|left join|group by|order by|where\s+\w+\s*[=<>]|\bsqlx?\b|bigquery|lookml|lookm-?l|explore\s+\w+|dimension|measure)\b/i,

	test: /\b(test|spec|unit test|integration test|e2e|mock|assertion|expect\(|jest|vitest|pytest|rspec|snapshot)\b/i,

	explain: /\b(explain|what (?:does|is|are)|how (?:does|do) .* work|walk me through|tell me about|why (?:does|is)|tldr)\b/i,

	// Code generation signals (default when nothing else matches).
	codeGen: /\b(add|create|implement|build|write|generate|make|scaffold|set ?up|hook up|wire up)\b/i,
};

/** Simple character-length buckets used as a complexity prior. */
function lengthBucket(len: number): TaskComplexity {
	if (len < 40) { return 'trivial'; }
	if (len < 160) { return 'simple'; }
	if (len < 600) { return 'moderate'; }
	return 'complex';
}

/** Decide the task type from the prompt. First matching signal wins. */
export function heuristicTaskType(prompt: string): TaskType {
	if (KW.plan.test(prompt)) { return 'plan'; }
	if (KW.debug.test(prompt)) { return 'debug'; }
	if (KW.refactor.test(prompt)) { return 'refactor'; }
	if (KW.sql.test(prompt)) { return 'sql'; }
	if (KW.test.test(prompt)) { return 'test'; }
	if (KW.shell.test(prompt)) { return 'shell'; }
	if (KW.explain.test(prompt)) { return 'explain'; }
	if (KW.codeGen.test(prompt)) { return 'code_gen'; }
	return 'chat';
}

/**
 * Decide a coarse complexity.
 *
 * Strategy:
 *   1. Trivial-kwd matches (e.g. "push to branch") → always `trivial`.
 *   2. Plan / architectural kwds → bump toward `complex`.
 *   3. Otherwise use a length-based bucket, nudged by reference count
 *      (5+ file refs almost always implies moderate+).
 */
export function heuristicComplexity(input: ClassificationInput): TaskComplexity {
	const prompt = input.prompt.trim();

	if (KW.trivial.test(prompt)) { return 'trivial'; }
	if (KW.plan.test(prompt)) { return 'complex'; }

	const base = lengthBucket(prompt.length);
	const refs = input.referenceCount ?? 0;

	// Large reference sets dominate — a short prompt pointing at 10+ files is
	// almost always a moderate/complex refactor, not a trivial ask.
	if (refs >= 10) { return 'complex'; }
	if (refs >= 5 && base === 'trivial') { return 'simple'; }
	if (refs >= 5 && base === 'simple') { return 'moderate'; }

	return base;
}

/**
 * Minimal topic-change heuristic: detect explicit pivots (e.g. "let's switch
 * to X", "new question:"). Continuation-style prompts are always false.
 *
 * When `recentHistory` is undefined we assume this is a fresh session and
 * return false — the caller should treat a missing history as "no change".
 */
export function heuristicTopicChanged(input: ClassificationInput): boolean {
	if (!input.recentHistory) { return false; }

	const prompt = input.prompt.trim();
	if (prompt.length === 0) { return false; }

	// Short continuations never flag a topic change.
	if (/^(?:go|continue|yes|y|no|n|ok|okay|thanks|thx|more|again)\b/i.test(prompt)) {
		return false;
	}

	// Explicit pivot phrases.
	if (/\b(?:switching|switch) (?:to|gears|topics)\b|\bnew (?:question|topic|task)\b|\bunrelated\b|\bdifferent (?:question|topic)\b|\bforget (?:that|the previous)\b/i.test(prompt)) {
		return true;
	}

	// Otherwise: don't flip without LLM confirmation.
	return false;
}

/** Does the caller clearly need a vision-capable model? */
export function heuristicNeedsVision(input: ClassificationInput): boolean {
	if (input.hasImageAttachment) { return true; }
	return KW.vision.test(input.prompt);
}

/**
 * Run the full regex heuristic and produce a core classification. Confidence
 * is intentionally lower than LLM tiers so downstream consumers can prefer
 * LLM results when both are available.
 */
export function classifyByHeuristic(input: ClassificationInput): ClassificationCore {
	const task_type = heuristicTaskType(input.prompt);
	const complexity = heuristicComplexity(input);
	const topic_changed = heuristicTopicChanged(input);
	const needs_vision = heuristicNeedsVision(input);

	// Confidence:
	//   - Trivial matches are cheap & rarely wrong → 0.75
	//   - Plain `chat` fall-through means no signal matched → 0.3
	//   - Everything else: 0.55 (enough to be useful, low enough to be overridden)
	let confidence = 0.55;
	if (complexity === 'trivial' && task_type !== 'chat') { confidence = 0.75; }
	if (task_type === 'chat' && complexity !== 'trivial') { confidence = 0.3; }

	return { complexity, task_type, topic_changed, needs_vision, confidence };
}
