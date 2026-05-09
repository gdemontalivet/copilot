/*---------------------------------------------------------------------------------------------
 *  BYOK CUSTOM FILE (Patch 51). Canonical copy under
 *  `.github/byok-patches/files/contextWindowStatusItem.ts` and installed
 *  into `src/extension/byok/vscode-node/` by
 *  `.github/scripts/apply-byok-patches.sh` on every upstream sync.
 *  Do not edit the installed copy directly.
 *--------------------------------------------------------------------------------------------*/

import * as l10n from '@vscode/l10n';
import * as vscode from 'vscode';
import { Disposable } from '../../../util/vs/base/common/lifecycle';
import {
	type ContextBreakdown,
	type ContextSegment,
	contextPercent,
	formatTokens,
} from '../common/contextBreakdown';
import { onDidUpdateContextBreakdown } from '../common/contextBreakdownChannel';

/**
 * BYOK context-window breakdown status item (Patch 51).
 *
 * Registers a `vscode.ChatStatusItem` that shows up in the chat panel's
 * status row (alongside `copilot.workspaceIndexStatus` and
 * `copilot.sessionSyncStatus`). The collapsed `description` is a single
 * line "Context: 42% (125K / 300K)" with an outline-circle icon; the
 * expanded `detail` lists every populated segment as a markdown bullet
 * with its token count.
 *
 * **Why a status item rather than the actual context-window ring popover?**
 *
 * The ring/percentage indicator above the chat input is rendered by VS
 * Code core (it reads `usage.prompt_tokens` / `modelMaxPromptTokens`
 * from each turn's response — see Patch 33's `TokenUsage` data-part for
 * how we feed those numbers in for BYOK turns). The popover that opens
 * when you click the ring is also rendered by core; there is currently
 * no extension API hook to add segments / breakdowns to it. The closest
 * extensibility surface is `vscode.window.createChatStatusItem`, which
 * paints into the chat panel's status row. So this item lives one
 * surface over from where Cursor users expect it — a known limitation
 * we cannot fix without an upstream VS Code API change.
 *
 * Data flow:
 *   `toolCallingLoop._onDidBuildPrompt.fire(...)` site (instrumented by
 *   Patch 51) → `computeContextBreakdown(...)` (pure, in `byok/common/`)
 *   → `reportContextBreakdown(...)` (singleton emitter) →
 *   `onDidUpdateContextBreakdown` listener here → `_render(...)`.
 *
 * Hidden by default. First update reveals it. Subsequent updates
 * re-render in place.
 */
export class ContextWindowStatusItem extends Disposable {
	private readonly _statusItem: vscode.ChatStatusItem;

	constructor() {
		super();

		this._statusItem = this._register(
			vscode.window.createChatStatusItem('copilot.contextBreakdown')
		);
		this._statusItem.title = l10n.t('Context Window');
		this._statusItem.description = '';
		this._statusItem.detail = '';
		this._statusItem.hide(); // until first breakdown lands

		this._register(onDidUpdateContextBreakdown(b => this._render(b)));
	}

	private _render(breakdown: ContextBreakdown): void {
		const pct = contextPercent(breakdown);
		const used = formatTokens(breakdown.totalPromptTokens);
		const max = formatTokens(breakdown.modelMaxPromptTokens);
		const icon = this._iconFor(pct);

		this._statusItem.title = {
			label: l10n.t('Context Window'),
			link: 'https://docs.anthropic.com/en/docs/build-with-claude/context-windows',
			helpText: l10n.t('Per-segment breakdown of prompt tokens used in the most recent turn.'),
		};

		this._statusItem.description = `${icon} ${l10n.t('{0}% ({1} / {2})', pct, used, max)}`;
		this._statusItem.detail = this._formatDetail(breakdown);
		this._statusItem.show();
	}

	/**
	 * Pick a codicon based on context utilisation. Mirrors the visual
	 * cues users associate with the upstream context-window ring colour
	 * ramp without competing with it visually.
	 */
	private _iconFor(pct: number): string {
		if (pct >= 90) { return '$(circle-filled)'; }
		if (pct >= 70) { return '$(circle-large-filled)'; }
		return '$(circle-large-outline)';
	}

	/**
	 * Render the per-segment detail. Each populated segment is a single
	 * markdown line "**Label**: 5.9K". Empty segments are skipped so the
	 * status row doesn't get cluttered with zeros.
	 */
	private _formatDetail(breakdown: ContextBreakdown): string {
		const lines: string[] = [];
		for (const seg of breakdown.segments) {
			if (seg.tokens <= 0) { continue; }
			lines.push(`**${this._localizedLabel(seg)}**: ${formatTokens(seg.tokens)}`);
		}
		// Markdown bullets over a single dotted line — the chat-panel
		// status pane renders bullets natively and the result reads like
		// the Cursor screenshot more closely than a one-line summary.
		const bullets = lines.map(l => `- ${l}`).join('\n');
		const modelLine = `_${l10n.t('Model: {0}', breakdown.modelId)}_`;
		return [bullets, modelLine].filter(Boolean).join('\n\n');
	}

	private _localizedLabel(seg: ContextSegment): string {
		switch (seg.kind) {
			case 'system': return l10n.t('System prompt');
			case 'tools': return l10n.t('Tools');
			case 'summary': return l10n.t('Summarized conversation');
			case 'history': return l10n.t('Conversation');
			case 'current': return l10n.t('Current message');
			default: return seg.label;
		}
	}
}
