# Detect a full data disk, degrade instead of failing, and recover by itself

Status: implemented
Translation: current

[中文](2026-09-27-local-storage-health.zh.md)

Refs: issue #1054 (layers 2 and 3). Contract: [local storage health](../../../../specs/local-storage-health.md).

## Abstract

When the disk holding Lody's data filled up, repo writes failed with `SQLITE_FULL`
and nobody noticed: the coalesced flush logged at debug level, loro-repo printed
background save failures to the console, and new turns went on to create worktrees
and fail halfway. The daemon now classifies storage-full failures by error code,
samples free space with `statfs`, and publishes a small storage field on the machine
heartbeat. While storage is critical it refuses new turns, speculative worktrees and
attachment copies up front, keeps unsaved changes in memory, and flushes them as soon
as space returns. The desktop shows a bilingual banner and asks before quitting with
unsaved changes. On a full 256 MiB RAM disk the real daemon stayed alive, refused a
turn with a readable notice, and saved everything within about three seconds of space
being freed. It does not recover a renderer IndexedDB connection that stops working
(issue #417) and adds no ballast file.

## Problem

Issue #1054 showed that storage itself survives a full disk: SQLite refuses writes
without corruption, and a later flush saves everything. What was missing was
everything around it. Nothing detected the condition. Nothing told the user their
work was only in memory. Nothing stopped new work from starting and failing midway.
The layer-1 fix (keeping the file log from crashing the daemon, PR #1056) is
separate; this change neither depends on it nor conflicts with it.

## Decisions

**Observe writes at the storage adapter.** loro-repo 0.20.3 persists local edits in
the background and hands a failed save to `logAsyncError`, which only prints. It
exposes no error hook. Every repo write goes through the `StorageAdapter`, so
`observeStorageAdapterWrites` (shared) wraps it and reports each outcome. It keeps
optional methods absent, because loro-repo feature-detects them, and rethrows errors
unchanged, so a failed save stays dirty and is retried by the next flush. The CLI
wraps its SQLite adapter and the renderer wraps IndexedDB with the same helper.

**Classify by code, never by message.** `classifyStorageFullError` walks `cause` and
`AggregateError.errors` (loro-repo wraps a failed snapshot fallback that way). It
accepts `ENOSPC`, `EDQUOT`, `SQLITE_FULL`, `RepoStorageError` with code `quota`, and
`QuotaExceededError`. It rejects `unavailable`, which is #417's problem, not free
space.

**One process-wide monitor.** `StorageHealthMonitor` lives in `LodyFleet`, because
the data directory is per process while repos are per workspace. Each workspace's
`LoroDocumentManager` registers its flush as a recovery target and unregisters it
before destroying the repo. Unsaved state clears only when every target flushed. A
generation counter stops a recovery that raced a new failure from clearing it.
Free space alone never clears it.

**Thresholds combine a share of the volume with absolute bounds.** Critical is 1% of
the volume, clamped to 256 MiB–1 GiB. 256 MiB leaves room for a flush, SQLite's
journal and a checkpoint, but not for a worktree or an install. The 1 GiB cap keeps a
large disk from degrading with gigabytes free. Warning is 5%, clamped to 1–5 GiB, so
it arrives well before work is refused. On small volumes both are capped to a quarter
and a half of the disk. That kept a 256 MiB test disk healthy while empty. Leaving a
level needs 10% headroom.

**Publish on the machine heartbeat.** The alternatives did not fit:

- `CliRuntimeState` issues reach only Electron's main process.
- `machine-monitor` runs only while an observer holds a lease.
- A durable document write needs the disk that is full.

The field is fixed-shape, rides the heartbeat's own key (a transition replaces an
unsent heartbeat), and changes only on level transitions, which are interval-bounded.
An unparseable field is caught and dropped; rejecting the entry would read a live
machine as offline to an older or newer reader. The runtime issue
`local_storage_unsaved` is still raised, because it is what the desktop quit path can
read.

**Gate at the start of work, next to the memory-pressure refusal.**

- *Turn start (create and continue)* is the one entry that covers new sessions from
  the UI, the CLI and MCP, and everything heavy that follows: worktree creation,
  dependency setup, agent start. It fails with the new `storage_critical` notice
  through the same helper memory pressure uses, so the pointer advances and the turn
  does not loop.
- *Speculative worktree preparation* is refused, since only the first turn then
  builds the worktree, and that turn is gated too.
- *Attachment copies* into the local store are refused with `LODY_STORAGE_CRITICAL`;
  the composer shows it instead of falling back to a cloud upload.
- *Turn diffs are not gated*, because skipping them loses them for good while a failed
  write only waits.
- *Image uploads are not gated*: they belong to a running turn.

The gate re-samples `statfs` when the reading is older than 2 seconds, so the
60-second poll does not delay it.

**Surface the same banner for the renderer's quota errors.** `create-workspace-runtime`
wraps its IndexedDB adapter. A `quota` failure sets the renderer atom, and the next
successful write clears it. The banner prefers a failed write over low space, and the
desktop's own machine over colleagues' machines. This is the notice part of #417's
crisis mode. The breaker for a dead connection, the blocking recovery modal and the
filesystem-only "Manage storage" panel remain #417's.

**Warn at exit.** `LodyFleet.shutdown` logs `unsavedSince` after every runtime's final
flush was attempted. Electron's quit barrier gained an optional `confirmQuit` step
that reads `local_storage_unsaved` from the runtime state and asks. If asking fails,
the answer counts as yes, so a broken dialog never traps the user.

**Coalesced flush failures** now log a warning naming when the run of failures began,
at most every 5 minutes, and an info line when a flush succeeds again.

## Ballast file (layer 4): not implemented

A reserved file (say 256 MiB), deleted when the disk fills, would buy room for a clean
flush and exit. It is not worth its cost now:

- Every install pays the space permanently. On APFS the freed blocks go back to a
  container shared with other volumes and local snapshots. The file must be written
  in full, because macOS has no `fallocate`.
- Once deleted, other processes can take the space before Lody uses it. Recreating
  the file needs a policy that can itself push the disk back into warning.
- The daemon no longer crashes on a full disk (PR #1056) and keeps changes in memory
  until space returns. What a ballast would add is a clean exit while the disk stays
  full, and the quit warning covers that decision.

A better next step is #417's "Manage storage": show what Lody itself can reclaim
(worktrees, logs, caches) so the user can free space quickly.

## Verification

Automated, with injected clocks, manual timers and fault injection, no real sleeps:

- `apps/cli/src/lib/storage-health.test.ts`:
  - thresholds;
  - hysteresis;
  - the gate;
  - one notification per transition;
  - a classified failure turns critical at once, and only a full flush clears it,
    with recovery rate-limited;
  - a real `SqliteRepoStore` capped with `PRAGMA max_page_count` raises a genuine
    `SQLITE_FULL`. Twenty documents written while full are read back through a
    second connection before the first repo is destroyed.
  - Ablation: with the recovery flush removed, both behavioral tests fail. The first
    version of the SQLite test passed anyway, because `repo.destroy()` flushes;
    reading through a second connection fixed that.
- `apps/cli/src/lib/loro/presence.test.ts`: a transition writes the heartbeat
  immediately, and the field survives a real `EphemeralStore` roundtrip.
- `packages/shared/tests/presence.test.ts`: an unknown storage value keeps the
  heartbeat. Ablating `.catch` fails it.
- `packages/shared/tests/storage-health.test.ts`: classification, and the wrapper
  keeping optional methods absent.
- `apps/cli/tests/session-execution-service.test.ts`: the memory-pressure refusal
  cases are parameterized over storage too, for both create and continue.
- `packages/components/tests/local-storage-banner.test.tsx`: banner state, value
  stability across presence ticks, and the real container rendered in English and
  Chinese from the exact payloads the daemon published.
- `apps/electron/src/main/services/desktop-exclusion.test.mjs`: a cancelled quit
  stays open and the next quit stops.

Real run: a throwaway `lody start` with a clean environment and
`LODY_DATA_DIR=/Volumes/lodysh/lody` on a 256 MiB RAM disk. It ran this branch merged
locally with PR #1056, because without #1056 the daemon exits on its first log
`ENOSPC`. The merge was never pushed.

1. The disk was filled with `dd` until `ENOSPC`, and its descriptors were closed.
   Within 4 seconds the log read
   `Free space critical … 0 MiB available; disk-heavy work is paused`.
2. Then `Local write failed (SQLITE_FULL) in loro-repo compactMeta`.
3. A probe read the local data plane the way the renderer does. It saw the heartbeat
   change to `{"level":"critical","reason":"write-failed","availableBytes":0,"unsavedSince":…}`.
4. A `session/create` sent over the local control socket was acknowledged. The daemon
   logged `Lody paused new agent turns…` and started no agent.
5. After the fillers were deleted, it logged `Free space recovered (250 MiB)` and
   `Saved changes pending since 11:49:05.421Z` within about 3 seconds. The heartbeat
   dropped the field.
6. A second SQLite connection found the `storage_critical` notice (written while full)
   on disk.
7. The disk was filled again and a write failure caused. SIGINT then printed
   `Stopping with local changes unsaved since …` and exited with code 0.

Storybook screenshots of the four banner states in both languages were checked by
eye. They exposed a stray space between Chinese sentences, now a localized join key.

## Limits

- The desktop banner, its quit dialog and the renderer quota path were verified by DOM
  tests and Storybook, not in a packaged desktop on a full disk.
- loro-repo still prints each failed background save with a stack. A first open after
  a schema upgrade still needs to write (loro-dev/loro-repo#139).
- `unsavedSince` covers repo writes only. Other stores (schedules, operation stores,
  the diff store) fail independently and are not tracked.
- The quit dialog reads the runtime state Electron last polled, so a failure in the
  final seconds may not be shown.
- Colleagues' machines are not shown in the app-level banner; the field is on their
  heartbeat for a future per-machine surface.
