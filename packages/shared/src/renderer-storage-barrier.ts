/**
 * Which renderer windows hold repo changes their own storage (IndexedDB)
 * refused for lack of space. The local agent's disk is a different store with
 * its own runtime issue; a healthy agent says nothing about these.
 *
 * Self-contained (no imports), so Electron's `node --test` suite and the renderer
 * tests load the same code. Contract: `specs/local-storage-health.md`.
 */
export type RendererStorageQuitCheckOptions = {
  /** Pushes `storage.quitCheck` to a window; false when it is gone. */
  send: (windowId: number, requestId: string) => boolean;
  timeoutMs: number;
  setTimer?: (callback: () => void, delayMs: number) => unknown;
  clearTimer?: (handle: unknown) => void;
};

export class RendererStorageState {
  private readonly unsaved = new Map<number, number>();
  /** Bumped by every unsaved report: an approval is only valid for the generation it saw. */
  private readonly generations = new Map<number, number>();
  private readonly pending = new Map<string, (since: number | null) => void>();
  private nextRequest = 1;

  /**
   * A window's current unsaved state. The renderer reports again on every newly
   * refused write (its revision), even when the earliest `since` is unchanged,
   * so each unsaved report is news.
   */
  report(windowId: number, since: number | null): void {
    if (since === null) {
      this.unsaved.delete(windowId);
      return;
    }
    this.unsaved.set(windowId, since);
    this.generations.set(windowId, this.generation(windowId) + 1);
  }

  generation(windowId: number): number {
    return this.generations.get(windowId) ?? 0;
  }

  /**
   * Drops the window's report. Only for a teardown the window barrier approved
   * (its flush saved everything, or the user chose to discard), or for a
   * renderer that is already gone. Returns what was dropped.
   */
  forget(windowId: number): number | null {
    const since = this.unsaved.get(windowId) ?? null;
    this.unsaved.delete(windowId);
    return since;
  }

  unsavedSince(windowId: number): number | null {
    return this.unsaved.get(windowId) ?? null;
  }

  earliestUnsaved(): number | null {
    let earliest: number | null = null;
    for (const since of this.unsaved.values()) {
      if (earliest === null || since < earliest) earliest = since;
    }
    return earliest;
  }

  handleQuitCheckResult(windowId: number, requestId: string, since: number | null): void {
    this.report(windowId, since);
    const resolve = this.pending.get(requestId);
    if (!resolve) return;
    this.pending.delete(requestId);
    resolve(since);
  }

  /**
   * Asks every window that reported unsaved changes to flush now, and resolves
   * to the earliest change still unsaved. A window that does not answer in time
   * keeps its last report: silence is not proof that it saved.
   */
  async checkBeforeQuit(options: RendererStorageQuitCheckOptions): Promise<number | null> {
    await Promise.all([...this.unsaved.keys()].map((windowId) => this.ask(windowId, options)));
    return this.earliestUnsaved();
  }

  /** Same as {@link checkBeforeQuit}, for one window about to close or reload. */
  async checkWindow(
    windowId: number,
    options: RendererStorageQuitCheckOptions
  ): Promise<number | null> {
    if (this.unsaved.has(windowId)) await this.ask(windowId, options);
    return this.unsavedSince(windowId);
  }

  /** Resolves once the window answered or timed out; its report is then current. */
  private ask(windowId: number, options: RendererStorageQuitCheckOptions): Promise<void> {
    const setTimer =
      options.setTimer ??
      ((callback: () => void, delayMs: number) => setTimeout(callback, delayMs));
    const clearTimer = options.clearTimer ?? ((handle: unknown) => clearTimeout(handle as never));
    return new Promise<void>((resolve) => {
      const requestId = `storage-quit-check-${this.nextRequest++}`;
      const timer = setTimer(() => {
        this.pending.delete(requestId);
        resolve();
      }, options.timeoutMs);
      this.pending.set(requestId, () => {
        clearTimer(timer);
        resolve();
      });
      // A window that cannot be asked keeps its last report: not being able to
      // ask is not proof that it saved.
      if (!options.send(windowId, requestId)) {
        clearTimer(timer);
        this.pending.delete(requestId);
        resolve();
      }
    });
  }
}

export type WindowTeardownKind = 'close' | 'reload' | 'sign-out' | 'clear-cache';

export type WindowStorageBarrierOptions = {
  state: RendererStorageState;
  quitCheck: RendererStorageQuitCheckOptions;
  /**
   * A quit the user approved through the quit storage check is in progress:
   * every window was asked already, so windows unload freely. Never the global
   * "app is quitting" flag, which other code sets before any check and which a
   * cancelled quit must not leave behind.
   */
  quitApproved: () => boolean;
  /** Asks whether to drop changes still unsaved after the window's final flush. */
  confirmDiscard: (since: number, kind: WindowTeardownKind) => Promise<boolean>;
  /** A renderer went away without an approved teardown (crash, forced destroy). */
  reportLost?: (windowId: number, since: number) => void;
  now?: () => number;
  /**
   * How long an approval stays usable. It covers the unload it was given for:
   * the repeated close/reload, or the user retrying a navigation the page
   * started itself (which main cannot repeat). Default 10 s.
   */
  approvalTtlMs?: number;
};

/** One unload the barrier allows: for the unsaved generation it saw, once, soon. */
type Approval = { generation: number; expiresAt: number };

type TeardownIntent = { kind: WindowTeardownKind; redo: () => void };

/**
 * Per-window counterpart of the quit barrier. A window whose own repo holds
 * unsaved changes cancels its unload (`beforeunload`), and Electron reports that
 * as `will-prevent-unload`. The barrier then asks the window to flush; the close
 * or reload goes ahead only once it saved everything, or once the user chose to
 * discard, and it is repeated on the window's behalf. Cancelling keeps the
 * window and its repo, which recovery keeps retrying.
 */
export class WindowStorageBarrier {
  private readonly intents = new Map<number, TeardownIntent>();
  private readonly approvals = new Map<number, Approval>();
  /** Unloads an approval let through, until the document is really gone. */
  private readonly unloading = new Map<number, number>();
  private readonly decisions = new Map<number, Promise<void>>();
  // No parameter property: `node --test` strips types and cannot compile one.
  private readonly options: WindowStorageBarrierOptions;

  constructor(options: WindowStorageBarrierOptions) {
    this.options = options;
  }

  /** Records what a main-initiated close or reload should repeat once approved. */
  noteIntent(windowId: number, kind: WindowTeardownKind, redo: () => void): void {
    this.intents.set(windowId, { kind, redo });
  }

  /**
   * `will-prevent-unload`: returns true when the unload should proceed now
   * (the caller then calls `event.preventDefault()` to override the renderer).
   */
  onUnloadPrevented(windowId: number): boolean {
    if (this.options.quitApproved() || this.consumeApproval(windowId)) return true;
    if (this.decisions.has(windowId)) return false;
    const intent = this.intents.get(windowId);
    this.intents.delete(windowId);
    const decision = this.decide(windowId, intent).finally(() => {
      this.decisions.delete(windowId);
    });
    this.decisions.set(windowId, decision);
    return false;
  }

  /** Resolves once the window's pending teardown decision (if any) was made. */
  whenDecided(windowId: number): Promise<void> {
    return this.decisions.get(windowId) ?? Promise.resolve();
  }

  private async decide(windowId: number, intent: TeardownIntent | undefined): Promise<void> {
    const since = await this.options.state.checkWindow(windowId, this.options.quitCheck);
    const allowed =
      since === null ||
      (await this.options.confirmDiscard(since, intent?.kind ?? 'reload').catch(() => false));
    if (!allowed) return;
    // The report stays: until the window really unloads, its changes are still
    // only in memory, and a later quit must still see them.
    this.grantApproval(windowId);
    // A renderer-initiated navigation has nothing to repeat: the user retries it
    // within the approval's lifetime, or is asked again.
    intent?.redo();
  }

  private grantApproval(windowId: number): void {
    this.approvals.set(windowId, {
      generation: this.options.state.generation(windowId),
      expiresAt: this.now() + (this.options.approvalTtlMs ?? 10_000),
    });
  }

  /**
   * Single use, and only for the unsaved state it was given for: a newer
   * report (a write refused after the approval) or expiry voids it.
   */
  private consumeApproval(windowId: number): boolean {
    const approval = this.approvals.get(windowId);
    this.approvals.delete(windowId);
    const valid =
      approval !== undefined &&
      approval.generation === this.options.state.generation(windowId) &&
      this.now() < approval.expiresAt;
    if (valid) this.unloading.set(windowId, approval.generation);
    return valid;
  }

  private now(): number {
    return (this.options.now ?? Date.now)();
  }

  /**
   * For a teardown main performs itself (sign-out, cache clear) with `destroy()`,
   * which runs no `beforeunload`: every listed window holding unsaved changes is
   * asked to flush, and what is still unsaved gets one confirmation. Resolves to
   * true (and approves those windows) only when all saved or the user chose to
   * discard; false leaves every window, repo and report as it was.
   *
   * Flushing and asking take time, and any listed window can have a write
   * refused meanwhile. So this runs in rounds over the full list, not over a
   * first snapshot: a window that became unsaved during the flushes is flushed
   * in another round before anyone is asked about it, and a report that arrives
   * while the user is looking at the question starts another round. Only a
   * round in which nothing changed is approved, for exactly the generations
   * the user was asked about.
   */
  async approveTeardown(windowIds: readonly number[], kind: WindowTeardownKind): Promise<boolean> {
    const { state } = this.options;
    const unsavedIds = () => windowIds.filter((windowId) => state.unsavedSince(windowId) !== null);
    for (;;) {
      const flushed = unsavedIds();
      await Promise.all(
        flushed.map((windowId) => state.checkWindow(windowId, this.options.quitCheck))
      );
      const unsaved = unsavedIds();
      // Unsaved since this round's flushes began: it gets a flush of its own first.
      if (unsaved.some((windowId) => !flushed.includes(windowId))) continue;
      const asked = new Map(windowIds.map((windowId) => [windowId, state.generation(windowId)]));
      if (unsaved.length > 0) {
        const earliest = Math.min(
          ...unsaved.map((windowId) => state.unsavedSince(windowId) ?? Number.POSITIVE_INFINITY)
        );
        const allowed = await this.options.confirmDiscard(earliest, kind).catch(() => false);
        if (!allowed) return false;
      }
      // The answer covers only what was asked about.
      if (windowIds.some((windowId) => state.generation(windowId) !== asked.get(windowId))) {
        continue;
      }
      for (const windowId of unsaved) this.grantApproval(windowId);
      return true;
    }
  }

  /**
   * Whether `destroy()` may run on this window now: it holds nothing unsaved, or
   * its unsaved state is exactly what an approval covers.
   */
  mayTearDown(windowId: number): boolean {
    const { state } = this.options;
    if (state.unsavedSince(windowId) === null) return true;
    const approval = this.approvals.get(windowId);
    return (
      approval !== undefined &&
      approval.generation === state.generation(windowId) &&
      this.now() < approval.expiresAt
    );
  }

  /** The window's document was replaced or its renderer is gone. */
  documentGone(windowId: number): void {
    const generation = this.options.state.generation(windowId);
    // Approved means approved for exactly the unsaved state that was dropped.
    const approved =
      this.unloading.get(windowId) === generation ||
      this.approvals.get(windowId)?.generation === generation;
    this.approvals.delete(windowId);
    this.unloading.delete(windowId);
    this.intents.delete(windowId);
    const dropped = this.options.state.forget(windowId);
    if (!approved && dropped !== null) this.options.reportLost?.(windowId, dropped);
  }
}

/**
 * The earliest change anywhere that would be lost by quitting now: the local
 * agent's (its `local_storage_unsaved` runtime issue) or any window's, after
 * those windows got one last chance to flush.
 */
export async function resolveUnsavedBeforeQuit(options: {
  cliUnsavedSince: number | null;
  renderer: RendererStorageState;
  quitCheck: RendererStorageQuitCheckOptions;
}): Promise<number | null> {
  const renderer = await options.renderer.checkBeforeQuit(options.quitCheck);
  const candidates = [options.cliUnsavedSince, renderer].filter(
    (since): since is number => since !== null
  );
  return candidates.length === 0 ? null : Math.min(...candidates);
}

/**
 * Destroys every listed window except `keep`, but only after
 * {@link WindowStorageBarrier.approveTeardown} approved them all (including
 * `keep`, whose own repo the caller is about to invalidate). Resolves to false,
 * destroying nothing, when the user kept unsaved changes.
 */
export async function tearDownWindows(options: {
  barrier: WindowStorageBarrier;
  windowIds: readonly number[];
  keep?: number;
  kind: WindowTeardownKind;
  destroy: (windowId: number) => void;
}): Promise<boolean> {
  const doomed = options.windowIds.filter((windowId) => windowId !== options.keep);
  for (;;) {
    if (!(await options.barrier.approveTeardown(options.windowIds, options.kind))) return false;
    // Last look before destroy(): anything that changed since approval is asked about again.
    if (doomed.every((windowId) => options.barrier.mayTearDown(windowId))) break;
  }
  for (const windowId of doomed) options.destroy(windowId);
  return true;
}

/** Auth error code when the user kept unsaved changes instead of signing out. */
export const SIGN_OUT_CANCELLED_CODE = 'sign_out_cancelled_unsaved_storage';

export type QuitCoordinator = {
  /**
   * Flushes and, if needed, asks before anything quits (menu, last window,
   * updater). Idempotent while an approved quit is in progress.
   */
  approve: () => Promise<boolean>;
  /** The quit did not go ahead (cancelled, install or stop failed): undo approval. */
  abort: () => void;
  isApproved: () => boolean;
};

/**
 * The one owner of quit approval. A cancel resets the global "app is quitting"
 * flag too: other code sets that flag before asking (updaters must, since
 * Electron's updater closes windows before `before-quit`), and a flag left
 * behind would let every later window close/reload skip the storage barrier.
 */
export function createQuitCoordinator(options: {
  /** The earliest change a quit would lose, after a final flush; null if none. */
  unsavedSince: () => Promise<number | null>;
  confirmDiscard: (since: number) => Promise<boolean>;
  setAppQuitting: (quitting: boolean) => void;
}): QuitCoordinator {
  let approved = false;
  const abort = () => {
    approved = false;
    options.setAppQuitting(false);
  };
  return {
    isApproved: () => approved,
    abort,
    approve: async () => {
      if (approved) return true;
      const since = await options.unsavedSince();
      if (since !== null && !(await options.confirmDiscard(since).catch(() => false))) {
        abort();
        return false;
      }
      approved = true;
      return true;
    },
  };
}
