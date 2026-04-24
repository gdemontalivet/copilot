/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it } from 'vitest';
import { ChatFetchResponseType, RESPONSE_EMPTY_STOP, RESPONSE_TOOL_HISTORY_INVALID, getErrorDetailsFromChatFetchError } from '../../common/commonTypes';

// GitHubOutageStatus is a const enum in githubService.ts; vitest (esbuild)
// doesn't inline const enums across files, so we pass the literal numeric
// value that matches GitHubOutageStatus.None.
const OUTAGE_NONE = 0;

// ─── BYOK CUSTOM PATCH: Patch 44 test coverage ──────────────────────────────
// Preserved by .github/scripts/apply-byok-patches.sh. Do not remove.
// Verify that getErrorDetailsFromChatFetchError surfaces the dedicated
// tool-history-invalid message (Patch 44) and the empty-stop message
// (Patch 31) for their respective reason tags, and falls back to the
// generic "no response" wording otherwise.
// ─── END BYOK CUSTOM PATCH ─────────────────────────────────────────────────

function makeUnknown(reason: string) {
	return {
		type: ChatFetchResponseType.Unknown as const,
		reason,
		requestId: 'req-1',
		serverRequestId: 'srv-1',
	};
}

describe('getErrorDetailsFromChatFetchError — Unknown branch messages', () => {

	it('returns the tool-history-invalid message for RESPONSE_TOOL_HISTORY_INVALID (Patch 44)', () => {
		const details = getErrorDetailsFromChatFetchError(
			makeUnknown(RESPONSE_TOOL_HISTORY_INVALID),
			'individual',
			OUTAGE_NONE as never,
		);
		expect(details.message).toMatch(/tool-call \/ tool-response mismatch/i);
		expect(details.message).toMatch(/start a new chat/i);
	});

	it('returns the empty-stop message for RESPONSE_EMPTY_STOP (Patch 31)', () => {
		const details = getErrorDetailsFromChatFetchError(
			makeUnknown(RESPONSE_EMPTY_STOP),
			'individual',
			OUTAGE_NONE as never,
		);
		expect(details.message).toMatch(/empty response|stop with no content/i);
	});

	it('falls back to the generic "no response was returned" message for other reasons', () => {
		const details = getErrorDetailsFromChatFetchError(
			makeUnknown('some unrelated reason'),
			'individual',
			OUTAGE_NONE as never,
		);
		expect(details.message).toMatch(/no response was returned/i);
	});
});
