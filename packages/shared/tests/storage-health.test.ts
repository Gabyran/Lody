import { LoroRepo, type StorageAdapter } from 'loro-repo';
import { describe, expect, it } from 'vitest';
import {
  RepoStorageGuard,
  StorageFullRecovery,
  classifyStorageFullError,
  observeStorageAdapterWrites,
} from '../src';

const withCode = (code: string) => Object.assign(new Error(code), { code });

describe('classifyStorageFullError', () => {
  it('classifies out-of-space errors by code or name, wherever they are wrapped', () => {
    expect(classifyStorageFullError(withCode('ENOSPC'))).toBe('ENOSPC');
    expect(classifyStorageFullError(withCode('EDQUOT'))).toBe('EDQUOT');
    expect(
      classifyStorageFullError(
        new AggregateError([new Error('snapshot'), withCode('SQLITE_FULL')], 'fallback failed')
      )
    ).toBe('SQLITE_FULL');
    const repoQuota = Object.assign(new Error('write refused'), {
      name: 'RepoStorageError',
      code: 'quota',
    });
    expect(classifyStorageFullError(new Error('flush', { cause: repoQuota }))).toBe(
      'RepoStorageError:quota'
    );
    expect(classifyStorageFullError(new DOMException('full', 'QuotaExceededError'))).toBe(
      'QuotaExceededError'
    );
  });

  it('rejects other failures, including a message that merely mentions a full disk', () => {
    expect(classifyStorageFullError(new Error('database or disk is full'))).toBeNull();
    expect(
      classifyStorageFullError(
        Object.assign(new Error('closing'), { name: 'RepoStorageError', code: 'unavailable' })
      )
    ).toBeNull();
    expect(classifyStorageFullError(withCode('EACCES'))).toBeNull();
    const cyclic: { cause?: unknown } = new Error('cycle');
    cyclic.cause = cyclic;
    expect(classifyStorageFullError(cyclic)).toBeNull();
  });
});

describe('observeStorageAdapterWrites', () => {
  it('reports write outcomes, rethrows failures and keeps missing capabilities absent', async () => {
    let failNext = false;
    const saved: unknown[] = [];
    const inner: StorageAdapter = {
      save: async (payload) => {
        if (failNext) throw withCode('SQLITE_FULL');
        saved.push(payload);
      },
      loadDoc: async () => undefined,
      loadMeta: async () => undefined,
    };
    const outcomes: string[] = [];
    const adapter = observeStorageAdapterWrites(inner, {
      onWriteFailed: (error, operation) =>
        outcomes.push(`failed:${operation}:${classifyStorageFullError(error)}`),
      onWriteSucceeded: () => outcomes.push('ok'),
    });

    const payload = { type: 'meta', update: new Uint8Array([1]) } as never;
    await adapter.save(payload);
    failNext = true;
    await expect(adapter.save(payload)).rejects.toMatchObject({ code: 'SQLITE_FULL' });
    await adapter.loadDoc('doc-1');

    expect(saved).toEqual([payload]);
    expect(outcomes).toEqual(['ok', 'failed:save:SQLITE_FULL']);
    // loro-repo feature-detects optional methods, so the wrapper must not invent them.
    expect('deleteDoc' in adapter).toBe(false);
    expect('loadMetaReplica' in adapter).toBe(false);
  });
});

/** Timers fire only when the test fires them; the clock moves only when the test moves it. */
const createManualScheduler = () => {
  let nowMs = 1_000;
  let nextId = 1;
  const timers = new Map<number, { at: number; callback: () => void }>();
  return {
    now: () => nowMs,
    setTimer: (callback: () => void, delayMs: number): unknown => {
      const id = nextId++;
      timers.set(id, { at: nowMs + delayMs, callback });
      return id;
    },
    clearTimer: (handle: unknown) => {
      timers.delete(handle as number);
    },
    pendingDelays: () => [...timers.values()].map((timer) => timer.at - nowMs),
    advance(ms: number) {
      const until = nowMs + ms;
      for (;;) {
        const due = [...timers.entries()]
          .filter(([, timer]) => timer.at <= until)
          .sort(([, a], [, b]) => a.at - b.at)[0];
        if (!due) break;
        timers.delete(due[0]);
        nowMs = due[1].at;
        due[1].callback();
      }
      nowMs = until;
    },
  };
};

describe('StorageFullRecovery over a real LoroRepo', () => {
  /**
   * An in-memory store that refuses metadata writes while `metaFull` is set, the
   * way IndexedDB refuses one transaction for quota while a smaller one fits.
   */
  const createStore = () => {
    const state = { metaFull: false, saved: [] as string[] };
    const adapter: StorageAdapter = {
      save: async (payload) => {
        const target = 'docId' in payload ? `${payload.type}:${payload.docId}` : payload.type;
        if (state.metaFull && payload.type.startsWith('meta-')) {
          throw new DOMException('quota', 'QuotaExceededError');
        }
        state.saved.push(target);
      },
      loadDoc: async () => undefined,
      loadMeta: async () => undefined,
    };
    return { state, adapter };
  };

  const setup = async () => {
    const scheduler = createManualScheduler();
    const store = createStore();
    const transitions: Array<number | null> = [];
    let repo: LoroRepo | null = null;
    // Composed the way create-workspace-runtime composes the renderer repo.
    const recovery = new StorageFullRecovery({
      flush: async () => {
        if (!repo) throw new Error('repo not ready');
        await repo.flush();
      },
      onChange: (next) => transitions.push(next?.since ?? null),
      now: scheduler.now,
      setTimer: scheduler.setTimer,
      clearTimer: scheduler.clearTimer,
      retryDelaysMs: [5_000, 15_000],
    });
    repo = await LoroRepo.create({
      storageAdapter: observeStorageAdapterWrites(store.adapter, {
        onWriteFailed: (error) => recovery.reportWriteFailed(error),
        onWriteSucceeded: () => recovery.reportWriteSucceeded(),
      }),
      metaDebounceCommitMs: 0,
    });
    const writeDoc = async (docId: string) => {
      const handle = await repo!.openPersistedDoc(docId);
      handle.doc.getText('body').insert(0, docId);
      handle.doc.commit();
      await repo!.persistDocNow(docId, handle.doc);
    };
    return { scheduler, store, transitions, recovery, repo, writeDoc };
  };

  it('keeps the episode open when an unrelated doc write succeeds while meta is still refused', async () => {
    const { scheduler, store, transitions, recovery, repo, writeDoc } = await setup();
    store.state.metaFull = true;
    await repo.upsertDocMeta('doc-a', { title: 'kept in memory' });
    await expect(repo.persistMetaNow()).rejects.toThrow();
    expect(transitions).toEqual([1_000]);

    // A smaller write fits. It triggers a recovery flush, which re-hits the refused meta.
    await writeDoc('healthy-doc');
    await recovery.settled();
    expect(store.state.saved).toContain('doc-update:healthy-doc');
    expect(store.state.saved.some((target) => target.startsWith('meta-'))).toBe(false);
    expect(recovery.since).toBe(1_000);
    expect(transitions).toEqual([1_000]);

    // The failed flush keeps retrying on its own, with backoff.
    expect(scheduler.pendingDelays()).toEqual([15_000]);
    scheduler.advance(15_000);
    await recovery.settled();
    expect(recovery.since).toBe(1_000);

    // Space returns: the next retry flushes the dirty meta, and only then the episode ends.
    store.state.metaFull = false;
    scheduler.advance(15_000);
    await recovery.settled();
    expect(store.state.saved.some((target) => target.startsWith('meta-'))).toBe(true);
    expect(recovery.since).toBeNull();
    expect(transitions).toEqual([1_000, null]);
    expect(scheduler.pendingDelays()).toEqual([]);
    recovery.dispose();
    await repo.destroy();
  });

  it('does not let a flush that raced a newer failure end the episode', async () => {
    const scheduler = createManualScheduler();
    let releaseFlush!: () => void;
    const transitions: Array<number | null> = [];
    const recovery = new StorageFullRecovery({
      flush: () =>
        new Promise<void>((resolve) => {
          releaseFlush = resolve;
        }),
      onChange: (next) => transitions.push(next?.since ?? null),
      now: scheduler.now,
      setTimer: scheduler.setTimer,
      clearTimer: scheduler.clearTimer,
    });
    const quota = new DOMException('quota', 'QuotaExceededError');
    recovery.reportWriteFailed(quota);
    recovery.reportWriteSucceeded();
    // Another resource is refused while the recovery flush is still running.
    recovery.reportWriteFailed(quota);
    releaseFlush();
    await recovery.settled();
    expect(recovery.since).toBe(1_000);
    expect(transitions).toEqual([1_000]);
    recovery.dispose();
  });
});

describe('RepoStorageGuard over a real LoroRepo', () => {
  /** Refuses every write while `full`, like an IndexedDB origin out of quota. */
  const createQuotaStore = () => {
    const state = { full: false, saved: [] as string[] };
    const adapter: StorageAdapter = {
      save: async (payload) => {
        if (state.full) throw new DOMException('quota', 'QuotaExceededError');
        state.saved.push('docId' in payload ? `${payload.type}:${payload.docId}` : payload.type);
      },
      loadDoc: async () => undefined,
      loadMeta: async () => undefined,
    };
    return { state, adapter };
  };

  it('keeps a repo closed while full open, and destroys it only once recovery saved it', async () => {
    const scheduler = createManualScheduler();
    const store = createQuotaStore();
    const unsaved: Array<number | null> = [];
    let closed = 0;
    const { promise: closedSignal, resolve: signalClosed } = Promise.withResolvers<void>();
    const guard = new RepoStorageGuard(store.adapter, {
      onUnsavedChange: (since) => unsaved.push(since),
      onClosed: () => {
        closed += 1;
        signalClosed();
      },
      now: scheduler.now,
      setTimer: scheduler.setTimer,
      clearTimer: scheduler.clearTimer,
    });
    const repo = await LoroRepo.create({ storageAdapter: guard.adapter, metaDebounceCommitMs: 0 });
    guard.attach(repo);

    store.state.full = true;
    const handle = await repo.openPersistedDoc('doc-a');
    handle.doc.getText('body').insert(0, 'only in memory');
    handle.doc.commit();
    await expect(repo.persistDocNow('doc-a', handle.doc)).rejects.toThrow();
    await repo.upsertDocMeta('doc-a', { title: 'only in memory' });
    expect(unsaved).toEqual([1_000]);

    // The workspace is switched away (runtime disposed) while storage is still full.
    await expect(guard.close()).resolves.toBe('retained');
    expect(closed).toBe(0);
    // The quit-time flush still cannot save it.
    await expect(guard.flushNow()).resolves.toBe(1_000);

    store.state.full = false;
    await expect(guard.flushNow()).resolves.toBeNull();
    await closedSignal;
    expect(closed).toBe(1);
    expect(unsaved).toEqual([1_000, null]);
    expect(store.state.saved).toEqual(
      expect.arrayContaining(['doc-update:doc-a', expect.stringMatching(/^meta-/)])
    );
  });

  it('closes at once when nothing is unsaved', async () => {
    const store = createQuotaStore();
    let closed = 0;
    const guard = new RepoStorageGuard(store.adapter, {
      onUnsavedChange: () => {},
      onClosed: () => {
        closed += 1;
      },
    });
    const repo = await LoroRepo.create({ storageAdapter: guard.adapter, metaDebounceCommitMs: 0 });
    guard.attach(repo);
    await repo.upsertDocMeta('doc-a', { title: 'saved' });
    await expect(guard.close()).resolves.toBe('closed');
    expect(closed).toBe(1);
    expect(store.state.saved.some((target) => target.startsWith('meta-'))).toBe(true);
  });
});
