/**
 * Prevent quit (and OS lease release) until owned execution has confirmed exit.
 *
 * `confirmQuit` runs first and may cancel the quit, for example while the
 * local agent reports changes it could not save. A check that throws counts as
 * a no: it may have been the one protecting those changes. (The quit
 * coordinator never throws; a dialog that fails to open is its own no.)
 *
 * The returned promise settles once this attempt is back to running or stopped;
 * `preventDefault` is always called synchronously, before the first await.
 */
export function createDesktopQuitBarrier(options: {
  stop: () => Promise<void>
  quit: () => void
  reportFailure: (error: unknown) => void
  /**
   * Rolls back the approval `confirmQuit` gave, and the app-wide quitting state,
   * when stopping fails and the app stays open: windows must be guarded again,
   * not left free to unload. (A cancelled `confirmQuit` rolls back itself.)
   */
  abort: () => void
  confirmQuit?: () => Promise<boolean>
  /**
   * After `stop`, right before `quit`: what changed while stopping is confirmed
   * too. False keeps the app open; `resume` restarts what `stop` stopped.
   */
  confirmFinal?: () => Promise<boolean>
  resume?: () => void
}) {
  let state: 'running' | 'stopping' | 'stopped' = 'running'
  return async (event: { preventDefault: () => void }): Promise<void> => {
    if (state === 'stopped') return
    event.preventDefault()
    if (state === 'stopping') return
    state = 'stopping'
    let confirmed = true
    try {
      confirmed = (await options.confirmQuit?.()) ?? true
    } catch (error: unknown) {
      // Not a yes: the check that failed may have been the one protecting unsaved
      // changes. `createQuitCoordinator` never rejects, so this only guards misuse.
      console.error('[Electron] Quit check failed; staying open', error)
      confirmed = false
    }
    if (!confirmed) {
      state = 'running'
      return
    }
    try {
      await options.stop()
    } catch (error: unknown) {
      state = 'running'
      options.abort()
      options.reportFailure(error)
      return
    }
    let final = true
    try {
      final = (await options.confirmFinal?.()) ?? true
    } catch (error: unknown) {
      console.error('[Electron] Final quit check failed; staying open', error)
      options.abort()
      final = false
    }
    if (!final) {
      state = 'running'
      options.resume?.()
      return
    }
    state = 'stopped'
    options.quit()
  }
}
