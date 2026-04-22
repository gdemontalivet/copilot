/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Types for the BYOK routing classifier — the Stage-1 "pre-router" that
 * decides the complexity / task-type of a chat request so downstream
 * cost-aware routing can pick the cheapest capable model.
 *
 * This file is intentionally SDK-free so it can be imported from both the
 * `vscode-node` (classifier implementation) and `common` (heuristic fallback,
 * future router) layers without pulling network deps into common code.
 */

/**
 * Coarse classification of how much horsepower a request needs.
 *
 *  - `trivial`  : one-tool-call with no reasoning ("push to branch", "run tests")
 *  - `simple`   : single-file edit with clear intent ("add loading state to X")
 *  - `moderate` : multi-file changes or moderate reasoning ("refactor to hooks")
 *  - `complex`  : planning / architecture / deep analysis ("design a cache layer")
 */
export type TaskComplexity = 'trivial' | 'simple' | 'moderate' | 'complex';

/** Coarse intent label attached to the prompt. */
export type TaskType =
	| 'code_gen'
	| 'debug'
	| 'refactor'
	| 'plan'
	| 'shell'
	| 'sql'
	| 'explain'
	| 'test'
	| 'chat';

/** Which tier produced the classification, surfaced for observability + tests. */
export type ClassificationSource = 'gemini-flash' | 'claude-haiku' | 'heuristic';

/** Inputs the classifier needs to make a decision. */
export interface ClassificationInput {
	/** The user's latest chat message. */
	prompt: string;

	/**
	 * Optional short summary of the previous 2-3 turns. Capped at a few hundred
	 * tokens by the caller — used only to decide `topic_changed`. Leave
	 * undefined on the first turn of a session.
	 */
	recentHistory?: string;

	/** Number of file / symbol references attached to the request (variableData). */
	referenceCount?: number;

	/** Whether the request carries an image attachment. Pre-computed by caller. */
	hasImageAttachment?: boolean;
}

/**
 * The core classification payload — the LLM is asked to output exactly this
 * shape as JSON. Kept separate from {@link ClassificationResult} so the
 * classifier can add metadata (source, latency) without the LLM seeing it.
 */
export interface ClassificationCore {
	complexity: TaskComplexity;
	task_type: TaskType;
	/**
	 * True when the new prompt is about a different file / API / goal than the
	 * recent history. Short continuations ("go", "continue", "yes") are NEVER
	 * marked as topic changes.
	 */
	topic_changed: boolean;
	/** True when the request needs vision-capable models (image attached, etc.). */
	needs_vision: boolean;
	/** Classifier's self-reported confidence, 0.0 - 1.0. */
	confidence: number;
}

/** The full classification result surfaced to the caller. */
export interface ClassificationResult extends ClassificationCore {
	/** Which tier produced this result. */
	source: ClassificationSource;
	/** End-to-end latency including failover attempts, milliseconds. */
	latencyMs: number;
}

/** Options that configure a {@link IByokRoutingClassifier} at construction. */
export interface ClassifierOptions {
	/** How long to wait for the Tier-1 (Gemini Flash) call. Default: 800ms. */
	primaryTimeoutMs?: number;

	/** How long to wait for the Tier-2 (Claude Haiku) call. Default: 1500ms. */
	failoverTimeoutMs?: number;

	/**
	 * API key for the Google Gemini native API. When undefined, Tier 1 is
	 * skipped and the classifier starts at Tier 2.
	 */
	geminiApiKey?: string;

	/**
	 * Which Gemini model to use for classification. The caller picks from what
	 * their key has access to (e.g. `gemini-3-flash`, `gemini-2.5-flash`).
	 * Defaults to `gemini-2.5-flash` which is broadly available.
	 */
	geminiModelId?: string;

	/**
	 * Vertex AI credentials + region for the Tier-2 (Claude Haiku) failover.
	 * When undefined, Tier 2 is skipped and the classifier falls through
	 * directly to the heuristic.
	 */
	vertexConfig?: VertexClassifierConfig;

	/**
	 * Which Vertex-hosted Haiku model id to call on failover. Defaults to
	 * `claude-3-5-haiku@20241022`, which must exist in the user's project.
	 */
	haikuModelId?: string;
}

/** Vertex AI configuration specific to the classifier's failover call. */
export interface VertexClassifierConfig {
	/** Either a service-account JSON string, or a pre-minted OAuth2 Bearer token. */
	apiKey: string;
	/** GCP project id hosting the Vertex AI endpoint. */
	projectId: string;
	/**
	 * GCP region hosting the model. Haiku 3.5 is in `us-east5` / `us-central1`
	 * — unlike Opus / Sonnet 4.x which are `global`.
	 */
	locationId: string;
}

/** Runtime overrides injected by tests to stub out the network calls. */
export interface ClassifierTestOverrides {
	/** Replaces the Gemini Flash call. */
	gemini?: (input: ClassificationInput) => Promise<ClassificationCore>;
	/** Replaces the Vertex Haiku call. */
	haiku?: (input: ClassificationInput) => Promise<ClassificationCore>;
	/** Replaces `Date.now()` (used by tests to assert latency metadata). */
	now?: () => number;
}

/** The service surface consumed by the auto-router. */
export interface IByokRoutingClassifier {
	classify(input: ClassificationInput): Promise<ClassificationResult>;
}
