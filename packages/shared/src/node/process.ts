/**
 * The process layer shared by the CLI, the desktop main process and the CLI
 * supervisor: the one place that starts, awaits and signals OS processes.
 *
 * Kept as a single module with no relative imports so Node's own ESM loader
 * (`node --test --experimental-strip-types` in apps/electron) can load it.
 * Rules: apps/cli/src/platform/AGENTS.md; guard: scripts/check-cli-process-boundary.mjs.
 */
import type {
  ChildProcess,
  SpawnOptions,
  SpawnSyncOptions,
  SpawnSyncReturns,
} from 'node:child_process';

import spawn from 'cross-spawn';
import {
  Cause,
  Context,
  Data,
  Deferred,
  Duration,
  Effect,
  Either,
  Exit,
  Layer,
  Logger,
  type Scope,
} from 'effect';

const formatErrorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

// ---- node-process ---------------------------------------------

/**
 * The only door from the process layer to the operating system.
 *
 * Everything above it describes process work as Effects; this service performs
 * it. Tests replace it with an in-memory process table, so no test needs a real
 * child, a real signal, or the host platform.
 */
export interface NodeProcessApi {
  readonly platform: NodeJS.Platform;
  /** Synchronous like `child_process.spawn`: async failures arrive as `error`. */
  readonly spawn: (command: string, args: readonly string[], options: SpawnOptions) => ChildProcess;
  /**
   * Blocks the event loop until the child exits. Only for callers that are
   * synchronous by contract and bounded by a timeout.
   */
  readonly spawnSync: (
    command: string,
    args: readonly string[],
    options: SpawnSyncOptions
  ) => SpawnSyncReturns<Buffer>;
  /** `process.kill` semantics: throws `ESRCH` when no process matches. */
  readonly kill: (pid: number, signal: NodeJS.Signals | 0) => void;
}

export class NodeProcess extends Context.Tag('lody/NodeProcess')<NodeProcess, NodeProcessApi>() {}

export const nodeProcessLive: NodeProcessApi = {
  platform: process.platform,
  spawn: (command, args, options) => spawn(command, [...args], options),
  spawnSync: (command, args, options) =>
    spawn.sync(command, [...args], { ...options, encoding: 'buffer' }),
  kill: (pid, signal) => {
    process.kill(pid, signal);
  },
};

export const NodeProcessLive = Layer.succeed(NodeProcess, nodeProcessLive);

export const errnoCode = (error: unknown): string | undefined => {
  if (!error || typeof error !== 'object' || !('code' in error)) {
    return undefined;
  }
  const code = (error as { code?: unknown }).code;
  return typeof code === 'string' ? code : undefined;
};

// ---- errors ---------------------------------------------------

/** The OS refused to start a process (for example ENOENT or EACCES). */
export class SpawnFailed extends Data.TaggedError('SpawnFailed')<{
  readonly command: string;
  readonly message: string;
  readonly cause: unknown;
}> {}

/**
 * A process tree could not be proven gone within the termination policy.
 *
 * `still-alive`: every signal was delivered but the tree outlived the bounded
 * wait. `signal-failed`: the final signal could not be delivered at all.
 * Callers must not treat either as success: the tree may still hold resources
 * (an ACP prompt, a port, a file lock) that a successor would contend with.
 */
export class TerminationFailed extends Data.TaggedError('TerminationFailed')<{
  readonly target: string;
  readonly reason: 'still-alive' | 'signal-failed';
  readonly message: string;
  readonly cause?: unknown;
}> {}

// ---- process-tree ---------------------------------------------

export type TreeSignal = 'SIGTERM' | 'SIGKILL';

/** `gone`: nothing was left to signal, which is as good as a completed kill. */
export type SignalOutcome = 'delivered' | 'gone';

/**
 * A set of OS processes that live and die together: a POSIX process group, a
 * Windows process tree rooted at one pid, a cgroup, or a lone child.
 *
 * `isAlive` must answer for the whole set, not just its root. That is what lets
 * termination keep going after the root exits while its descendants run on.
 */
export interface ProcessTree {
  readonly description: string;
  readonly isAlive: Effect.Effect<boolean, TerminationFailed>;
  readonly signal: (signal: TreeSignal) => Effect.Effect<SignalOutcome, TerminationFailed>;
}

/**
 * `graceMs` is the SIGTERM window; 0 sends SIGKILL immediately. `killWaitMs`
 * bounds the wait after SIGKILL: every wait is bounded, so a tree that cannot
 * be killed surfaces as `TerminationFailed` instead of hanging its caller.
 */
export interface TerminationPolicy {
  readonly graceMs: number;
  readonly killWaitMs: number;
}

export const TREE_POLL_INTERVAL = Duration.millis(20);
export const TASKKILL_DEADLINE = Duration.seconds(10);
/** taskkill exit status when no process matched the pid. */
const TASKKILL_NOT_FOUND = 128;

export const hasExited = (child: ChildProcess): boolean =>
  (child.exitCode ?? null) !== null || (child.signalCode ?? null) !== null;

const hasPid = (child: ChildProcess): child is ChildProcess & { pid: number } =>
  typeof child.pid === 'number' && child.pid > 0;

const signalFailed = (target: string, signal: TreeSignal | 0, cause: unknown) =>
  new TerminationFailed({
    target,
    reason: 'signal-failed',
    message: `Failed to send ${signal === 0 ? 'liveness probe' : signal} to ${target}: ${formatErrorMessage(cause)}`,
    cause,
  });

/**
 * Every member of the group started by a `detached` spawn. The group outlives
 * its leader, so this is how orphaned grandchildren (an MCP server under an
 * exited npx wrapper) stay reachable.
 */
export const posixGroupTree = (np: NodeProcessApi, pgid: number): ProcessTree => {
  const description = `process group ${pgid}`;
  const kill = (signal: TreeSignal | 0) =>
    Effect.try({
      try: () => np.kill(-pgid, signal),
      catch: (cause) => cause,
    });
  return {
    description,
    isAlive: kill(0).pipe(
      Effect.as(true),
      Effect.catchAll((cause) => {
        const code = errnoCode(cause);
        if (code === 'ESRCH') return Effect.succeed(false);
        // EPERM: the group exists but is not ours to signal; it is still alive.
        if (code === 'EPERM') return Effect.succeed(true);
        return Effect.fail(signalFailed(description, 0, cause));
      })
    ),
    signal: (signal) =>
      kill(signal).pipe(
        Effect.as<SignalOutcome>('delivered'),
        Effect.catchAll((cause) =>
          errnoCode(cause) === 'ESRCH'
            ? Effect.succeed<SignalOutcome>('gone')
            : Effect.fail(signalFailed(description, signal, cause))
        )
      ),
  };
};

/**
 * A process with no group of its own; only the root can be reached. A child
 * that never started reads as alive until signalled, where `kill()` reporting
 * no delivery settles it as gone.
 */
export const childTree = (child: ChildProcess): ProcessTree => {
  const description = `process ${child.pid ?? '(not started)'}`;
  return {
    description,
    isAlive: Effect.sync(() => !hasExited(child)),
    signal: (signal) =>
      Effect.try({
        try: () => child.kill(signal),
        catch: (cause) => cause,
      }).pipe(
        Effect.map((delivered): SignalOutcome => (delivered ? 'delivered' : 'gone')),
        Effect.catchAll((cause) =>
          errnoCode(cause) === 'ESRCH'
            ? Effect.succeed<SignalOutcome>('gone')
            : Effect.fail(signalFailed(description, signal, cause))
        )
      ),
  };
};

/**
 * Spawn taskkill and subscribe in the same synchronous step: attaching after
 * a fiber yield could miss the `close` of a taskkill that finished first.
 * Interruption (the deadline) kills a taskkill that is still running.
 */
const runTaskkill = (np: NodeProcessApi, args: readonly string[]) =>
  Effect.async<number | null, unknown>((resume) => {
    let taskkill: ChildProcess;
    try {
      taskkill = np.spawn('taskkill', args, { stdio: 'ignore', windowsHide: true });
    } catch (cause) {
      resume(Effect.fail(cause));
      return Effect.void;
    }
    const onClose = (code: number | null) => resume(Effect.succeed(code));
    const onError = (error: Error) => resume(Effect.fail(error));
    taskkill.once('close', onClose);
    taskkill.once('error', onError);
    return Effect.sync(() => {
      taskkill.off('close', onClose);
      taskkill.off('error', onError);
      if (!hasExited(taskkill)) taskkill.kill();
    });
  });

/**
 * `taskkill /T` walks the tree from the root at call time. A descendant whose
 * parent already exited is no longer reachable from it; only a Job Object
 * could contain that case, and this tree does not claim to.
 */
export const windowsTree = (
  np: NodeProcessApi,
  root: ChildProcess & { pid: number }
): ProcessTree => {
  const description = `process tree ${root.pid}`;
  return {
    description,
    isAlive: Effect.sync(() => !hasExited(root)),
    signal: (signal) =>
      Effect.gen(function* () {
        const force = signal === 'SIGKILL';
        const code = yield* runTaskkill(np, [
          '/PID',
          String(root.pid),
          '/T',
          ...(force ? ['/F'] : []),
        ]).pipe(
          Effect.mapError((cause) => signalFailed(description, signal, cause)),
          Effect.timeoutFail({
            duration: TASKKILL_DEADLINE,
            onTimeout: () =>
              signalFailed(
                description,
                signal,
                new Error(`taskkill did not finish within ${Duration.format(TASKKILL_DEADLINE)}`)
              ),
          })
        );
        if (code === 0) return 'delivered' as const;
        if (code === TASKKILL_NOT_FOUND) return 'gone' as const;
        return yield* Effect.fail(
          signalFailed(description, signal, new Error(`taskkill exited with status ${code}`))
        );
      }),
  };
};

/**
 * The tree a spawned child heads. `processGroup` must match how the child was
 * spawned: only a `detached` POSIX spawn leads its own group.
 */
export const childProcessTree = (
  child: ChildProcess,
  options: { readonly processGroup: boolean }
): Effect.Effect<ProcessTree, never, NodeProcess> =>
  Effect.map(NodeProcess, (np) => {
    if (!hasPid(child)) return childTree(child);
    if (np.platform === 'win32') return windowsTree(np, child);
    return options.processGroup ? posixGroupTree(np, child.pid) : childTree(child);
  });

/** Poll until the whole tree is gone. `false` means it outlived `within`. */
export const waitUntilGone = (
  tree: ProcessTree,
  within: Duration.DurationInput
): Effect.Effect<boolean, TerminationFailed> => {
  const poll: Effect.Effect<boolean, TerminationFailed> = Effect.flatMap(tree.isAlive, (alive) =>
    alive
      ? Effect.zipRight(
          Effect.sleep(TREE_POLL_INTERVAL),
          Effect.suspend(() => poll)
        )
      : Effect.succeed(true)
  );
  return Effect.timeoutTo(poll, {
    duration: within,
    onSuccess: (gone) => gone,
    onTimeout: () => false,
  });
};

/**
 * SIGTERM, bounded grace, SIGKILL, bounded wait. Succeeds only once the whole
 * tree is proven gone; otherwise fails with `TerminationFailed`.
 */
export const terminateTree = (
  tree: ProcessTree,
  policy: TerminationPolicy
): Effect.Effect<void, TerminationFailed> =>
  Effect.gen(function* () {
    if (!(yield* tree.isAlive)) return;

    if (policy.graceMs > 0) {
      const graceful = yield* Effect.either(tree.signal('SIGTERM'));
      if (Either.isRight(graceful)) {
        if (graceful.right === 'gone') return;
        if (yield* waitUntilGone(tree, Duration.millis(policy.graceMs))) return;
        yield* Effect.logDebug(
          `${tree.description} still running ${policy.graceMs}ms after SIGTERM; escalating to SIGKILL`
        );
      } else {
        // A tree that cannot take SIGTERM (a Windows console app refusing a
        // graceful taskkill) gains nothing from waiting out the grace period.
        yield* Effect.logDebug(
          `SIGTERM was not delivered to ${tree.description}; escalating to SIGKILL: ${graceful.left.message}`
        );
      }
    }

    if ((yield* tree.signal('SIGKILL')) === 'gone') return;
    if (yield* waitUntilGone(tree, Duration.millis(policy.killWaitMs))) return;
    yield* Effect.fail(
      new TerminationFailed({
        target: tree.description,
        reason: 'still-alive',
        message: `${tree.description} was still running ${policy.killWaitMs}ms after SIGKILL`,
      })
    );
  });

// ---- managed-process ------------------------------------------

export interface ProcessExit {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
}

export interface SpawnSpec {
  readonly command: string;
  readonly args: readonly string[];
  readonly options: SpawnOptions;
  /**
   * Start the child as the leader of its own POSIX process group so the whole
   * subtree can be signalled. Ignored on Windows, where the tree is walked
   * from the root pid instead.
   */
  readonly processGroup: boolean;
  /**
   * Windows only: start the child `detached`, with its own hidden console, so
   * it outlives the console that launched it (a daemon started from a
   * terminal). POSIX detachment always follows `processGroup`; the Windows
   * tree is walked from the root pid either way.
   */
  readonly windowsDetached?: boolean;
  /**
   * Runs synchronously right after the OS call, before any asynchronous
   * post-spawn step. Anything that must observe the child's first stdio or
   * lifecycle event (output capture, event replay) attaches here.
   */
  readonly onSpawned?: (child: ChildProcess) => void;
}

export interface ManagedProcess {
  readonly child: ChildProcess;
  readonly tree: ProcessTree;
  /** The root's pid once the OS confirms the start, or the spawn error. */
  readonly started: Effect.Effect<number, SpawnFailed>;
  /** The root's exit. A child that never started completes with nulls. */
  readonly exited: Effect.Effect<ProcessExit>;
  /** Exit plus drained stdio (`close`): the point where captured output is complete. */
  readonly closed: Effect.Effect<ProcessExit>;
  /**
   * Terminate the whole tree under `policy`. Concurrent calls each converge
   * on "gone": a forced call during a graceful one escalates at once instead
   * of waiting out the grace period, and a call after a successful one
   * returns immediately because nothing is left alive.
   */
  readonly terminate: (policy: TerminationPolicy) => Effect.Effect<void, TerminationFailed>;
}

/**
 * Spawn a process whose termination the caller owns. Prefer `spawnScoped`;
 * this form exists for owners whose lifetime is not yet an Effect scope.
 */
export const spawnProcess = (
  spec: SpawnSpec
): Effect.Effect<ManagedProcess, SpawnFailed, NodeProcess> =>
  Effect.gen(function* () {
    const np = yield* NodeProcess;
    const processGroup = spec.processGroup && np.platform !== 'win32';
    const exited = yield* Deferred.make<ProcessExit>();
    const closed = yield* Deferred.make<ProcessExit>();
    const started = yield* Deferred.make<number, SpawnFailed>();
    const spawnFailed = (cause: unknown) =>
      new SpawnFailed({
        command: spec.command,
        message: `Failed to spawn ${spec.command}: ${formatErrorMessage(cause)}`,
        cause,
      });
    const child = yield* Effect.try({
      try: () => {
        const spawned = np.spawn(spec.command, spec.args, {
          // The daemon runs without a console on Windows; without
          // CREATE_NO_WINDOW every console child pops a window and steals focus.
          windowsHide: true,
          ...spec.options,
          detached: np.platform === 'win32' ? spec.windowsDetached === true : processGroup,
        });
        // Subscribe before anything can yield: Node reports a failed spawn on
        // the next tick, and a listener attached later would never hear it.
        if (typeof spawned.pid === 'number' && spawned.pid > 0) {
          Deferred.unsafeDone(started, Effect.succeed(spawned.pid));
        }
        spawned.once('spawn', () => {
          if (typeof spawned.pid === 'number' && spawned.pid > 0) {
            Deferred.unsafeDone(started, Effect.succeed(spawned.pid));
          }
        });
        spawned.once('exit', (code, signal) => {
          Deferred.unsafeDone(exited, Effect.succeed({ code, signal }));
        });
        spawned.once('close', (code, signal) => {
          Deferred.unsafeDone(closed, Effect.succeed({ code, signal }));
        });
        spawned.once('error', (error) => {
          // A spawn failure has no exit event; release anyone awaiting one.
          if (typeof spawned.pid !== 'number') {
            Deferred.unsafeDone(started, Effect.fail(spawnFailed(error)));
            Deferred.unsafeDone(exited, Effect.succeed({ code: null, signal: null }));
            Deferred.unsafeDone(closed, Effect.succeed({ code: null, signal: null }));
          }
        });
        spec.onSpawned?.(spawned);
        return spawned;
      },
      catch: spawnFailed,
    });
    const tree = yield* childProcessTree(child, { processGroup });
    return {
      child,
      tree,
      started: Deferred.await(started),
      exited: Deferred.await(exited),
      closed: Deferred.await(closed),
      terminate: (policy) => terminateTree(tree, policy),
    } satisfies ManagedProcess;
  });

/**
 * Spawn a process owned by the current scope: closing the scope terminates
 * its whole tree under `releasePolicy`. A release that cannot prove the tree
 * gone is logged, because a finalizer cannot fail.
 */
export const spawnScoped = (
  spec: SpawnSpec,
  releasePolicy: TerminationPolicy
): Effect.Effect<ManagedProcess, SpawnFailed, NodeProcess | Scope.Scope> =>
  Effect.acquireRelease(spawnProcess(spec), (managed) =>
    managed
      .terminate(releasePolicy)
      .pipe(
        Effect.catchAll((error) =>
          Effect.logWarning(`Scope release could not terminate ${error.target}: ${error.message}`)
        )
      )
  );

// ---- command --------------------------------------------------

/** Node's `execFile` default, so migrated callers keep their output ceiling. */
export const DEFAULT_MAX_OUTPUT_BYTES = 1024 * 1024;

/** How a command is ended when its caller stops waiting (timeout, interrupt, output limit). */
const ABANDONED_COMMAND_POLICY: TerminationPolicy = { graceMs: 0, killWaitMs: 2_000 };

export interface CommandSpec {
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd?: string;
  readonly env?: NodeJS.ProcessEnv;
  /** Written to stdin, which is then closed. Without it stdin is ignored. */
  readonly input?: string | Buffer;
  /** Ends the whole process tree and fails with `CommandTimedOut` when exceeded. */
  readonly timeout?: Duration.DurationInput;
  /** Combined ceiling per stream; exceeding it fails with `CommandOutputTooLarge`. */
  readonly maxOutputBytes?: number;
}

export interface CommandOutput extends ProcessExit {
  readonly stdout: Buffer;
  readonly stderr: Buffer;
}

export class CommandTimedOut extends Data.TaggedError('CommandTimedOut')<{
  readonly command: string;
  readonly message: string;
}> {}

export class CommandOutputTooLarge extends Data.TaggedError('CommandOutputTooLarge')<{
  readonly command: string;
  readonly message: string;
}> {}

/**
 * A command that exited unsuccessfully. Carries what `execFile` rejected with,
 * so callers that classify git or gh failures by stderr keep working.
 */
export class CommandFailed extends Data.TaggedError('CommandFailed')<{
  readonly command: string;
  readonly args: readonly string[];
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly message: string;
}> {}

export type RunCommandError = SpawnFailed | CommandTimedOut | CommandOutputTooLarge;

const describe = (spec: Pick<CommandSpec, 'command' | 'args'>) =>
  [spec.command, ...spec.args].join(' ');

/**
 * Run a command to completion and collect its output, whatever its exit status.
 * The command leads its own process tree. A caller that stops waiting (timeout,
 * interruption, output over the limit) ends that whole tree; a command that
 * exits on its own keeps whatever it deliberately left running, as `execFile`
 * did (daemons such as an fsmonitor or an agent socket).
 */
export const runCommand = (
  spec: CommandSpec
): Effect.Effect<CommandOutput, RunCommandError, NodeProcess> =>
  Effect.scoped(
    Effect.gen(function* () {
      const maxBytes = spec.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
      const stdout: Buffer[] = [];
      const stderr: Buffer[] = [];
      let stdoutBytes = 0;
      let stderrBytes = 0;
      const overflowed = yield* Deferred.make<never, CommandOutputTooLarge>();
      const overflow = () =>
        Deferred.unsafeDone(
          overflowed,
          Effect.fail(
            new CommandOutputTooLarge({
              command: spec.command,
              message: `${describe(spec)} wrote more than ${maxBytes} bytes to one stream`,
            })
          )
        );
      const managed = yield* Effect.acquireRelease(
        spawnProcess({
          command: spec.command,
          args: spec.args,
          options: {
            cwd: spec.cwd,
            env: spec.env,
            stdio: [spec.input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
          },
          processGroup: true,
          onSpawned: (child) => {
            child.stdout?.on('data', (chunk: Buffer) => {
              stdoutBytes += chunk.length;
              if (stdoutBytes > maxBytes) overflow();
              else stdout.push(chunk);
            });
            child.stderr?.on('data', (chunk: Buffer) => {
              stderrBytes += chunk.length;
              if (stderrBytes > maxBytes) overflow();
              else stderr.push(chunk);
            });
            if (spec.input !== undefined && child.stdin) {
              // A child that exits without reading its input closes the pipe;
              // that is its choice, not a failure of this call.
              child.stdin.on('error', () => {});
              child.stdin.end(spec.input);
            }
          },
        }),
        (process, exit) =>
          Exit.isSuccess(exit)
            ? Effect.void
            : process
                .terminate(ABANDONED_COMMAND_POLICY)
                .pipe(
                  Effect.catchAll((error) =>
                    Effect.logWarning(
                      `Abandoned command ${describe(spec)} could not be terminated: ${error.message}`
                    )
                  )
                )
      );
      yield* managed.started;
      const finished = Effect.raceFirst(managed.closed, Deferred.await(overflowed));
      const exit = yield* spec.timeout
        ? finished.pipe(
            Effect.timeoutFail({
              duration: spec.timeout,
              onTimeout: () =>
                new CommandTimedOut({
                  command: spec.command,
                  message: `${describe(spec)} did not finish within ${Duration.format(spec.timeout ?? 0)}`,
                }),
            })
          )
        : finished;
      return { ...exit, stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr) };
    })
  );

const toCommandFailed = (spec: CommandSpec, output: CommandOutput) =>
  new CommandFailed({
    command: spec.command,
    args: spec.args,
    code: output.code,
    signal: output.signal,
    stdout: output.stdout.toString('utf8'),
    stderr: output.stderr.toString('utf8'),
    message: `${describe(spec)} failed (${output.signal ?? `exit ${output.code}`}): ${output.stderr.toString('utf8').trim()}`,
  });

/** `runCommand`, failing with `CommandFailed` unless the command exits 0. */
export const runCommandOk = (
  spec: CommandSpec
): Effect.Effect<CommandOutput, RunCommandError | CommandFailed, NodeProcess> =>
  Effect.flatMap(runCommand(spec), (output) =>
    output.code === 0 && output.signal === null
      ? Effect.succeed(output)
      : Effect.fail(toCommandFailed(spec, output))
  );

/**
 * Blocking variant for callers that are synchronous by contract. It stalls the
 * daemon's event loop for the command's whole run, so it requires a timeout;
 * prefer `runCommand` wherever the caller can await.
 */
export const runCommandSync = (
  spec: CommandSpec & { readonly timeout: Duration.DurationInput }
): Effect.Effect<CommandOutput, RunCommandError, NodeProcess> =>
  Effect.gen(function* () {
    const np = yield* NodeProcess;
    const timeoutMs = Duration.toMillis(Duration.decode(spec.timeout));
    const result = np.spawnSync(spec.command, spec.args, {
      cwd: spec.cwd,
      env: spec.env,
      input: spec.input,
      timeout: timeoutMs,
      killSignal: 'SIGKILL',
      maxBuffer: spec.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES,
      windowsHide: true,
      stdio: [spec.input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
    });
    const errorCode = (result.error as NodeJS.ErrnoException | undefined)?.code;
    if (errorCode === 'ETIMEDOUT') {
      return yield* Effect.fail(
        new CommandTimedOut({
          command: spec.command,
          message: `${describe(spec)} did not finish within ${timeoutMs}ms`,
        })
      );
    }
    if (errorCode === 'ENOBUFS') {
      return yield* Effect.fail(
        new CommandOutputTooLarge({
          command: spec.command,
          message: `${describe(spec)} wrote more than its output limit`,
        })
      );
    }
    if (result.error) {
      return yield* Effect.fail(
        new SpawnFailed({
          command: spec.command,
          message: `Failed to spawn ${spec.command}: ${formatErrorMessage(result.error)}`,
          cause: result.error,
        })
      );
    }
    return {
      code: result.status,
      signal: result.signal,
      stdout: result.stdout ?? Buffer.alloc(0),
      stderr: result.stderr ?? Buffer.alloc(0),
    };
  });

/** `runCommandSync`, failing with `CommandFailed` unless the command exits 0. */
export const runCommandSyncOk = (
  spec: CommandSpec & { readonly timeout: Duration.DurationInput }
): Effect.Effect<CommandOutput, RunCommandError | CommandFailed, NodeProcess> =>
  Effect.flatMap(runCommandSync(spec), (output) =>
    output.code === 0 && output.signal === null
      ? Effect.succeed(output)
      : Effect.fail(toCommandFailed(spec, output))
  );

/**
 * What `kill(pid, 0)` says about a pid: `ours` (a live process we may signal),
 * `foreign` (a live process owned by another user: EPERM), or `missing`.
 */
export type PidState = 'ours' | 'foreign' | 'missing';

export const probePid = (pid: number): Effect.Effect<PidState, never, NodeProcess> =>
  Effect.map(NodeProcess, (np) => {
    try {
      np.kill(pid, 0);
      return 'ours';
    } catch (error) {
      return (error as NodeJS.ErrnoException | undefined)?.code === 'EPERM' ? 'foreign' : 'missing';
    }
  });

/** Whether any process has this pid, including one owned by another user. */
export const isPidAlive = (pid: number): Effect.Effect<boolean, never, NodeProcess> =>
  Effect.map(probePid(pid), (state) => state !== 'missing');

// ---- promise facades ----------------------------------------------------

/*
 * TEMPORARY doors for Promise code that has not become an Effect yet. Each
 * caller is deleted from this list when its own layer migrates; see
 * `.agents/docs/cli-effect-ts.md#temporary-promise-facades`. Failures reject
 * with the typed error itself (`Cause.squash`), and a spawn failure with the
 * raw OS error (`code: 'ENOENT'`), as the callers' old `child_process` code did.
 */

export interface ProcessFacadeOptions {
  /** Where `Effect.log*` from the process layer goes; silent when omitted. */
  readonly loggerLayer?: Layer.Layer<never>;
  readonly nodeProcess?: NodeProcessApi;
}

export type ProcessRunner = <A, E>(effect: Effect.Effect<A, E, NodeProcess>) => Promise<A>;

export const processLayer = (options: ProcessFacadeOptions): Layer.Layer<NodeProcess> =>
  Layer.merge(
    Layer.succeed(NodeProcess, options.nodeProcess ?? nodeProcessLive),
    options.loggerLayer ?? Logger.replace(Logger.defaultLogger, Logger.none)
  );

export const runPromiseSquashed = <A, E>(effect: Effect.Effect<A, E>): Promise<A> =>
  Effect.runPromiseExit(effect).then((exit) => {
    if (Exit.isSuccess(exit)) return exit.value;
    throw Cause.squash(exit.cause);
  });

const runSyncSquashed = <A, E>(effect: Effect.Effect<A, E>): A => {
  const exit = Effect.runSyncExit(effect);
  if (Exit.isSuccess(exit)) return exit.value;
  throw Cause.squash(exit.cause);
};

const unwrapSpawnFailure = (error: unknown): unknown =>
  error instanceof SpawnFailed && error.cause instanceof Error ? error.cause : error;

export const makeProcessRunner = (options: ProcessFacadeOptions): ProcessRunner => {
  const layer = processLayer(options);
  return (effect) => runPromiseSquashed(Effect.provide(effect, layer));
};

/** Facade options that swap only the spawn function, for callers with a spawn test seam. */
export const withSpawn = (
  spawnImpl: NodeProcessApi['spawn'] | undefined,
  options: Omit<ProcessFacadeOptions, 'nodeProcess'> = {}
): ProcessFacadeOptions =>
  spawnImpl ? { ...options, nodeProcess: { ...nodeProcessLive, spawn: spawnImpl } } : options;

export interface CommandText {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stdout: string;
  readonly stderr: string;
}

const toText = (output: CommandOutput): CommandText => ({
  code: output.code,
  signal: output.signal,
  stdout: output.stdout.toString('utf8'),
  stderr: output.stderr.toString('utf8'),
});

/**
 * `runCommand` / `runCommandOk` for Promise callers. `check: 'exit-0'` rejects
 * with `CommandFailed` on a non-zero exit, like `execFile`; `check: 'none'`
 * resolves with any exit status.
 */
export const runCommandText = async (
  spec: CommandSpec & { readonly check: 'exit-0' | 'none' },
  options: ProcessFacadeOptions = {}
): Promise<CommandText> => {
  const run = makeProcessRunner(options);
  try {
    return toText(await run(spec.check === 'exit-0' ? runCommandOk(spec) : runCommand(spec)));
  } catch (error) {
    throw unwrapSpawnFailure(error);
  }
};

/** `runCommandSync` for synchronous callers; blocks the event loop. */
export const runCommandTextSync = (
  spec: CommandSpec & {
    readonly timeout: Duration.DurationInput;
    readonly check: 'exit-0' | 'none';
  },
  options: ProcessFacadeOptions = {}
): CommandText => {
  const effect = spec.check === 'exit-0' ? runCommandSyncOk(spec) : runCommandSync(spec);
  try {
    return toText(runSyncSquashed(Effect.provide(effect, processLayer(options))));
  } catch (error) {
    throw unwrapSpawnFailure(error);
  }
};

export interface ProcessHandle {
  readonly child: ChildProcess;
  /** Resolves with the root's exit; never rejects. */
  readonly exited: Promise<ProcessExit>;
  /** Terminate the whole tree; rejects with `TerminationFailed` if it survives. */
  terminate(policy: TerminationPolicy): Promise<void>;
}

/**
 * `spawnProcess` for long-lived children owned by Promise code. Synchronous
 * like `spawn`: an asynchronous start failure arrives on `child`'s `error`
 * event, and `exited` then resolves with nulls.
 */
export const startProcess = (spec: SpawnSpec, options: ProcessFacadeOptions = {}): ProcessHandle => {
  let managed: ManagedProcess;
  try {
    managed = runSyncSquashed(Effect.provide(spawnProcess(spec), processLayer(options)));
  } catch (error) {
    throw unwrapSpawnFailure(error);
  }
  const run = makeProcessRunner(options);
  return {
    child: managed.child,
    exited: runPromiseSquashed(managed.exited),
    terminate: (policy) => run(managed.terminate(policy)),
  };
};

/** End an existing child's whole tree (its group when it was started detached). */
export const terminateChildTree = (
  child: ChildProcess,
  policy: TerminationPolicy & { readonly processGroup: boolean },
  options: ProcessFacadeOptions = {}
): Promise<void> =>
  makeProcessRunner(options)(
    Effect.flatMap(childProcessTree(child, { processGroup: policy.processGroup }), (tree) =>
      terminateTree(tree, policy)
    )
  );

/**
 * Send one signal to a child's tree without waiting, for `process.on('exit')`
 * handlers that cannot await. The signal (and a Windows `taskkill`) starts
 * before this returns; nothing confirms the tree is gone, so prefer
 * `terminateChildTree` wherever the caller can wait.
 */
export const signalChildTreeNow = (
  child: ChildProcess,
  signal: TreeSignal,
  target: { readonly processGroup: boolean },
  options: ProcessFacadeOptions = {}
): void => {
  // Run synchronously: a forked fiber would send nothing before the process
  // exits. A Windows `taskkill` is spawned inside the synchronous step and runs
  // to completion on its own, so the async remainder may be abandoned here.
  Effect.runSyncExit(
    Effect.provide(
      Effect.flatMap(childProcessTree(child, target), (tree) => tree.signal(signal)).pipe(
        Effect.catchAll((error) => Effect.logWarning(error.message))
      ),
      processLayer(options)
    )
  );
};

export const isPidAliveSync = (pid: number, options: ProcessFacadeOptions = {}): boolean =>
  runSyncSquashed(Effect.provide(isPidAlive(pid), processLayer(options)));

export const probePidSync = (pid: number, options: ProcessFacadeOptions = {}): PidState =>
  runSyncSquashed(Effect.provide(probePid(pid), processLayer(options)));
