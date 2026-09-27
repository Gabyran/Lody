import type { StorageAdapter } from 'loro-repo';
import { observeStorageAdapterWrites } from './observed-storage-adapter';
import { isStorageFullError } from './storage-health';

export type StorageFullRecoveryOptions = {
  /** Persists everything the repo still holds dirty; rejects if any of it fails. */
  flush: () => Promise<void>;
  /** Fires when an episode starts (`{ since }`) and when it ends (`null`). */
  onChange: (state: { since: number } | null) => void;
  now?: () => number;
  setTimer?: (callback: () => void, delayMs: number) => unknown;
  clearTimer?: (handle: unknown) => void;
  /**
   * Delays before retry attempt N while the episode lasts; the last entry
   * repeats. The first entry is also the minimum gap between two attempts, so a
   * burst of successful writes cannot turn into a burst of flushes.
   */
  retryDelaysMs?: readonly number[];
};

const DEFAULT_RETRY_DELAYS_MS = [5_000, 15_000, 60_000] as const;

/**
 * One repo's "storage is full" episode, for a writer without a process-wide
 * monitor (the renderer's IndexedDB repo). Contract: `specs/local-storage-health.md`.
 *
 * A successful write proves only that SOME write fit: a failed save of another
 * resource (say, workspace meta) is still dirty in memory. So a success never
 * ends the episode by itself; it only asks for a recovery flush. The episode
 * ends when that flush succeeds and no classified failure arrived while it ran
 * (a generation fence). A failed flush keeps the episode and retries on a
 * bounded backoff, even when nothing else writes.
 */
export class StorageFullRecovery {
  private readonly now: () => number;
  private readonly setTimer: (callback: () => void, delayMs: number) => unknown;
  private readonly clearTimer: (handle: unknown) => void;
  private readonly retryDelaysMs: readonly number[];
  private sinceMs: number | null = null;
  private generation = 0;
  private attempt = 0;
  private lastAttemptAt: number | null = null;
  private timer: unknown = null;
  private flushing: Promise<void> | null = null;
  private disposed = false;

  constructor(private readonly options: StorageFullRecoveryOptions) {
    this.now = options.now ?? Date.now;
    this.setTimer =
      options.setTimer ??
      ((callback, delayMs) => {
        const handle = setTimeout(callback, delayMs);
        (handle as { unref?: () => void }).unref?.();
        return handle;
      });
    this.clearTimer = options.clearTimer ?? ((handle) => clearTimeout(handle as never));
    this.retryDelaysMs =
      options.retryDelaysMs && options.retryDelaysMs.length > 0
        ? options.retryDelaysMs
        : DEFAULT_RETRY_DELAYS_MS;
  }

  /** First unrecovered storage-full failure of this episode, or null. */
  get since(): number | null {
    return this.sinceMs;
  }

  /** Returns true when the failure was storage-full and now belongs to the episode. */
  reportWriteFailed(error: unknown): boolean {
    if (this.disposed || !isStorageFullError(error)) return false;
    this.generation += 1;
    if (this.sinceMs === null) {
      this.sinceMs = this.now();
      this.attempt = 0;
      this.options.onChange({ since: this.sinceMs });
    }
    // Retry even if nothing else writes: the dirty data must not wait for a user edit.
    if (!this.flushing) this.scheduleRetry();
    return true;
  }

  /** A write fit; if an episode is open, flush everything held dirty (rate-limited). */
  reportWriteSucceeded(): void {
    if (this.disposed || this.sinceMs === null || this.flushing) return;
    const minGap = this.retryDelaysMs[0] ?? 0;
    const wait =
      this.lastAttemptAt === null ? 0 : Math.max(0, this.lastAttemptAt + minGap - this.now());
    if (wait === 0) {
      this.cancelTimer();
      void this.recover();
      return;
    }
    if (this.timer === null) this.arm(wait);
  }

  /**
   * Flushes now, ignoring the rate limit (the app is about to quit and asks
   * for a final answer). Resolves once that attempt settled.
   */
  async flushNow(): Promise<void> {
    if (this.disposed || this.sinceMs === null) return;
    await this.settled();
    if (this.sinceMs === null) return;
    this.cancelTimer();
    await this.recover();
  }

  /** Resolves once no recovery flush started by this object is running. */
  async settled(): Promise<void> {
    while (this.flushing) {
      await this.flushing;
    }
  }

  dispose(): void {
    this.disposed = true;
    this.cancelTimer();
  }

  private recover(): Promise<void> {
    if (this.flushing) return this.flushing;
    const generation = this.generation;
    this.lastAttemptAt = this.now();
    const run = (async () => {
      let ok = true;
      try {
        await this.options.flush();
      } catch {
        ok = false;
      }
      if (this.disposed || this.sinceMs === null) return;
      if (ok && this.generation === generation) {
        this.sinceMs = null;
        this.attempt = 0;
        this.options.onChange(null);
        return;
      }
      this.attempt += 1;
      this.scheduleRetry();
    })();
    this.flushing = run.finally(() => {
      this.flushing = null;
    });
    return this.flushing;
  }

  private scheduleRetry(): void {
    if (this.disposed || this.timer !== null) return;
    const index = Math.min(this.attempt, this.retryDelaysMs.length - 1);
    this.arm(this.retryDelaysMs[index] ?? 0);
  }

  private arm(delayMs: number): void {
    this.timer = this.setTimer(() => {
      this.timer = null;
      if (this.sinceMs !== null) void this.recover();
    }, delayMs);
  }

  private cancelTimer(): void {
    if (this.timer === null) return;
    this.clearTimer(this.timer);
    this.timer = null;
  }
}

type GuardedRepo = { flush(): Promise<void>; destroy(): Promise<void> };

export type RepoStorageGuardOptions = Omit<StorageFullRecoveryOptions, 'flush' | 'onChange'> & {
  /** The episode's first unsaved failure, or null once everything was saved. */
  onUnsavedChange: (since: number | null) => void;
  /** The repo was destroyed; after a retained close, only once its changes were saved. */
  onClosed?: () => void;
  /**
   * Every write refused for lack of space, including those inside an episode
   * that already started (whose `since` does not change). Lets a caller notice
   * data that became unsaved after it last looked.
   */
  onWriteRefused?: () => void;
};

/**
 * Owns one repo's storage lifecycle for a writer without a process-wide
 * monitor (the renderer): it observes the adapter, runs {@link StorageFullRecovery},
 * and closes the repo without dropping changes that did not reach storage.
 */
export class RepoStorageGuard {
  readonly adapter: StorageAdapter;
  private readonly recovery: StorageFullRecovery;
  private repo: GuardedRepo | null = null;
  private closing = false;
  private closed = false;

  constructor(
    inner: StorageAdapter,
    private readonly options: RepoStorageGuardOptions
  ) {
    const {
      onUnsavedChange: _onUnsavedChange,
      onClosed: _onClosed,
      onWriteRefused: _onWriteRefused,
      ...timing
    } = options;
    this.recovery = new StorageFullRecovery({
      ...timing,
      flush: async () => {
        if (!this.repo) throw new Error('repo not ready');
        await this.repo.flush();
      },
      onChange: (state) => {
        options.onUnsavedChange(state?.since ?? null);
        // A close that had to wait for space finishes as soon as recovery saved everything.
        if (state === null && this.closing) void this.finishClose();
      },
    });
    this.adapter = observeStorageAdapterWrites(inner, {
      onWriteFailed: (error) => {
        if (this.recovery.reportWriteFailed(error)) options.onWriteRefused?.();
      },
      onWriteSucceeded: () => this.recovery.reportWriteSucceeded(),
    });
  }

  attach(repo: GuardedRepo): void {
    this.repo = repo;
  }

  get unsavedSince(): number | null {
    return this.recovery.since;
  }

  /** Flushes now; resolves to the episode still open, or null once everything is saved. */
  async flushNow(): Promise<number | null> {
    await this.recovery.flushNow();
    return this.recovery.since;
  }

  /**
   * Final flush, then destroy. When changes are still unsaved (the flush was
   * refused for lack of space, or an earlier episode never ended), the repo
   * stays open and recovery keeps retrying; it is destroyed once saved.
   */
  async close(): Promise<'closed' | 'retained'> {
    if (this.closing) return this.closed ? 'closed' : 'retained';
    this.closing = true;
    try {
      await this.repo?.flush();
    } catch (error) {
      // A non-storage failure is not this guard's to hold on to; destroy reports it.
      this.recovery.reportWriteFailed(error);
    }
    if (this.recovery.since !== null) return 'retained';
    await this.finishClose();
    return 'closed';
  }

  private async finishClose(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.recovery.dispose();
    try {
      await this.repo?.destroy();
    } finally {
      this.options.onClosed?.();
    }
  }
}
