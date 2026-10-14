/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { GoogleGenAIOptions } from '@google/genai';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ConfigKey, IConfigurationService } from '../../../../platform/configuration/common/configurationService';
import { CancellationToken } from '../../../../util/vs/base/common/cancellation';
import { DisposableStore } from '../../../../util/vs/base/common/lifecycle';
import { IInstantiationService } from '../../../../util/vs/platform/instantiation/common/instantiation';
import { createExtensionUnitTestingServices } from '../../../test/node/services';
import type { ExtendedLanguageModelChatInformation } from '../abstractLanguageModelChatProvider';
import type { IBYOKStorageService } from '../byokStorageService';
import { VertexGeminiLMProvider, type VertexGeminiProviderConfig } from '../vertexGeminiProvider';

const mocks = vi.hoisted(() => ({ clientOptions: [] as GoogleGenAIOptions[] }));
vi.mock('@google/genai', async importOriginal => {
	class MockGoogleGenAI {
		constructor(options: GoogleGenAIOptions) { mocks.clientOptions.push(options); }
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

class TestVertexGeminiProvider extends VertexGeminiLMProvider {
	clientForModel(model: ExtendedLanguageModelChatInformation<VertexGeminiProviderConfig>, credential = model.configuration?.apiKey ?? 'adc') {
		return this.createClient(credential, model);
	}
}

describe('Vertex Gemini authentication and model configuration', () => {
	const disposables = new DisposableStore();
	const credentialFile = '/test/gcloud/adc.json';
	let provider: TestVertexGeminiProvider;
	let configuration: IConfigurationService;

	beforeEach(async () => {
		mocks.clientOptions.length = 0;
		const services = disposables.add(createExtensionUnitTestingServices());
		const accessor = disposables.add(services.createTestingAccessor());
		configuration = accessor.get(IConfigurationService);
		await configuration.setConfig(ConfigKey.VertexGeminiModels, {
			'gemini-3.8-flash': { name: 'Gemini 3.8 Flash (Vertex)', projectId: 'test-project', locationId: 'global' },
		});
		provider = accessor.get(IInstantiationService).createInstance(TestVertexGeminiProvider, undefined, new MockBYOKStorageService());
	});
	afterEach(() => disposables.clear());

	async function modelForCredential(apiKey: string) {
		const models = await provider.provideLanguageModelChatInformation({ silent: false, configuration: { apiKey } }, CancellationToken.None);
		expect(models).toHaveLength(1);
		return models[0];
	}

	it('uses a model discovered from global settings after the group configuration is attached', async () => {
		const model = await modelForCredential(credentialFile);
		provider.clientForModel(model);
		expect(mocks.clientOptions[0]).toMatchObject({
			vertexai: true, project: 'test-project', location: 'global',
			httpOptions: { headers: { 'x-goog-user-project': 'test-project' } },
			googleAuthOptions: { keyFilename: credentialFile, scopes: ['https://www.googleapis.com/auth/cloud-platform'] },
		});
		expect(mocks.clientOptions[0].apiKey).toBeUndefined();
	});

	it('loads system ADC when the credential is adc', async () => {
		provider.clientForModel(await modelForCredential('adc'));
		expect(mocks.clientOptions[0].googleAuthOptions).toMatchObject({ projectId: 'test-project', scopes: ['https://www.googleapis.com/auth/cloud-platform'] });
		expect(mocks.clientOptions[0].googleAuthOptions?.keyFilename).toBeUndefined();
	});

	it('preserves inline authorized-user credentials and selects Vertex AI', async () => {
		const credentials = { type: 'authorized_user', client_id: 'test-client', client_secret: 'test-secret', refresh_token: 'test-refresh-token' };
		provider.clientForModel(await modelForCredential(JSON.stringify(credentials)));
		expect(mocks.clientOptions[0].googleAuthOptions?.credentials).toEqual(credentials);
		expect(mocks.clientOptions[0].vertexai).toBe(true);
	});

	it('preserves support for a supplied bearer token', async () => {
		provider.clientForModel(await modelForCredential('test-access-token'));
		expect(mocks.clientOptions[0].httpOptions?.headers).toMatchObject({
			Authorization: 'Bearer test-access-token', 'x-goog-user-project': 'test-project',
		});
	});

	it('uses per-group model settings ahead of global settings', async () => {
		const models = await provider.provideLanguageModelChatInformation({ silent: false, configuration: {
			apiKey: credentialFile,
			models: [{ id: 'gemini-3.8-flash', name: 'Group model', projectId: 'group-project', locationId: 'europe-west4' }],
		} }, CancellationToken.None);
		provider.clientForModel(models[0]);
		expect(mocks.clientOptions[0]).toMatchObject({ project: 'group-project', location: 'europe-west4' });
	});
});
