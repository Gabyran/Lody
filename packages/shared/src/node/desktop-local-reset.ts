// Node-only contract for the one-shot desktop reset: the CLI arms it
// (`lody app reset-cache`), the Electron main process consumes it at its next
// launch (`apps/electron/src/main/services/local-reset-service.ts`).
//
// The renderer owns the precise cache clear (`clear-local-cache.ts` in
// `@lody/components`), but a user whose renderer is wedged cannot reach the
// settings action that arms it. The request therefore travels through the
// installation's data directory — the one path both processes already derive the
// same way — instead of through the frozen UI. Both sides live here so a writer
// and a reader can never drift apart on the format or the location.
import fs from 'node:fs';
import fsPromises from 'node:fs/promises';
import path from 'node:path';
import { getLodyDataDir } from './installation-profile';
import type { PlatformKind } from '../platform-kind';

/**
 * `cache` removes recoverable local caches and keeps the user signed in with
 * their preferences; `hard` wipes every local store for the install, so the app
 * comes back signed out. Same two levels as the in-app settings action and the
 * crash screen, so a CLI-armed reset cannot mean something the UI never offers.
 */
export type DesktopLocalResetMode = 'cache' | 'hard';

type DesktopLocalResetRequest = {
  version: 1;
  mode: DesktopLocalResetMode;
  /** Wall clock of the arming CLI run, used only for the staleness bound below. */
  requestedAtMs: number;
};

/**
 * A request the desktop never consumed stays armed on disk, so bound it. Applying
 * a forgotten `hard` reset days later would sign someone out with nothing they
 * could connect it to. The window still has to cover "arm it, then restart the app
 * a while later", which is why it is a day rather than minutes.
 */
export const DESKTOP_LOCAL_RESET_REQUEST_TTL_MS = 24 * 60 * 60 * 1000;

export function getDesktopLocalResetRequestPath(platform?: PlatformKind): string {
  return path.join(getLodyDataDir(platform), 'desktop-local-reset.json');
}

type DesktopLocalResetTarget = {
  filePath?: string;
  platform?: PlatformKind;
};

function resolveRequestPath(target: DesktopLocalResetTarget): string {
  return target.filePath ?? getDesktopLocalResetRequestPath(target.platform);
}

/** Returns null for anything this version cannot act on, including a future version. */
function parseRequest(value: unknown): DesktopLocalResetRequest | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const candidate = value as Partial<DesktopLocalResetRequest>;
  if (candidate.version !== 1) return null;
  if (candidate.mode !== 'cache' && candidate.mode !== 'hard') return null;
  if (typeof candidate.requestedAtMs !== 'number' || !Number.isFinite(candidate.requestedAtMs)) {
    return null;
  }
  return { version: 1, mode: candidate.mode, requestedAtMs: candidate.requestedAtMs };
}

/**
 * Distance in either direction, so a request stamped by a clock that was later
 * corrected backwards cannot stay armed forever.
 */
function isExpired(request: DesktopLocalResetRequest, nowMs: number): boolean {
  return Math.abs(nowMs - request.requestedAtMs) > DESKTOP_LOCAL_RESET_REQUEST_TTL_MS;
}

/**
 * Arm a reset for the desktop app's next launch, replacing any request already
 * armed so the two levels can never both be pending.
 *
 * Written atomically because the desktop reads this file at startup with no lock:
 * a half-written request would be refused there, and the user would have run a
 * recovery command that silently did nothing.
 */
export async function writeDesktopLocalResetRequest(
  options: DesktopLocalResetTarget & { mode: DesktopLocalResetMode; nowMs?: number }
): Promise<string> {
  const filePath = resolveRequestPath(options);
  const request: DesktopLocalResetRequest = {
    version: 1,
    mode: options.mode,
    requestedAtMs: options.nowMs ?? Date.now(),
  };
  const temporaryPath = `${filePath}.${process.pid}.tmp`;
  await fsPromises.mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  await fsPromises.writeFile(temporaryPath, `${JSON.stringify(request, null, 2)}\n`, {
    mode: 0o600,
  });
  try {
    await fsPromises.rename(temporaryPath, filePath);
  } catch (error) {
    await fsPromises.rm(temporaryPath, { force: true });
    throw error;
  }
  return filePath;
}

/** Disarm a reset that has not been applied yet. False when none was armed. */
export async function clearDesktopLocalResetRequest(
  target: DesktopLocalResetTarget = {}
): Promise<boolean> {
  try {
    await fsPromises.unlink(resolveRequestPath(target));
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

export type ConsumeDesktopLocalResetOptions = DesktopLocalResetTarget & {
  nowMs?: number;
  /** Diagnostics sink; the desktop passes its main-process console. */
  log?: (message: string, detail?: unknown) => void;
};

/**
 * Read and REMOVE the armed request, returning what this launch should apply.
 *
 * The removal is unconditional: a malformed, unreadable, or stale request must not
 * survive to be re-evaluated at every later launch, and an applied one must not
 * apply twice. Deleting before acting also means a crash during the wipe costs the
 * user one more `lody app reset-cache`, rather than a boot loop that wipes storage
 * on every launch.
 *
 * Synchronous on purpose: the desktop runs this once, before its first window
 * exists, and what it does next depends on the answer.
 */
export function consumeDesktopLocalResetRequest(
  options: ConsumeDesktopLocalResetOptions = {}
): DesktopLocalResetMode | null {
  return consumeDesktopLocalResetRequestDetailed(options)?.mode ?? null;
}

/**
 * {@link consumeDesktopLocalResetRequest}, also returning when the request was
 * armed. A `cache` clear the user declines at boot (another window still holds
 * unsaved storage) is written back with that original time, so it is retried on a
 * later launch without ever outliving {@link DESKTOP_LOCAL_RESET_REQUEST_TTL_MS}.
 */
export function consumeDesktopLocalResetRequestDetailed(
  options: ConsumeDesktopLocalResetOptions = {}
): { mode: DesktopLocalResetMode; requestedAtMs: number } | null {
  const filePath = resolveRequestPath(options);
  const log = options.log ?? (() => {});

  let raw: string;
  try {
    raw = fs.readFileSync(filePath, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      log('Failed to read the desktop reset request', { filePath, error });
    }
    return null;
  }

  try {
    fs.unlinkSync(filePath);
  } catch (error) {
    // Losing the delete would replay the reset on every launch, so refuse a
    // request that cannot be retired.
    log('Could not remove the desktop reset request; ignoring it', { filePath, error });
    return null;
  }

  let decoded: unknown;
  try {
    decoded = JSON.parse(raw);
  } catch {
    log('Desktop reset request is not valid JSON; ignoring it', { filePath });
    return null;
  }

  const request = parseRequest(decoded);
  if (!request) {
    log('Desktop reset request is not understood; ignoring it', { filePath });
    return null;
  }
  if (isExpired(request, options.nowMs ?? Date.now())) {
    log('Desktop reset request is stale; ignoring it', {
      filePath,
      requestedAtMs: request.requestedAtMs,
    });
    return null;
  }
  return { mode: request.mode, requestedAtMs: request.requestedAtMs };
}

/**
 * The desktop side of a consumed `cache` request, handed to booting windows. It
 * stays armed until a window that ran the clear settles it `cleared`.
 *
 * One claimant at a time, so two windows booting together do not both run it; the
 * claimant may claim again after reloading, and a window that goes away releases
 * its claim. A window that declines (another window still holds unsaved storage)
 * leaves it armed in memory for the next load, and writes it back to disk with its
 * original `requestedAtMs`, so a user who quits instead of reloading still gets it
 * at the next launch and it never outlives {@link DESKTOP_LOCAL_RESET_REQUEST_TTL_MS}.
 * Once a window ran it, that re-armed copy is retired again.
 */
export type DesktopLocalClearHandoff = {
  arm: (request: { mode: DesktopLocalResetMode; requestedAtMs: number }) => void;
  /** The armed clear for this window; null while none is armed or another window holds it. */
  claim: (windowId: number) => DesktopLocalResetMode | null;
  /** `cleared`: the clear ran (or was attempted), so it is done. `declined`: keep it armed. */
  settle: (windowId: number, outcome: 'cleared' | 'declined') => void;
  /** The claimant went away without settling: the clear stays armed. */
  release: (windowId: number) => void;
  /** Resolves once every re-arm and retire so far has reached the disk. */
  whenPersisted: () => Promise<void>;
};

export function createDesktopLocalClearHandoff(
  options: DesktopLocalResetTarget & { log?: (message: string, detail?: unknown) => void } = {}
): DesktopLocalClearHandoff {
  const { log, ...target } = options;
  let armed: { mode: DesktopLocalResetMode; requestedAtMs: number } | null = null;
  let claimedBy: number | null = null;
  let rearmedOnDisk = false;
  // Re-arming and retiring touch the same file, so they run in order: a clear that
  // finished right after a decline must not leave the re-armed copy behind.
  let writes: Promise<void> = Promise.resolve();
  const queue = (label: string, write: () => Promise<unknown>) => {
    writes = writes.then(write).then(
      () => undefined,
      (error: unknown) => log?.(`Could not ${label}`, error)
    );
  };
  return {
    arm: (request) => {
      armed = { mode: request.mode, requestedAtMs: request.requestedAtMs };
      claimedBy = null;
    },
    claim: (windowId) => {
      if (!armed) return null;
      if (claimedBy !== null && claimedBy !== windowId) return null;
      claimedBy = windowId;
      return armed.mode;
    },
    settle: (windowId, outcome) => {
      if (!armed || claimedBy !== windowId) return;
      claimedBy = null;
      if (outcome === 'declined') {
        const { mode, requestedAtMs } = armed;
        rearmedOnDisk = true;
        queue('re-arm a declined desktop reset', () =>
          writeDesktopLocalResetRequest({ ...target, mode, nowMs: requestedAtMs })
        );
        return;
      }
      armed = null;
      if (!rearmedOnDisk) return;
      rearmedOnDisk = false;
      queue('retire a re-armed desktop reset', () => clearDesktopLocalResetRequest(target));
    },
    release: (windowId) => {
      if (claimedBy === windowId) claimedBy = null;
    },
    whenPersisted: () => writes,
  };
}
