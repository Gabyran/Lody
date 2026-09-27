# Lody lifecycle migration roadmap onto Effect

Status: proposed
Translation: current

[中文](2026-09-27-effect-lifecycle-migration-roadmap.zh.md)

## Abstract

Lody's lifecycle defects cluster around a few hand-written mechanisms:
- timer-driven backoff and watchdogs;
- generation counters;
- hand-rolled disposed flags;
- keyed promise chains;
- swallowed `.catch` handlers.

The repository already depends on effect 3.18, but only as islands: Effects are built inside
class methods and run with `runPromise` at the boundary, with no scope spanning modules. This
roadmap covers everything outside
[turn execution and ACP process ownership](2026-09-27-effect-turn-execution-and-acp-process-ownership.md).
It ranks each remaining area by defect density and open issues, and gives its target design,
prerequisites, and the places where Effect is the wrong tool. The ranking comes from
classifying fix commits and issues from 2026-07 to 2026-09, not from runtime measurement.
Each unit needs its own detailed plan and note when work starts.

## Basis for the ranking

- **Lifecycle share of fixes.** Of the last three months' 511 fix commits, about 116 are
  races, hangs, leaks, cancellation, or reconnection bugs. Per file, two stand out:
  - `apps/cli/src/lib/message-handler.ts`: 43 of its 61 fix commits are lifecycle-related;
  - `session-execution-service.ts`: 34 of 43.
- **Hand-written mechanism counts in non-test code.** Rough counts of timers / swallowed
  catches / disposed-style flags:

  | Directory | Timers | Swallowed catches | Disposed-style flags |
  | --- | --- | --- | --- |
  | `apps/cli/src/lib` | 91 | 70 | 38 |
  | `packages/components/src/providers` | 51 | 27 | 27 |
  | `apps/electron/src/main` | 32 | 10 | 8 |

  In the renderer, 83 files hand-write `let cancelled/disposed = false`.
- **Existing Effect footholds:**
  - `apps/cli/src/lib/loro/connection-recovery.ts`: serial Queue + Fiber event loop;
  - `packages/components/src/providers/local-reconnect-loop.ts`: `Clock` + `Fiber`, with an
    injectable TestClock;
  - `apps/cli/src/session/session-access-retry.ts`: `Schedule`;
  - `apps/cli/src/lib/pr-poller`: `Layer`;
  - `packages/components/src/lib/code-collab-file-index-cache.ts`: `ScopedCache`.

## Shared foundations (delivered by phases 0/1 of the turn proposal, reused below)

- A daemon-level `ManagedRuntime` and root scope, plus a `TestContext` runtime for tests.
- The process-tree primitive, `spawnScoped` / `terminateTree` / `awaitExit`. It reads
  `signalCode`, kills process groups, escalates within bounds, and checks Windows exit codes.
- Boundary rules:
  - never call `run*` inside an Effect;
  - use `tryPromise` with the signal for any promise that can reject;
  - every interrupt must be owned by a scope or awaited;
  - put timeouts on the waiter;
  - bound every wait inside a finalizer;
  - `FiberMap` replacement does not await the old fiber.
- These rules live in `.agents/docs/cli-effect-ts.md`, which phase 0 of the turn proposal
  restores.

## Migration units, by priority

### 1. Dispatch watcher and MessageHandler event finalization

- **Where:**
  - `apps/cli/src/session/session-dispatch-watcher.ts` (2874 lines);
  - `session-dispatch-logic.ts`;
  - `apps/cli/src/lib/message-handler.ts` (9762 lines).
- **Fixed:**
  - #676: uncoalesced checks held the daemon at 100% CPU for 42 seconds.
  - #166: a stale `latestUserMsgId` produced false delivery failures.
  - #1043/#1050: duplicate-turn repair recursion, with #1040 (OOM) still open.
  - #595.
  - fe26b552: a repeated teardown finalization overwrote `endedAt`.
- **Open:** #939 (a skipped usage flush is never retried) and #553 (overlapping history syncs
  fail).
- **Current mechanisms:**
  - `enqueueSessionCheck` is a ~110-line hand-written keyed serial queue: probe records,
    generation fences, a coalescing search, and a `setImmediate` yield.
  - `finalizeACPState` is called from about eight places.
  - The `sessionManager.on(...)` handlers are competing `void (async () => ...)()` calls.
- **Target:**
  - One worker fiber per session, via `FiberMap` + a sliding `Queue`, or a dirty flag +
    `Semaphore(1)`. Coalescing, ordering and interruption on stop then come from the
    structure.
  - Session events become subscriptions on the instance scope, and finalization happens only
    when no turn owns the session. Phase 2 of the turn proposal delivers the turn half first.
  - Usage flushes retry durably with a `Schedule`.
- **Prerequisites:** phases 2–4 of the turn proposal. CRDT pointers and duplicate rows still
  need a data-model fix; Effect cannot solve them.
- **Likely closes:** #939 and #553 (by turning the single-flight into a join on the in-flight
  run). For #1040, only the in-process half.

### 2. Connection recovery, presence, and machine liveness (CLI)

- **Where:**
  - `apps/cli/src/lib/loro/connection-recovery.ts` (1087 lines);
  - `presence.ts`;
  - `machine-monitor.ts`;
  - `session-active-presence.ts`.
- **Fixed:**
  - #12: a reconnect fan-out storm, with about 30 full rescans a minute and a 6.4-second
    event-loop delay.
  - #673: a lost token-refresh signal.
- **Open:**
  - #399: the watchdog tears down a connection whose transport is connected and only its meta
    room is still joining.
  - #484: unknown is treated as offline.
  - #1028: machine access registration never retries after failure.
- **Current mechanisms:**
  - Three hand-written `setTimeout`s, a `setInterval` watchdog, hand-written exponential
    backoff with jitter, and `streamsRecoveryGeneration`.
  - Presence has ten timers and a `stopped` flag.
  - `machine-monitor` polls every second.
- **Target:**
  - Backoff: `Schedule.exponential` + `jittered` + `resetAfter` for the flap window.
  - Watchdog and heartbeat: `Effect.repeat(Schedule.spaced)`.
  - Throttling: `sleep` + interruption.
  - Leases: `RcRef`.
  - Presence: model the three states `unknown|online|offline` explicitly with
    `SubscriptionRef`.
  - Machine access registration: a background fiber with a `Schedule`.
- **Constraints:**
  - First read [`.agents/docs/cli-lib-loro-presence.md`](../../../docs/cli-lib-loro-presence.md)
    and [`cli-lib-local-loro-data-plane.md`](../../../docs/cli-lib-local-loro-data-plane.md),
    and invoke the `lody-loro-sync-stack` skill.
  - Keep the deliberate split between `onStreamsOnline` and `onMetaRoomSynced`.
  - A throttled emit may be delayed, never dropped.
- **Prerequisites:** the shared foundations. Coupling to the turn proposal is small, so this
  is the first unit to validate the pattern on.

### 3. Renderer workspace runtime

- **Where:**
  - `packages/components/src/providers/create-workspace-runtime.ts` (4731 lines, the largest
    single hotspot);
  - `workspace-machine-rpc-facade.ts`;
  - `atoms/runtime.ts`;
  - `hooks/use-machine-flock-rows.ts`;
  - `hooks/use-session-doc.ts`;
  - `atoms/doc-meta.ts`;
  - `providers/prompt-shortcut-provider.tsx`.
- **Fixed:**
  - #449: unbounded meta reconnect recovery.
  - #898: a failed first Flock sync swallowed by `.catch(() => undefined)`.
  - #989: a disposed runtime being reused.
- **Open:** #480: bounded reconnects still publish empty presence, so the machine reads as
  offline.
- **Current mechanisms:**
  - `disposePromise`, `cloudTransportAttachPromise` and `metaRoomJoinPromise` act as state
    latches.
  - Many closures use `let disposed = false`.
  - Retries use `await new Promise(r => setTimeout(r, 1000 * attempt))`.
  - Presence is stopped in six places.
  - The session store's hand-written acquire/release reference counting is written twice.
- **Target:**
  - Split per transport (cloud, local, presence, monitor, rpc) into `Layer.scoped`.
  - Attach with `acquireRelease`, and run child tasks with `forkScoped`.
  - Clear presence only when its scope really closes.
  - Keyed resources use `RcMap`, which covers #989's reuse problem.
  - Retries use `FiberMap` + `Schedule`.
- **React seam:** keep jotai. Components subscribe to Effect-managed stores through
  `useSyncExternalStore` or `atomEffect`. Do not adopt `@effect/atom`.
- **Constraints:** read `packages/components/src/providers/AGENTS.md` first. It and most
  `AGENTS.md` files under components are close to the 8 KiB limit, so new rules require
  routing content out first.
- **Where Effect does not apply** (estimated at about 60% of renderer lifecycle defects):
  - URL ↔ state two-way sync (#193, fixed by a single source of truth);
  - derived-state conflicts (#613, #496);
  - virtual-list measurement timing (#695, #896, #674);
  - third-party library behaviour (#722).

  These stay with React discipline and moving state out of components.

### 4. Local Loro data plane join/unload

- **Where:**
  - `packages/shared/src/local-loro-data-plane-server.ts`;
  - `packages/shared/src/local-loro-transport.ts`;
  - `apps/cli/src/lib/local-loro-data-plane-server.ts`;
  - `apps/cli/src/lib/loro/doc.ts` (3143 lines).
- **Fixed:**
  - #4: after unload the room still held the old document, silently cutting sync.
  - `0ec3656a`: Electron reconnect crash.
  - `c1a502f7`: unbounded bootstrap fan-out.
  - #774: joins stuck in connecting forever.
- **Open:** #485 and #398: Flock freshness sync hard-fails.
- **Target:**
  - One fiber per join. `Effect.timeout` replaces the triple requestId/generation guards, and
    a superseded join is simply interrupted.
  - Rooms use `RcMap`/`ScopedCache`; invalidation runs when the last reference releases.
  - Flock freshness sync falls back to the local replica via `timeout` + `orElse`.
- **Constraints:**
  - **Keep "unload, then invalidate" ordering** (#4); otherwise silent sync loss returns.
  - loro-repo's internal `reconnect`/`joinDocRoom`/`unloadDoc` state machines are not ours.
    Effect can only wrap them.
- **Priority:** below units 1–3, because this area has had several recent fix rounds.

### 5. Managed runtime download and ACP login

- **Where:**
  - `apps/cli/src/agent/managed-agent-runtime.ts` (1588 lines);
  - `acp-authentication.ts` (1168 lines);
  - `acp-binary-manager.ts`;
  - `npx-cache.ts`;
  - `abortable-zip.ts`.
- **Fixed:**
  - #878: the cancel signal was not passed into the download.
  - #829: cancel queued behind start and waited 285 seconds.
  - #881: cache-maintenance failure aborted startup.
- **Open:** #828 (login cancel and error reporting) and #505 (login hangs).
- **Target:**
  - Interruption propagates downward automatically, which removes AbortSignal threading.
  - Shared installs use `RcMap`, or `Deferred` + consumer leases, interrupting when the last
    lease is released.
  - Resumable downloads use a `Schedule`.
  - Scratch and partial files use `acquireRelease`.
  - The auth state machine's `cancelled`/`timedOut`/`terminating` flags become one reason
    value.
- **Constraints:** keep every install-cancellation rule in `apps/cli/src/agent/AGENTS.md`:
  - independent consumer leases;
  - waiting for an aborted generation's cleanup;
  - ZIP cancellation fenced on the reader's real close event.
- **Prerequisites:** the process-tree primitive, for the auth probe process.

### 6. Worktrees, setup runner, and file locks

- **Where:**
  - `apps/cli/src/session/worktree/worktree-manager.ts` (1830 lines);
  - `speculative-worktree.ts`;
  - `worktree-setup-runner.ts`;
  - `worktree-gc.ts`;
  - `packages/shared/src/node/file-lock.ts`.
- **Fixed:**
  - #76: a superseded preparation's late dispose deleted its replacement's worktree.
  - #6: same-process waiters raced for a file lock.
- **Open:** #296 (possibly fixed by #620; needs checking).
- **Unfiled defect:** a setup-script timeout sends SIGTERM only to the shell, so descendants
  (such as `pnpm install`) leak.
- **Target:**
  - A keyed `Semaphore` replaces the `withSessionMarkerLock` promise chain.
  - File locks become `acquireRelease` resources that poll with a `Schedule`.
  - Setup scripts become scoped processes under the process-tree primitive.
  - GC becomes an `Effect.repeat(Schedule.spaced)` in the daemon scope.

### 7. Orchestration delivery

- **Where:**
  - `apps/cli/src/orchestration/operation-coordinator.ts` (1560 lines);
  - `operation-store.ts` (1595 lines).
- **Fixed:**
  - #322: completed deliveries were replayed.
  - #461: a progress feedback loop.
  - #200: a wrong store path swallowed completion notifications.
- **Open:** #675: after Stop, subtask results still wake the session and trigger Codex
  auto-compaction.
- **Target:**
  - A `FiberMap` keyed by operation.
  - `Schedule` for retries and deadlines.
  - One scope per requester session, so Stop can cancel pending deliveries. This depends on
    the turn proposal's stop reasons.
- **Constraints:** the SQLite store's generation fences and insert triggers, and cross-process
  MCP hosts, are outside Effect's control.

### 8. Electron main, the embedded CLI, and cli-supervisor

- **Where:**
  - `apps/electron/src/main/services/cli-service.ts`;
  - `loro-data-plane-relay.ts`;
  - `packages/cli-supervisor/src/supervisor.ts`.
- **Fixed:** #849, #742.
- **Open:**
  - #448: the relay throws synchronously during a dispose race and main exits.
  - #938: proxy settings are frozen into the CLI environment at launch.
  - #1054: log transport ENOSPC causes an uncaught exit.
- **Target:**
  - The CLI child process uses the process-tree primitive.
  - One scope per sender, closed on `destroyed`, with send wrapped in `Effect.try`.
  - Proxy settings go into a `SubscriptionRef`, and the CLI restarts on change with defined
    semantics.
  - The supervisor's generation counter and `lifecycleQueue` become one supervisor fiber plus
    a `Schedule`.
  - Its kill implementation moves to the shared process-tree primitive. That requires moving
    the primitive somewhere the supervisor can depend on, such as `packages/shared/src/node`.
- **Constraints:**
  - Read `apps/electron/AGENTS.md` first; it is at the edge of the 8 KiB limit.
  - Electron main tests use `node --test`, where extensionless imports of shared code fail,
    so keep testable logic in `packages/shared`.

### 9. Low priority

Migrate these to the pattern only when touched:
- the preview proxy (#156 is fixed);
- `packages/loro-streams-rpc` (no recent fixes);
- the PR poller (#758's root cause was quota policy);
- the Electron updater (#278's root cause was a third-party event-style API).

## Fixes that need not wait for Effect

- **#1054:** attach an `error` listener to `DailyRotateFile`, and degrade to stderr on ENOSPC
  instead of exiting on an uncaught error.
- **#448:** wrap the relay's `send` in try, and stop callbacks after `destroyed`.
- **#553:** make the history-sync single-flight join the in-flight run instead of throwing
  "already running".
- **Close after checking:**
  - #296 (possibly fixed by #620);
  - the download half of #828 (fixed by #878).

## Suggested order

1. Phases 0–1 of the turn proposal: the shared foundations and the process tree, which fix
   #429.
2. Connection recovery and presence (unit 2). It has the most open issues, existing patterns
   and little coupling, so it is where the pattern gets validated.
3. Phases 2–4 of the turn proposal.
4. Dispatch watcher and MessageHandler (unit 1).
5. Renderer workspace runtime (unit 3), split one transport at a time.
6. Units 5, 6, 7, 4 and 8, re-ranked by their defect and issue state when work starts.

## Verification limits

- The ranking and mechanism counts come from git history, issues, and code grep, not runtime
  measurement.
- "Likely closes" is inference: each unit must reproduce and verify it during implementation.
- Migration effort and its effect on release cadence were not assessed.
