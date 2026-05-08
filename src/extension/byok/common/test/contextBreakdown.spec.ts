/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { OutputMode, Raw } from '@vscode/prompt-tsx';
import type { LanguageModelChatTool } from 'vscode';
import { describe, expect, it } from 'vitest';
import type { ITokenizer } from '../../../../util/common/tokenizer';
import {
	type ContextBreakdownInput,
	computeContextBreakdown,
	contextPercent,
	formatTokens,
} from '../contextBreakdown';

/**
 * Deterministic tokenizer for tests: char-based estimate (`length / 4` rounded
 * up), constant 3-token role overhead per message. No async I/O, no flake.
 */
class FakeTokenizer implements ITokenizer {
	public readonly mode = OutputMode.Raw;

	async tokenLength(text: string | Raw.ChatCompletionContentPart): Promise<number> {
		const s = typeof text === 'string' ? text : (text.type === Raw.ChatCompletionContentPartKind.Text ? text.text : '');
		return Math.ceil(s.length / 4);
	}

	async countMessageTokens(message: Raw.ChatMessage): Promise<number> {
		let body = 0;
		for (const part of message.content) {
			if (part.type === Raw.ChatCompletionContentPartKind.Text) {
				body += Math.ceil(part.text.length / 4);
			}
		}
		return body + 3; // role overhead
	}

	async countMessagesTokens(messages: Raw.ChatMessage[]): Promise<number> {
		let total = 3; // base completion overhead
		for (const m of messages) {
			total += await this.countMessageTokens(m);
		}
		return total;
	}

	async countToolTokens(_tools: readonly LanguageModelChatTool[]): Promise<number> {
		// callers pre-compute and pass `toolTokenCount` directly, so this is
		// only here to satisfy the interface contract.
		return 0;
	}
}

function userMsg(text: string): Raw.UserChatMessage {
	return {
		role: Raw.ChatRole.User,
		content: [{ type: Raw.ChatCompletionContentPartKind.Text, text }],
	};
}

function assistantMsg(text: string): Raw.AssistantChatMessage {
	return {
		role: Raw.ChatRole.Assistant,
		content: [{ type: Raw.ChatCompletionContentPartKind.Text, text }],
	};
}

function systemMsg(text: string): Raw.SystemChatMessage {
	return {
		role: Raw.ChatRole.System,
		content: [{ type: Raw.ChatCompletionContentPartKind.Text, text }],
	};
}

function toolMsg(text: string, toolCallId = 'tool_1'): Raw.ToolChatMessage {
	return {
		role: Raw.ChatRole.Tool,
		toolCallId,
		content: [{ type: Raw.ChatCompletionContentPartKind.Text, text }],
	};
}

const baseInput = (overrides: Partial<ContextBreakdownInput>): ContextBreakdownInput => ({
	messages: [],
	tokenizer: new FakeTokenizer(),
	modelId: 'test-model',
	modelMaxPromptTokens: 200_000,
	toolTokenCount: 0,
	...overrides,
});

describe('computeContextBreakdown', () => {
	it('returns zero segments + zero total when messages is empty', async () => {
		const breakdown = await computeContextBreakdown(baseInput({}));
		expect(breakdown.totalPromptTokens).toBe(0);
		expect(breakdown.modelId).toBe('test-model');
		expect(breakdown.modelMaxPromptTokens).toBe(200_000);
		const tokens = Object.fromEntries(breakdown.segments.map(s => [s.kind, s.tokens]));
		expect(tokens).toEqual({ system: 0, tools: 0, summary: 0, history: 0, current: 0 });
	});

	it('classifies a single user message as `current`', async () => {
		const breakdown = await computeContextBreakdown(baseInput({
			messages: [userMsg('hello world '.repeat(20))], // ~240 chars → ~60 tokens + 3 overhead
		}));
		const tokens = Object.fromEntries(breakdown.segments.map(s => [s.kind, s.tokens]));
		expect(tokens.current).toBeGreaterThan(0);
		expect(tokens.history).toBe(0);
	});

	it('treats earlier user messages as history, the latest as current', async () => {
		const breakdown = await computeContextBreakdown(baseInput({
			messages: [
				userMsg('first user turn '.repeat(10)),
				assistantMsg('first assistant reply '.repeat(10)),
				userMsg('second user turn '.repeat(10)),
				assistantMsg('second assistant reply '.repeat(10)),
				userMsg('third + latest user turn '.repeat(10)),
			],
		}));
		const tokens = Object.fromEntries(breakdown.segments.map(s => [s.kind, s.tokens]));
		// the latest user message is `current`; the rest land in history
		expect(tokens.current).toBeGreaterThan(0);
		expect(tokens.history).toBeGreaterThan(tokens.current);
	});

	it('classifies system messages independently from user/assistant', async () => {
		const breakdown = await computeContextBreakdown(baseInput({
			messages: [
				systemMsg('You are a helpful assistant. '.repeat(20)),
				userMsg('hi '.repeat(10)),
			],
		}));
		const tokens = Object.fromEntries(breakdown.segments.map(s => [s.kind, s.tokens]));
		expect(tokens.system).toBeGreaterThan(0);
		expect(tokens.history).toBe(0);
		expect(tokens.current).toBeGreaterThan(0);
	});

	it('respects pre-computed `toolTokenCount` instead of recomputing', async () => {
		const breakdown = await computeContextBreakdown(baseInput({
			messages: [userMsg('hi')],
			toolTokenCount: 12_345,
		}));
		const tokens = Object.fromEntries(breakdown.segments.map(s => [s.kind, s.tokens]));
		expect(tokens.tools).toBe(12_345);
	});

	it('carves `summary` out of `history` when summaryText is provided', async () => {
		const summaryText = 'Earlier we discussed the architecture. '.repeat(50); // ~1900 chars → ~475 tokens
		const inputWithoutSummary = baseInput({
			messages: [
				userMsg('first turn '.repeat(20)),
				assistantMsg('first reply '.repeat(20)),
				userMsg('latest user turn'),
			],
		});
		const inputWithSummary = baseInput({
			...inputWithoutSummary,
			summaryText,
		});
		const a = await computeContextBreakdown(inputWithoutSummary);
		const b = await computeContextBreakdown(inputWithSummary);
		const tokensA = Object.fromEntries(a.segments.map(s => [s.kind, s.tokens]));
		const tokensB = Object.fromEntries(b.segments.map(s => [s.kind, s.tokens]));
		expect(tokensB.summary).toBeGreaterThan(0);
		expect(tokensB.history).toBeLessThan(tokensA.history); // moved from history to summary
	});

	it('clamps history at 0 when summary is bigger than history', async () => {
		const breakdown = await computeContextBreakdown(baseInput({
			messages: [userMsg('hi')], // tiny history (zero, in fact — current only)
			summaryText: 'massive summary text '.repeat(500),
		}));
		const tokens = Object.fromEntries(breakdown.segments.map(s => [s.kind, s.tokens]));
		expect(tokens.history).toBe(0);
		expect(tokens.summary).toBeGreaterThan(0);
	});

	it('classifies tool messages as history', async () => {
		const breakdown = await computeContextBreakdown(baseInput({
			messages: [
				userMsg('please read foo.ts'),
				assistantMsg('Calling read_file…'),
				toolMsg('the file content '.repeat(20)),
				userMsg('thanks, now what?'),
			],
		}));
		const tokens = Object.fromEntries(breakdown.segments.map(s => [s.kind, s.tokens]));
		// tool message goes into history; the second user message is current
		expect(tokens.history).toBeGreaterThan(0);
		expect(tokens.current).toBeGreaterThan(0);
	});

	it('totalPromptTokens equals sum of all segments', async () => {
		const breakdown = await computeContextBreakdown(baseInput({
			messages: [
				systemMsg('system prompt body '.repeat(10)),
				userMsg('user one '.repeat(10)),
				assistantMsg('assistant one '.repeat(10)),
				userMsg('latest'),
			],
			toolTokenCount: 100,
			summaryText: 'summary text '.repeat(20),
		}));
		const sum = breakdown.segments.reduce((acc, s) => acc + s.tokens, 0);
		expect(sum).toBe(breakdown.totalPromptTokens);
	});

	it('survives a tokenizer that throws on a single message', async () => {
		class ThrowingTokenizer extends FakeTokenizer {
			override async countMessageTokens(message: Raw.ChatMessage): Promise<number> {
				if (message.role === Raw.ChatRole.System) {
					throw new Error('boom');
				}
				return super.countMessageTokens(message);
			}
		}
		const breakdown = await computeContextBreakdown(baseInput({
			messages: [
				systemMsg('this will throw'),
				userMsg('this will not'),
			],
			tokenizer: new ThrowingTokenizer(),
		}));
		const tokens = Object.fromEntries(breakdown.segments.map(s => [s.kind, s.tokens]));
		expect(tokens.system).toBe(0); // swallowed
		expect(tokens.current).toBeGreaterThan(0);
	});

	it('records computedAt within the test window', async () => {
		const before = Date.now();
		const breakdown = await computeContextBreakdown(baseInput({}));
		const after = Date.now();
		expect(breakdown.computedAt).toBeGreaterThanOrEqual(before);
		expect(breakdown.computedAt).toBeLessThanOrEqual(after);
	});
});

describe('formatTokens', () => {
	it('returns plain digits below 1000', () => {
		expect(formatTokens(0)).toBe('0');
		expect(formatTokens(1)).toBe('1');
		expect(formatTokens(999)).toBe('999');
	});

	it('shows one decimal between 1K and 9.9K', () => {
		expect(formatTokens(1_000)).toBe('1.0K');
		expect(formatTokens(1_234)).toBe('1.2K');
		expect(formatTokens(9_999)).toBe('10.0K');
	});

	it('rounds to whole K from 10K to 999K', () => {
		expect(formatTokens(10_000)).toBe('10K');
		expect(formatTokens(125_100)).toBe('125K');
		expect(formatTokens(999_999)).toBe('1000K');
	});

	it('shows one decimal in M for 1M+', () => {
		expect(formatTokens(1_000_000)).toBe('1.0M');
		expect(formatTokens(1_500_000)).toBe('1.5M');
	});
});

describe('contextPercent', () => {
	it('returns 0 when modelMaxPromptTokens is 0', () => {
		expect(contextPercent({ totalPromptTokens: 100, modelMaxPromptTokens: 0 })).toBe(0);
	});

	it('rounds to nearest integer', () => {
		expect(contextPercent({ totalPromptTokens: 50, modelMaxPromptTokens: 200 })).toBe(25);
		expect(contextPercent({ totalPromptTokens: 51, modelMaxPromptTokens: 200 })).toBe(26);
	});

	it('clamps at 100 when over budget', () => {
		expect(contextPercent({ totalPromptTokens: 300, modelMaxPromptTokens: 200 })).toBe(100);
	});

	it('clamps at 0 when negative', () => {
		expect(contextPercent({ totalPromptTokens: -50, modelMaxPromptTokens: 200 })).toBe(0);
	});
});
