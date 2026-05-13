/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { EncryptedThinkingDelta, RawThinkingDelta, ThinkingDelta } from './thinking';

function getThinkingDeltaText(thinking: RawThinkingDelta | undefined): string | undefined {
	if (!thinking) {
		return '';
	}
	if (thinking.reasoning_content) {
		return thinking.reasoning_content;
	}
	if (thinking.cot_summary) {
		return thinking.cot_summary;
	}
	if (thinking.reasoning_text) {
		return thinking.reasoning_text;
	}
	if (thinking.thinking) {
		return thinking.thinking;
	}
	return undefined;
}

function getThinkingDeltaId(thinking: RawThinkingDelta | undefined): string | undefined {
	if (!thinking) {
		return undefined;
	}
	if (thinking.cot_id) {
		return thinking.cot_id;
	}
	if (thinking.reasoning_opaque) {
		return thinking.reasoning_opaque;
	}
	if (thinking.signature) {
		return thinking.signature;
	}
	// ─── BYOK CUSTOM PATCH: synthetic id for reasoning_content (Patch 53) ───────
	// DeepSeek / OpenAI o-series send reasoning_content but no native id field.
	// Without an id the ThinkingDataContainer pipeline gates on `thinking.id &&`
	// and never serialises the thinking block — causing HTTP 400 on the next
	// turn: "The reasoning_content in the thinking mode must be passed back."
	// Return a stable sentinel so the block flows through to Patch 54's
	// out.reasoning_content re-serialisation.
	if (thinking.reasoning_content) {
		return 'reasoning';
	}
	// ─── END BYOK CUSTOM PATCH ──────────────────────────────────────────────────
	return undefined;
}

export function extractThinkingDeltaFromChoice(choice: { message?: RawThinkingDelta; delta?: RawThinkingDelta }): ThinkingDelta | EncryptedThinkingDelta | undefined {
	const thinking = choice.message || choice.delta;
	if (!thinking) {
		return undefined;
	}

	const id = getThinkingDeltaId(thinking);
	const text = getThinkingDeltaText(thinking);

	// reasoning_opaque is encrypted content that should be marked as such
	if (thinking.reasoning_opaque) {
		return { id: thinking.reasoning_opaque, text, encrypted: thinking.reasoning_opaque };
	}

	if (id && text) {
		return { id, text };
	} else if (text) {
		return { text };
	} else if (id) {
		return { id };
	}
	return undefined;
}
