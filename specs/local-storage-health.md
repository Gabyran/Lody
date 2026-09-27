# Local storage health

Status: draft
Translation: current

[中文](local-storage-health.zh.md)

A machine's Lody data directory holds the local Loro repo, git worktrees, attachment
copies and logs. In local mode the repo's SQLite file is the only copy of the user's
work. When the disk under it fills up, Lody keeps running, keeps unsaved changes in
memory, tells the user, refuses new work that would write a lot, and saves everything
by itself once space returns.

## Levels

The daemon judges the volume holding its data directory by two signals:

- **Free space**, sampled with `statfs` every 60 seconds while healthy and every
  10 seconds otherwise. Work about to start re-samples a reading older than 2 seconds.
- **Refused writes.** A local write that fails because storage is full (`ENOSPC`,
  `EDQUOT`, `SQLITE_FULL`, or loro-repo's `RepoStorageError` with code `quota`)
  applies at once, without waiting for the next sample. Errors are classified by
  code or name, never by message text.

| Level | When | Effect |
| --- | --- | --- |
| `ok` | free space above the warning threshold, no refused write | none |
| `warning` | free space below the warning threshold | informs; dismissible |
| `critical` | free space below the critical threshold, or a write was refused | degraded mode |

Thresholds scale with the volume and are capped at both ends:

- critical: 1% of the volume, at least 256 MiB and at most 1 GiB;
- warning: 5% of the volume, at least 1 GiB and at most 5 GiB;
- on a volume too small for those floors, critical is at most a quarter and warning
  at most half of the volume.

A level is left only once free space clears its threshold by 10%, so a volume
hovering at the line does not flap.

## Unsaved changes

A refused write means some repo changes exist only in memory. The daemon records
when the first such write failed (`unsavedSince`). The state clears only after
every open workspace repo has flushed successfully. Free space merely looking
better does not clear it.

Recovery needs no user action. Leaving `critical`, and any successful local write
while changes are unsaved, triggers a flush of every workspace repo, at most once
every 5 seconds. Each poll while changes are unsaved retries too.

Stopping a workspace does not end its part in recovery. Its teardown flushes first,
and only a successful flush lets the repo close. If that flush is refused for lack
of space, the repo stays open and registered, and recovery closes it after saving
it. A repo that closes any other way while changes are unsaved leaves the episode
open for the rest of the process: the remaining repos saving cannot prove its
changes were saved.

## Degraded mode

While `critical`, the daemon refuses, before it starts:

- **new agent turns**, including a new session's first turn. The turn fails with the
  `storage_critical` notice instead of creating a worktree, installing dependencies
  or starting an agent. This covers session creation from the UI, the CLI and MCP.
- **speculative worktree preparation**. Refusing only means the first turn prepares
  its worktree itself, and that turn is gated too.
- **attachment copies** into the local attachment store (`LODY_STORAGE_CRITICAL`).

Work already running continues. Its writes may fail and stay in memory like any
other. Turn diffs are not gated: skipping them would lose them for good, while a
failed write only waits for space.

The daemon never exits because storage is full. Keeping its file log from crashing
the process on a full disk is the separate first layer of issue #1054 (PR #1056).

## What the user sees

The machine heartbeat on the presence channel carries an optional `storage` field
while the level is not `ok`: level, reason (`low-space` or `write-failed`), free
bytes and `unsavedSince`. It follows the
[presence budget](loro-ephemeral-presence-channel.md). The field rides the
heartbeat's own key and changes only on level transitions. A reader that cannot
parse it ignores the field, never the heartbeat.

The desktop shows one banner for its own machine:

- `write-failed`: the disk is full, changes are kept in memory and saved once space
  is freed, new work is paused, and unsaved changes exist since a given time;
- `critical` low space: how much is left and that new work is paused;
- `warning`: how much is left, dismissible until the level changes.

The renderer's own IndexedDB repo shows the same banner when a write fails with
`quota`. A later successful write of some other resource does not clear it: it only
triggers a full repo flush, at most every 5 seconds, and failed flushes retry on a
bounded backoff. The banner clears once such a flush succeeds with no newer
refusal in between. The renderer's crisis handling
for a connection that stops working (`unavailable`) is tracked separately in
issue #417.

## Exit

Stopping the daemon while changes are unsaved logs a warning naming `unsavedSince`.
The desktop asks before quitting in that state: quitting then loses changes not yet
synced elsewhere.

## Open questions

- loro-repo still logs failed background saves to the console, and a first open after
  a schema upgrade needs to write (loro-dev/loro-repo#139).
- Whether a ballast file is worth its cost is recorded in the implementing note; this
  Spec does not require one.

## Evidence

- Monitor, thresholds and recovery: `apps/cli/src/lib/storage-health.ts`, owned by
  `apps/cli/src/lib/lody-fleet.ts`.
- Classification and the storage-adapter wrapper: `packages/shared/src/storage-health.ts`,
  `packages/shared/src/observed-storage-adapter.ts`; wired in
  `apps/cli/src/lib/loro/doc.ts` and
  `packages/components/src/providers/create-workspace-runtime.ts`.
- Gates: `apps/cli/src/session/session-execution-service.ts` (turn start) and
  `apps/cli/src/lib/message-handler.ts` (preparation, attachment copies).
- Presence field: `packages/shared/src/presence.ts`, `apps/cli/src/lib/loro/presence.ts`.
- UI: `packages/components/src/components/local-storage-banner.tsx`,
  `packages/components/src/atoms/local-storage-health.ts`; desktop quit:
  `apps/electron/src/main/application.ts`.
- Executed validation: a daemon on a full 256 MiB RAM disk, recorded in
  [the implementing note](../.agents/notes/implemented/feature/2026-09-27-local-storage-health.md).
