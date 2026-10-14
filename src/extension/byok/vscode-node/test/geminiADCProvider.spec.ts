/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { ApiError, type GoogleGenAIOptions } from '@google/genai';
import type { GoogleAuthOptions } from 'google-auth-library';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NoopOTelService, resolveOTelConfig } from '../../../../platform/otel/common/index';
import { NullRequestLogger } from '../../../../platform/requestLogger/node/nullRequestLogger';
import { NullTelemetryService } from '../../../../platform/telemetry/common/nullTelemetryService';
import { TestLogService } from '../../../../platform/testing/common/testLogService';
import { CancellationToken } from '../../../../util/vs/base/common/cancellation';
import type { IBYOKStorageService } from '../byokStorageService';
import { GeminiADCLMProvider } from '../geminiADCProvider';

const mocks = vi.hoisted(() => ({
	authOptions: [] as GoogleAuthOptions[],
	clientOptions: [] as GoogleGenAIOptions[],
	getAccessToken: vi.fn(),
	listModels: vi.fn(),
}));

vi.mock('google-auth-library', async importOriginal => {
	class MockGoogleAuth {
		constructor(options: GoogleAuthOptions) { mocks.authOptions.push(options); }
		getAccessToken = mocks.getAccessToken;
	}
	return { ...await importOriginal<typeof import('google-auth-library')>(), GoogleAuth: MockGoogleAuth };
});

vi.mock('@google/genai', async importOriginal => {
	class MockGoogleGenAI {
		constructor(options: GoogleGenAIOptions) { mocks.clientOptions.push(options); }
		models = { list: mocks.listModels };
	}
	return { ...await importOriginal<typeof import('@google/genai')>(), GoogleGenAI: MockGoogleGenAI };
});

class MockBYOKStorageService implements IBYOKStorageService {
	getAPIKey = vi.fn().mockResolvedValue(undefined);
	storeAPIKey = vi.fn().mockResolvedValue(undefined);
	deleteAPIKey = vi.fn().mockResolvedValue(undefined);
	getStoredModelConfigs = vi.fn().mockResolvedValue({});
	saveModelConfig = vi.fn().mockResolvedValue(undefined);
	removeModelConfig = vi.fn().mockResolvedValue(undefined);
}

class TestGeminiADCProvider extends GeminiADCLMProvider {
	discover(apiKey: string) { return this.getAllModels(false, apiKey); }
}

describe('Gemini ADC model discovery', () => {
	let provider: TestGeminiADCProvider;

	beforeEach(() => {
		vi.clearAllMocks();
		mocks.authOptions.length = 0;
		mocks.clientOptions.length = 0;
		mocks.getAccessToken.mockResolvedValue('test-access-token');
		mocks.listModels.mockImplementation(async () => (async function* () {
			yield { name: 'models/gemini-3.8-flash', displayName: 'Gemini 3.8 Flash', supportedActions: ['generateContent'] };
		})());
		provider = new TestGeminiADCProvider(undefined, new MockBYOKStorageService(), new TestLogService(), new NullRequestLogger(), new NullTelemetryService(),
			new NoopOTelService(resolveOTelConfig({ env: {}, extensionVersion: 'test', sessionId: 'test' })));
	});

	it('does not attempt authentication when no provider group is configured', async () => {
		expect(await provider.provideLanguageModelChatInformation({ silent: false }, CancellationToken.None)).toEqual([]);
		expect(mocks.getAccessToken).not.toHaveBeenCalled();
	});

	it('discovers models for a blank credential group using system ADC', async () => {
		vi.useFakeTimers();
		try {
			const models = await provider.provideLanguageModelChatInformation({ silent: false, configuration: {} }, CancellationToken.None);
			expect(models).toHaveLength(1);
			expect(models[0].configuration?.apiKey).toBe('adc');
			expect(mocks.clientOptions[0].httpOptions?.headers?.Authorization).toBe('Bearer test-access-token');
			expect(mocks.authOptions[0].scopes).toContain('https://www.googleapis.com/auth/generative-language');
			expect(vi.getTimerCount()).toBe(0);
		} finally {
			vi.useRealTimers();
		}
	});

	it('uses the configured quota project for billing', async () => {
		await provider.discover('test-billing-project');
		expect(mocks.clientOptions[0].httpOptions?.headers?.['x-goog-user-project']).toBe('test-billing-project');
	});

	it('keeps separate credentials and quota projects for service account groups', async () => {
		for (const project of ['first-project', 'second-project']) {
			await provider.discover(JSON.stringify({ type: 'service_account', project_id: project, client_email: `test@${project}.iam.gserviceaccount.com` }));
		}
		expect(mocks.authOptions).toHaveLength(2);
		expect(mocks.clientOptions.map(options => options.httpOptions?.headers?.['x-goog-user-project'])).toEqual(['first-project', 'second-project']);
	});

	it('does not misdiagnose an API permission error as insufficient OAuth scopes', async () => {
		mocks.listModels.mockRejectedValue(new ApiError({ status: 403, message: JSON.stringify({ error: {
			status: 'PERMISSION_DENIED', message: 'Generative Language API is disabled for this project.',
		} }) }));
		await expect(provider.discover('test-project')).rejects.toThrow('Generative Language API is disabled for this project.');
	});

	it('reports billing failures during ADC discovery as payment errors', async () => {
		mocks.listModels.mockRejectedValue(new ApiError({ status: 402, message: JSON.stringify({ error: {
			code: 402, status: 'RESOURCE_EXHAUSTED', message: 'Your prepayment credits are depleted.',
		} }) }));
		await expect(provider.discover('test-project')).rejects.toThrow('Gemini API payment required (HTTP 402)');
	});

	it('recognizes an insufficient scope reason after other error details', async () => {
		mocks.listModels.mockRejectedValue(new ApiError({ status: 403, message: JSON.stringify({ error: {
			status: 'PERMISSION_DENIED', message: 'Insufficient scopes.', details: [{ reason: 'OTHER_DETAIL' }, { reason: 'ACCESS_TOKEN_SCOPE_INSUFFICIENT' }],
		} }) }));
		await expect(provider.discover('test-project')).rejects.toThrow('Insufficient OAuth scopes');
	});
});
