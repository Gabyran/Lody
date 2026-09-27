import { z } from 'zod';

/**
 * Local storage health of the volume holding a machine's Lody data directory.
 *
 * `critical` is the degraded mode: new disk-heavy work is refused and pending
 * repo changes stay in memory until a write succeeds again. `warning` only
 * informs. `ok` is never published; healthy machines carry no storage field.
 * Contract: `specs/local-storage-health.md`.
 */
export type LodyStorageHealthLevel = 'ok' | 'warning' | 'critical';

/**
 * Why a machine is not `ok`. `write-failed` wins over `low-space`: it means a
 * local write was actually refused, so changes are no longer on disk.
 */
export type LodyStorageHealthReason = 'low-space' | 'write-failed';

/**
 * The storage field of a machine presence heartbeat. Fixed shape and a few
 * numbers only, so it fits the presence budget in
 * `specs/loro-ephemeral-presence-channel.md`.
 */
export type LodyMachineStorageHealth = {
  level: Exclude<LodyStorageHealthLevel, 'ok'>;
  reason: LodyStorageHealthReason;
  /** Free bytes for the daemon's user at the last check, when known. */
  availableBytes?: number;
  /** Epoch ms of the first local write that failed and has not been saved since. */
  unsavedSince?: number;
};

export const LodyMachineStorageHealthSchema = z.object({
  level: z.enum(['warning', 'critical']),
  reason: z.enum(['low-space', 'write-failed']),
  availableBytes: z.number().finite().nonnegative().optional(),
  unsavedSince: z.number().finite().optional(),
});

/** A storage-full classification, named after the error code that carried it. */
export type StorageFullErrorCode =
  | 'ENOSPC'
  | 'EDQUOT'
  | 'SQLITE_FULL'
  | 'RepoStorageError:quota'
  | 'QuotaExceededError';

const ERRNO_CODES: ReadonlySet<string> = new Set(['ENOSPC', 'EDQUOT', 'SQLITE_FULL']);
/** Bounds the walk over `cause` chains and `AggregateError` members. */
const MAX_ERROR_WALK = 16;

const classifyOne = (value: unknown): StorageFullErrorCode | null => {
  if (typeof value !== 'object' || value === null) return null;
  const { code, name } = value as { code?: unknown; name?: unknown };
  if (typeof code === 'string' && ERRNO_CODES.has(code)) {
    return code as StorageFullErrorCode;
  }
  // loro-repo's classified storage failure; matched by name so the renderer and
  // the CLI need not share one loro-repo module instance.
  if (name === 'RepoStorageError' && code === 'quota') return 'RepoStorageError:quota';
  if (name === 'QuotaExceededError') return 'QuotaExceededError';
  return null;
};

/**
 * Classifies an error as "the store refused a write because it is out of
 * space": `ENOSPC`/`EDQUOT` from Node, `SQLITE_FULL` from better-sqlite3,
 * `RepoStorageError` with code `quota` from loro-repo, or a browser
 * `QuotaExceededError`. Walks `cause` and `AggregateError.errors`, because
 * loro-repo wraps a failed snapshot fallback in an `AggregateError`.
 *
 * Message text is never matched: it varies across engines and locales.
 */
export const classifyStorageFullError = (error: unknown): StorageFullErrorCode | null => {
  const queue: unknown[] = [error];
  const seen = new Set<unknown>();
  while (queue.length > 0 && seen.size < MAX_ERROR_WALK) {
    const current = queue.shift();
    if (typeof current !== 'object' || current === null || seen.has(current)) continue;
    seen.add(current);
    const code = classifyOne(current);
    if (code) return code;
    const { cause, errors } = current as { cause?: unknown; errors?: unknown };
    if (cause !== undefined) queue.push(cause);
    if (Array.isArray(errors)) queue.push(...errors);
  }
  return null;
};

export const isStorageFullError = (error: unknown): boolean =>
  classifyStorageFullError(error) !== null;

/**
 * Thrown by the CLI when storage is critical and an operation that would write
 * a lot to disk is refused before it starts. `code` is the stable contract; the
 * message is English and user-facing.
 */
export const LODY_STORAGE_CRITICAL_ERROR_CODE = 'LODY_STORAGE_CRITICAL';

export class StorageCriticalError extends Error {
  readonly code = LODY_STORAGE_CRITICAL_ERROR_CODE;
  constructor(operation: string) {
    super(
      `Lody paused ${operation}: the disk holding Lody's data is almost full. ` +
        'Changes are kept in memory and saved automatically once space is freed.'
    );
    this.name = 'StorageCriticalError';
  }
}

export const isStorageCriticalError = (error: unknown): boolean =>
  typeof error === 'object' &&
  error !== null &&
  (error as { code?: unknown }).code === LODY_STORAGE_CRITICAL_ERROR_CODE;
