/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { OutputMode, Raw } from '@vscode/prompt-tsx';
import { describe, expect, it } from 'vitest';
import { CancellationToken } from '../../../../util/vs/base/common/cancellation';
import { BYOKStubChatEndpoint } from '../byokStubChatEndpoint';

describe('BYOKStubChatEndpoint (Patch 45)', () => {
	describe('shape', () => {
		it('exposes IChatEndpoint-compatible defaults without needing DI', () => {
			const ep = new BYOKStubChatEndpoint();
			expect(ep.name).toBe('BYOK Stub');
			expect(ep.family).toBe('byok-stub');
			expect(ep.model).toBe('byok-stub');
			expect(ep.modelProvider).toBe('byok-stub');
			expect(ep.isFallback).toBe(true);
			expect(ep.showInModelPicker).toBe(false);
			expect(ep.supportsVision).toBe(false);
			expect(ep.supportsPrediction).toBe(false);
			expect(ep.isPremium).toBe(false);
		});

		it('defaults modelMaxPromptTokens to 128k and accepts an override', () => {
			expect(new BYOKStubChatEndpoint().modelMaxPromptTokens).toBe(128_000);
			expect(new BYOKStubChatEndpoint(4096).modelMaxPromptTokens).toBe(4096);
		});

		it('does not look like any real provider family (guards against model-specific branches)', () => {
			const ep = new BYOKStubChatEndpoint();
			expect(ep.family.startsWith('gpt-')).toBe(false);
			expect(ep.family.startsWith('claude-')).toBe(false);
			expect(ep.family.startsWith('gemini-')).toBe(false);
			expect(ep.model.startsWith('claude-opus')).toBe(false);
		});

		it('urlOrRequestMetadata is a non-routable sentinel', () => {
			expect(new BYOKStubChatEndpoint().urlOrRequestMetadata).toBe('byok-stub://no-endpoint');
		});
	});

	describe('cloneWithTokenOverride', () => {
		it('returns a new stub with the overridden budget and preserves all other defaults', () => {
			const ep = new BYOKStubChatEndpoint(1000);
			const clone = ep.cloneWithTokenOverride(5000);
			expect(clone).toBeInstanceOf(BYOKStubChatEndpoint);
			expect(clone.modelMaxPromptTokens).toBe(5000);
			expect(clone.name).toBe(ep.name);
			expect(clone.family).toBe(ep.family);
			expect(clone.isFallback).toBe(true);
		});
	});

	describe('acquireTokenizer (rough char-based fallback)', () => {
		it('returns a tokenizer in Raw mode', () => {
			const tk = new BYOKStubChatEndpoint().acquireTokenizer();
			expect(tk.mode).toBe(OutputMode.Raw);
		});

		it('tokenLength for a string returns a positive estimate proportional to length', async () => {
			const tk = new BYOKStubChatEndpoint().acquireTokenizer();
			const short = await tk.tokenLength('hi');
			const long = await tk.tokenLength('hello world, this is a long-ish sentence with many tokens');
			expect(short).toBeGreaterThan(0);
			expect(long).toBeGreaterThan(short);
		});

		it('tokenLength for a text part uses the inner `text` field', async () => {
			const tk = new BYOKStubChatEndpoint().acquireTokenizer();
			const part: Raw.ChatCompletionContentPart = {
				type: Raw.ChatCompletionContentPartKind.Text,
				text: 'hello world',
			};
			const n = await tk.tokenLength(part);
			expect(n).toBeGreaterThan(0);
		});

		it('tokenLength for an empty string is 0', async () => {
			const tk = new BYOKStubChatEndpoint().acquireTokenizer();
			expect(await tk.tokenLength('')).toBe(0);
		});

		it('countMessageTokens adds role overhead to content length', async () => {
			const tk = new BYOKStubChatEndpoint().acquireTokenizer();
			const msg: Raw.ChatMessage = {
				role: Raw.ChatRole.User,
				content: [{ type: Raw.ChatCompletionContentPartKind.Text, text: 'hello world' }],
			};
			const n = await tk.countMessageTokens(msg);
			expect(n).toBeGreaterThan(3);
		});

		it('countMessagesTokens aggregates across multiple messages', async () => {
			const tk = new BYOKStubChatEndpoint().acquireTokenizer();
			const mk = (t: string): Raw.ChatMessage => ({
				role: Raw.ChatRole.User,
				content: [{ type: Raw.ChatCompletionContentPartKind.Text, text: t }],
			});
			const one = await tk.countMessagesTokens([mk('hello world')]);
			const two = await tk.countMessagesTokens([mk('hello world'), mk('hello world')]);
			expect(two).toBeGreaterThan(one);
		});

		it('countToolTokens returns a non-zero estimate for a non-empty tool list', async () => {
			const tk = new BYOKStubChatEndpoint().acquireTokenizer();
			const n = await tk.countToolTokens([
				{ name: 'read_file', description: 'read a file', inputSchema: { type: 'object', properties: { path: { type: 'string' } } } },
			]);
			expect(n).toBeGreaterThan(0);
		});

		it('countToolTokens is 0 for an empty tool list', async () => {
			const tk = new BYOKStubChatEndpoint().acquireTokenizer();
			expect(await tk.countToolTokens([])).toBe(0);
		});
	});

	describe('network methods throw with a clear, actionable message', () => {
		it('makeChatRequest throws synchronously (callers see rejection on await)', () => {
			const ep = new BYOKStubChatEndpoint();
			expect(() =>
				ep.makeChatRequest('x', [], undefined, CancellationToken.None, 0 as never),
			).toThrow(/BYOKStubChatEndpoint/);
		});

		it('makeChatRequest2 throws synchronously (callers see rejection on await)', () => {
			const ep = new BYOKStubChatEndpoint();
			expect(() =>
				ep.makeChatRequest2({} as never, CancellationToken.None),
			).toThrow(/BYOKStubChatEndpoint/);
		});

		it('processResponseFromChatEndpoint throws synchronously (not a rejected promise)', () => {
			const ep = new BYOKStubChatEndpoint();
			expect(() =>
				ep.processResponseFromChatEndpoint(
					{} as never,
					{} as never,
					{} as never,
					1,
					(() => { }) as never,
					{} as never,
				),
			).toThrow(/BYOKStubChatEndpoint/);
		});

		it('createRequestBody throws', () => {
			const ep = new BYOKStubChatEndpoint();
			expect(() => ep.createRequestBody({} as never)).toThrow(/BYOKStubChatEndpoint/);
		});
	});
});
