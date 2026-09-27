// @vitest-environment jsdom

import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { Provider, createStore } from 'jotai';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  getMachineRoomId,
  type MachineId,
  type MachineMeta,
  type SessionId,
  type WorkspaceId,
} from '@lody/shared';

import { runtimeAtom, type WorkspaceRuntime } from '../src/atoms';
import { machineMetaCacheAtom } from '../src/atoms/doc-meta';
import { localProbeResultAtom } from '../src/atoms/local-probe';
import { lodyPresenceSyncStateAtom } from '../src/atoms/presence';
import { writeTextToClipboard } from '../src/lib/clipboard';
import { writeIosSimulatorSelectedDevice } from '../src/lib/ios-simulator/ios-simulator-model';
import type {
  IosSimulatorClient,
  IosSimulatorDevice,
  IosSimulatorListResult,
  IosSimulatorPreviewStatus,
} from '../src/lib/ios-simulator/ios-simulator-types';
import { SessionIosSimulatorPanel } from '../src/components/sessions/ios-simulator/session-ios-simulator-panel';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (_key: string, fallback?: string, values?: Record<string, string>) =>
      (fallback ?? _key).replace(
        /\{\{(\w+)\}\}/g,
        (placeholder, key: string) => values?.[key] ?? placeholder
      ),
  }),
}));

vi.mock('../src/lib/clipboard', () => ({
  writeTextToClipboard: vi.fn(async () => true),
}));

vi.mock('@/lib/toast', () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

const MACHINE = 'mac-studio' as MachineId;
const SESSION = { id: 'session-sim' as SessionId, machineId: MACHINE };
const WORKSPACE = 'workspace-sim' as WorkspaceId;
const VIEWER_URL = 'https://viewer.example/stream?capability=secret-capability';

const macMeta = (protocolCapabilities?: Record<string, number>): MachineMeta => ({
  id: MACHINE,
  name: 'Studio',
  cliVersion: '9.9.9',
  os: 'darwin',
  sessions: [],
  protocolCapabilities,
});

const device = (overrides: Partial<IosSimulatorDevice> & { udid: string }): IosSimulatorDevice => ({
  name: overrides.udid,
  runtimeId: 'rt.ios-18',
  family: 'iphone',
  state: 'shutdown',
  available: true,
  occupancy: { kind: 'free' },
  screen: { width: 390, height: 844 },
  ...overrides,
});

const catalog = (devices: IosSimulatorDevice[]): IosSimulatorListResult => ({
  ok: true,
  runtimes: [
    { id: 'rt.ios-18', name: 'iOS 18.2', platform: 'iOS', version: '18.2', available: true },
  ],
  devices,
});

type Deferred<T> = { promise: Promise<T>; resolve: (value: T) => void };
const deferred = <T,>(): Deferred<T> => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => {
    resolve = next;
  });
  return { promise, resolve };
};

/** A client whose every answer the test states; unanswered calls stay pending. */
function createFakeClient(initial: {
  list: IosSimulatorListResult;
  status?: IosSimulatorPreviewStatus;
}) {
  const calls: string[] = [];
  let listResult = initial.list;
  let statusResult: IosSimulatorPreviewStatus = initial.status ?? { phase: 'idle' };
  let pendingStart: Deferred<IosSimulatorPreviewStatus> | null = null;
  const client: IosSimulatorClient = {
    list: async () => {
      calls.push('list');
      return listResult;
    },
    status: async () => {
      calls.push('status');
      return statusResult;
    },
    startPreview: (_target, request) => {
      calls.push(`start:${request.udid}:boot=${request.boot}`);
      pendingStart = deferred();
      return pendingStart.promise;
    },
    cancelStart: async () => {
      calls.push('cancel');
      statusResult = { phase: 'idle' };
      return statusResult;
    },
    stopPreview: async () => {
      calls.push('stop');
      statusResult = { phase: 'idle' };
      return statusResult;
    },
  };
  return {
    client,
    calls,
    setList: (next: IosSimulatorListResult) => {
      listResult = next;
    },
    setStatus: (next: IosSimulatorPreviewStatus) => {
      statusResult = next;
    },
    resolveStart: async (next: IosSimulatorPreviewStatus) => {
      statusResult = next;
      await act(async () => {
        pendingStart?.resolve(next);
        await Promise.resolve();
      });
    },
  };
}

let root: Root | undefined;
let container: HTMLDivElement | undefined;

afterEach(() => {
  act(() => root?.unmount());
  root = undefined;
  container?.remove();
  container = undefined;
  window.localStorage.clear();
  vi.clearAllMocks();
  vi.useRealTimers();
});

async function renderPanel(options: {
  client: IosSimulatorClient | null;
  machine?: MachineMeta;
  presence?: 'synced' | 'idle';
  localMachine?: boolean;
  active?: boolean;
}) {
  const store = createStore();
  store.set(runtimeAtom, {
    workspaceId: WORKSPACE,
    workspaceSlug: 'sim',
    iosSimulator: options.client ?? undefined,
  } as unknown as WorkspaceRuntime);
  store.set(machineMetaCacheAtom, {
    [getMachineRoomId(MACHINE)]: options.machine ?? macMeta({ iosSimulator: 1 }),
  });
  store.set(lodyPresenceSyncStateAtom, options.presence ?? 'synced');
  if (options.localMachine) {
    store.set(localProbeResultAtom, { machineId: MACHINE } as never);
  }
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  const render = async (active: boolean) => {
    await act(async () => {
      root?.render(
        createElement(
          Provider,
          { store },
          createElement(SessionIosSimulatorPanel, { session: SESSION, active })
        )
      );
    });
    await flush();
  };
  await render(options.active ?? true);
  return { render };
}

async function flush() {
  for (let index = 0; index < 4; index += 1) {
    await act(async () => {
      await Promise.resolve();
    });
  }
}

const text = () => container?.textContent ?? '';

function button(label: string): HTMLButtonElement {
  const match = [...(container?.querySelectorAll('button') ?? [])].find(
    (candidate) => candidate.textContent?.trim() === label
  );
  if (!match) throw new Error(`No button "${label}" in: ${text()}`);
  return match as HTMLButtonElement;
}

async function click(label: string) {
  await act(async () => {
    button(label).click();
  });
  await flush();
}

describe('SessionIosSimulatorPanel', () => {
  it('asks for an update on a Mac whose Lody predates the protocol, without calling it', async () => {
    const fake = createFakeClient({ list: catalog([device({ udid: 'a' })]) });
    await renderPanel({ client: fake.client, machine: macMeta() });
    expect(text()).toContain('Update Lody on Studio');
    expect(fake.calls).toEqual([]);
  });

  it('says a remote Mac is offline, but keeps talking to this machine directly', async () => {
    const offline = createFakeClient({ list: catalog([device({ udid: 'a' })]) });
    await renderPanel({ client: offline.client, presence: 'synced' });
    expect(text()).toContain('Studio is offline');
    expect(offline.calls).toEqual([]);
    act(() => root?.unmount());
    container?.remove();

    const local = createFakeClient({
      list: catalog([device({ udid: 'phone', name: 'iPhone 16', state: 'booted' })]),
    });
    await renderPanel({ client: local.client, presence: 'synced', localMachine: true });
    expect(text()).not.toContain('offline');
    expect(text()).toContain('iPhone 16');
    expect(local.calls).toContain('list');
  });

  it('starts a shut-down device, then shows its screen without ever printing the viewer address', async () => {
    const fake = createFakeClient({
      list: catalog([device({ udid: 'phone', name: 'iPhone 16' })]),
    });
    await renderPanel({ client: fake.client, presence: 'idle' });
    expect(text()).toContain('Start and preview');

    await click('Start and preview');
    expect(fake.calls).toContain('start:phone:boot=true');
    expect(text()).toContain('Starting the simulator');

    await fake.resolveStart({
      phase: 'ready',
      udid: 'phone',
      viewerUrl: VIEWER_URL,
      connection: 'remote',
    });
    await flush();
    const frame = container?.querySelector('iframe');
    expect(frame?.getAttribute('src')).toBe(VIEWER_URL);
    expect(frame?.getAttribute('referrerpolicy')).toBe('no-referrer');
    expect(container?.innerHTML.split(VIEWER_URL).length).toBe(2);
    expect(text()).not.toContain('viewer.example');
  });

  it('cancels a start in flight and ignores the start’s late answer', async () => {
    const fake = createFakeClient({
      list: catalog([device({ udid: 'phone', name: 'iPhone 16', state: 'booted' })]),
    });
    await renderPanel({ client: fake.client, presence: 'idle' });
    await click('Preview');
    expect(fake.calls).toContain('start:phone:boot=false');
    expect(text()).toContain('Starting the screen stream');

    await click('Cancel');
    expect(fake.calls).toContain('cancel');
    await fake.resolveStart({
      phase: 'ready',
      udid: 'phone',
      viewerUrl: VIEWER_URL,
      connection: 'direct',
    });
    await flush();
    expect(container?.querySelector('iframe')).toBeNull();
    expect(button('Preview').disabled).toBe(false);
  });

  it('keeps a start in flight when the panel is hidden and shown again', async () => {
    const fake = createFakeClient({
      list: catalog([device({ udid: 'phone', name: 'iPhone 16', state: 'booted' })]),
    });
    const { render } = await renderPanel({ client: fake.client, presence: 'idle' });
    await click('Preview');
    await render(false);
    await render(true);
    // Re-showing reads status again while the start is still pending.
    expect(fake.calls.filter((call) => call === 'status').length).toBe(2);

    await fake.resolveStart({
      phase: 'ready',
      udid: 'phone',
      viewerUrl: VIEWER_URL,
      connection: 'direct',
    });
    await flush();
    expect(container?.querySelector('iframe')?.getAttribute('src')).toBe(VIEWER_URL);
  });

  it('stops a preview without shutting the simulator down', async () => {
    const fake = createFakeClient({
      list: catalog([
        device({
          udid: 'phone',
          name: 'iPhone 16',
          state: 'booted',
          occupancy: { kind: 'this-session' },
        }),
      ]),
      status: { phase: 'interrupted', udid: 'phone', connection: 'remote', reason: 'expired' },
    });
    await renderPanel({ client: fake.client, presence: 'idle' });
    expect(text()).toContain('The preview expired.');

    await click('Stop preview');
    expect(fake.calls.filter((call) => call.startsWith('start') || call === 'stop')).toEqual([
      'stop',
    ]);
    expect(button('Preview').disabled).toBe(false);
  });

  it('never offers a preview of a device another Session controls', async () => {
    const fake = createFakeClient({
      list: catalog([
        device({ udid: 'free', name: 'iPhone 16', state: 'booted' }),
        device({
          udid: 'taken',
          name: 'iPhone 16 Pro',
          state: 'booted',
          occupancy: { kind: 'other-session', sessionTitle: 'Fix login' },
        }),
      ]),
    });
    writeIosSimulatorSelectedDevice(
      { workspaceId: WORKSPACE, machineId: MACHINE, sessionId: SESSION.id },
      'taken'
    );
    await renderPanel({ client: fake.client, presence: 'idle' });
    expect(text()).toContain('“Fix login” is using this simulator');
    expect(() => button('Preview')).toThrow();
    expect(() => button('Start and preview')).toThrow();
  });

  it('polls while preparing only when on screen, and drops the viewer when hidden', async () => {
    vi.useFakeTimers();
    const fake = createFakeClient({
      list: catalog([device({ udid: 'phone', name: 'iPhone 16', state: 'booted' })]),
      status: { phase: 'preparing', udid: 'phone', stage: 'connecting' },
    });
    const { render } = await renderPanel({ client: fake.client, presence: 'idle' });
    expect(text()).toContain('Connecting the viewer');

    fake.setStatus({ phase: 'ready', udid: 'phone', viewerUrl: VIEWER_URL, connection: 'direct' });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_500);
    });
    await flush();
    expect(container?.querySelector('iframe')?.getAttribute('src')).toBe(VIEWER_URL);

    await render(false);
    expect(container?.querySelector('iframe')).toBeNull();
    const before = fake.calls.length;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
    });
    expect(fake.calls.length).toBe(before);
  });

  it('explains a Mac without Xcode and copies redacted diagnostics', async () => {
    const fake = createFakeClient({
      list: {
        ok: false,
        error: {
          code: 'xcode-missing',
          message: 'xcrun failed at /Users/alice/Library via https://relay.example/?token=abc',
        },
      },
    });
    await renderPanel({ client: fake.client, presence: 'idle' });
    expect(text()).toContain('Xcode isn’t set up on Studio');

    await click('Copy diagnostics');
    const copied = vi.mocked(writeTextToClipboard).mock.calls.at(-1)?.[0] ?? '';
    expect(copied).toContain('error=xcode-missing');
    expect(copied).not.toContain('alice');
    expect(copied).not.toContain('relay.example');
  });
});
