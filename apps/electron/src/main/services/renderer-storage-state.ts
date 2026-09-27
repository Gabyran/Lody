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

  /**
   * Drops the window's report. Only for a teardown the window barrier approved
   * (its flush saved everything, or the user chose to discard), or for a
   * renderer that is already gone. Returns what was dropped.
   */
  forget(windowId: number): number | null {
    const since = this.unsaved.get(windowId) ?? null
    this.unsaved.delete(windowId)
    return since
  }

  unsavedSince(windowId: number): number | null {
    return this.unsaved.get(windowId) ?? null
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
    await Promise.all([...this.unsaved.keys()].map((windowId) => this.ask(windowId, options)))
    return this.earliestUnsaved()
  }

  /** Same as {@link checkBeforeQuit}, for one window about to close or reload. */
  async checkWindow(
    windowId: number,
    options: RendererStorageQuitCheckOptions
  ): Promise<number | null> {
    if (this.unsaved.has(windowId)) await this.ask(windowId, options)
    return this.unsavedSince(windowId)
  }

  /** Resolves once the window answered or timed out; its report is then current. */
  private ask(windowId: number, options: RendererStorageQuitCheckOptions): Promise<void> {
    const setTimer =
      options.setTimer ?? ((callback: () => void, delayMs: number) => setTimeout(callback, delayMs))
    const clearTimer = options.clearTimer ?? ((handle: unknown) => clearTimeout(handle as never))
    return new Promise<void>((resolve) => {
      const requestId = `storage-quit-check-${this.nextRequest++}`
      const timer = setTimer(() => {
        this.pending.delete(requestId)
        resolve()
      }, options.timeoutMs)
      this.pending.set(requestId, () => {
        clearTimer(timer)
        resolve()
      })
      // A window that cannot be asked keeps its last report: not being able to
      // ask is not proof that it saved.
      if (!options.send(windowId, requestId)) {
        clearTimer(timer)
        this.pending.delete(requestId)
        resolve()
      }
    })
  }
}

export type WindowTeardownKind = 'close' | 'reload'

export type WindowStorageBarrierOptions = {
  state: RendererStorageState
  quitCheck: RendererStorageQuitCheckOptions
  /** The app is quitting: its own barrier already asked; let every window go. */
  isQuitting: () => boolean
  /** Asks whether to drop changes still unsaved after the window's final flush. */
  confirmDiscard: (since: number, kind: WindowTeardownKind) => Promise<boolean>
  /** A renderer went away without an approved teardown (crash, forced destroy). */
  reportLost?: (windowId: number, since: number) => void
}

type TeardownIntent = { kind: WindowTeardownKind; redo: () => void }

/**
 * Per-window counterpart of the quit barrier. A window whose own repo holds
 * unsaved changes cancels its unload (`beforeunload`), and Electron reports that
 * as `will-prevent-unload`. The barrier then asks the window to flush; the close
 * or reload goes ahead only once it saved everything, or once the user chose to
 * discard, and it is repeated on the window's behalf. Cancelling keeps the
 * window and its repo, which recovery keeps retrying.
 */
export class WindowStorageBarrier {
  private readonly intents = new Map<number, TeardownIntent>()
  private readonly approved = new Set<number>()
  private readonly decisions = new Map<number, Promise<void>>()
  // No parameter property: `node --test` strips types and cannot compile one.
  private readonly options: WindowStorageBarrierOptions

  constructor(options: WindowStorageBarrierOptions) {
    this.options = options
  }

  /** Records what a main-initiated close or reload should repeat once approved. */
  noteIntent(windowId: number, kind: WindowTeardownKind, redo: () => void): void {
    this.intents.set(windowId, { kind, redo })
  }

  /**
   * `will-prevent-unload`: returns true when the unload should proceed now
   * (the caller then calls `event.preventDefault()` to override the renderer).
   */
  onUnloadPrevented(windowId: number): boolean {
    if (this.options.isQuitting() || this.approved.has(windowId)) return true
    if (this.decisions.has(windowId)) return false
    const intent = this.intents.get(windowId)
    this.intents.delete(windowId)
    const decision = this.decide(windowId, intent).finally(() => {
      this.decisions.delete(windowId)
    })
    this.decisions.set(windowId, decision)
    return false
  }

  /** Resolves once the window's pending teardown decision (if any) was made. */
  whenDecided(windowId: number): Promise<void> {
    return this.decisions.get(windowId) ?? Promise.resolve()
  }

  private async decide(windowId: number, intent: TeardownIntent | undefined): Promise<void> {
    const since = await this.options.state.checkWindow(windowId, this.options.quitCheck)
    const allowed =
      since === null ||
      (await this.options.confirmDiscard(since, intent?.kind ?? 'reload').catch(() => false))
    if (!allowed) return
    this.approved.add(windowId)
    this.options.state.forget(windowId)
    // A renderer-initiated navigation has nothing to repeat: the user retries it.
    intent?.redo()
  }

  /** The window's document was replaced or its renderer is gone. */
  documentGone(windowId: number): void {
    const wasApproved = this.approved.delete(windowId)
    this.intents.delete(windowId)
    const dropped = this.options.state.forget(windowId)
    if (!wasApproved && dropped !== null) this.options.reportLost?.(windowId, dropped)
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
