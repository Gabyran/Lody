/**
 * Prevent quit (and OS lease release) until owned execution has confirmed exit.
 *
 * `confirmQuit` runs first and may cancel the quit, for example while the
 * local agent reports changes it could not save; a failure to ask counts as a
 * yes, so a broken dialog never traps the user in the app.
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
    } catch {
      confirmed = true
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
    } catch {
      final = true
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
