/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import { LanguageModelChatInformation, LanguageModelChatProvider, lm } from 'vscode';
import { IAuthenticationService } from '../../../platform/authentication/common/authentication';
import { IVSCodeExtensionContext } from '../../../platform/extContext/common/extensionContext';
import { ILogService } from '../../../platform/log/common/logService';
import { IFetcherService } from '../../../platform/networking/common/fetcherService';
import { Disposable, DisposableStore } from '../../../util/vs/base/common/lifecycle';
import { IInstantiationService } from '../../../util/vs/platform/instantiation/common/instantiation';
import { BYOKKnownModels, isClientBYOKAllowed } from '../../byok/common/byokProvider';
import { IExtensionContribution } from '../../common/contributions';
import { AbstractLanguageModelChatProvider } from './abstractLanguageModelChatProvider';
import { AnthropicLMProvider } from './anthropicProvider';
import { AzureBYOKModelProvider } from './azureProvider';
import { BYOKAutoLMProvider } from './byokAutoProvider';
import { BYOKStorageService, IBYOKStorageService } from './byokStorageService';
import { CustomEndpointBYOKModelProvider } from './customEndpointProvider';
import { CustomOAIBYOKModelProvider } from './customOAIProvider';
import { GeminiNativeBYOKLMProvider } from './geminiNativeProvider';
import { OllamaLMProvider } from './ollamaProvider';
import { OAIBYOKLMProvider } from './openAIProvider';
import { OpenRouterLMProvider } from './openRouterProvider';
import { VertexAnthropicLMProvider } from './vertexAnthropicProvider';
import { VertexGeminiLMProvider } from './vertexGeminiProvider';
import { VertexAnthropicLMProvider } from './vertexAnthropicProvider';
import { XAIBYOKLMProvider } from './xAIProvider';
import { DeepSeekBYOKLMProvider } from './deepseekProvider';
import { DeepSeekBYOKLMProvider } from './deepseekProvider';

export class BYOKContrib extends Disposable implements IExtensionContribution {
	public readonly id: string = 'byok-contribution';
	private readonly _byokStorageService: IBYOKStorageService;
	private readonly _providers: Map<string, LanguageModelChatProvider<LanguageModelChatInformation>> = new Map();
	private readonly _providerRegistrations = this._register(new DisposableStore());
	private _providersRegistered = false;
	private _knownModelsRefreshed = false;
	private _knownModelsRefreshTargets: ReadonlyArray<readonly [string, AbstractLanguageModelChatProvider]> = [];

	constructor(
		@IFetcherService private readonly _fetcherService: IFetcherService,
		@ILogService private readonly _logService: ILogService,
		@IVSCodeExtensionContext extensionContext: IVSCodeExtensionContext,
		@IAuthenticationService private readonly _authService: IAuthenticationService,
		@IInstantiationService private readonly _instantiationService: IInstantiationService,
	) {
		super();
		this._byokStorageService = new BYOKStorageService(extensionContext);
		this._applyPolicy();
		this._register(this._authService.onDidAuthenticationChange(() => this._applyPolicy()));
	}

	private _buildProviders(): void {
		const instantiationService = this._instantiationService;

		const anthropic = instantiationService.createInstance(AnthropicLMProvider, undefined, this._byokStorageService);
		const gemini = instantiationService.createInstance(GeminiNativeBYOKLMProvider, undefined, this._byokStorageService);
		const xai = instantiationService.createInstance(XAIBYOKLMProvider, {}, this._byokStorageService);
		const openai = instantiationService.createInstance(OAIBYOKLMProvider, {}, this._byokStorageService);

		this._providers.set(OllamaLMProvider.providerId, instantiationService.createInstance(OllamaLMProvider, this._byokStorageService));
		this._providers.set(AnthropicLMProvider.providerId, anthropic);
		// BYOK CUSTOM PATCH: Vertex-hosted Anthropic, registered as a separate vendor so it has
		// independent API key / quota / concurrency state. Also wired as a failover target for
		// the direct Anthropic provider (gated by chat.byok.anthropic.fallback.enabled).
		const vertexAnthropicProvider = instantiationService.createInstance(VertexAnthropicLMProvider, undefined, this._byokStorageService);
		this._providers.set(VertexAnthropicLMProvider.providerName.toLowerCase(), vertexAnthropicProvider);
		anthropic.setFailoverTarget(vertexAnthropicProvider);
		this._providers.set(GeminiNativeBYOKLMProvider.providerId, gemini);
		// BYOK CUSTOM PATCH: Vertex-hosted Gemini, registered as a separate vendor so it has
		// independent API key / quota state. Auth is SA-JSON or pre-minted Bearer token, not
		// the Gemini public-API apiKey.
		this._providers.set(VertexGeminiLMProvider.providerName.toLowerCase(), instantiationService.createInstance(VertexGeminiLMProvider, undefined, this._byokStorageService));
		this._providers.set(XAIBYOKLMProvider.providerId, xai);
		// BYOK CUSTOM PATCH: DeepSeek provider registration (Patch 55)
		this._providers.set(DeepSeekBYOKLMProvider.providerId, instantiationService.createInstance(DeepSeekBYOKLMProvider, undefined, this._byokStorageService));
		this._providers.set(OAIBYOKLMProvider.providerId, openai);
		this._providers.set(OpenRouterLMProvider.providerId, instantiationService.createInstance(OpenRouterLMProvider, this._byokStorageService));
		this._providers.set(AzureBYOKModelProvider.providerId, instantiationService.createInstance(AzureBYOKModelProvider, this._byokStorageService));
		this._providers.set(CustomOAIBYOKModelProvider.providerId, instantiationService.createInstance(CustomOAIBYOKModelProvider, this._byokStorageService));

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
				// Patch 40 extended the constructor to take the shared
				// BYOK storage service so the classifier can read the
				// user's Gemini / Vertex keys without re-prompting.
				instantiationService.createInstance(BYOKAutoLMProvider, this._byokStorageService),
			);
			// ─── END BYOK CUSTOM PATCH ──────────────────────────────
		this._providers.set(CustomEndpointBYOKModelProvider.providerId, instantiationService.createInstance(CustomEndpointBYOKModelProvider, this._byokStorageService));

		this._knownModelsRefreshTargets = [
			[AnthropicLMProvider.providerName, anthropic],
			[GeminiNativeBYOKLMProvider.providerName, gemini],
			[XAIBYOKLMProvider.providerName, xai],
			[OAIBYOKLMProvider.providerName, openai],
		];
	}

	private _applyPolicy(): void {
		const allowed = isClientBYOKAllowed(!!this._authService.anyGitHubSession, this._authService.copilotToken);
		if (allowed && !this._providersRegistered) {
			if (this._providers.size === 0) {
				this._buildProviders();
			}
			for (const [providerId, provider] of this._providers) {
				this._providerRegistrations.add(lm.registerLanguageModelChatProvider(providerId, provider));
			}
			this._providersRegistered = true;
			this._logService.info(`BYOK: registered ${this._providers.size} provider(s): ${Array.from(this._providers.keys()).join(', ')}`);
			if (!this._knownModelsRefreshed) {
				this._knownModelsRefreshed = true;
				void this._refreshKnownModels().catch(err => {
					this._knownModelsRefreshed = false;
					this._logService.warn(`BYOK: failed to refresh known models, will retry on next allowed transition: ${err instanceof Error ? err.message : String(err)}`);
				});
			}
		} else if (!allowed && this._providersRegistered) {
			this._providerRegistrations.clear();
			this._providersRegistered = false;
			this._logService.info('BYOK: unregistered providers due to enterprise policy.');
		}
	}

	private async _refreshKnownModels(): Promise<void> {
		const knownModels = await this._fetchKnownModelList(this._fetcherService);
		if (this._store.isDisposed) {
			return;
		}
		for (const [providerName, provider] of this._knownModelsRefreshTargets) {
			provider.updateKnownModels(knownModels[providerName]);
		}
	}

	private async _fetchKnownModelList(fetcherService: IFetcherService): Promise<Record<string, BYOKKnownModels>> {
		this._logService.info('BYOK: fetching known models list');
		const data = await (await fetcherService.fetch('https://main.vscode-cdn.net/extensions/copilotChat.json', { method: 'GET', callSite: 'byok-known-models' })).json();
		// Use this for testing with changes from a local file. Don't check in
		// const data = JSON.parse((await this._fileSystemService.readFile(URI.file('/Users/roblou/code/vscode-engineering/chat/copilotChat.json'))).toString());
		if (data.version !== 1) {
			this._logService.warn('BYOK: Copilot Chat known models list is not in the expected format. Defaulting to empty list.');
			return {};
		}
		this._logService.info('BYOK: Copilot Chat known models list fetched successfully.');
		return data.modelInfo;
	}
}
