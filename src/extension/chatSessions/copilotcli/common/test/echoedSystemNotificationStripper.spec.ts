/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it } from 'vitest';
import {
	ECHOED_SYSTEM_NOTIFICATION_HEADER,
	createEchoedSystemNotificationStripper,
} from '../echoedSystemNotificationStripper';

const HEADER = ECHOED_SYSTEM_NOTIFICATION_HEADER;

describe('createEchoedSystemNotificationStripper (Patch 46)', () => {
	it('strips the full header when delivered as a single chunk', () => {
		const stripper = createEchoedSystemNotificationStripper();
		const body = 'Hello, here is my real answer.';
		const chunk = HEADER + body;
		expect(stripper.process('msg-1', chunk)).toBe(body);
	});

	it('strips the header when split across many small chunks', () => {
		const stripper = createEchoedSystemNotificationStripper();
		const body = 'Continuing the real response.';
		const full = HEADER + body;
		const chunkSize = 7; // arbitrary small size
		const chunks: string[] = [];
		for (let i = 0; i < full.length; i += chunkSize) {
			chunks.push(full.slice(i, i + chunkSize));
		}
		let emitted = '';
		for (const c of chunks) {
			emitted += stripper.process('msg-1', c);
		}
		expect(emitted).toBe(body);
	});

	it('commits to pass-through immediately when first chunk clearly does not match', () => {
		const stripper = createEchoedSystemNotificationStripper();
		const chunk = 'Hello world! This is a normal response.';
		expect(stripper.process('msg-1', chunk)).toBe(chunk);
	});

	it('commits to pass-through when buffered bytes diverge from header prefix', () => {
		const stripper = createEchoedSystemNotificationStripper();
		// Starts with a real prefix of the header ('[SYSTEM'), then diverges
		// ('?' doesn't match the expected space after SYSTEM).
		const first = '[SYSTEM';
		const second = '? something else';
		const firstOut = stripper.process('msg-1', first);
		expect(firstOut).toBe(''); // still buffering (valid prefix of header)
		const secondOut = stripper.process('msg-1', second);
		expect(secondOut).toBe(first + second);
		// A further chunk passes through verbatim.
		expect(stripper.process('msg-1', ' TAIL')).toBe(' TAIL');
	});

	it('only strips once per message — later echoes of the header remain visible', () => {
		const stripper = createEchoedSystemNotificationStripper();
		const body = 'First reply.';
		const trailing = '\n\n' + HEADER + 'Second occurrence inside the body.';
		const firstOut = stripper.process('msg-1', HEADER + body);
		const secondOut = stripper.process('msg-1', trailing);
		expect(firstOut).toBe(body);
		expect(secondOut).toBe(trailing);
	});

	it('keeps state per messageId (one message stripped, another passed through)', () => {
		const stripper = createEchoedSystemNotificationStripper();
		const out1 = stripper.process('a', HEADER + 'answer A');
		const out2 = stripper.process('b', 'answer B directly');
		expect(out1).toBe('answer A');
		expect(out2).toBe('answer B directly');
	});

	it('flush() returns residual buffered bytes if the message ended mid-prefix', () => {
		const stripper = createEchoedSystemNotificationStripper();
		// Only send the start of the header, never enough to decide.
		const partial = '[SYS';
		expect(stripper.process('msg-1', partial)).toBe('');
		expect(stripper.flush('msg-1')).toBe(partial);
		// Second flush is a no-op.
		expect(stripper.flush('msg-1')).toBe('');
	});

	it('flush() is a no-op after a message has already committed', () => {
		const stripper = createEchoedSystemNotificationStripper();
		expect(stripper.process('msg-1', 'Normal content.')).toBe('Normal content.');
		expect(stripper.flush('msg-1')).toBe('');
	});

	it('flush() is a no-op after header has been successfully stripped', () => {
		const stripper = createEchoedSystemNotificationStripper();
		expect(stripper.process('msg-1', HEADER + 'body')).toBe('body');
		expect(stripper.flush('msg-1')).toBe('');
	});

	it('empty chunk passes through unchanged without affecting state', () => {
		const stripper = createEchoedSystemNotificationStripper();
		expect(stripper.process('msg-1', '')).toBe('');
		// Stripping still works afterwards.
		expect(stripper.process('msg-1', HEADER + 'real')).toBe('real');
	});

	it('strips when the header is split character-by-character then a body follows', () => {
		const stripper = createEchoedSystemNotificationStripper();
		const body = 'final body';
		const full = HEADER + body;
		let emitted = '';
		for (const ch of full) {
			emitted += stripper.process('msg-1', ch);
		}
		expect(emitted).toBe(body);
	});

	it('preserves content immediately after the header boundary across chunk boundaries', () => {
		const stripper = createEchoedSystemNotificationStripper();
		// Put the boundary inside a chunk so the stripper has to slice mid-chunk.
		const first = HEADER.slice(0, 50);
		const second = HEADER.slice(50) + 'tail';
		const a = stripper.process('msg-1', first);
		const b = stripper.process('msg-1', second);
		expect(a + b).toBe('tail');
	});
});
