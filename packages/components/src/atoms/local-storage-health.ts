import { atom } from 'jotai';
import { atomFamily, selectAtom } from 'jotai/utils';
import {
  findFreshMachinePresenceState,
  type LodyMachineStorageHealth,
  type MachineId,
} from '@lody/shared';
import { lodyPresenceNowMsAtom, lodyPresenceStatesAtom } from './presence';
import { localMachineIdAtom } from './local-probe';

/**
 * Storage health a machine published on its fresh presence heartbeat; null
 * while it is healthy or its heartbeat is not fresh. Spec:
 * `specs/local-storage-health.md`.
 */
export const machineStorageHealthAtomFamily = atomFamily((machineId: MachineId | null) =>
  atom<LodyMachineStorageHealth | null>((get) => {
    if (!machineId) return null;
    const state = findFreshMachinePresenceState(
      get(lodyPresenceStatesAtom),
      machineId,
      get(lodyPresenceNowMsAtom)
    );
    return state?.storage ?? null;
  })
);

/**
 * Set while this app's own repo store (IndexedDB) refused a write for lack of
 * space; cleared only once a full repo flush succeeds (`StorageFullRecovery`).
 * `since` is the first failure.
 */
export const rendererStorageFullAtom = atom<{ since: number } | null>(null);

export type LocalStorageBannerState =
  | { kind: 'write-failed'; since: number | null; source: 'machine' | 'app' }
  | { kind: 'low-space'; level: 'warning' | 'critical'; availableBytes: number | null };

/**
 * What the app-level banner shows. Only the desktop's own machine is covered:
 * a colleague's machine running low is not this user's banner. A failed write
 * wins over low space because unsaved changes are the more urgent fact.
 */
const bannerStateAtom = atom<LocalStorageBannerState | null>((get) => {
  const machine = get(machineStorageHealthAtomFamily(get(localMachineIdAtom)));
  if (machine?.reason === 'write-failed') {
    return { kind: 'write-failed', since: machine.unsavedSince ?? null, source: 'machine' };
  }
  const app = get(rendererStorageFullAtom);
  if (app) {
    return { kind: 'write-failed', since: app.since, source: 'app' };
  }
  if (machine) {
    return {
      kind: 'low-space',
      level: machine.level,
      availableBytes: machine.availableBytes ?? null,
    };
  }
  return null;
});

const sameBannerState = (
  a: LocalStorageBannerState | null,
  b: LocalStorageBannerState | null
): boolean => JSON.stringify(a) === JSON.stringify(b);

/**
 * Stable across presence snapshots and the presence clock, so the banner leaf
 * re-renders only when what it shows changes.
 */
export const localStorageBannerStateAtom = selectAtom(
  bannerStateAtom,
  (state) => state,
  sameBannerState
);
