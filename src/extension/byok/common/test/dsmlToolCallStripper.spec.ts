// ─── BYOK CUSTOM PATCH: tests for DSML tool-call stripper (Patch 58) ───
// Installed at: src/extension/byok/common/test/dsmlToolCallStripper.spec.ts
//
// Validates the streaming DSML parser used by DeepSeekBYOKLMProvider to
// work around DeepSeek V4's intermittent server-side bug where native
// DSML tool-call tokens leak into the `content` field instead of being
// parsed into structured `tool_calls`. See dsmlToolCallStripper.ts.
//
// ──────────────────────────────────────────────────────────────────────

import { describe, expect, it } from 'vitest';
import {
	DSML_TOOL_CALLS_CLOSE,
	DSML_TOOL_CALLS_OPEN,
	DsmlToolCallStripper,
	parseDsmlPayload,
} from '../dsmlToolCallStripper';

const FULL_DSML = [
	DSML_TOOL_CALLS_OPEN,
	'<\uFF5C\uFF5CDSML\uFF5C\uFF5Cinvoke name="read_file">',
	'<\uFF5C\uFF5CDSML\uFF5C\uFF5Cparameter name="filePath" string="true">/foo/bar.ts</\uFF5C\uFF5CDSML\uFF5C\uFF5Cparameter>',
	'<\uFF5C\uFF5CDSML\uFF5C\uFF5Cparameter name="startLine" string="false">1</\uFF5C\uFF5CDSML\uFF5C\uFF5Cparameter>',
	'<\uFF5C\uFF5CDSML\uFF5C\uFF5Cparameter name="endLine" string="false">120</\uFF5C\uFF5CDSML\uFF5C\uFF5Cparameter>',
	'</\uFF5C\uFF5CDSML\uFF5C\uFF5Cinvoke>',
	DSML_TOOL_CALLS_CLOSE,
].join('');

describe('parseDsmlPayload', () => {
	it('parses a single invoke with mixed string/non-string parameters', () => {
		const payload = [
			'<\uFF5C\uFF5CDSML\uFF5C\uFF5Cinvoke name="read_file">',
			'<\uFF5C\uFF5CDSML\uFF5C\uFF5Cparameter name="filePath" string="true">/foo/bar.ts</\uFF5C\uFF5CDSML\uFF5C\uFF5Cparameter>',
			'<\uFF5C\uFF5CDSML\uFF5C\uFF5Cparameter name="startLine" string="false">1</\uFF5C\uFF5CDSML\uFF5C\uFF5Cparameter>',
			'<\uFF5C\uFF5CDSML\uFF5C\uFF5Cparameter name="endLine" string="false">120</\uFF5C\uFF5CDSML\uFF5C\uFF5Cparameter>',
			'</\uFF5C\uFF5CDSML\uFF5C\uFF5Cinvoke>',
		].join('');
		const result = parseDsmlPayload(payload);
		expect(result).toEqual([
			{ name: 'read_file', args: { filePath: '/foo/bar.ts', startLine: 1, endLine: 120 } },
		]);
	});

	it('parses multiple parallel invocations', () => {
		const payload = [
			'<\uFF5C\uFF5CDSML\uFF5C\uFF5Cinvoke name="a"><\uFF5C\uFF5CDSML\uFF5C\uFF5Cparameter name="x" string="true">1</\uFF5C\uFF5CDSML\uFF5C\uFF5Cparameter></\uFF5C\uFF5CDSML\uFF5C\uFF5Cinvoke>',
			'<\uFF5C\uFF5CDSML\uFF5C\uFF5Cinvoke name="b"><\uFF5C\uFF5CDSML\uFF5C\uFF5Cparameter name="y" string="false">2</\uFF5C\uFF5CDSML\uFF5C\uFF5Cparameter></\uFF5C\uFF5CDSML\uFF5C\uFF5Cinvoke>',
			'<\uFF5C\uFF5CDSML\uFF5C\uFF5Cinvoke name="c"><\uFF5C\uFF5CDSML\uFF5C\uFF5Cparameter name="z" string="false">{"k":"v"}</\uFF5C\uFF5CDSML\uFF5C\uFF5Cparameter></\uFF5C\uFF5CDSML\uFF5C\uFF5Cinvoke>',
		].join('');
		const result = parseDsmlPayload(payload);
		expect(result).toEqual([
			{ name: 'a', args: { x: '1' } },
			{ name: 'b', args: { y: 2 } },
			{ name: 'c', args: { z: { k: 'v' } } },
		]);
	});

	it('treats string="false" with bogus JSON as a literal string', () => {
		const payload = '<\uFF5C\uFF5CDSML\uFF5C\uFF5Cinvoke name="t"><\uFF5C\uFF5CDSML\uFF5C\uFF5Cparameter name="p" string="false">not-json</\uFF5C\uFF5CDSML\uFF5C\uFF5Cparameter></\uFF5C\uFF5CDSML\uFF5C\uFF5Cinvoke>';
		const result = parseDsmlPayload(payload);
		expect(result).toEqual([{ name: 't', args: { p: 'not-json' } }]);
	});

	it('omits the string="..." attribute (defaults to string)', () => {
		const payload = '<\uFF5C\uFF5CDSML\uFF5C\uFF5Cinvoke name="t"><\uFF5C\uFF5CDSML\uFF5C\uFF5Cparameter name="p">hello</\uFF5C\uFF5CDSML\uFF5C\uFF5Cparameter></\uFF5C\uFF5CDSML\uFF5C\uFF5Cinvoke>';
		const result = parseDsmlPayload(payload);
		expect(result).toEqual([{ name: 't', args: { p: 'hello' } }]);
	});

	it('returns an empty array for an empty payload', () => {
		expect(parseDsmlPayload('')).toEqual([]);
	});
});

describe('DsmlToolCallStripper', () => {
	it('passes through plain text unchanged when no DSML appears', () => {
		const s = new DsmlToolCallStripper();
		const { text, calls } = s.process('Hello world, this is plain markdown.');
		const flush = s.flush();
		expect(text + flush.text).toBe('Hello world, this is plain markdown.');
		expect(calls).toEqual([]);
		expect(flush.calls).toEqual([]);
	});

	it('extracts a single tool call from a full DSML block in one chunk', () => {
		const s = new DsmlToolCallStripper();
		const { text, calls } = s.process(FULL_DSML);
		const flush = s.flush();
		expect(text + flush.text).toBe('');
		const all = [...calls, ...flush.calls];
		expect(all).toHaveLength(1);
		expect(all[0].name).toBe('read_file');
		expect(all[0].args).toEqual({ filePath: '/foo/bar.ts', startLine: 1, endLine: 120 });
		expect(all[0].id).toMatch(/^deepseek_dsml_\d+$/);
	});

	it('preserves leading text before the DSML block', () => {
		const s = new DsmlToolCallStripper();
		const { text, calls } = s.process('Let me read those files for you.\n\n' + FULL_DSML);
		const flush = s.flush();
		expect(text + flush.text).toBe('Let me read those files for you.\n\n');
		const all = [...calls, ...flush.calls];
		expect(all).toHaveLength(1);
	});

	it('preserves trailing text after the DSML block', () => {
		const s = new DsmlToolCallStripper();
		const { text, calls } = s.process(FULL_DSML + 'Done — let me know if you need more.');
		const flush = s.flush();
		expect(text + flush.text).toBe('Done — let me know if you need more.');
		const all = [...calls, ...flush.calls];
		expect(all).toHaveLength(1);
	});

	it('handles DSML markers split across chunk boundaries (one char at a time)', () => {
		const s = new DsmlToolCallStripper();
		const collectedText: string[] = [];
		const collectedCalls: string[] = [];
		const input = 'Hello ' + FULL_DSML + ' world';
		for (const ch of input) {
			const step = s.process(ch);
			collectedText.push(step.text);
			collectedCalls.push(...step.calls.map(c => c.name));
		}
		const flush = s.flush();
		collectedText.push(flush.text);
		collectedCalls.push(...flush.calls.map(c => c.name));
		expect(collectedText.join('')).toBe('Hello  world');
		expect(collectedCalls).toEqual(['read_file']);
	});

	it('handles split open marker — partial prefix is not emitted prematurely', () => {
		const s = new DsmlToolCallStripper();
		const half = DSML_TOOL_CALLS_OPEN.slice(0, 8);
		const rest = DSML_TOOL_CALLS_OPEN.slice(8);
		const r1 = s.process('prefix' + half);
		expect(r1.text).toBe('prefix');
		expect(r1.calls).toEqual([]);
		const r2 = s.process(rest + '<\uFF5C\uFF5CDSML\uFF5C\uFF5Cinvoke name="t"></\uFF5C\uFF5CDSML\uFF5C\uFF5Cinvoke>' + DSML_TOOL_CALLS_CLOSE + 'after');
		const flush = s.flush();
		expect(r2.text + flush.text).toBe('after');
		expect([...r2.calls, ...flush.calls].map(c => c.name)).toEqual(['t']);
	});

	it('extracts multiple parallel invocations in one DSML block', () => {
		const payload = [
			DSML_TOOL_CALLS_OPEN,
			'<\uFF5C\uFF5CDSML\uFF5C\uFF5Cinvoke name="alpha"><\uFF5C\uFF5CDSML\uFF5C\uFF5Cparameter name="a" string="false">1</\uFF5C\uFF5CDSML\uFF5C\uFF5Cparameter></\uFF5C\uFF5CDSML\uFF5C\uFF5Cinvoke>',
			'<\uFF5C\uFF5CDSML\uFF5C\uFF5Cinvoke name="beta"><\uFF5C\uFF5CDSML\uFF5C\uFF5Cparameter name="b" string="false">2</\uFF5C\uFF5CDSML\uFF5C\uFF5Cparameter></\uFF5C\uFF5CDSML\uFF5C\uFF5Cinvoke>',
			DSML_TOOL_CALLS_CLOSE,
		].join('');
		const s = new DsmlToolCallStripper();
		const { text, calls } = s.process(payload);
		const flush = s.flush();
		expect(text + flush.text).toBe('');
		const all = [...calls, ...flush.calls];
		expect(all.map(c => c.name)).toEqual(['alpha', 'beta']);
		expect(all.map(c => c.args)).toEqual([{ a: 1 }, { b: 2 }]);
		expect(new Set(all.map(c => c.id)).size).toBe(2);
	});

	it('flushes residual DSML payload best-effort when the stream ends mid-block', () => {
		const s = new DsmlToolCallStripper();
		const truncated = DSML_TOOL_CALLS_OPEN + '<\uFF5C\uFF5CDSML\uFF5C\uFF5Cinvoke name="x"><\uFF5C\uFF5CDSML\uFF5C\uFF5Cparameter name="p" string="true">hello</\uFF5C\uFF5CDSML\uFF5C\uFF5Cparameter></\uFF5C\uFF5CDSML\uFF5C\uFF5Cinvoke>';
		const r1 = s.process(truncated);
		expect(r1.text).toBe('');
		expect(r1.calls).toEqual([]);
		const flush = s.flush();
		expect(flush.calls.map(c => c.name)).toEqual(['x']);
		expect(flush.calls[0].args).toEqual({ p: 'hello' });
	});

	it('handles a "<" character that is not part of a DSML marker', () => {
		const s = new DsmlToolCallStripper();
		const r1 = s.process('a < b and c > d, then more text');
		const flush = s.flush();
		expect(r1.text + flush.text).toBe('a < b and c > d, then more text');
		expect([...r1.calls, ...flush.calls]).toEqual([]);
	});

	it('handles multiple separate DSML blocks in one stream', () => {
		const single = (name: string, val: string) =>
			DSML_TOOL_CALLS_OPEN +
			'<\uFF5C\uFF5CDSML\uFF5C\uFF5Cinvoke name="' + name + '"><\uFF5C\uFF5CDSML\uFF5C\uFF5Cparameter name="p" string="true">' + val + '</\uFF5C\uFF5CDSML\uFF5C\uFF5Cparameter></\uFF5C\uFF5CDSML\uFF5C\uFF5Cinvoke>' +
			DSML_TOOL_CALLS_CLOSE;
		const s = new DsmlToolCallStripper();
		const r1 = s.process(single('first', 'one') + 'middle text ' + single('second', 'two'));
		const flush = s.flush();
		expect(r1.text + flush.text).toBe('middle text ');
		const all = [...r1.calls, ...flush.calls];
		expect(all.map(c => c.name)).toEqual(['first', 'second']);
		expect(all.map(c => c.id)).toEqual(['deepseek_dsml_1', 'deepseek_dsml_2']);
	});

	it('mints unique sequential ids per stripper instance', () => {
		const s1 = new DsmlToolCallStripper();
		const s2 = new DsmlToolCallStripper();
		const r1 = s1.process(FULL_DSML);
		const r2 = s2.process(FULL_DSML);
		expect(r1.calls[0].id).toBe('deepseek_dsml_1');
		expect(r2.calls[0].id).toBe('deepseek_dsml_1');
	});

	it('respects a custom id prefix', () => {
		const s = new DsmlToolCallStripper('custom_pfx');
		const { calls } = s.process(FULL_DSML);
		expect(calls[0].id).toBe('custom_pfx_1');
	});

	it('passes through arbitrary "<" characters without buffering indefinitely', () => {
		const s = new DsmlToolCallStripper();
		const chunks = ['Some text with < ', 'and more < text here'];
		const collected: string[] = [];
		for (const ch of chunks) {
			collected.push(s.process(ch).text);
		}
		collected.push(s.flush().text);
		expect(collected.join('')).toBe('Some text with < and more < text here');
	});
});
