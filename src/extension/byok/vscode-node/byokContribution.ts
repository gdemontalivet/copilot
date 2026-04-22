/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import { LanguageModelChatInformation, LanguageModelChatProvider, lm } from 'vscode';
import { IAuthenticationService } from '../../../platform/authentication/common/authentication';
import { ICAPIClientService } from '../../../platform/endpoint/common/capiClient';
import { IVSCodeExtensionContext } from '../../../platform/extContext/common/extensionContext';
import { ILogService } from '../../../platform/log/common/logService';
import { IFetcherService } from '../../../platform/networking/common/fetcherService';
import { Disposable, DisposableStore } from '../../../util/vs/base/common/lifecycle';
import { IInstantiationService } from '../../../util/vs/platform/instantiation/common/instantiation';
import { BYOKKnownModels, isBYOKEnabled } from '../../byok/common/byokProvider';
import { IExtensionContribution } from '../../common/contributions';
import { AnthropicLMProvider } from './anthropicProvider';
import { AzureBYOKModelProvider } from './azureProvider';
import { BYOKAutoLMProvider } from './byokAutoProvider';
import { BYOKStorageService, IBYOKStorageService } from './byokStorageService';
import { CustomOAIBYOKModelProvider } from './customOAIProvider';
import { GeminiNativeBYOKLMProvider } from './geminiNativeProvider';
import { OllamaLMProvider } from './ollamaProvider';
import { OAIBYOKLMProvider } from './openAIProvider';
import { OpenRouterLMProvider } from './openRouterProvider';
import { VertexAnthropicLMProvider } from './vertexAnthropicProvider';
import { VertexGeminiLMProvider } from './vertexGeminiProvider';
import { XAIBYOKLMProvider } from './xAIProvider';

export class BYOKContrib extends Disposable implements IExtensionContribution {
	public readonly id: string = 'byok-contribution';
	private readonly _byokStorageService: IBYOKStorageService;
	private readonly _providers: Map<string, LanguageModelChatProvider<LanguageModelChatInformation>> = new Map();
	private readonly _byokRegistrations = this._register(new DisposableStore());
	private _byokProvidersRegistered = false;

	constructor(
		@IFetcherService private readonly _fetcherService: IFetcherService,
		@ILogService private readonly _logService: ILogService,
		@ICAPIClientService private readonly _capiClientService: ICAPIClientService,
		@IVSCodeExtensionContext extensionContext: IVSCodeExtensionContext,
		@IAuthenticationService authService: IAuthenticationService,
		@IInstantiationService private readonly _instantiationService: IInstantiationService,
	) {
		super();
		this._byokStorageService = new BYOKStorageService(extensionContext);
		this._authChange(authService, this._instantiationService);

		this._register(authService.onDidAuthenticationChange(() => {
			this._authChange(authService, this._instantiationService);
		}));
	}

	private async _authChange(authService: IAuthenticationService, instantiationService: IInstantiationService) {
		const byokEnabled = authService.copilotToken && isBYOKEnabled(authService.copilotToken, this._capiClientService);

		if (!byokEnabled && this._byokProvidersRegistered) {
			this._logService.info('BYOK: Disabling BYOK providers due to account change.');
			this._byokRegistrations.clear();
			this._providers.clear();
			this._byokProvidersRegistered = false;
			return;
		}

		if (byokEnabled && !this._byokProvidersRegistered) {
			this._byokProvidersRegistered = true;
			// Update known models list from CDN so all providers have the same list
			const knownModels = await this.fetchKnownModelList(this._fetcherService);
			if (this._store.isDisposed) {
				return;
			}
			this._providers.set(OllamaLMProvider.providerName.toLowerCase(), instantiationService.createInstance(OllamaLMProvider, this._byokStorageService));
			const anthropicProvider = instantiationService.createInstance(AnthropicLMProvider, knownModels[AnthropicLMProvider.providerName], this._byokStorageService);
			this._providers.set(AnthropicLMProvider.providerName.toLowerCase(), anthropicProvider);
			// BYOK CUSTOM PATCH: Vertex-hosted Anthropic, registered as a separate vendor so it has
			// independent API key / quota / concurrency state. Also wired as a failover target for
			// the direct Anthropic provider (gated by chat.byok.anthropic.fallback.enabled).
			const vertexAnthropicProvider = instantiationService.createInstance(VertexAnthropicLMProvider, knownModels[AnthropicLMProvider.providerName], this._byokStorageService);
			this._providers.set(VertexAnthropicLMProvider.providerName.toLowerCase(), vertexAnthropicProvider);
			anthropicProvider.setFailoverTarget(vertexAnthropicProvider);
			this._providers.set(GeminiNativeBYOKLMProvider.providerName.toLowerCase(), instantiationService.createInstance(GeminiNativeBYOKLMProvider, knownModels[GeminiNativeBYOKLMProvider.providerName], this._byokStorageService));
			// BYOK CUSTOM PATCH: Vertex-hosted Gemini, registered as a separate vendor so it has
			// independent API key / quota state. Auth is SA-JSON or pre-minted Bearer token, not
			// the Gemini public-API apiKey.
			this._providers.set(VertexGeminiLMProvider.providerName.toLowerCase(), instantiationService.createInstance(VertexGeminiLMProvider, knownModels[GeminiNativeBYOKLMProvider.providerName], this._byokStorageService));
			this._providers.set(XAIBYOKLMProvider.providerName.toLowerCase(), instantiationService.createInstance(XAIBYOKLMProvider, knownModels[XAIBYOKLMProvider.providerName], this._byokStorageService));
			this._providers.set(OAIBYOKLMProvider.providerName.toLowerCase(), instantiationService.createInstance(OAIBYOKLMProvider, knownModels[OAIBYOKLMProvider.providerName], this._byokStorageService));
			this._providers.set(OpenRouterLMProvider.providerName.toLowerCase(), instantiationService.createInstance(OpenRouterLMProvider, this._byokStorageService));
			this._providers.set(AzureBYOKModelProvider.providerName.toLowerCase(), instantiationService.createInstance(AzureBYOKModelProvider, this._byokStorageService));
			this._providers.set(CustomOAIBYOKModelProvider.providerName.toLowerCase(), instantiationService.createInstance(CustomOAIBYOKModelProvider, this._byokStorageService));

			// ─── BYOK CUSTOM PATCH: BYOK Auto provider (Patch 34) ─────────────
			// Preserved by .github/scripts/apply-byok-patches.sh. Do not remove.
			// Upstream's `copilot/auto` pseudo-model hits CAPI with the Copilot
			// token to pick a real model — that flow dies under the BYOK
			// fake-token bypass and surfaces as "Language model unavailable".
			// Register a BYOK-native Auto provider that delegates to whichever
			// model the user configures in `chat.byok.auto.defaultModel`.
			// See byokAutoProvider.ts for the full rationale.
			this._providers.set(
				BYOKAutoLMProvider.vendorId,
				instantiationService.createInstance(BYOKAutoLMProvider),
			);
			// ─── END BYOK CUSTOM PATCH ──────────────────────────────

			for (const [providerName, provider] of this._providers) {
				this._byokRegistrations.add(lm.registerLanguageModelChatProvider(providerName, provider));
			}
		}
	}
	private async fetchKnownModelList(fetcherService: IFetcherService): Promise<Record<string, BYOKKnownModels>> {
		const data = await (await fetcherService.fetch('https://main.vscode-cdn.net/extensions/copilotChat.json', { method: 'GET', callSite: 'byok-known-models' })).json();
		// Use this for testing with changes from a local file. Don't check in
		// const data = JSON.parse((await this._fileSystemService.readFile(URI.file('/Users/roblou/code/vscode-engineering/chat/copilotChat.json'))).toString());
		let knownModels: Record<string, BYOKKnownModels>;
		if (data.version !== 1) {
			this._logService.warn('BYOK: Copilot Chat known models list is not in the expected format. Defaulting to empty list.');
			knownModels = {};
		} else {
			knownModels = data.modelInfo;
		}
		this._logService.info('BYOK: Copilot Chat known models list fetched successfully.');
		return knownModels;
	}
}