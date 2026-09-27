import { LoroRepo, type StorageAdapter, type StorageSavePayload } from 'loro-repo';
import { describe, expect, it } from 'vitest';
import { RepoStorageGuard } from '@lody/shared';
import { RendererStorageEpisodes } from '../src/lib/renderer-storage-episodes';

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
