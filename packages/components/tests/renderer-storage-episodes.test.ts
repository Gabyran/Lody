// @vitest-environment jsdom
import { LoroRepo, type StorageAdapter, type StorageSavePayload } from 'loro-repo';
import { afterEach, describe, expect, it } from 'vitest';
import { RepoStorageGuard } from '@lody/shared';
import {
  RendererStorageState,
  WindowStorageBarrier,
  SIGN_OUT_CANCELLED_CODE,
  tearDownWindows,
} from '@lody/shared/renderer-storage-barrier';
import {
  RendererStorageEpisodes,
  rendererStorageEpisodes,
} from '../src/lib/renderer-storage-episodes';
import {
  getAuthSessionIntentGeneration,
  signOutWithoutRedirect,
  type LodyAuthClient,
} from '../src/lib/auth';
import { readStoredAuthToken, writeStoredAuthToken } from '../src/lib/auth-bootstrap';
import { readLastAppRoutePath, writeLastAppRoutePath } from '../src/lib/last-app-route';
import { readPreferredWorkspaceSlug, writePreferredWorkspaceSlug } from '../src/lib/workspace';

/** Refuses every write while `full`, like an IndexedDB origin out of quota. */
const createQuotaStore = () => {
  const state = { full: false, saved: [] as string[] };
  const target = (payload: StorageSavePayload) =>
    'docId' in payload ? `${payload.type}:${payload.docId}` : payload.type;
  // Both entry points, like IndexedDBStorageAdaptor: metadata goes through `saveMany`.
  const adapter: StorageAdapter = {
    save: async (payload) => {
      if (state.full) throw new DOMException('quota', 'QuotaExceededError');
      state.saved.push(target(payload));
    },
    saveMany: async (payloads) => {
      if (state.full) throw new DOMException('quota', 'QuotaExceededError');
      state.saved.push(...payloads.map(target));
    },
    loadDoc: async () => undefined,
    loadMeta: async () => undefined,
  };
  return { state, adapter };
};

/** Composed the way create-workspace-runtime composes one workspace runtime's repo. */
const openRuntime = async (
  episodes: RendererStorageEpisodes,
  adapter: StorageAdapter,
  now: () => number
) => {
  const { promise: closed, resolve: signalClosed } = Promise.withResolvers<void>();
  const episode = episodes.register(() => guard.flushNow());
  const guard = new RepoStorageGuard(adapter, {
    onUnsavedChange: (since) => episode.report(since),
    onClosed: () => {
      episode.release();
      signalClosed();
    },
    now,
    // Retries are driven by the test through flushForQuit, not by timers.
    setTimer: () => null,
    clearTimer: () => {},
  });
  const repo = await LoroRepo.create({ storageAdapter: guard.adapter, metaDebounceCommitMs: 0 });
  guard.attach(repo);
  return { repo, guard, closed };
};

describe('RendererStorageEpisodes', () => {
  it('keeps a switched-away workspace unsaved until its repo is saved and closed', async () => {
    const published: Array<number | null> = [];
    const episodes = new RendererStorageEpisodes((since) => published.push(since));
    const storeA = createQuotaStore();
    const a = await openRuntime(episodes, storeA.adapter, () => 1_000);

    storeA.state.full = true;
    const handle = await a.repo.openPersistedDoc('doc-a');
    handle.doc.getText('body').insert(0, 'typed while the quota was exhausted');
    handle.doc.commit();
    await expect(a.repo.persistDocNow('doc-a', handle.doc)).rejects.toThrow();
    expect(published).toEqual([1_000]);

    // Switching workspaces disposes runtime A and opens runtime B.
    await expect(a.guard.close()).resolves.toBe('retained');
    const b = await openRuntime(episodes, createQuotaStore().adapter, () => 2_000);
    expect(episodes.earliestUnsaved).toBe(1_000);

    // Quitting now: the final flush is still refused, so the answer stays "unsaved".
    await expect(episodes.flushForQuit()).resolves.toBe(1_000);

    // Space is freed; the next quit check saves runtime A's repo and closes it.
    storeA.state.full = false;
    await expect(episodes.flushForQuit()).resolves.toBeNull();
    await a.closed;
    expect(storeA.state.saved).toContain('doc-update:doc-a');
    expect(published).toEqual([1_000, null]);
    await b.guard.close();
  });

  it('cancels closing or reloading the window until its repo is saved', async () => {
    const episodes = new RendererStorageEpisodes(() => {});
    const store = createQuotaStore();
    const runtime = await openRuntime(episodes, store.adapter, () => 1_000);
    const unload = () => {
      const event = { defaultPrevented: false, returnValue: '' as unknown };
      episodes.handleBeforeUnload({
        preventDefault: () => {
          event.defaultPrevented = true;
        },
        get returnValue() {
          return event.returnValue as never;
        },
        set returnValue(value) {
          event.returnValue = value;
        },
      });
      return event.defaultPrevented;
    };
    expect(unload()).toBe(false);

    store.state.full = true;
    await runtime.repo.upsertDocMeta('doc-a', { title: 'typed while full' });
    await expect(runtime.repo.persistMetaNow()).rejects.toThrow();
    // Close or reload now would drop the repo: the unload is cancelled.
    expect(unload()).toBe(true);
    // Main's window barrier asks for a flush first; still refused, so still cancelled.
    await expect(episodes.flushForQuit()).resolves.toBe(1_000);
    expect(unload()).toBe(true);

    // Space returns: the barrier's flush saves the repo, and the window may go.
    store.state.full = false;
    await expect(episodes.flushForQuit()).resolves.toBeNull();
    expect(store.state.saved.some((target) => target.startsWith('meta-'))).toBe(true);
    expect(unload()).toBe(false);
    await runtime.guard.close();
  });
});

describe('sign-out across windows', () => {
  /**
   * Window A signs out while window B's own repo holds a quota-refused write. The
   * main-side barrier talks to each window's registry the way the IPC does.
   */
  const setup = async (discard: boolean, lost: number[] = []) => {
    const state = new RendererStorageState();
    const windowA = new RendererStorageEpisodes((since) => state.report(1, since));
    const windowB = new RendererStorageEpisodes((since) => state.report(2, since));
    const registries = new Map([
      [1, windowA],
      [2, windowB],
    ]);
    const confirms: Array<[number, string]> = [];
    const barrier = new WindowStorageBarrier({
      state,
      quitApproved: () => false,
      reportLost: (windowId) => lost.push(windowId),
      confirmDiscard: async (since, kind) => {
        confirms.push([since, kind]);
        return discard;
      },
      quitCheck: {
        timeoutMs: 3_000,
        setTimer: () => null,
        clearTimer: () => {},
        send: (windowId, requestId) => {
          const registry = registries.get(windowId);
          if (!registry) return false;
          void registry
            .flushForQuit()
            .then((since) => state.handleQuitCheckResult(windowId, requestId, since));
          return true;
        },
      },
    });
    await openRuntime(windowA, createQuotaStore().adapter, () => 500);
    const storeB = createQuotaStore();
    const b = await openRuntime(windowB, storeB.adapter, () => 1_000);
    storeB.state.full = true;
    await b.repo.upsertDocMeta('doc-b', { title: 'typed in window B while full' });
    await expect(b.repo.persistMetaNow()).rejects.toThrow();
    expect(state.unsavedSince(2)).toBe(1_000);

    const destroyed: number[] = [];
    const signOut = () =>
      tearDownWindows({
        barrier,
        windowIds: [1, 2],
        keep: 1,
        kind: 'sign-out',
        destroy: (windowId) => destroyed.push(windowId),
      });
    return { state, barrier, confirms, storeB, b, destroyed, signOut };
  };

  it('keeps window B, its repo and its report when the user cancels, and saves it later', async () => {
    const { state, confirms, storeB, b, destroyed, signOut } = await setup(false);

    await expect(signOut()).resolves.toBe(false);
    expect(confirms).toEqual([[1_000, 'sign-out']]);
    expect(destroyed).toEqual([]);
    expect(state.unsavedSince(2)).toBe(1_000);

    // Space returns: the next sign-out's flush saves B's repo, so no question is asked.
    storeB.state.full = false;
    await expect(signOut()).resolves.toBe(true);
    expect(confirms).toHaveLength(1);
    expect(destroyed).toEqual([2]);
    expect(storeB.state.saved.some((target) => target.startsWith('meta-'))).toBe(true);
    await b.guard.close();
  });

  describe('through the shared sign-out', () => {
    afterEach(() => {
      delete (window as { ipc?: unknown }).ipc;
      localStorage.clear();
    });

    it('changes no auth state when a window becomes unsaved during the final check and the user cancels', async () => {
      const state = new RendererStorageState();
      const windowA = new RendererStorageEpisodes((since) => state.report(1, since));
      const windowB = new RendererStorageEpisodes((since) => state.report(2, since));
      const registries = new Map([
        [1, windowA],
        [2, windowB],
      ]);
      const storeA = createQuotaStore();
      const storeB = createQuotaStore();
      const a = await openRuntime(windowA, storeA.adapter, () => 500);
      const b = await openRuntime(windowB, storeB.adapter, () => 1_000);
      // B's refusal lands while A, the window signing out, is being flushed.
      const refuseInB = async () => {
        storeB.state.full = true;
        await b.repo.upsertDocMeta('doc-b', { title: 'typed in window B while signing out' });
        await expect(b.repo.persistMetaNow()).rejects.toThrow();
      };
      let injected = false;
      const confirms: Array<[number, string]> = [];
      const barrier = new WindowStorageBarrier({
        state,
        quitApproved: () => false,
        reportLost: () => {},
        confirmDiscard: async (since, kind) => {
          confirms.push([since, kind]);
          return false;
        },
        quitCheck: {
          timeoutMs: 3_000,
          setTimer: () => null,
          clearTimer: () => {},
          send: (windowId, requestId) => {
            const registry = registries.get(windowId);
            if (!registry) return false;
            void (async () => {
              if (!injected) {
                injected = true;
                await refuseInB();
              }
              state.handleQuitCheckResult(windowId, requestId, await registry.flushForQuit());
            })();
            return true;
          },
        },
      });
      storeA.state.full = true;
      await a.repo.upsertDocMeta('doc-a', { title: 'typed in window A while full' });
      await expect(a.repo.persistMetaNow()).rejects.toThrow();
      storeA.state.full = false;

      // The main process's `auth.prepareSignOut`, reached through the preload bridge.
      const destroyed: number[] = [];
      (window as unknown as { ipc: unknown }).ipc = {
        invoke: async (channel: string) => {
          if (channel !== 'auth.prepareSignOut') throw new Error(`unexpected ${channel}`);
          return await tearDownWindows({
            barrier,
            windowIds: [1, 2],
            keep: 1,
            kind: 'sign-out',
            destroy: (windowId) => destroyed.push(windowId),
          });
        },
      };
      writeStoredAuthToken('token');
      localStorage.setItem('lody:auth-bootstrap', '{"user":"someone"}');
      writeLastAppRoutePath('/acme/sessions/session-1');
      writePreferredWorkspaceSlug('acme');
      let serverSignOuts = 0;
      const authClient = {
        signOut: async () => {
          serverSignOuts++;
        },
      } as unknown as LodyAuthClient;
      const generation = getAuthSessionIntentGeneration(authClient);

      const outcome = await signOutWithoutRedirect(authClient);

      expect(outcome).toMatchObject({ ok: false, error: { code: SIGN_OUT_CANCELLED_CODE } });
      expect(confirms).toEqual([[1_000, 'sign-out']]);
      expect(readStoredAuthToken()).toBe('token');
      expect(localStorage.getItem('lody:auth-bootstrap')).toBe('{"user":"someone"}');
      expect(readLastAppRoutePath()).toBe('/acme/sessions/session-1');
      expect(readPreferredWorkspaceSlug()).toBe('acme');
      expect(getAuthSessionIntentGeneration(authClient)).toBe(generation);
      expect(serverSignOuts).toBe(0);
      expect(destroyed).toEqual([]);
      expect(state.unsavedSince(2)).toBe(1_000);
      // B's repo still holds the change: once space returns, its flush saves it.
      storeB.state.full = false;
      storeB.state.saved.length = 0;
      await expect(windowB.flushForQuit()).resolves.toBeNull();
      expect(storeB.state.saved.some((target) => target.startsWith('meta-'))).toBe(true);
      await Promise.all([a.guard.close(), b.guard.close()]);
    });
  });

  it('destroys window B only after the user explicitly discards', async () => {
    const lost: number[] = [];
    const { barrier, confirms, destroyed, signOut, state } = await setup(true, lost);
    await expect(signOut()).resolves.toBe(true);
    expect(confirms).toEqual([[1_000, 'sign-out']]);
    expect(destroyed).toEqual([2]);
    // Still unsaved until B is really gone, so a quit in between would still see it.
    expect(state.unsavedSince(2)).toBe(1_000);
    // The destroy that follows is an approved teardown, not a loss.
    barrier.documentGone(2);
    expect(state.unsavedSince(2)).toBeNull();
    expect(lost).toEqual([]);
  });
});

describe('refusals inside an open episode', () => {
  it('voids an unload approval at the refusal itself, before the next unload', async () => {
    const state = new RendererStorageState();
    const published: Array<[number | null, number]> = [];
    const episodes = new RendererStorageEpisodes((since, revision) => {
      published.push([since, revision]);
      state.report(1, since);
    });
    const store = createQuotaStore();
    const episode = episodes.register(() => guard.flushNow());
    const guard = new RepoStorageGuard(store.adapter, {
      onUnsavedChange: (since) => episode.report(since),
      onWriteRefused: () => episode.refused(),
      now: () => 1_000,
      // Nothing runs on a timer here: a refusal must reach main by itself.
      setTimer: () => null,
      clearTimer: () => {},
    });
    const repo = await LoroRepo.create({ storageAdapter: guard.adapter, metaDebounceCommitMs: 0 });
    guard.attach(repo);
    const confirms: Array<[number, string]> = [];
    const barrier = new WindowStorageBarrier({
      state,
      quitApproved: () => false,
      confirmDiscard: async (since, kind) => {
        confirms.push([since, kind]);
        return true;
      },
      quitCheck: {
        timeoutMs: 3_000,
        setTimer: () => null,
        clearTimer: () => {},
        send: (windowId, requestId) => {
          void episodes
            .flushForQuit()
            .then((since) => state.handleQuitCheckResult(windowId, requestId, since));
          return true;
        },
      },
    });

    store.state.full = true;
    await repo.upsertDocMeta('doc-a', { title: 'first' });
    await expect(repo.persistMetaNow()).rejects.toThrow();
    // The page reloads itself; its flush is still refused and the user picks Reload Anyway.
    expect(barrier.onUnloadPrevented(1)).toBe(false);
    await barrier.whenDecided(1);
    expect(confirms).toEqual([[1_000, 'reload']]);
    const beforeRefusal = published.length;

    // Before the user retries, another write is refused inside the same episode.
    await repo.upsertDocMeta('doc-b', { title: 'typed after the approval' });
    await expect(repo.persistMetaNow()).rejects.toThrow();
    const [since, revision] = published.at(-1)!;
    expect(published.length).toBeGreaterThan(beforeRefusal);
    expect(since).toBe(1_000);
    expect(revision).toBeGreaterThan(published[beforeRefusal - 1]![1]);

    // The retried unload is not let through on the old approval: it flushes and asks again.
    expect(barrier.onUnloadPrevented(1)).toBe(false);
    await barrier.whenDecided(1);
    expect(confirms).toEqual([
      [1_000, 'reload'],
      [1_000, 'reload'],
    ]);

    store.state.full = false;
    await guard.close();
  });

  it("reaches main before the window's next task, not with the IPC queue", () => {
    // Main as the preload bridge reaches it: `send` is delivered later, like any
    // async IPC message; `sendSync` returns only once main handled it.
    const main = new RendererStorageState();
    const deliver = (payload: unknown) =>
      main.report(1, (payload as { since: number | null }).since);
    (window as unknown as { ipc: unknown }).ipc = {
      send: (_channel: string, payload: unknown) => queueMicrotask(() => deliver(payload)),
      sendSync: (_channel: string, payload: unknown) => deliver(payload),
    };
    try {
      const episode = rendererStorageEpisodes.register(async () => 1_000);
      episode.report(1_000);
      const generation = main.generation(1);
      episode.refused();
      // Synchronously after the refusal, as a `beforeunload` right after it would see.
      expect(main.generation(1)).toBeGreaterThan(generation);
      episode.release();
    } finally {
      delete (window as { ipc?: unknown }).ipc;
    }
  });
});
