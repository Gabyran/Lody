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

**Observe writes at the storage adapter.** loro-repo persists local edits in the
background and hands a failed save to `logAsyncError`, which only prints. It exposes
no error hook. Every repo write goes through the `StorageAdapter`, so
`observeStorageAdapterWrites` (shared) wraps it and reports each outcome. It keeps
optional methods absent, because loro-repo feature-detects them, and rethrows errors
unchanged, so a failed save stays dirty and is retried by the next flush. The CLI
wraps its SQLite adapter and the renderer wraps IndexedDB with the same helper.

Since loro-repo 0.21.0 (#1066), metadata and named Flock payloads are committed
through the adapter's optional atomic `saveMany`, which both real adapters implement.
The wrapper forwards it and observes it as one write. Leaving it out would not fail;
it would silently fall back to one commit per payload and undo loro-repo#141's single
strict transaction. A refused `saveMany` rolls back every payload and the repo
retries them all, so it is one classified failure like any other.

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

Stopping a workspace (list reconcile, revocation, shutdown) must not drop a repo that
holds unsaved changes. `cleanUp` flushes explicitly, instead of leaving it to
`repo.destroy()`, whose failure would drop the repo with the changes, and unregisters
only after that flush succeeds. If the flush
is refused as storage-full, the manager keeps its repo open and registered; the
monitor's recovery flushes it and then destroys it. Unregistering with `saved: false`
during an open episode marks it lost, and the episode then never clears in that
process. The first revision unregistered before the final flush, so a workspace
stopped on a full disk lost its changes and the monitor then cleared `unsavedSince`
with no targets left; review caught it.

The first fix only covered the final flush. Unloading an open session or machine
document persists it first, so on a full disk `SessionDocument.destroy()` threw
`SQLITE_FULL` before teardown ever reached that flush. The fleet had already
dropped the runtime, and nothing finished the stop. Review caught that too. Now each
document's release catches a storage-full failure and keeps going: the document
stays loaded and dirty in the repo, and its wrapper still disposes. Only the final
flush decides whether the repo closes. `whenRepoReleased()` resolves once the repo
is really destroyed. The fleet keeps that promise per workspace and makes a restart
of the same workspace wait for it, instead of opening a second repo on the same
SQLite file. The shutdown warning names the workspaces recovery still holds.

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

- _Turn start (create and continue)_ is the one entry that covers new sessions from
  the UI, the CLI and MCP, and everything heavy that follows: worktree creation,
  dependency setup, agent start. It fails with the new `storage_critical` notice
  through the same helper memory pressure uses, so the pointer advances and the turn
  does not loop.
- _Speculative worktree preparation_ is refused, since only the first turn then
  builds the worktree, and that turn is gated too.
- _Attachment copies_ into the local store are refused with `LODY_STORAGE_CRITICAL`;
  the composer shows it instead of falling back to a cloud upload.
- _Turn diffs are not gated_, because skipping them loses them for good while a failed
  write only waits.
- _Image uploads are not gated_: they belong to a running turn.

The gate re-samples `statfs` when the reading is older than 2 seconds, so the
60-second poll does not delay it.

**Surface the same banner for the renderer's quota errors.** `create-workspace-runtime`
wraps its IndexedDB adapter with the shared `StorageFullRecovery`. A `quota` failure
sets the renderer atom. A later successful write clears nothing by itself: IndexedDB
can accept a small doc write while the failed meta is still dirty. It only triggers a
`repo.flush()` (at most every 5 s; failed flushes retry at 5, 15 and 60 s). The
episode ends when that flush succeeds and a generation fence shows no newer refusal
arrived meanwhile, the same rule the CLI monitor applies. The first revision of this
PR cleared on any successful write; review caught it. The banner prefers a failed
write over low space, and the desktop's own machine over colleagues' machines. This is the notice part of #417's
crisis mode. The breaker for a dead connection, the blocking recovery modal and the
filesystem-only "Manage storage" panel remain #417's.

**The renderer's repo outlives its runtime while unsaved.** `RepoStorageGuard`
(shared) owns the renderer repo's storage lifecycle. Disposing a workspace runtime
(switching or leaving a workspace) runs a final flush and destroys the repo only if
nothing is unsaved. Otherwise the repo stays open, recovery keeps retrying, and the
repo is destroyed once saved. A window-wide registry (`renderer-storage-episodes`)
keeps every such episode, including those of runtimes already gone, so the banner
no longer clears when the provider unmounts. The first revision cleared the banner
on dispose and destroyed the repo with its unsaved changes; review caught it.

**Warn at exit.** `LodyFleet.shutdown` logs `unsavedSince` after every runtime's final
flush was attempted. Electron's quit barrier gained an optional `confirmQuit` step.
It asks when the local agent reports `local_storage_unsaved` _or_ any window
reported unsaved renderer changes over `storage.rendererUnsaved`. The agent's disk
and a window's IndexedDB are different stores, and a healthy agent proves nothing
about the window.

Before asking, main pushes `storage.quitCheck` to each such window. The window
flushes every retained repo and answers with what is still unsaved. A window that
does not answer within 3 s keeps its last report. If asking fails, the answer
counts as yes, so a broken dialog never traps the user. The first revision checked
only the agent; review caught that too.

**Closing or reloading one window is guarded too.** The next revision still dropped a
window's report when its `webContents` was destroyed, and closing a window (Linux,
Windows without a tray, any auxiliary session window) or pressing Cmd/Ctrl+R
destroyed the renderer's in-memory repo without a check. Review caught it; the
revision's own Limits section had named it.

Now the renderer registry cancels `beforeunload` while any of its repos holds
unsaved changes. That covers close, reload, force reload, navigation and
`location.reload()`. Electron reports each cancellation as `will-prevent-unload`, and
`WindowStorageBarrier` (main) takes over:

- It asks that window to flush (`storage.quitCheck`). If the answer is saved, it
  repeats the action.
- If changes are still unsaved, it shows the quit dialog's per-window variant
  ("Close/Reload Anyway"). Cancel keeps the window, its repo and its report.
- An approval lets one unload through: it is bound to the unsaved generation it saw,
  used once, and expires after 10 s.

Main-initiated actions record what to repeat: window close, the Cmd/Ctrl+R shortcut,
the View menu's Reload / Force Reload (now click items, since the built-in roles
reload directly) and recovery reloads. A renderer-initiated navigation has nothing to
repeat, so the user retries it within the approval's lifetime or is asked again. During
an approved quit windows unload freely. A report is dropped only when the document is
gone, not at approval, so a quit in between still sees it. A crash or an unapproved
destroy is logged as a loss, and failing to ask a window keeps its report.

The first version of this barrier kept an approval until the document was replaced.
After "Reload Anyway" on a navigation the page had started itself, nothing was
repeated. The user could keep editing, and the next close then dropped the new
changes without asking. Review caught it. Now:

- Main bumps a per-window generation on every unsaved report, and an approval is
  valid only for the generation it saw.
- The renderer republishes on every newly refused write, even inside an episode whose
  earliest `since` is unchanged. Guards report each refusal (`onWriteRefused`), and
  the registry sends a revision at most every 500 ms.
- An approval is also single use and short-lived.

**Sign-out and cache clear force-destroy other windows, so they approve first.** They
call `destroy()`, which runs no `beforeunload`, so the unload guard never saw them;
review caught that as well. Both now go through `tearDownWindows`, which calls
`WindowStorageBarrier.approveTeardown` before destroying:

- Every listed window holding unsaved changes flushes.
- Whatever is still unsaved gets one confirmation ("Sign Out Anyway" / "Clear
  Anyway").
- Cancel destroys nothing and leaves reports and repos intact.

Sign-out asks through `auth.prepareSignOut` before the shared sign-out clears any
local auth state or redirects. A cancel returns `sign_out_cancelled_unsaved_storage`
and leaves the session, the CLI and every window alone. `signOut` itself approves
again, in case a window became unsaved in between. A declined cache clear leaves the
clear armed for the next load.

Correction: that held for the in-app flag, which stays in localStorage, but not for a
clear armed by `lody app reset-cache`. Main handed that one to the first booting
window and forgot it, having already deleted the request from disk. Cancel then lost
it for good, with no way to see that the command had been swallowed. Review caught
it. Main now hands the clear out as a claim (`app.claimPendingLocalClear`), one window
at a time, and forgets it only when that window reports the clear ran
(`app.settlePendingLocalClear('cleared')`). On `declined`, main keeps it armed for the
next load and writes the request back to disk with its original time, so quitting
instead of reloading keeps it for the next launch, within the same one-day bound. A
window that goes away mid-way releases its claim. The disk request is still deleted
before acting, so a clear that wedges the renderer cannot loop; only an explicit
decline writes it back. Peeking the disk request and deleting it after completion
was rejected for that reason. Tests drive the renderer boot clear through the real
handoff across reloads and a simulated restart, and the handoff against the file;
removing the decline or the completion report, consuming on claim, skipping the
disk re-arm or its retirement, dropping the release, or re-arming with a fresh time
each fails one of them.

Correction: that second approval could itself be cancelled, but it ran after the
shared sign-out had already cleared the token, the auth bootstrap, the last route
and the preferred workspace (that clear has to precede the network sign-out, to
fence token requests). A window that became unsaved between the two checks, followed
by Cancel, therefore left this window half signed out while the CLI and the session
stayed. Review caught it. `auth.prepareSignOut` is now the only step that can
cancel, and it is final: it runs `tearDownWindows`, so other windows are flushed,
asked about in rounds, and destroyed before it returns, leaving none that could
become unsaved afterwards. `auth.signOut` no longer cancels; it destroys only a
window opened since that holds nothing unsaved, and the renderer adapter always
stops the CLI after it. A test drives `signOutWithoutRedirect` against the real
barrier over real `LoroRepo`s. Window B's write is refused while A is being flushed,
and the user cancels. The token, bootstrap, route, workspace and intent fence are
unchanged, the server sign-out is not called, B is kept, and B's repo later saves
the change. Clearing before the barrier, or skipping the barrier, fails it.

`approveTeardown` first flushed and asked about a snapshot taken on entry. A window
that became unsaved while another was flushing, or while the user looked at the
question, was then destroyed without a flush or a question. Review caught this TOCTOU
as well. It now works in rounds over the full list:

- A window that became unsaved during the flushes gets a flush of its own before
  anyone is asked.
- Any generation that moves while the question is open starts another round.
- Approvals are granted only for the generations the user was asked about.
- `tearDownWindows` checks every window once more (`mayTearDown`) right before
  `destroy()`.

**Quit approval has one owner.** The updater set the global "app is quitting" flag
before the quit barrier asked anything. It has to set that flag because Electron's
updater closes windows before `before-quit`. A cancelled quit never cleared the
flag, and the window barrier trusted it, so after a cancelled update every window
close or reload skipped the flush and the question. Review caught that as well.

`createQuitCoordinator` now approves every quit: menu, last window, and all three
updater paths.

- It flushes the agent and the windows, and confirms what is still unsaved.
- A cancel, an install failure or a failed stop aborts: approval and the quitting
  flag are both cleared. For a failed stop, that rollback lived only in the
  application's failure callback, and the ordinary quit set the flag before its stop
  could fail. Review asked for one owner of it. `createDesktopQuitBarrier` now takes
  a required `abort` and calls it whenever stopping fails. The ordinary quit sets the
  flag only right before `app.quit()`, once the agent has stopped. A test fails the
  agent stop after an approved quit: approval and flag are cleared, and a window
  that then reports a refused write is flushed and asked on close. Dropping the
  `abort` call fails it. Services stopped before the agent (tray, relays, updater)
  stay stopped until the next quit attempt, as the failure dialog says.
  (Superseded by the next correction: they now stop only after the final check.)

**A quit approval covers what it asked about, not the seconds that follow.** Stopping
the agent can take seconds while windows keep running. A window whose storage first
refused a write in that time was never part of the question. The approval still let
it unload freely, and the app then quit without looking again. Review caught it.
The coordinator now records each window's storage generation when the user is
asked; `coversWindow` holds only while that generation is unchanged. The window
barrier uses it, so a window that became unsaved after approval is guarded on close
as usual. After the agent stopped, `approveFinal` flushes every uncovered window
and asks, in rounds (`approveTeardown(ids, 'quit')`), and only then does the app
tear down the tray, relays and updater and call `app.quit()`. A Cancel aborts the
quit and restarts the agent (`resume`). Those local services now stop after the
final check, so a cancelled or failed quit leaves them running. The session-end
guard releases only when the approval covers every window (`coversAll`). A test
pauses the agent stop, injects a refusal, closes the window (guarded), and then
completes the stop. The final check asks, and Cancel keeps the app and resumes the
agent. A second quit asks up front and again about a write refused during that
question. Skipping the final check, ignoring the generation, skipping the uncovered
windows, dropping `resume`, or snapshotting after the question each fails it.

The Linux `.deb` update has the same shape with a longer wait. It approves before
the polkit password prompt, which can stay open for minutes, and then relaunched and
quit. Review caught it as well. `installLinuxDebThenQuit` makes it one transaction:
install, `approveFinal`, and only then `app.relaunch()` and `app.quit()`. A Cancel
aborts the quit, so nothing is armed to relaunch. A test pauses the install,
injects a refusal and closes the window (guarded), then completes the install. The
final check asks, and Cancel means no relaunch. Skipping the updater's final check,
letting the approval cover the whole wait, or a no-op final check each fails it.
The before-quit final check still runs after that for the agent stop. A Cancel
there leaves the relaunch that the updater already armed pending until the next
quit.

- The window barrier trusts only the coordinator's approval, never the global flag.
- The updater asks before it marks anything or starts the install; on Linux that is
  before the password prompt and `app.relaunch()`.
- A cancelled install returns `cancelled: true`, and the renderer treats it as no
  error.

The barrier code moved to the self-contained `@lody/shared/renderer-storage-barrier`,
so Electron's `node --test` suite and the renderer's real-`LoroRepo` tests run the
same code.

**A system shutdown is a quit too.** On Windows, Electron sends no `before-quit` when
the app closes for a shutdown, restart or log-off, so none of the above ran and
changes held only in memory were lost with the process. Review caught it. Every
window now handles `query-session-end`, and `powerMonitor` `shutdown` covers Linux
and macOS. The OS wants a synchronous answer, so `createSessionEndGuard` decides from
what main already knows: the agent's unsaved issue and the windows' reports. With
nothing unsaved, or a quit already approved, the session end goes ahead at once, so a
healthy app never holds up a shutdown. Otherwise it holds the session end and calls
`app.quit()`, which enters the same quit barrier: final flush, question, agent stop.
The app exiting lets the session end continue; a Cancel keeps the app open and the
session end held. A test drives a session end with no `before-quit` through the real
coordinator and barrier. Never holding, holding when healthy, not starting the quit,
or holding after approval each fails it. Not verified on a real Windows shutdown: the
system's "apps are preventing shutdown" screen may cover the question, and Electron
exposes no way to set its block reason.

**Remote-sync persistence failures** are reported like every other write. The first
revision also raised the Streams persist coalescer's failures from debug to a
rate-limited warning. #1066 removed that coalescer: each cursor save now waits on a
real per-resource barrier, whose writes pass through the observed adapter. The
monitor's own warnings (once per episode, then at most every 5 minutes, naming when
it began) cover them.

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
  - teardown on a full disk: `LoroDocumentManager.cleanUp()` on a real capped SQLite
    repo keeps it open, recovery saves it once space returns, and a second
    connection reads all ten documents. With the old order (unregister, swallowed
    flush, destroy) cleanup failed with `database or disk is full`. A target
    unregistered unsaved keeps the episode open; removing that fence fails its test.
  - teardown whose first failure is an open `SessionDocument`'s unload (real manager,
    real capped SQLite): cleanup resolves and recovery holds the workspace. After
    space returns the repo is saved and destroyed, and recovery no longer holds it;
    a second connection reads the session doc. Rethrowing the unload failure
    reproduces the reported early exit (`database or disk is full`). Skipping the
    unregister leaves the workspace held; both fail the test.
  - metadata refused through `saveMany` (real `SqliteRepoStore` capped with
    `max_page_count`, metadata-only writes): the refused commit reaches the adapter's
    `saveMany`, the observer turns it critical, recovery saves it, and a second
    connection reads all fifty entries. Without the forwarding the wrapper has no
    `saveMany` and the test fails. The in-memory fakes in the shared and renderer
    suites inject faults into both `save` and `saveMany`, as the real adapters do.
  - `tests/lody-fleet-local-catalog.test.ts`: restarting a workspace whose stopped
    repo is still retained does not call `Lody.create` until the repo is released.
    Removing the wait fails it.
  - Ablation: with the recovery flush removed, both behavioral tests fail. The first
    version of the SQLite test passed anyway, because `repo.destroy()` flushes;
    reading through a second connection fixed that.
- `apps/cli/src/lib/loro/presence.test.ts`: a transition writes the heartbeat
  immediately, and the field survives a real `EphemeralStore` roundtrip.
- `packages/shared/tests/presence.test.ts`: an unknown storage value keeps the
  heartbeat. Ablating `.catch` fails it.
- `packages/shared/tests/storage-health.test.ts`: classification; the wrapper keeps
  optional methods absent; and, over a real `LoroRepo`, meta refused with
  `QuotaExceededError` followed by a successful doc write does not end the episode.
  The recovery flush stays degraded while meta is still refused and retries on
  backoff; only once meta reaches storage does the episode end. A second case checks
  that a flush racing a newer refusal does not end it. Ablating "any success clears"
  fails both; ablating the generation fence fails the race case.
- `apps/cli/tests/session-execution-service.test.ts`: the memory-pressure refusal
  cases are parameterized over storage too, for both create and continue.
- `packages/components/tests/local-storage-banner.test.tsx`: banner state, value
  stability across presence ticks, and the real container rendered in English and
  Chinese from the exact payloads the daemon published.
- `apps/electron/src/main/services/desktop-exclusion.test.mjs`: a cancelled quit
  stays open and the next quit stops. With a healthy agent, a window whose storage
  refused changes is asked to flush: it still answers unsaved, so the user is warned
  and cancels. After space is freed, its answer is saved and the quit proceeds. A
  silent or unreachable window keeps its last report. Ignoring renderer state fails
  the first case. `WindowStorageBarrier`:
  - A close whose flush is still refused asks "Close Anyway", and Cancel keeps the
    window and its report.
  - After space is freed the same close goes through without asking and clears the
    report.
  - A discarded reload is repeated and let through.
  - Quitting lets every window go.
  - A crash is reported as a loss.

  Making the barrier approve without asking fails both barrier tests.
  Approval lifetime: an approval without an intent is void after a newer report, a
  republished `since`, one use or 10 s. The approved unload is not reported as a
  loss, while data that appears without approval is. Removing the generation check,
  single use or expiry each fails it.

- `renderer-storage-episodes.test.ts` (refusal revision, real `LoroRepo`): a second
  refused meta write inside an open episode republishes with the same `since` and a
  higher revision. Dropping the guard's refusal hook fails it.
- `desktop-exclusion.test.mjs` (teardown rounds): with the question about window 1
  held open, window 2 has its first write refused. The old answer does not cover
  window 2, which is flushed and asked about again. On Cancel, nothing is destroyed
  and window 2's report stays; if window 2's flush saves, it is destroyed with no loss.
  A window that becomes unsaved during another window's flush is flushed before the
  question. A report landing right after approval sends `tearDownWindows` round again.
  Removing the generation fence, the newcomer flush, or the final `mayTearDown` check
  each fails a test.
- `desktop-exclusion.test.mjs` (quit coordinator): with the quitting flag preset as
  the updater does, a cancelled quit clears it, and a later window close is flushed
  and asked again. An approved quit lets the window go; an aborted one (failed
  install) guards it again. Not clearing the flag on abort fails it.
- `packages/components/tests/renderer-storage-episodes.test.ts` (sign-out across
  windows, real `LoroRepo`s): window B's meta is refused and window A signs out.
  - Cancel destroys nothing, and B's report and repo stay.
  - After space is freed, the next sign-out flushes B, saves the meta and destroys B
    without asking.
  - An explicit discard destroys B, and its destroy is not reported as a loss.

  Making `tearDownWindows` destroy without approval fails both.

- `packages/components/tests/renderer-storage-episodes.test.ts` (unload guard, real
  `LoroRepo`): after a quota refusal the window's `beforeunload` is cancelled, and
  stays cancelled after a flush that is still refused. Once space returns the flush
  saves the meta and the unload is released. Making the guard a no-op fails it.
- `packages/shared/tests/storage-health.test.ts` (`RepoStorageGuard`): on a real
  `LoroRepo`, a doc refused with `QuotaExceededError` makes `close()` retain the
  repo. The quit-time flush still reports unsaved while full; once storage accepts
  writes, it saves the doc and meta and only then destroys the repo.
- `packages/components/tests/renderer-storage-episodes.test.ts`: switching
  workspaces while full keeps the old runtime's episode registered next to the new
  runtime. `flushForQuit` stays unsaved until space returns, then saves and releases
  it. Making `close()` always destroy fails both of these.

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
- Restarting a workspace whose stopped repo still waits for space also waits, until
  space is freed or the process exits.
- A renderer that is hung or crashed cannot run its unload guard or flush; a crash
  loses its in-memory changes and is only logged. The hang watchdog's Reload is an
  explicit user choice in that dialog.
- `unsavedSince` covers repo writes only. Other stores (schedules, operation stores,
  the diff store) fail independently and are not tracked.
- The quit dialog reads the runtime state Electron last polled, so a failure in the
  final seconds may not be shown.
- Colleagues' machines are not shown in the app-level banner; the field is on their
  heartbeat for a future per-machine surface.
