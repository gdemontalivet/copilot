/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import {
	CancellationToken,
	LanguageModelChat,
	LanguageModelChatInformation,
	LanguageModelChatMessage,
	LanguageModelChatMessage2,
	LanguageModelChatProvider,
	LanguageModelResponsePart2,
	PrepareLanguageModelChatModelOptions,
	Progress,
	ProvideLanguageModelChatResponseOptions,
} from 'vscode';
import { ConfigKey, IConfigurationService } from '../../../platform/configuration/common/configurationService';
import { ILogService } from '../../../platform/log/common/logService';

interface CandidateResult {
	model: LanguageModelChat;
	text: string;
	error?: string;
	durationMs?: number;
}

/**
 * Synthetic "Fusion" model that lives in the BYOK world.
 *
 * This provider registers a parallel `byokfusion` vendor with a single `byok-fusion`
 * model. When selected, it sends the current prompt in parallel to several
 * configured or auto-discovered language models, collects their outputs,
 * and passes all of them to a high-capacity "merger" model to synthesize
 * a single, highly optimized code answer.
 */
export class BYOKFusionLMProvider implements LanguageModelChatProvider<LanguageModelChatInformation> {

	public static readonly providerName: string = 'BYOKFusion';
	public static readonly vendorId: string = 'byokfusion';
	public static readonly modelId: string = 'byok-fusion';

	private static readonly AUTO_DISCOVERY_VENDOR_PRIORITY: readonly string[] = [
		'gemini',
		'vertexgemini',
		'anthropic',
		'vertexanthropic',
		'openai',
		'deepseek',
		'xai',
		'azure',
		'customoai',
		'ollama'
	];

	private static readonly AUTO_DISCOVERY_MODEL_PREFERENCE: readonly string[] = [
		'gemini-3.1-pro',
		'gemini-3-pro',
		'gemini-3-flash',
		'gemini-2.5-pro',
		'gemini-2.0-flash',
		'claude-sonnet-4',
		'claude-opus-4',
		'claude-haiku',
		'gpt-5',
		'gpt-4.1',
		'gpt-4o',
		'gpt-4-turbo',
		'deepseek-chat',
		'deepseek-coder',
		'grok-2',
	];

	private readonly _onDidChange = new vscode.EventEmitter<void>();
	public readonly onDidChangeLanguageModelChatInformation = this._onDidChange.event;

	constructor(
		@IConfigurationService private readonly _configurationService: IConfigurationService,
		@ILogService private readonly _logService: ILogService,
	) { }

	dispose(): void {
		this._onDidChange.dispose();
	}

	async provideLanguageModelChatInformation(
		_options: PrepareLanguageModelChatModelOptions,
		_token: CancellationToken,
	): Promise<LanguageModelChatInformation[]> {
		return [{
			id: BYOKFusionLMProvider.modelId,
			name: 'BYOK Fusion',
			family: 'byok-fusion',
			version: '1.0.0',
			maxInputTokens: 1_000_000,
			maxOutputTokens: 64_000,
			tooltip: 'Sends prompt to multiple BYOK models in parallel and merges outputs into a single high-quality response.',
			detail: 'Capability Fusion (Multi-Model Parallel Synthesis)',
			category: { label: '', order: Number.MIN_SAFE_INTEGER },
			isUserSelectable: true,
			multiplierNumeric: 0,
			capabilities: {
				toolCalling: false,
				imageInput: false,
			},
		} satisfies LanguageModelChatInformation];
	}

	async provideLanguageModelChatResponse(
		_model: LanguageModelChatInformation,
		messages: Array<LanguageModelChatMessage | LanguageModelChatMessage2>,
		options: ProvideLanguageModelChatResponseOptions,
		progress: Progress<LanguageModelResponsePart2>,
		token: CancellationToken,
	): Promise<void> {
		const candidates = await this._resolveCandidates(token);
		if (candidates.length === 0) {
			throw new Error('BYOK Fusion: No candidate models are configured or registered. Enable at least one other BYOK provider.');
		}

		const merger = await this._resolveMerger(candidates, token);
		const showHint = this._readShowHint();

		if (showHint) {
			const candidateNames = candidates.map(c => `${c.vendor}/${c.id}`).join(', ');
			progress.report(new vscode.LanguageModelTextPart(`*🤖 Fusing capabilities from: **${candidateNames}**...*\n\n`));
		}

		// Execute candidates in parallel
		const startTime = Date.now();
		const results: CandidateResult[] = await Promise.all(
			candidates.map(async (candidate) => {
				const candStart = Date.now();
				try {
					const response = await candidate.sendRequest(
						messages,
						{
							modelOptions: options.modelOptions,
							toolMode: options.toolMode,
							tools: options.tools,
							justification: `BYOK Fusion candidate generation for ${candidate.vendor}/${candidate.id}`,
						},
						token,
					);

					let text = '';
					for await (const part of response.stream) {
						if (token.isCancellationRequested) {
							break;
						}
						if (part instanceof vscode.LanguageModelTextPart) {
							text += part.value;
						}
					}

					return {
						model: candidate,
						text,
						durationMs: Date.now() - candStart,
					};
				} catch (err) {
					return {
						model: candidate,
						text: '',
						error: err instanceof Error ? err.message : String(err),
						durationMs: Date.now() - candStart,
					};
				}
			})
		);

		const duration = Date.now() - startTime;
		this._logService.trace(`[BYOKFusion] Parallel candidate generation finished in ${duration}ms`);

		// Report candidates generation status
		if (showHint) {
			let statusMsg = '';
			for (const res of results) {
				const spec = `${res.model.vendor}/${res.model.id}`;
				if (res.error) {
					statusMsg += `- 🟥 **${spec}**: Generation failed (*${res.error}*)\n`;
				} else {
					statusMsg += `- 🟩 **${spec}**: Completed in ${res.durationMs}ms (${res.text.length} chars)\n`;
				}
			}
			statusMsg += `\n*✨ Fusing and merging candidate responses using **${merger.vendor}/${merger.id}**...*\n\n---\n\n`;
			progress.report(new vscode.LanguageModelTextPart(statusMsg));
		}

		const successfulResults = results.filter(r => !r.error && r.text.trim().length > 0);
		if (successfulResults.length === 0) {
			throw new Error('BYOK Fusion: All candidate model requests failed or returned empty. Cannot perform fusion.');
		}

		// Prepare merger payload
		const candidatesText = successfulResults.map((res, i) => {
			return `### Candidate ${i + 1} (${res.model.vendor}/${res.model.id})\n\n${res.text}\n`;
		}).join('\n');

		const mergerPrompt = `You are an expert code architect specializing in capability fusion.
You have been provided with several candidate solutions generated by different high-quality language models for the user's request.

Your task is to:
1. Carefully analyze each candidate response.
2. Identify the strengths, best-practice implementations, edge-case coverage, and clean coding patterns in each response.
3. Synthesize and merge these candidates into a single, cohesive, exceptionally high-quality answer.
4. If there are contradictions, resolve them in favor of the most robust, secure, and modern design.
5. Provide the final, consolidated code solution along with clear explanations of why it was structured this way, what was fused from each candidate, and any key architectural decisions made.

Do not reference the internal mechanics or candidate names unless necessary. Present the results in a direct, elegant, and highly polished format.

Below are the candidate responses:

---
${candidatesText}
---

Produce the final, merged, optimal response now.`;

		// Run the merger model
		const mergerMessages = [
			...messages,
			vscode.LanguageModelChatMessage.User(mergerPrompt),
		];

		const mergerResponse = await merger.sendRequest(
			mergerMessages,
			{
				modelOptions: options.modelOptions,
				toolMode: options.toolMode,
				tools: options.tools,
				justification: 'BYOK Fusion merging candidate responses',
			},
			token,
		);

		for await (const part of mergerResponse.stream) {
			if (token.isCancellationRequested) {
				return;
			}
			progress.report(part as LanguageModelResponsePart2);
		}
	}

	async provideTokenCount(
		_model: LanguageModelChatInformation,
		text: string | LanguageModelChatMessage | LanguageModelChatMessage2,
		token: CancellationToken,
	): Promise<number> {
		try {
			const candidates = await this._resolveCandidates(token);
			if (candidates.length > 0) {
				const merger = await this._resolveMerger(candidates, token);
				return merger.countTokens(text as LanguageModelChatMessage, token);
			}
		} catch {
			// ignore and fallback
		}
		const s = typeof text === 'string' ? text : JSON.stringify(text);
		return Math.ceil(s.length / 4);
	}

	private async _resolveCandidates(token: CancellationToken): Promise<LanguageModelChat[]> {
		const configuredSpecs = this._readFusionModelsSetting();
		if (configuredSpecs.length > 0) {
			const selected: LanguageModelChat[] = [];
			for (const spec of configuredSpecs) {
				const parsed = this._parseTargetSpec(spec);
				if (parsed) {
					const models = await vscode.lm.selectChatModels({ vendor: parsed.vendor, id: parsed.id });
					if (models.length > 0) {
						selected.push(models[0]);
					} else {
						this._logService.warn(`[BYOKFusion] Configured fusion model not available: ${spec}`);
					}
				}
			}
			if (selected.length > 0) {
				return selected;
			}
		}

		// Fallback: Auto-discovery
		return this._autoDiscoverCandidates(token);
	}

	private async _resolveMerger(candidates: LanguageModelChat[], token: CancellationToken): Promise<LanguageModelChat> {
		const configured = this._readFusionMergerModelSetting();
		if (configured) {
			const parsed = this._parseTargetSpec(configured);
			if (parsed) {
				const models = await vscode.lm.selectChatModels({ vendor: parsed.vendor, id: parsed.id });
				if (models.length > 0) {
					return models[0];
				}
				this._logService.warn(`[BYOKFusion] Configured merger model not available: ${configured}`);
			}
		}

		// Fallback: Pick the first candidate
		if (candidates.length > 0) {
			return candidates[0];
		}

		throw new Error('BYOK Fusion: No candidate models are available to act as a merger.');
	}

	private async _autoDiscoverCandidates(_token: CancellationToken): Promise<LanguageModelChat[]> {
		let all: LanguageModelChat[] = [];
		try {
			all = await vscode.lm.selectChatModels();
		} catch (err) {
			this._logService.warn(`[BYOKFusion] Auto-discovery candidate selection failed: ${(err as Error).message}`);
			return [];
		}

		const byVendor = new Map<string, LanguageModelChat[]>();
		for (const m of all) {
			if (m.vendor === BYOKFusionLMProvider.vendorId || m.vendor === 'byokauto') {
				continue;
			}
			const list = byVendor.get(m.vendor) ?? [];
			list.push(m);
			byVendor.set(m.vendor, list);
		}

		const candidates: LanguageModelChat[] = [];
		for (const vendor of BYOKFusionLMProvider.AUTO_DISCOVERY_VENDOR_PRIORITY) {
			const models = byVendor.get(vendor);
			if (models && models.length > 0) {
				const picked = this._pickPreferredModel(models);
				if (picked) {
					candidates.push(picked);
				}
			}
			if (candidates.length >= 3) {
				break;
			}
		}

		// If we still need more candidates and have other vendors, add them
		if (candidates.length < 3) {
			for (const [vendor, models] of byVendor.entries()) {
				if (BYOKFusionLMProvider.AUTO_DISCOVERY_VENDOR_PRIORITY.includes(vendor)) {
					continue;
				}
				const picked = this._pickPreferredModel(models);
				if (picked) {
					candidates.push(picked);
				}
				if (candidates.length >= 3) {
					break;
				}
			}
		}

		return candidates;
	}

	private _pickPreferredModel(models: readonly LanguageModelChat[]): LanguageModelChat | undefined {
		if (models.length === 0) {
			return undefined;
		}
		for (const needle of BYOKFusionLMProvider.AUTO_DISCOVERY_MODEL_PREFERENCE) {
			const hit = models.find(m => {
				const id = (m.id ?? '').toLowerCase();
				const family = (m.family ?? '').toLowerCase();
				return id.includes(needle) || family.includes(needle);
			});
			if (hit) {
				return hit;
			}
		}
		return models[0];
	}

	private _readFusionModelsSetting(): string[] {
		try {
			const value = this._configurationService.getConfig(ConfigKey.ByokFusionModels);
			if (Array.isArray(value)) {
				return value.map(v => typeof v === 'string' ? v.trim() : '').filter(Boolean);
			}
		} catch {
			// ignore
		}
		return [];
	}

	private _readFusionMergerModelSetting(): string {
		try {
			const value = this._configurationService.getConfig(ConfigKey.ByokFusionMergerModel);
			if (typeof value === 'string') {
				return value.trim();
			}
		} catch {
			// ignore
		}
		return '';
	}

	private _readShowHint(): boolean {
		try {
			const value = this._configurationService.getConfig(ConfigKey.ByokFusionShowHint);
			return value !== false;
		} catch {
			return true;
		}
	}

	private _parseTargetSpec(raw: string): { vendor: string; id: string } | undefined {
		if (typeof raw !== 'string') {
			return undefined;
		}
		const idx = raw.indexOf('/');
		if (idx <= 0 || idx === raw.length - 1) {
			return undefined;
		}
		return {
			vendor: raw.substring(0, idx),
			id: raw.substring(idx + 1),
		};
	}
}
