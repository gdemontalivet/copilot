/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import Anthropic from '@anthropic-ai/sdk';
import { GoogleGenAI, Type } from '@google/genai';
import { GoogleAuth } from 'google-auth-library';
import type { ILogService } from '../../../platform/log/common/logService';
import { classifyAnthropicError, isFailoverTrigger } from '../common/byokFailover';
import { classifyByHeuristic } from '../common/byokRoutingHeuristics';
import type {
	ClassificationCore,
	ClassificationInput,
	ClassificationResult,
	ClassifierOptions,
	ClassifierTestOverrides,
	IByokRoutingClassifier,
	TaskComplexity,
	TaskType,
	VertexClassifierConfig,
} from '../common/byokRoutingClassifier.types';

/**
 * Routing classifier that chooses the coarse complexity / task-type of an
 * incoming BYOK chat request using a 3-tier cascade:
 *
 *   Tier 1 — Gemini 3 (Flash) via the user's Google Generative AI API key.
 *            Sub-second, ~$0.0001/call. Preferred whenever available.
 *   Tier 2 — Claude Haiku 3.5 via Vertex AI when Tier 1 rate-limits / errors.
 *            Slightly slower & pricier but independently hosted so it's
 *            unlikely to share failure modes with Tier 1.
 *   Tier 3 — Pure-regex heuristic (see byokRoutingHeuristics.ts).
 *            Offline, instant, always returns a (lower-confidence) decision.
 *
 * Failover within this classifier is LOCAL — it never touches the normal
 * response-generation pipeline. If every tier fails to produce valid JSON
 * we still return the heuristic result with the wrapping error logged.
 */
export class ByokRoutingClassifier implements IByokRoutingClassifier {

	private readonly _primaryTimeoutMs: number;
	private readonly _failoverTimeoutMs: number;
	private readonly _geminiApiKey: string | undefined;
	private readonly _geminiModelId: string;
	private readonly _vertexConfig: VertexClassifierConfig | undefined;
	private readonly _haikuModelId: string;
	private readonly _now: () => number;
	private readonly _overrides: ClassifierTestOverrides;

	private _tokenCache: { token: string; expiresAt: number } | undefined;

	constructor(
		options: ClassifierOptions,
		private readonly _logService: ILogService,
		testOverrides?: ClassifierTestOverrides,
	) {
		this._primaryTimeoutMs = options.primaryTimeoutMs ?? 800;
		this._failoverTimeoutMs = options.failoverTimeoutMs ?? 1500;
		this._geminiApiKey = options.geminiApiKey;
		this._geminiModelId = options.geminiModelId ?? 'gemini-2.5-flash';
		this._vertexConfig = options.vertexConfig;
		this._haikuModelId = options.haikuModelId ?? 'claude-3-5-haiku@20241022';
		this._overrides = testOverrides ?? {};
		this._now = testOverrides?.now ?? Date.now.bind(Date);
	}

	async classify(input: ClassificationInput): Promise<ClassificationResult> {
		const start = this._now();

		// Tier 1 — Gemini Flash
		if (this._overrides.gemini || this._geminiApiKey) {
			try {
				const core = await this._tryWithTimeout(
					() => (this._overrides.gemini ?? this._callGeminiFlash.bind(this))(input),
					this._primaryTimeoutMs,
					'gemini-flash'
				);
				return { ...core, source: 'gemini-flash', latencyMs: this._now() - start };
			} catch (err) {
				this._logTierFailure('gemini-flash', err);
				// Fall through to Tier 2 only on failover-worthy classifications.
				// For a "fatal" error (e.g. API key malformed), Tier 2 would fail
				// the same way, so we short-circuit to the heuristic below.
				const anthropicLike = classifyAnthropicError(err);
				if (anthropicLike !== 'ok' && anthropicLike !== 'fatal' && !isFailoverTrigger(anthropicLike) && !(err instanceof TimeoutError)) {
					// Rare path — keep going but log clearly.
					this._logService.trace(`[ByokRoutingClassifier] non-failover Tier-1 error, trying Tier 2 anyway: ${anthropicLike}`);
				}
			}
		}

		// Tier 2 — Claude Haiku 3.5 via Vertex
		if (this._overrides.haiku || this._vertexConfig) {
			try {
				const core = await this._tryWithTimeout(
					() => (this._overrides.haiku ?? this._callVertexHaiku.bind(this))(input),
					this._failoverTimeoutMs,
					'claude-haiku'
				);
				return { ...core, source: 'claude-haiku', latencyMs: this._now() - start };
			} catch (err) {
				this._logTierFailure('claude-haiku', err);
			}
		}

		// Tier 3 — pure heuristic. Cannot fail.
		const core = classifyByHeuristic(input);
		return { ...core, source: 'heuristic', latencyMs: this._now() - start };
	}

	/* ───────────────────────── Tier 1: Gemini Flash ──────────────────────── */

	private async _callGeminiFlash(input: ClassificationInput): Promise<ClassificationCore> {
		if (!this._geminiApiKey) {
			throw new Error('Gemini API key not configured');
		}

		const client = new GoogleGenAI({ apiKey: this._geminiApiKey });
		const response = await client.models.generateContent({
			model: this._geminiModelId,
			contents: buildUserPrompt(input),
			config: {
				systemInstruction: CLASSIFIER_SYSTEM_PROMPT,
				temperature: 0,
				maxOutputTokens: 256,
				responseMimeType: 'application/json',
				responseSchema: GEMINI_JSON_SCHEMA,
			},
		});

		const text = extractGeminiText(response);
		if (!text) {
			throw new Error('Gemini response contained no text');
		}
		return parseAndValidate(text, input);
	}

	/* ───────────────────────── Tier 2: Vertex Haiku ──────────────────────── */

	private async _callVertexHaiku(input: ClassificationInput): Promise<ClassificationCore> {
		const cfg = this._vertexConfig;
		if (!cfg) {
			throw new Error('Vertex config not provided');
		}

		const endpoint = cfg.locationId === 'global'
			? 'aiplatform.googleapis.com'
			: `${cfg.locationId}-aiplatform.googleapis.com`;
		const baseUrl = `https://${endpoint}/v1/projects/${cfg.projectId}/locations/${cfg.locationId}/publishers/anthropic/models`;
		const modelId = this._haikuModelId;

		const client = new Anthropic({
			apiKey: cfg.apiKey,
			baseURL: baseUrl,
			fetch: async (url, init) => {
				const urlStr = url.toString();
				const finalUrl = urlStr.includes('/messages')
					? `${baseUrl}/${modelId}:rawPredict`
					: urlStr;
				const token = await this._getVertexAccessToken(cfg);
				const headers = new Headers(init?.headers);
				headers.set('Authorization', `Bearer ${token}`);
				headers.delete('x-api-key');
				// Vertex does NOT accept `model` in the body; inject
				// `anthropic_version` instead.
				let body = init?.body;
				if (typeof body === 'string') {
					try {
						const parsed = JSON.parse(body);
						delete parsed.model;
						delete parsed.stream;
						parsed.anthropic_version = 'vertex-2023-10-16';
						body = JSON.stringify(parsed);
					} catch {
						// Body wasn't JSON — pass through untouched.
					}
				}
				return fetch(finalUrl, { ...init, headers, body });
			},
		});

		const response = await client.messages.create({
			model: modelId,
			max_tokens: 256,
			temperature: 0,
			system: CLASSIFIER_SYSTEM_PROMPT,
			messages: [{ role: 'user', content: buildUserPrompt(input) }],
		});

		const text = response.content
			.filter((b): b is Anthropic.TextBlock => b.type === 'text')
			.map(b => b.text)
			.join('');
		if (!text) {
			throw new Error('Haiku response contained no text');
		}
		return parseAndValidate(text, input);
	}

	/** Refresh and cache a Vertex OAuth bearer token (see vertexAnthropicProvider). */
	private async _getVertexAccessToken(cfg: VertexClassifierConfig): Promise<string> {
		const trimmed = cfg.apiKey.trim();
		if (!trimmed.startsWith('{')) {
			return trimmed;
		}
		if (this._tokenCache && this._tokenCache.expiresAt > this._now() + 60_000) {
			return this._tokenCache.token;
		}
		const credentials = JSON.parse(trimmed);
		const auth = new GoogleAuth({
			credentials,
			scopes: 'https://www.googleapis.com/auth/cloud-platform',
			projectId: credentials.project_id || credentials.quota_project_id || cfg.projectId,
		});
		const client = await auth.getClient();
		const tokenResponse = await client.getAccessToken();
		const token = tokenResponse.token;
		if (!token) {
			throw new Error('Failed to retrieve access token for classifier');
		}
		this._tokenCache = { token, expiresAt: this._now() + 45 * 60 * 1000 };
		return token;
	}

	/* ─────────────────────────── helpers ────────────────────────────────── */

	private async _tryWithTimeout<T>(fn: () => Promise<T>, ms: number, label: string): Promise<T> {
		let timer: ReturnType<typeof setTimeout> | undefined;
		try {
			return await Promise.race([
				fn(),
				new Promise<never>((_, reject) => {
					timer = setTimeout(() => reject(new TimeoutError(label, ms)), ms);
				}),
			]);
		} finally {
			if (timer) { clearTimeout(timer); }
		}
	}

	private _logTierFailure(tier: 'gemini-flash' | 'claude-haiku', err: unknown): void {
		const msg = err instanceof Error ? err.message : String(err);
		this._logService.trace(`[ByokRoutingClassifier] ${tier} failed: ${msg}`);
	}
}

/* ───────────────────────── prompt / schema ──────────────────────────────── */

const CLASSIFIER_SYSTEM_PROMPT = `You are a task classifier for a developer-facing AI coding assistant.

Output ONLY a single JSON object with exactly these keys and no prose:
  complexity      — one of: "trivial", "simple", "moderate", "complex"
  task_type       — one of: "code_gen", "debug", "refactor", "plan", "shell", "sql", "explain", "test", "chat"
  topic_changed   — boolean; true when the prompt is about a different file/API/goal than the recent history. Continuations like "go", "yes", "continue" are never topic changes.
  needs_vision    — boolean; true when the user refers to an image/screenshot/diagram or explicitly asks the model to "see" something.
  confidence      — number between 0 and 1; your own confidence in this classification.

Definitions:
  trivial   — one-tool-call with no reasoning ("push to branch", "run tests")
  simple    — single-file edit with clear intent ("add loading state to X")
  moderate  — multi-file changes or moderate reasoning ("refactor foo to use hooks")
  complex   — planning / architecture / deep analysis ("design a cache layer")

Do NOT wrap the object in markdown fences. Do NOT add explanations.`;

/** JSON schema passed to Gemini's structured-output mode. */
const GEMINI_JSON_SCHEMA = {
	type: Type.OBJECT,
	properties: {
		complexity: { type: Type.STRING, enum: ['trivial', 'simple', 'moderate', 'complex'] },
		task_type: { type: Type.STRING, enum: ['code_gen', 'debug', 'refactor', 'plan', 'shell', 'sql', 'explain', 'test', 'chat'] },
		topic_changed: { type: Type.BOOLEAN },
		needs_vision: { type: Type.BOOLEAN },
		confidence: { type: Type.NUMBER },
	},
	required: ['complexity', 'task_type', 'topic_changed', 'needs_vision', 'confidence'],
	// GoogleGenAI respects property ordering for determinism.
	propertyOrdering: ['complexity', 'task_type', 'topic_changed', 'needs_vision', 'confidence'],
};

/** Build the per-request user message. Keeps history + prompt cleanly separated. */
export function buildUserPrompt(input: ClassificationInput): string {
	const parts: string[] = [];
	if (input.recentHistory && input.recentHistory.trim().length > 0) {
		parts.push(`<recent_history>\n${truncate(input.recentHistory, 1200)}\n</recent_history>`);
	}
	parts.push(`<prompt>\n${truncate(input.prompt, 2000)}\n</prompt>`);
	parts.push(`<context>\n  references: ${input.referenceCount ?? 0}\n  has_image: ${input.hasImageAttachment ? 'true' : 'false'}\n</context>`);
	parts.push('Return only the JSON object.');
	return parts.join('\n\n');
}

function truncate(s: string, max: number): string {
	if (s.length <= max) { return s; }
	return `${s.slice(0, max)}… [truncated ${s.length - max} chars]`;
}

/* ────────────────────────── parse / validate ────────────────────────────── */

const VALID_COMPLEXITY: readonly TaskComplexity[] = ['trivial', 'simple', 'moderate', 'complex'];
const VALID_TASK_TYPES: readonly TaskType[] = ['code_gen', 'debug', 'refactor', 'plan', 'shell', 'sql', 'explain', 'test', 'chat'];

/**
 * Parse the model response into a {@link ClassificationCore}, repairing
 * missing fields with heuristic values rather than throwing. Unrecognised
 * enum values are coerced to the closest reasonable default so the caller
 * always gets a usable answer.
 */
export function parseAndValidate(text: string, input: ClassificationInput): ClassificationCore {
	const json = extractJsonObject(text);
	const heuristic = classifyByHeuristic(input);
	if (!json) {
		throw new ClassifierParseError(`no JSON object found in: ${truncate(text, 200)}`);
	}

	const complexity = coerceEnum(json['complexity'], VALID_COMPLEXITY, heuristic.complexity);
	const task_type = coerceEnum(json['task_type'], VALID_TASK_TYPES, heuristic.task_type);
	const topic_changed = typeof json['topic_changed'] === 'boolean' ? json['topic_changed'] : heuristic.topic_changed;
	const needs_vision = typeof json['needs_vision'] === 'boolean' ? json['needs_vision'] : heuristic.needs_vision;
	const rawConfidence = typeof json['confidence'] === 'number' ? json['confidence'] : heuristic.confidence;
	const confidence = Math.max(0, Math.min(1, rawConfidence));

	return { complexity, task_type, topic_changed, needs_vision, confidence };
}

/**
 * Pull the first top-level `{…}` object out of a possibly-noisy model
 * response. Handles markdown fences (` ```json\n{...}\n``` `), leading /
 * trailing prose, and extra whitespace.
 */
function extractJsonObject(text: string): Record<string, unknown> | undefined {
	const trimmed = text.trim();

	const fenced = /```(?:json)?\s*(\{[\s\S]*?\})\s*```/i.exec(trimmed);
	if (fenced) {
		try { return JSON.parse(fenced[1]) as Record<string, unknown>; } catch { /* fall through */ }
	}

	const first = trimmed.indexOf('{');
	const last = trimmed.lastIndexOf('}');
	if (first >= 0 && last > first) {
		const candidate = trimmed.slice(first, last + 1);
		try { return JSON.parse(candidate) as Record<string, unknown>; } catch { /* fall through */ }
	}

	try { return JSON.parse(trimmed) as Record<string, unknown>; } catch { return undefined; }
}

function coerceEnum<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
	if (typeof value === 'string') {
		const lower = value.toLowerCase() as T;
		if ((allowed as readonly string[]).includes(lower)) { return lower; }
	}
	return fallback;
}

function extractGeminiText(response: unknown): string | undefined {
	if (!response || typeof response !== 'object') { return undefined; }
	const resp = response as { text?: string | (() => string); candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }> };

	if (typeof resp.text === 'string' && resp.text.length > 0) { return resp.text; }
	if (typeof resp.text === 'function') {
		try {
			const t = resp.text();
			if (typeof t === 'string' && t.length > 0) { return t; }
		} catch { /* fall through */ }
	}
	const candidate = resp.candidates?.[0];
	const parts = candidate?.content?.parts ?? [];
	const joined = parts.map(p => p.text ?? '').join('');
	return joined.length > 0 ? joined : undefined;
}

/* ─────────────────────────────── errors ─────────────────────────────────── */

/** Thrown when a tier call exceeds its timeout budget. */
export class TimeoutError extends Error {
	constructor(label: string, ms: number) {
		super(`Classifier tier "${label}" timed out after ${ms}ms`);
		this.name = 'ClassifierTimeoutError';
	}
}

/** Thrown when a tier's response can't be parsed as the expected schema. */
export class ClassifierParseError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'ClassifierParseError';
	}
}
