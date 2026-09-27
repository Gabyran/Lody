import { statfs } from 'node:fs/promises';
import {
  StorageCriticalError,
  classifyStorageFullError,
  type LodyMachineStorageHealth,
  type LodyStorageHealthLevel,
  type LodyStorageHealthReason,
  type StorageFullErrorCode,
} from '@lody/shared';
import type { Logger } from '@/utils/logger';
import { formatErrorMessage } from '@/utils/format-error';

/**
 * Local storage health of the volume holding the Lody data directory, and the
 * degraded mode that follows from it. Contract: `specs/local-storage-health.md`.
 *
 * Two independent signals feed one level:
 * - free space from a periodic `statfs` of the data directory, and
 * - classified write failures (`ENOSPC`, `EDQUOT`, `SQLITE_FULL`, loro-repo
 *   `quota`) reported by the storage boundaries, which apply immediately.
 *
 * A write failure means repo changes exist only in memory. It clears only after
 * every registered flush target has flushed successfully, never because free
 * space merely looks better.
 */

const MIB = 1024 * 1024;
const GIB = 1024 * MIB;

export type StorageSpace = { availableBytes: number; totalBytes: number };
export type StorageThresholds = { warningBytes: number; criticalBytes: number };

const clamp = (value: number, min: number, max: number): number =>
  Math.min(Math.max(value, min), max);

/**
 * Free-space thresholds for a volume of `totalBytes`.
 *
 * - critical: 1% of the volume, at least 256 MiB and at most 1 GiB. 256 MiB is
 *   enough headroom for a repo flush, SQLite's journal and a checkpoint, but
 *   not for a new worktree or dependency install; 1 GiB caps it so a large disk
 *   is not degraded while gigabytes are still free.
 * - warning: 5% of the volume, at least 1 GiB and at most 5 GiB, so the user
 *   hears about it well before work is refused.
 *
 * On a small volume both floors would exceed the disk itself, so critical is
 * also capped at a quarter and warning at half of the volume.
 */
export const computeStorageThresholds = (totalBytes: number): StorageThresholds => ({
  criticalBytes: Math.min(clamp(totalBytes * 0.01, 256 * MIB, GIB), totalBytes * 0.25),
  warningBytes: Math.min(clamp(totalBytes * 0.05, GIB, 5 * GIB), totalBytes * 0.5),
});

/** A level is left only once free space clears its threshold by this factor. */
const HYSTERESIS_FACTOR = 1.1;

export const classifyStorageSpace = (
  space: StorageSpace,
  previous: LodyStorageHealthLevel
): LodyStorageHealthLevel => {
  const { criticalBytes, warningBytes } = computeStorageThresholds(space.totalBytes);
  const exitFactor = (level: LodyStorageHealthLevel) =>
    previous === level || (previous === 'critical' && level === 'warning') ? HYSTERESIS_FACTOR : 1;
  if (space.availableBytes < criticalBytes * exitFactor('critical')) return 'critical';
  if (space.availableBytes < warningBytes * exitFactor('warning')) return 'warning';
  return 'ok';
};

export type StorageHealthSnapshot = {
  level: LodyStorageHealthLevel;
  reason: LodyStorageHealthReason | null;
  space: StorageSpace | null;
  /** First classified write failure not yet recovered by a successful flush. */
  unsavedSince: number | null;
  lastFailureCode: StorageFullErrorCode | null;
};

type FlushTarget = { name: string; flush: () => Promise<void> };

export type StorageHealthMonitorOptions = {
  dataDir: string;
  logger: Pick<Logger, 'warn' | 'info' | 'debug'>;
  now?: () => number;
  readSpace?: (dir: string) => Promise<StorageSpace>;
  setTimer?: (callback: () => void, delayMs: number) => unknown;
  clearTimer?: (handle: unknown) => void;
  /** Poll interval while healthy. */
  healthyIntervalMs?: number;
  /** Poll interval while warning, critical or holding unsaved changes. */
  degradedIntervalMs?: number;
  /** Minimum gap between two recovery flush attempts. */
  recoveryMinIntervalMs?: number;
  /** Minimum gap between two repeated failure warnings in the log. */
  warnIntervalMs?: number;
};

export const readStorageSpace = async (dir: string): Promise<StorageSpace> => {
  const stats = await statfs(dir);
  return {
    availableBytes: Number(stats.bavail) * Number(stats.bsize),
    totalBytes: Number(stats.blocks) * Number(stats.bsize),
  };
};

const formatBytes = (bytes: number): string =>
  bytes >= GIB ? `${(bytes / GIB).toFixed(1)} GiB` : `${Math.round(bytes / MIB)} MiB`;

export class StorageHealthMonitor {
  private readonly now: () => number;
  private readonly readSpace: (dir: string) => Promise<StorageSpace>;
  private readonly setTimer: (callback: () => void, delayMs: number) => unknown;
  private readonly clearTimer: (handle: unknown) => void;
  private readonly healthyIntervalMs: number;
  private readonly degradedIntervalMs: number;
  private readonly recoveryMinIntervalMs: number;
  private readonly warnIntervalMs: number;

  private spaceLevel: LodyStorageHealthLevel = 'ok';
  private space: StorageSpace | null = null;
  private spaceSampledAt: number | null = null;
  private unsavedSince: number | null = null;
  private lastFailureCode: StorageFullErrorCode | null = null;
  /** Bumped on every classified failure, so a recovery that raced one does not clear it. */
  private failureGeneration = 0;
  private failuresSinceWarn = 0;
  private lastWarnAt: number | null = null;

  private pollTimer: unknown = null;
  private recoveryTimer: unknown = null;
  private recovering: Promise<void> | null = null;
  private lastRecoveryAt: number | null = null;
  private started = false;
  private stopped = false;
  private published: string;
  private readonly inflight = new Set<Promise<unknown>>();
  private readonly targets = new Set<FlushTarget>();
  private readonly listeners = new Set<(snapshot: StorageHealthSnapshot) => void>();

  constructor(private readonly options: StorageHealthMonitorOptions) {
    this.now = options.now ?? Date.now;
    this.readSpace = options.readSpace ?? readStorageSpace;
    this.setTimer =
      options.setTimer ??
      ((callback, delayMs) => {
        const handle = setTimeout(callback, delayMs);
        handle.unref?.();
        return handle;
      });
    this.clearTimer = options.clearTimer ?? ((handle) => clearTimeout(handle as never));
    this.healthyIntervalMs = options.healthyIntervalMs ?? 60_000;
    this.degradedIntervalMs = options.degradedIntervalMs ?? 10_000;
    this.recoveryMinIntervalMs = options.recoveryMinIntervalMs ?? 5_000;
    this.warnIntervalMs = options.warnIntervalMs ?? 5 * 60_000;
    this.published = this.transitionKey();
  }

  /** Samples once and keeps polling until {@link stop}. */
  async start(): Promise<void> {
    if (this.started || this.stopped) return;
    this.started = true;
    await this.poll();
  }

  stop(): void {
    this.stopped = true;
    this.cancelTimer('pollTimer');
    this.cancelTimer('recoveryTimer');
    this.listeners.clear();
    this.targets.clear();
  }

  getSnapshot(): StorageHealthSnapshot {
    const writeFailed = this.unsavedSince !== null;
    const level: LodyStorageHealthLevel = writeFailed ? 'critical' : this.spaceLevel;
    return {
      level,
      reason: writeFailed ? 'write-failed' : level === 'ok' ? null : 'low-space',
      space: this.space,
      unsavedSince: this.unsavedSince,
      lastFailureCode: this.lastFailureCode,
    };
  }

  /** The presence field for the machine heartbeat; undefined while healthy. */
  getPresenceField(): LodyMachineStorageHealth | undefined {
    const snapshot = this.getSnapshot();
    if (snapshot.level === 'ok' || !snapshot.reason) return undefined;
    return {
      level: snapshot.level,
      reason: snapshot.reason,
      ...(snapshot.space ? { availableBytes: snapshot.space.availableBytes } : {}),
      ...(snapshot.unsavedSince !== null ? { unsavedSince: snapshot.unsavedSince } : {}),
    };
  }

  /**
   * Fires on level/reason/unsaved transitions only, never on a plain change of
   * free bytes, so a subscriber can publish on every call without a rate limit
   * of its own. Polling and recovery attempts are both interval-bounded.
   */
  subscribe(listener: (snapshot: StorageHealthSnapshot) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /**
   * Registers a repo whose pending changes must be flushed once storage
   * recovers. A write failure clears only when every target flushed.
   */
  registerFlushTarget(name: string, flush: () => Promise<void>): () => void {
    const target: FlushTarget = { name, flush };
    this.targets.add(target);
    return () => this.targets.delete(target);
  }

  /**
   * Reports a failed local write. Returns true when it was a storage-full
   * failure, which puts the monitor in `critical` immediately.
   */
  reportWriteFailure(error: unknown, context: string): boolean {
    const code = classifyStorageFullError(error);
    if (!code || this.stopped) return false;
    const now = this.now();
    this.lastFailureCode = code;
    this.failureGeneration += 1;
    this.failuresSinceWarn += 1;
    if (this.unsavedSince === null) {
      this.unsavedSince = now;
      this.lastWarnAt = now;
      this.failuresSinceWarn = 0;
      this.options.logger.warn(
        `[storage] Local write failed (${code}) in ${context}: ${formatErrorMessage(error)}. ` +
          'Changes stay in memory and are saved once space is freed; disk-heavy work is paused.'
      );
      this.emitIfChanged();
      this.reschedulePoll();
    } else if (this.lastWarnAt === null || now - this.lastWarnAt >= this.warnIntervalMs) {
      this.options.logger.warn(
        `[storage] Local writes still failing (${code}); ${this.failuresSinceWarn} more failure(s), ` +
          `changes unsaved since ${new Date(this.unsavedSince).toISOString()}`
      );
      this.lastWarnAt = now;
      this.failuresSinceWarn = 0;
    }
    return true;
  }

  /**
   * Reports a successful local write. It proves space exists again, so a
   * pending write failure triggers a recovery flush (interval-bounded).
   */
  reportWriteSuccess(): void {
    if (this.unsavedSince !== null && !this.recovering) {
      this.requestRecovery();
    }
  }

  /**
   * Refuses disk-heavy work while critical, with an error the caller can show
   * as is. Re-samples free space when the last sample is older than `maxAgeMs`,
   * so the gate reacts faster than the poll interval.
   */
  async assertCanStartDiskHeavyWork(operation: string, maxAgeMs = 2_000): Promise<void> {
    if (
      this.started &&
      !this.stopped &&
      (this.spaceSampledAt === null || this.now() - this.spaceSampledAt > maxAgeMs)
    ) {
      await this.sample();
    }
    if (this.getSnapshot().level === 'critical') {
      throw new StorageCriticalError(operation);
    }
  }

  /** Resolves once no poll or recovery flush started by the monitor is running. */
  async settled(): Promise<void> {
    while (this.inflight.size > 0) {
      await Promise.allSettled([...this.inflight]);
    }
  }

  private track(work: Promise<unknown>): void {
    const tracked = work.finally(() => this.inflight.delete(tracked));
    this.inflight.add(tracked);
  }

  /** True while changes failed to reach disk; used to warn at exit. */
  hasUnsavedChanges(): boolean {
    return this.unsavedSince !== null;
  }

  private async poll(): Promise<void> {
    this.pollTimer = null;
    if (this.stopped) return;
    await this.sample();
    if (
      this.unsavedSince !== null &&
      this.space &&
      this.space.availableBytes >= computeStorageThresholds(this.space.totalBytes).criticalBytes
    ) {
      this.requestRecovery();
    }
    this.reschedulePoll();
  }

  private async sample(): Promise<void> {
    let space: StorageSpace;
    try {
      space = await this.readSpace(this.options.dataDir);
    } catch (error) {
      // statfs failing says nothing about space; keep the last known level.
      this.options.logger.debug(`[storage] statfs failed: ${formatErrorMessage(error)}`);
      return;
    }
    if (this.stopped) return;
    const previous = this.spaceLevel;
    this.space = space;
    this.spaceSampledAt = this.now();
    this.spaceLevel = classifyStorageSpace(space, previous);
    if (this.spaceLevel === previous) return;
    const free = formatBytes(space.availableBytes);
    if (this.spaceLevel === 'ok') {
      this.options.logger.info(`[storage] Free space recovered (${free} available)`);
    } else {
      this.options.logger.warn(
        `[storage] Free space ${this.spaceLevel} on the Lody data volume: ${free} available` +
          (this.spaceLevel === 'critical' ? '; disk-heavy work is paused' : '')
      );
    }
    if (previous === 'critical') {
      // Leaving critical: persist anything that queued up while writes were at risk.
      this.requestRecovery();
    }
    this.emitIfChanged();
  }

  private requestRecovery(): void {
    if (this.stopped || this.recovering || this.recoveryTimer !== null) return;
    const now = this.now();
    const wait =
      this.lastRecoveryAt === null
        ? 0
        : Math.max(0, this.lastRecoveryAt + this.recoveryMinIntervalMs - now);
    if (wait === 0) {
      this.track(this.recover());
      return;
    }
    this.recoveryTimer = this.setTimer(() => {
      this.recoveryTimer = null;
      this.track(this.recover());
    }, wait);
  }

  private recover(): Promise<void> {
    if (this.recovering) return this.recovering;
    this.lastRecoveryAt = this.now();
    const run = (async () => {
      const unsavedSince = this.unsavedSince;
      const generation = this.failureGeneration;
      for (const target of [...this.targets]) {
        try {
          await target.flush();
        } catch (error) {
          if (!this.reportWriteFailure(error, `recovery flush (${target.name})`)) {
            this.options.logger.warn(
              `[storage] Recovery flush failed for ${target.name}: ${formatErrorMessage(error)}`
            );
          }
          return;
        }
      }
      if (this.stopped || unsavedSince === null || this.failureGeneration !== generation) return;
      this.unsavedSince = null;
      this.lastFailureCode = null;
      this.options.logger.info(
        `[storage] Saved changes pending since ${new Date(unsavedSince).toISOString()}; local writes succeed again`
      );
      this.emitIfChanged();
      this.reschedulePoll();
    })();
    this.recovering = run.finally(() => {
      this.recovering = null;
    });
    return this.recovering;
  }

  private reschedulePoll(): void {
    if (!this.started || this.stopped) return;
    this.cancelTimer('pollTimer');
    const degraded = this.getSnapshot().level !== 'ok';
    this.pollTimer = this.setTimer(
      () => {
        this.track(this.poll());
      },
      degraded ? this.degradedIntervalMs : this.healthyIntervalMs
    );
  }

  private cancelTimer(key: 'pollTimer' | 'recoveryTimer'): void {
    const handle = this[key];
    if (handle === null) return;
    this.clearTimer(handle);
    this[key] = null;
  }

  private transitionKey(): string {
    const snapshot = this.getSnapshot();
    return `${snapshot.level}|${snapshot.reason ?? ''}|${snapshot.unsavedSince ?? ''}`;
  }

  private emitIfChanged(): void {
    const key = this.transitionKey();
    if (key === this.published) return;
    this.published = key;
    const snapshot = this.getSnapshot();
    for (const listener of this.listeners) {
      try {
        listener(snapshot);
      } catch (error) {
        this.options.logger.debug(
          `[storage] Storage health listener failed: ${formatErrorMessage(error)}`
        );
      }
    }
  }
}
