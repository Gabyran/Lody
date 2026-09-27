/**
 * Which renderer windows hold repo changes their own storage (IndexedDB)
 * refused for lack of space. The local agent's disk is a different store with
 * its own runtime issue; a healthy agent says nothing about these.
 *
 * Kept free of `@lody/shared` imports so `node --test` can load it directly.
 * Contract: `specs/local-storage-health.md`.
 */
export type RendererStorageQuitCheckOptions = {
  /** Pushes `storage.quitCheck` to a window; false when it is gone. */
  send: (windowId: number, requestId: string) => boolean
  timeoutMs: number
  setTimer?: (callback: () => void, delayMs: number) => unknown
  clearTimer?: (handle: unknown) => void
}

export class RendererStorageState {
  private readonly unsaved = new Map<number, number>()
  private readonly pending = new Map<string, (since: number | null) => void>()
  private nextRequest = 1

  report(windowId: number, since: number | null): void {
    if (since === null) this.unsaved.delete(windowId)
    else this.unsaved.set(windowId, since)
  }

  /** The window's renderer is gone; whatever it held in memory went with it. */
  forget(windowId: number): void {
    this.unsaved.delete(windowId)
  }

  earliestUnsaved(): number | null {
    let earliest: number | null = null
    for (const since of this.unsaved.values()) {
      if (earliest === null || since < earliest) earliest = since
    }
    return earliest
  }

  handleQuitCheckResult(windowId: number, requestId: string, since: number | null): void {
    this.report(windowId, since)
    const resolve = this.pending.get(requestId)
    if (!resolve) return
    this.pending.delete(requestId)
    resolve(since)
  }

  /**
   * Asks every window that reported unsaved changes to flush now, and resolves
   * to the earliest change still unsaved. A window that does not answer in time
   * keeps its last report: silence is not proof that it saved.
   */
  async checkBeforeQuit(options: RendererStorageQuitCheckOptions): Promise<number | null> {
    const setTimer =
      options.setTimer ?? ((callback: () => void, delayMs: number) => setTimeout(callback, delayMs))
    const clearTimer = options.clearTimer ?? ((handle: unknown) => clearTimeout(handle as never))
    await Promise.all(
      [...this.unsaved.keys()].map(
        (windowId) =>
          new Promise<void>((resolve) => {
            const requestId = `storage-quit-check-${this.nextRequest++}`
            const timer = setTimer(() => {
              this.pending.delete(requestId)
              resolve()
            }, options.timeoutMs)
            this.pending.set(requestId, () => {
              clearTimer(timer)
              resolve()
            })
            if (!options.send(windowId, requestId)) {
              clearTimer(timer)
              this.pending.delete(requestId)
              this.forget(windowId)
              resolve()
            }
          })
      )
    )
    return this.earliestUnsaved()
  }
}

/**
 * The earliest change anywhere that would be lost by quitting now: the local
 * agent's (its `local_storage_unsaved` runtime issue) or any window's, after
 * those windows got one last chance to flush.
 */
export async function resolveUnsavedBeforeQuit(options: {
  cliUnsavedSince: number | null
  renderer: RendererStorageState
  quitCheck: RendererStorageQuitCheckOptions
}): Promise<number | null> {
  const renderer = await options.renderer.checkBeforeQuit(options.quitCheck)
  const candidates = [options.cliUnsavedSince, renderer].filter(
    (since): since is number => since !== null
  )
  return candidates.length === 0 ? null : Math.min(...candidates)
}
