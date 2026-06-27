/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// ─── BYOK CUSTOM PATCH: Gemini API with ADC / OAuth auth (Patch 68) ──────────
// Preserved by .github/scripts/apply-byok-patches.sh. Do not remove.
//
// Google deprecated simple API key access to the Generative Language API for
// GCP-routed accounts.  Users who authenticated via `gcloud auth
// application-default login` (ADC) or a service-account key now get HTTP 403
// "API keys are not supported by this API" instead of working calls.
//
// This provider (vendor `geminiadc`) is a thin subclass of
// `GeminiNativeBYOKLMProvider` that replaces the raw `apiKey` HTTP header with
// an OAuth 2.0 Bearer token.  Everything else — streaming, OTel telemetry,
// exponential-backoff retry, readable error messages, model-allowlist relaxation
// (Patch 59), caps, tool calling — is inherited unchanged.
//
// The "API key" field (shown in the VS Code "Add Models" dialog) is interpreted
// the same way VertexGeminiLMProvider does, but without the Vertex AI endpoint:
//
//   • Empty / "adc" → system Application Default Credentials
//       (gcloud auth application-default login, or GOOGLE_APPLICATION_CREDENTIALS)
//
//   • JSON object starting with "{" → inline Service Account key
//       Paste the contents of a SA key JSON file directly.  Quota project is
//       auto-extracted from project_id / quota_project_id in the JSON.
//       This mirrors exactly what VertexGeminiLMProvider accepts as its "API key".
//
//   • Anything else → treated as a GCP project ID; system ADC is used for auth
//       and x-goog-user-project is set to that value for billing attribution.
//
// Because different provider groups can have different credentials (own GCP vs
// customer GCP), the GoogleAuth instance and token cache are keyed by a stable
// fingerprint of the credential so groups don't share state.
//
// Vendor: `geminiadc` (lowercase of providerName).
// ─────────────────────────────────────────────────────────────────────────────

import { ApiError, GoogleGenAI } from '@google/genai';
import { GoogleAuth } from 'google-auth-library';
import { ILogService } from '../../../platform/log/common/logService';
import { IOTelService } from '../../../platform/otel/common/otelService';
import { IRequestLogger } from '../../../platform/requestLogger/common/requestLogger';
import { ITelemetryService } from '../../../platform/telemetry/common/telemetry';
import { BYOKKnownModels, BYOKModelCapabilities, byokKnownModelsToAPIInfo } from '../common/byokProvider';
import { ExtendedLanguageModelChatInformation, LanguageModelChatConfiguration } from './abstractLanguageModelChatProvider';
import { IBYOKStorageService } from './byokStorageService';
import { GeminiNativeBYOKLMProvider } from './geminiNativeProvider';

// OAuth scopes accepted by the Generative Language API.
// cloud-platform is required when VPC Service Controls or org policies are active.
const ADC_SCOPES = [
	'https://www.googleapis.com/auth/generative-language',
	'https://www.googleapis.com/auth/cloud-platform',
];

// Token lifetime: Google OAuth2 tokens expire after 60 min.
// Cache for 50 min; pre-refresh when within 5 min of expiry.
const TOKEN_CACHE_TTL_MS = 50 * 60 * 1_000;
const TOKEN_REFRESH_BUFFER_MS = 5 * 60 * 1_000;

// Mirrors GeminiNativeBYOKLMProvider._GEMINI_MAX_INPUT_TOKENS (private static = 200_000)
// so Patch 23's compaction thresholds behave identically to the API-key provider.
const GEMINIADC_MAX_INPUT_TOKENS = 200_000;

interface CredentialSlot {
	auth: GoogleAuth;
	/** GCP project to bill usage against (x-goog-user-project header). */
	quotaProject: string | undefined;
}

/**
 * Routes Gemini requests through Google's Generative Language API
 * (`generativelanguage.googleapis.com`) using OAuth 2.0 credentials instead
 * of a raw API key.
 *
 * Credential resolution (same shape as {@link VertexGeminiLMProvider}):
 *  - Empty / "adc"   → system Application Default Credentials
 *  - JSON `{ ... }`  → inline Service Account key (paste from GCP console)
 *  - Anything else   → treated as a GCP quota project ID; system ADC used
 *
 * Multiple provider groups with different credentials (own GCP vs customer GCP)
 * are fully supported — each gets an independent {@link GoogleAuth} instance
 * and token cache keyed by a credential fingerprint.
 *
 * Extends {@link GeminiNativeBYOKLMProvider} — only credential resolution and
 * client construction are overridden.
 */
export class GeminiADCLMProvider extends GeminiNativeBYOKLMProvider {

	public static override readonly providerName: string = 'GeminiADC';

	/** Per-credential GoogleAuth instances + quota projects. */
	private readonly _credSlots = new Map<string, CredentialSlot>();
	/** Per-credential token cache. */
	private readonly _tokenCache = new Map<string, { token: string; expiresAt: number }>();
	/**
	 * Token pre-warmed by `provideLanguageModelChatResponse` before the
	 * synchronous `createClient()` is invoked inside the streaming loop.
	 * Keyed by credential fingerprint so concurrent groups don't clobber each other.
	 */
	private readonly _pendingTokens = new Map<string, string>();

	constructor(
		knownModels: BYOKKnownModels | undefined,
		byokStorageService: IBYOKStorageService,
		@ILogService logService: ILogService,
		@IRequestLogger requestLogger: IRequestLogger,
		@ITelemetryService telemetryService: ITelemetryService,
		@IOTelService otelService: IOTelService,
	) {
		super(knownModels, byokStorageService, logService, requestLogger, telemetryService, otelService);
		(this as unknown as { _name: string })._name = GeminiADCLMProvider.providerName;
		(this as unknown as { _id: string })._id = GeminiADCLMProvider.providerName.toLowerCase();
	}

	// ─── Credential resolution ────────────────────────────────────────────────

	/**
	 * Compute a stable, short fingerprint for a credential value so we can key
	 * the per-credential caches without storing secrets.
	 */
	private _credFingerprint(rawApiKey: string): string {
		if (!rawApiKey || rawApiKey === 'adc') {
			return 'adc';
		}
		const trimmed = rawApiKey.trim();
		if (trimmed.startsWith('{')) {
			// SA JSON: use client_email + project_id as a stable key
			try {
				const parsed = JSON.parse(trimmed) as { client_email?: string; project_id?: string };
				return `sa:${parsed.project_id ?? ''}:${parsed.client_email ?? ''}`;
			} catch {
				// Malformed JSON — fall through to length-based fingerprint
			}
		}
		// Quota project ID or unrecognised value: use verbatim (short strings are safe)
		return trimmed.length <= 64 ? trimmed : `key:${trimmed.slice(0, 32)}`;
	}

	/**
	 * Returns (and lazily creates) the {@link GoogleAuth} instance for the given
	 * raw API key value.  Mirrors VertexGeminiLMProvider.createClient() credential
	 * handling — SA JSON is parsed and passed to `googleAuthOptions.credentials`;
	 * anything else falls back to system ADC.
	 *
	 * Also returns the quota project extracted from the SA JSON (if present) so
	 * the `x-goog-user-project` header can be set without the user having to
	 * specify it separately.
	 */
	private _getCredSlot(rawApiKey: string): CredentialSlot {
		const key = this._credFingerprint(rawApiKey);
		const cached = this._credSlots.get(key);
		if (cached) {
			return cached;
		}

		let auth: GoogleAuth;
		let quotaProject: string | undefined;
		const trimmed = rawApiKey?.trim() ?? '';

		if (trimmed.startsWith('{')) {
			// ── SA JSON (same as VertexGeminiLMProvider case 1) ──────────────
			let credentials: Record<string, unknown>;
			try {
				credentials = JSON.parse(trimmed);
			} catch (e) {
				this._logService.error(`[GeminiADC] Failed to parse SA JSON: ${e}`);
				throw new Error('[GeminiADC] Invalid credentials: expected a service-account JSON object.');
			}
			quotaProject =
				(credentials.quota_project_id as string | undefined) ??
				(credentials.project_id as string | undefined);
			this._logService.trace(
				`[GeminiADC] Using SA credentials (type: ${credentials.type ?? 'unknown'}, project: ${quotaProject ?? 'none'})`
			);
			auth = new GoogleAuth({
				credentials: credentials as any,
				scopes: ADC_SCOPES,
				projectId: quotaProject,
			});
		} else if (trimmed && trimmed !== 'adc') {
			// ── Quota project ID + system ADC ─────────────────────────────────
			quotaProject = trimmed;
			this._logService.trace(`[GeminiADC] Using system ADC with quota project: ${quotaProject}`);
			auth = new GoogleAuth({ scopes: ADC_SCOPES });
		} else {
			// ── System ADC (no quota project) ─────────────────────────────────
			this._logService.trace('[GeminiADC] Using system ADC (no explicit quota project)');
			auth = new GoogleAuth({ scopes: ADC_SCOPES });
		}

		const slot: CredentialSlot = { auth, quotaProject };
		this._credSlots.set(key, slot);
		return slot;
	}

	// ─── Token management ─────────────────────────────────────────────────────

	private async _refreshToken(rawApiKey: string): Promise<string> {
		const fingerprint = this._credFingerprint(rawApiKey);
		const now = Date.now();
		const cached = this._tokenCache.get(fingerprint);
		if (cached && cached.expiresAt > now + TOKEN_REFRESH_BUFFER_MS) {
			return cached.token;
		}

		const slot = this._getCredSlot(rawApiKey);
		this._logService.trace(`[GeminiADC] Refreshing token (fingerprint: ${fingerprint})`);

		let token: string | null | undefined;
		try {
			token = await slot.auth.getAccessToken();
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			throw new Error(
				`[GeminiADC] Authentication failed: ${msg}\n` +
				'Ensure credentials are configured:\n' +
				'  • Paste a Service Account JSON key, or\n' +
				'  • Run: gcloud auth application-default login'
			);
		}
		if (!token) {
			throw new Error(
				'[GeminiADC] No access token returned.\n' +
				'Run: gcloud auth application-default login'
			);
		}

		this._tokenCache.set(fingerprint, { token, expiresAt: now + TOKEN_CACHE_TTL_MS });
		return token;
	}

	// ─── GoogleGenAI client builder ───────────────────────────────────────────

	private _buildClient(token: string, quotaProject?: string): GoogleGenAI {
		return new GoogleGenAI({
			httpOptions: {
				headers: {
					Authorization: `Bearer ${token}`,
					...(quotaProject ? { 'x-goog-user-project': quotaProject } : {}),
				},
			},
		});
	}

	// ─── createClient hook (Patch 26 seam) ───────────────────────────────────

	/**
	 * Called synchronously inside the streaming loop.  The token is pre-warmed
	 * in `provideLanguageModelChatResponse` before we get here.
	 */
	protected override createClient(
		apiKey: string,
		_model: ExtendedLanguageModelChatInformation<LanguageModelChatConfiguration>,
	): GoogleGenAI {
		const fingerprint = this._credFingerprint(apiKey);
		const token = this._pendingTokens.get(fingerprint);
		if (!token) {
			throw new Error(
				'[GeminiADC] Token not pre-warmed before createClient(). This is a bug.'
			);
		}
		const { quotaProject } = this._getCredSlot(apiKey);
		return this._buildClient(token, quotaProject);
	}

	// ─── Model discovery ──────────────────────────────────────────────────────

	protected override async getAllModels(
		silent: boolean,
		apiKey: string | undefined,
		_configuration?: LanguageModelChatConfiguration,
	): Promise<ExtendedLanguageModelChatInformation<LanguageModelChatConfiguration>[]> {
		const rawKey = apiKey ?? '';

		// Wrap the entire discovery in a try/catch so that a broken credential
		// (wrong scope, expired SA key, no ADC configured) never crashes VS Code's
		// model-picker refresh loop.  When silent=true VS Code is polling in the
		// background — returning an empty list is far better than throwing, which
		// locks the picker and prevents the user from deleting the group or
		// switching to another model.
		let token: string;
		try {
			token = await this._refreshToken(rawKey);
		} catch (err) {
			if (silent) {
				return [];
			}
			throw err;
		}

		const { quotaProject } = this._getCredSlot(rawKey);
		const client = this._buildClient(token, quotaProject);

		try {
			const models = await client.models.list();
			const modelList: Record<string, BYOKModelCapabilities> = {};

			for await (const model of models) {
				const modelId = model.name;
				if (!modelId) {
					continue;
				}
				if (this._knownModels && this._knownModels[modelId]) {
					const knownCaps = this._knownModels[modelId];
					modelList[modelId] = {
						...knownCaps,
						maxInputTokens: Math.min(knownCaps.maxInputTokens, GEMINIADC_MAX_INPUT_TOKENS),
					};
					continue;
				}
				const inferred = this._inferGeminiCapabilities(model);
				if (inferred) {
					modelList[modelId] = inferred;
				}
			}

			return byokKnownModelsToAPIInfo(
				this._name,
				modelList,
			) as ExtendedLanguageModelChatInformation<LanguageModelChatConfiguration>[];

		} catch (err) {
			// Silent mode: never propagate — just return empty so the picker stays usable.
			if (silent) {
				this._logService.warn(`[GeminiADC] Suppressed model-listing error (silent mode): ${err instanceof Error ? err.message : String(err)}`);
				return [];
			}

			// Non-silent: surface a clear, actionable error message.
			const error = this._classifyError(err);
			this._logService.error(error, '[GeminiADC] Error fetching available models');
			throw error;
		}
	}

	/**
	 * Converts a raw API error into a human-readable Error with an actionable
	 * fix suggestion.  Specifically detects the `ACCESS_TOKEN_SCOPE_INSUFFICIENT`
	 * 403 that happens when personal-account ADC credentials (from `gcloud auth
	 * application-default login` without `--scopes`) don't include the
	 * `generative-language` scope.
	 *
	 * Unlike service-account SA JSON (where `google-auth-library` can request
	 * any scope at token-mint time), user ADC scopes are fixed at login time and
	 * the `scopes` parameter passed to `GoogleAuth(...)` has no effect on them.
	 */
	private _classifyError(err: unknown): Error {
		if (err instanceof ApiError) {
			let parsed: { error?: { message?: string; status?: string; details?: Array<{ reason?: string }> } } | undefined;
			try { parsed = JSON.parse(err.message); } catch { /* not JSON */ }

			const reason = parsed?.error?.details?.[0]?.reason ?? '';
			const status = parsed?.error?.status ?? '';
			const message = parsed?.error?.message ?? err.message;

			if (reason === 'ACCESS_TOKEN_SCOPE_INSUFFICIENT' || status === 'PERMISSION_DENIED') {
				return new Error(
					`[GeminiADC] Insufficient OAuth scopes on your Application Default Credentials.\n\n` +
					`Personal-account ADC tokens created by plain "gcloud auth application-default login"\n` +
					`do not include the generative-language scope. Re-run with explicit scopes:\n\n` +
					`  gcloud auth application-default login \\\n` +
					`    --scopes=openid,\\\n` +
					`    https://www.googleapis.com/auth/userinfo.email,\\\n` +
					`    https://www.googleapis.com/auth/cloud-platform,\\\n` +
					`    https://www.googleapis.com/auth/generative-language\n\n` +
					`Alternatively, paste a Service Account JSON key into the credentials field\n` +
					`(same format as Vertex Gemini) — SA credentials bypass this limitation\n` +
					`because google-auth-library mints the token with the correct scopes automatically.\n\n` +
					`Original error: ${message}`,
					{ cause: err }
				);
			}

			return new Error(message, { cause: err });
		}
		return new Error(err instanceof Error ? err.message : String(err));
	}

	// ─── provideLanguageModelChatResponse override ────────────────────────────

	/**
	 * Pre-warms the credential-specific token so `createClient()` can use it
	 * synchronously.  Also injects the `'adc'` placeholder when no credential
	 * was configured, so the parent's non-null guard does not throw.
	 */
	override async provideLanguageModelChatResponse(
		model: ExtendedLanguageModelChatInformation<LanguageModelChatConfiguration>,
		messages: any,
		options: any,
		progress: any,
		token: any,
	): Promise<any> {
		const rawKey = (model.configuration as any)?.apiKey ?? '';
		const adcToken = await this._refreshToken(rawKey);
		this._pendingTokens.set(this._credFingerprint(rawKey), adcToken);

		// Inject placeholder so the parent's `if (!apiKey) throw` guard passes.
		const patchedModel = rawKey
			? model
			: {
				...model,
				configuration: { ...(model.configuration ?? {}), apiKey: 'adc' },
			};

		return super.provideLanguageModelChatResponse(patchedModel, messages, options, progress, token);
	}

	// ─── provideLanguageModelChatInformation override ─────────────────────────

	/**
	 * Injects `'adc'` as `configuration.apiKey` when no credential was entered,
	 * so the abstract base-class caching key and the per-model configuration
	 * are always non-empty without prompting for a key that doesn't exist.
	 */
	override async provideLanguageModelChatInformation(
		options: any,
		token: any,
	): Promise<ExtendedLanguageModelChatInformation<LanguageModelChatConfiguration>[]> {
		const apiKey = options?.configuration?.apiKey;
		const enrichedOptions = apiKey
			? options
			: {
				...options,
				configuration: { ...(options.configuration ?? {}), apiKey: 'adc' },
			};
		return super.provideLanguageModelChatInformation(enrichedOptions, token);
	}
}
