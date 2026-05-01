/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

export namespace CustomDataPartMimeTypes {
	export const CacheControl = 'cache_control';
	export const StatefulMarker = 'stateful_marker';
	export const ThinkingData = 'thinking';
	export const ContextManagement = 'context_management';
	export const PhaseData = 'phase_data';
	// ─── BYOK CUSTOM PATCH: token-usage data part ─────────────
	// Preserved by .github/scripts/apply-byok-patches.sh (Patch 33).
	// Carries the per-request `usage` payload from BYOK providers
	// (Anthropic, VertexAnthropic, Gemini, VertexGemini) to
	// `extChatEndpoint.ts`, which forwards it to the toolCallingLoop
	// so the context-window ring indicator can render real numbers
	// instead of the hardcoded zeros upstream falls back to.
	export const TokenUsage = 'token_usage';
	// ─── END BYOK CUSTOM PATCH ────────────────────────
}

export const CacheType = 'ephemeral';