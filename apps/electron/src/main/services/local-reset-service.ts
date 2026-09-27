// Applies a desktop reset armed from the CLI (`lody app reset-cache`). The user
// this exists for cannot reach Settings → Clear cache, because the renderer they
// would click it in is wedged, so the request arrives on disk and is applied here
// before the first window loads. Format and location:
// `@lody/shared/node/desktop-local-reset`.
import { session } from 'electron'
import {
  consumeDesktopLocalResetRequestDetailed,
  createDesktopLocalClearHandoff,
  type DesktopLocalResetMode
} from '@lody/shared/node/desktop-local-reset'
import { mainPlatformKind } from '../platform'

/**
 * Set when a `cache` reset was armed; a booting window claims it through
 * `app.claimPendingLocalClear` and settles it once the clear ran (or declines it,
 * which keeps it armed for the next load).
 *
 * A `cache` reset has to run in the renderer: it keeps the user signed in, keeps
 * their preferences, and keeps the Shortcut outbox (whose rows can be the only
 * copy of an offline save), and Chromium's storage APIs here cannot single out
 * individual IndexedDB databases or localStorage keys. So main only arms it, and
 * `clear-local-cache.ts` performs the same precise clear the settings action does.
 *
 * Settled once because a renderer reload re-runs that boot path: replaying the
 * clear on every reload would re-download the whole local replica each time. A
 * declined clear stays armed, in memory and back on disk (see the handoff).
 */
const pendingRendererLocalClear = createDesktopLocalClearHandoff({
  platform: mainPlatformKind,
  log: (message, detail) => console.error(`[Electron] ${message}`, detail)
})

/**
 * Consume the armed request, if any, before any window exists.
 *
 * `hard` is applied natively right here instead of being handed to the renderer,
 * because it is the escape hatch for a renderer that cannot boot far enough to
 * run its own clear. It wipes web storage, IndexedDB, Cache Storage, service
 * workers, and cookies for the app session, which includes the Better Auth token
 * the renderer keeps in localStorage — so the app comes back signed out.
 *
 * Never throws: a failed reset must still leave a usable app.
 */
export async function applyPendingDesktopLocalReset(): Promise<void> {
  let request: { mode: DesktopLocalResetMode; requestedAtMs: number } | null = null
  try {
    request = consumeDesktopLocalResetRequestDetailed({
      platform: mainPlatformKind,
      log: (message, detail) => console.warn(`[Electron] ${message}`, detail)
    })
  } catch (error) {
    console.error('[Electron] Failed to consume the desktop reset request', error)
    return
  }
  if (!request) return
  const { mode } = request

  console.info('[Electron] Applying a desktop reset armed from the CLI', { mode })
  if (mode === 'hard') {
    try {
      await session.defaultSession.clearStorageData()
      await session.defaultSession.clearCache()
    } catch (error) {
      console.error('[Electron] Hard desktop reset did not complete', error)
    }
    return
  }

  try {
    // Both levels drop the HTTP cache too: a wedge caused by a stale or
    // half-written asset is invisible from the renderer, which is exactly the
    // situation this command gets reached in.
    await session.defaultSession.clearCache()
  } catch (error) {
    // The renderer clear below is the part that matters; arm it regardless.
    console.error('[Electron] Could not clear the HTTP cache for a desktop reset', error)
  }
  pendingRendererLocalClear.arm(request)
}

/** Hands the armed `cache` reset to one booting window; see {@link createDesktopLocalClearHandoff}. */
export function claimPendingRendererLocalClear(windowId: number): DesktopLocalResetMode | null {
  return pendingRendererLocalClear.claim(windowId)
}

export function settlePendingRendererLocalClear(
  windowId: number,
  outcome: 'cleared' | 'declined'
): void {
  pendingRendererLocalClear.settle(windowId, outcome)
}

export function releasePendingRendererLocalClear(windowId: number): void {
  pendingRendererLocalClear.release(windowId)
}
