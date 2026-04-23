/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CancellationToken, LanguageModelChatMessage, LanguageModelChatMessage2, LanguageModelResponsePart2, PrepareLanguageModelChatModelOptions, Progress, ProvideLanguageModelChatResponseOptions } from 'vscode';
import { NullTelemetryService } from '../../../../platform/telemetry/common/nullTelemetryService';
import { TestLogService } from '../../../../platform/testing/common/testLogService';
import type { IBYOKStorageService } from '../byokStorageService';
import {
	AbstractLanguageModelChatProvider,
	type ExtendedLanguageModelChatInformation,
	type LanguageModelChatConfiguration,
} from '../abstractLanguageModelChatProvider';

type TestModel = ExtendedLanguageModelChatInformation<LanguageModelChatConfiguration>;

// Minimal concrete provider that only exercises `getAllModels`. We count
// invocations so the spec can assert that the Patch 42 cache really does
// short-circuit repeated `provideLanguageModelChatInformation` calls.
class CountingProvider extends AbstractLanguageModelChatProvider<LanguageModelChatConfiguration, TestModel> {
	public calls = 0;
	public nextError: Error | undefined;
	public resolveWith: TestModel[] = [];

	constructor(id = 'testvendor', logService = new TestLogService()) {
		const storage: IBYOKStorageService = {
			getAPIKey: async () => undefined,
			setAPIKey: async () => { },
			deleteAPIKey: async () => { },
		} as unknown as IBYOKStorageService;
		super(id, 'TestVendor', {}, storage, logService);
	}

	protected async getAllModels(_silent: boolean, _apiKey: string | undefined): Promise<TestModel[]> {
		this.calls++;
		if (this.nextError) {
			const err = this.nextError;
			this.nextError = undefined;
			throw err;
		}
		return this.resolveWith;
	}

	async provideLanguageModelChatResponse(_m: TestModel, _ms: Array<LanguageModelChatMessage | LanguageModelChatMessage2>, _o: ProvideLanguageModelChatResponseOptions, _p: Progress<LanguageModelResponsePart2>, _t: CancellationToken): Promise<void> { }
	async provideTokenCount(): Promise<number> { return 0; }
}

const opts = (overrides: Partial<PrepareLanguageModelChatModelOptions> = {}): PrepareLanguageModelChatModelOptions => ({
	silent: true,
	...overrides,
} as PrepareLanguageModelChatModelOptions);

const cancel: CancellationToken = { isCancellationRequested: false, onCancellationRequested: () => ({ dispose() { } }) } as unknown as CancellationToken;

describe('AbstractLanguageModelChatProvider.provideLanguageModelChatInformation (Patch 42 cache)', () => {
	let now = 0;
	let dateSpy: ReturnType<typeof vi.spyOn>;

	beforeEach(() => {
		now = 1_700_000_000_000;
		dateSpy = vi.spyOn(Date, 'now').mockImplementation(() => now);
	});

	afterEach(() => {
		dateSpy.mockRestore();
	});

	// NullTelemetryService is unused but imported for the side-effect of
	// proving the spec file compiles against the real dependency graph.
	void new NullTelemetryService();

	it('caches the result of a successful getAllModels for 24h so picker refresh storms do not hammer the vendor', async () => {
		const p = new CountingProvider();
		p.resolveWith = [{ id: 'm1', name: 'M1' } as TestModel];

		await p.provideLanguageModelChatInformation(opts({ configuration: { apiKey: 'k' } as LanguageModelChatConfiguration }), cancel);
		await p.provideLanguageModelChatInformation(opts({ configuration: { apiKey: 'k' } as LanguageModelChatConfiguration }), cancel);
		await p.provideLanguageModelChatInformation(opts({ configuration: { apiKey: 'k' } as LanguageModelChatConfiguration }), cancel);

		expect(p.calls).toBe(1);
	});

	it('refetches after the 24h TTL elapses', async () => {
		const p = new CountingProvider();
		p.resolveWith = [{ id: 'm1', name: 'M1' } as TestModel];

		await p.provideLanguageModelChatInformation(opts({ configuration: { apiKey: 'k' } as LanguageModelChatConfiguration }), cancel);
		now += 24 * 60 * 60 * 1000 + 1;
		await p.provideLanguageModelChatInformation(opts({ configuration: { apiKey: 'k' } as LanguageModelChatConfiguration }), cancel);

		expect(p.calls).toBe(2);
	});

	it('invalidates when the apiKey changes (rotation)', async () => {
		const p = new CountingProvider();
		p.resolveWith = [{ id: 'm1', name: 'M1' } as TestModel];

		await p.provideLanguageModelChatInformation(opts({ configuration: { apiKey: 'key-v1' } as LanguageModelChatConfiguration }), cancel);
		await p.provideLanguageModelChatInformation(opts({ configuration: { apiKey: 'key-v2' } as LanguageModelChatConfiguration }), cancel);

		expect(p.calls).toBe(2);
	});

	it('coalesces parallel refreshes so N concurrent callers trigger exactly one getAllModels call', async () => {
		const p = new CountingProvider();
		let release!: (v: TestModel[]) => void;
		const gate = new Promise<TestModel[]>(r => { release = r; });
		// Override to respect the gate.
		(p as unknown as { getAllModels: typeof p['getAllModels'] }).getAllModels = async () => {
			p.calls++;
			return gate;
		};

		const calls = [
			p.provideLanguageModelChatInformation(opts({ configuration: { apiKey: 'k' } as LanguageModelChatConfiguration }), cancel),
			p.provideLanguageModelChatInformation(opts({ configuration: { apiKey: 'k' } as LanguageModelChatConfiguration }), cancel),
			p.provideLanguageModelChatInformation(opts({ configuration: { apiKey: 'k' } as LanguageModelChatConfiguration }), cancel),
		];
		release([{ id: 'm1', name: 'M1' } as TestModel]);
		await Promise.all(calls);

		expect(p.calls).toBe(1);
	});

	it('negative-caches errors for 30s so a 429 storm does not become a retry storm', async () => {
		const p = new CountingProvider();
		p.nextError = new Error('RESOURCE_EXHAUSTED');

		await expect(p.provideLanguageModelChatInformation(opts({ configuration: { apiKey: 'k' } as LanguageModelChatConfiguration }), cancel)).rejects.toThrow('RESOURCE_EXHAUSTED');
		// Second call within 30s must hit the negative cache, not the network.
		p.nextError = new Error('should-not-be-called');
		await expect(p.provideLanguageModelChatInformation(opts({ configuration: { apiKey: 'k' } as LanguageModelChatConfiguration }), cancel)).rejects.toThrow('RESOURCE_EXHAUSTED');

		expect(p.calls).toBe(1);
	});

	it('retries after the 30s negative-cache window elapses', async () => {
		const p = new CountingProvider();
		p.nextError = new Error('RESOURCE_EXHAUSTED');

		await expect(p.provideLanguageModelChatInformation(opts({ configuration: { apiKey: 'k' } as LanguageModelChatConfiguration }), cancel)).rejects.toThrow('RESOURCE_EXHAUSTED');

		now += 31_000;
		p.resolveWith = [{ id: 'm1', name: 'M1' } as TestModel];
		const res = await p.provideLanguageModelChatInformation(opts({ configuration: { apiKey: 'k' } as LanguageModelChatConfiguration }), cancel);

		expect(p.calls).toBe(2);
		expect(res).toHaveLength(1);
	});
});
