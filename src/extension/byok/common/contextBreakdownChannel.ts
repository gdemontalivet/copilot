/*---------------------------------------------------------------------------------------------
 *  BYOK CUSTOM FILE (Patch 51). Canonical copy under
 *  `.github/byok-patches/files/contextBreakdownChannel.ts` and installed
 *  into `src/extension/byok/common/` by
 *  `.github/scripts/apply-byok-patches.sh` on every upstream sync.
 *  Do not edit the installed copy directly.
 *--------------------------------------------------------------------------------------------*/

import { Emitter, Event } from '../../../util/vs/base/common/event';
import type { ContextBreakdown } from './contextBreakdown';

/**
 * Singleton event channel between the producer (the
 * `toolCallingLoop._onDidBuildPrompt.fire(...)` site, instrumented by
 * Patch 51) and the consumer (the `ContextWindowStatusItem` registered
 * in `contributions.ts`).
 *
 * Why a module-level singleton instead of a DI-registered service?
 *
 *   - Both producer and consumer live inside the same extension host
 *     process — there's no IPC boundary to motivate a service.
 *   - The producer (`toolCallingLoop`) already has a complex constructor
 *     signature with ~10 injected dependencies. Threading
 *     `IContextBreakdownService` through it would expand the patch
 *     surface across the constructor, the call site, and every test
 *     fixture that instantiates it (~12 spec files). A module-level
 *     emitter keeps the patch confined to the one fire-after line.
 *   - The consumer (`ContextWindowStatusItem`) is a leaf-level UI
 *     contribution with no other deps, so DI buys nothing there
 *     either.
 *   - The emitter has no per-test state to leak — each `fire(...)` is
 *     synchronous and the listener set is stable across the test's
 *     lifetime; `vi.restoreAllMocks()` between tests is sufficient.
 *
 * Single-fire semantics: `fire(...)` emits the latest snapshot
 * synchronously. Listeners are expected to handle "I receive an
 * outdated snapshot" by simply waiting for the next fire — no
 * sequencing or buffering is provided here.
 */

const _emitter = new Emitter<ContextBreakdown>();

/** Subscribe to context-breakdown updates. */
export const onDidUpdateContextBreakdown: Event<ContextBreakdown> = _emitter.event;

/** Producer side: report a freshly-computed breakdown. Synchronous. */
export function reportContextBreakdown(breakdown: ContextBreakdown): void {
	_emitter.fire(breakdown);
}
