// @vitest-environment jsdom

import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { Provider, createStore } from 'jotai';
import i18next from 'i18next';
import { describe, expect, it } from 'vitest';
import {
  getLodyMachinePresenceKey,
  getServerNow,
  type LodyMachineStorageHealth,
  type LodyPresenceInstanceId,
  type LodyPresenceStateMap,
  type MachineId,
} from '@lody/shared';
import {
  localStorageBannerStateAtom,
  rendererStorageFullAtom,
} from '../src/atoms/local-storage-health';
import { localProbeResultAtom } from '../src/atoms/local-probe';
import { setLodyPresenceStatesAtom } from '../src/atoms/presence';
import { LocalStorageBannerContainer } from '../src/components/local-storage-banner';
import { initI18n } from '../src/i18n';

const LOCAL = 'machine-local' as MachineId;
const OTHER = 'machine-colleague' as MachineId;
const instanceId = 'cli-instance' as LodyPresenceInstanceId;

const heartbeats = (
  entries: Array<[MachineId, LodyMachineStorageHealth | undefined]>
): LodyPresenceStateMap =>
  Object.fromEntries(
    entries.map(([machineId, storage]) => [
      getLodyMachinePresenceKey(machineId, instanceId),
      {
        kind: 'machine',
        machineId,
        instanceId,
        updatedAt: getServerNow(),
        ...(storage ? { storage } : {}),
      },
    ])
  );

describe('localStorageBannerStateAtom', () => {
  it("shows only this desktop's machine, with a failed write ahead of low space", () => {
    const store = createStore();
    store.set(localProbeResultAtom, { ok: true, machineId: LOCAL });
    store.set(
      setLodyPresenceStatesAtom,
      heartbeats([
        [LOCAL, undefined],
        [OTHER, { level: 'critical', reason: 'write-failed', unsavedSince: 1 }],
      ])
    );
    expect(store.get(localStorageBannerStateAtom)).toBeNull();

    store.set(
      setLodyPresenceStatesAtom,
      heartbeats([[LOCAL, { level: 'warning', reason: 'low-space', availableBytes: 3_000 }]])
    );
    expect(store.get(localStorageBannerStateAtom)).toEqual({
      kind: 'low-space',
      level: 'warning',
      availableBytes: 3_000,
    });

    // The app's own store filling up outranks a machine that is merely low.
    store.set(rendererStorageFullAtom, { since: 42 });
    expect(store.get(localStorageBannerStateAtom)).toEqual({
      kind: 'write-failed',
      since: 42,
      source: 'app',
    });

    store.set(
      setLodyPresenceStatesAtom,
      heartbeats([[LOCAL, { level: 'critical', reason: 'write-failed', unsavedSince: 7 }]])
    );
    expect(store.get(localStorageBannerStateAtom)).toEqual({
      kind: 'write-failed',
      since: 7,
      source: 'machine',
    });
  });

  it('keeps its value identity across presence snapshots that change nothing it shows', () => {
    const store = createStore();
    store.set(localProbeResultAtom, { ok: true, machineId: LOCAL });
    const storage = { level: 'critical', reason: 'low-space', availableBytes: 10 } as const;
    store.set(setLodyPresenceStatesAtom, heartbeats([[LOCAL, storage]]));
    const first = store.get(localStorageBannerStateAtom);
    store.set(
      setLodyPresenceStatesAtom,
      heartbeats([
        [LOCAL, { ...storage }],
        [OTHER, undefined],
      ])
    );
    expect(store.get(localStorageBannerStateAtom)).toBe(first);
  });
});

describe('LocalStorageBannerContainer', () => {
  // The exact storage fields a real daemon published on a full RAM disk.
  const lowSpace = { level: 'critical', reason: 'low-space', availableBytes: 0 } as const;
  const writeFailed = {
    level: 'critical',
    reason: 'write-failed',
    availableBytes: 0,
    unsavedSince: 1_790_509_745_421,
  } as const;

  const render = async (
    language: 'en' | 'zh_CN',
    storage: LodyMachineStorageHealth | undefined
  ) => {
    await initI18n(language);
    await i18next.changeLanguage(language);
    const store = createStore();
    store.set(localProbeResultAtom, { ok: true, machineId: LOCAL });
    store.set(setLodyPresenceStatesAtom, heartbeats([[LOCAL, storage]]));
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    await act(async () => {
      root.render(createElement(Provider, { store }, createElement(LocalStorageBannerContainer)));
    });
    return {
      container,
      store,
      cleanup: () => {
        act(() => root.unmount());
        container.remove();
      },
    };
  };

  it('tells the user what is paused and since when changes are unsaved, in both languages', async () => {
    const en = await render('en', writeFailed);
    expect(en.container.textContent).toContain('Disk is full');
    expect(en.container.textContent).toContain(
      'Changes are kept in memory and saved automatically once space is freed.'
    );
    expect(en.container.textContent).toContain('Unsaved changes since');
    expect(en.container.querySelector('[role="alert"]')).not.toBeNull();
    en.cleanup();

    const zh = await render('zh_CN', writeFailed);
    expect(zh.container.textContent).toContain('磁盘已满');
    expect(zh.container.textContent).toContain('更改暂存在内存中，释放空间后会自动保存。');
    expect(zh.container.textContent).toContain('起有未保存的更改');
    zh.cleanup();

    const critical = await render('en', lowSpace);
    expect(critical.container.textContent).toContain('Disk almost full');
    expect(critical.container.textContent).toContain(
      'New sessions, turns and attachments are paused'
    );
    critical.cleanup();
  });

  it('disappears once the machine reports healthy storage again', async () => {
    const view = await render('en', writeFailed);
    expect(view.container.textContent).toContain('Disk is full');
    await act(async () => {
      view.store.set(setLodyPresenceStatesAtom, heartbeats([[LOCAL, undefined]]));
    });
    expect(view.container.textContent).toBe('');
    view.cleanup();
  });
});
