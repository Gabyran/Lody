// @vitest-environment jsdom

import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { Provider, createStore } from 'jotai';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  getMachineRoomId,
  type IosSimulatorCommand,
  type IosSimulatorDevice,
  type IosSimulatorPreview,
  type IosSimulatorResponse,
  type MachineId,
  type MachineMeta,
  type SessionId,
  type WorkspaceId,
} from '@lody/shared';

import { runtimeAtom, userAtom, type WorkspaceRuntime } from '../src/atoms';
import { machineMetaCacheAtom } from '../src/atoms/doc-meta';
import { localProbeResultAtom } from '../src/atoms/local-probe';
import { lodyPresenceSyncStateAtom } from '../src/atoms/presence';
import { writeTextToClipboard } from '../src/lib/clipboard';
import {
  IOS_SIMULATOR_PREPARING_MAX_POLLS,
  writeIosSimulatorSelectedDevice,
} from '../src/lib/ios-simulator/ios-simulator-model';
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
const VIEWER_ORIGIN = 'https://viewer.example';
const VIEWER_URL = `${VIEWER_ORIGIN}/stream?capability=secret-capability`;
const IOS_18 = 'com.apple.CoreSimulator.SimRuntime.iOS-18-2';

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
  runtime: IOS_18,
  deviceType: 'com.apple.CoreSimulator.SimDeviceType.iPhone-16',
  state: 'Shutdown',
  available: true,
  occupancy: 'available',
  ...overrides,
});

const answer = (fields: Partial<IosSimulatorResponse> = {}): IosSimulatorResponse => ({
  type: 'ios-simulator/control_response',
  sessionId: SESSION.id,
  success: true,
  ...fields,
});

const preview = (fields: Partial<IosSimulatorPreview> & Pick<IosSimulatorPreview, 'phase'>) => ({
  operationId: 'op-1',
  udid: 'phone',
  transport: 'remote' as const,
  ...fields,
});

/**
 * The one `ios-simulator/control` RPC, answered by the test. `list` and
 * `status` answer from the current fields; `start` and `stop` from a queue the
 * test fills, or stay pending until it does.
 */
function createFakeMachine(initial: {
  devices: IosSimulatorDevice[];
  preview?: IosSimulatorPreview;
  list?: IosSimulatorResponse;
}) {
  const commands: IosSimulatorCommand[] = [];
  const state = { preview: initial.preview, list: initial.list };
  const pending: Array<(response: IosSimulatorResponse) => void> = [];
  const requestIosSimulatorControl = async ({ command }: { command: IosSimulatorCommand }) => {
    commands.push(command);
    switch (command.action) {
      case 'list':
        return state.list ?? answer({ devices: initial.devices });
      case 'status':
        return answer({
          preview:
            !command.operationId || command.operationId === state.preview?.operationId
              ? state.preview
              : undefined,
        });
      default:
        return new Promise<IosSimulatorResponse>((resolve) => pending.push(resolve));
    }
  };
  return {
    commands,
    requestIosSimulatorControl,
    setPreview: (next: IosSimulatorPreview | undefined) => {
      state.preview = next;
    },
    /** Answers the oldest pending start/stop. */
    answerNext: async (response: IosSimulatorResponse) => {
      await act(async () => {
        pending.shift()?.(response);
        await Promise.resolve();
      });
      await flush();
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
  machine: ReturnType<typeof createFakeMachine>;
  meta?: MachineMeta;
  presence?: 'synced' | 'idle';
  localMachine?: boolean;
}) {
  const store = createStore();
  store.set(userAtom, { id: 'user-1', name: 'Sim User', email: 'sim@example.com' } as never);
  store.set(runtimeAtom, {
    workspaceId: WORKSPACE,
    workspaceSlug: 'sim',
    requestIosSimulatorControl: options.machine.requestIosSimulatorControl,
  } as unknown as WorkspaceRuntime);
  store.set(machineMetaCacheAtom, {
    [getMachineRoomId(MACHINE)]: options.meta ?? macMeta({ iosSimulator: 1 }),
  });
  store.set(lodyPresenceSyncStateAtom, options.presence ?? 'idle');
  if (options.localMachine) store.set(localProbeResultAtom, { machineId: MACHINE } as never);
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
  await render(true);
  return { render };
}

async function flush() {
  for (let index = 0; index < 5; index += 1) {
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

async function advance(ms: number) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
  await flush();
}

describe('SessionIosSimulatorPanel', () => {
  it('discovers an agent replacement when reopening instead of querying the cached operation', async () => {
    const machine = createFakeMachine({
      devices: [device({ udid: 'phone' }), device({ udid: 'tablet', deviceType: 'iPad' })],
    });
    const { render } = await renderPanel({ machine });
    await click('Start and preview');
    await machine.answerNext(
      answer({ preview: preview({ phase: 'ready', viewerUrl: VIEWER_URL }) })
    );
    expect(container?.querySelector('iframe')?.src).toBe(VIEWER_URL);
    await render(false);
    machine.setPreview(
      preview({
        operationId: 'agent-op',
        udid: 'tablet',
        phase: 'ready',
        viewerUrl: `${VIEWER_ORIGIN}/replacement`,
      })
    );
    await render(true);
    expect(container?.querySelector('iframe')?.src).toBe(`${VIEWER_ORIGIN}/replacement`);
    expect(machine.commands.at(-1)).toEqual({ action: 'status', operationId: undefined });
  });

  it('discovers an agent start through Refresh while the panel is already idle', async () => {
    const machine = createFakeMachine({ devices: [device({ udid: 'phone' })] });
    await renderPanel({ machine });
    machine.setPreview(preview({ operationId: 'agent-op', phase: 'ready', viewerUrl: VIEWER_URL }));
    await act(async () => {
      container?.querySelector<HTMLButtonElement>('button[aria-label="Simulator"]')?.click();
    });
    await flush();
    const refresh = document.querySelector<HTMLButtonElement>(
      'button[aria-label="Refresh simulators"]'
    );
    expect(refresh).not.toBeNull();
    await act(async () => {
      refresh?.click();
    });
    await flush();
    expect(container?.querySelector('iframe')?.src).toBe(VIEWER_URL);
  });

  it('asks for an update on a Mac whose Lody predates the protocol, without calling it', async () => {
    const machine = createFakeMachine({ devices: [device({ udid: 'a' })] });
    await renderPanel({ machine, meta: macMeta() });
    expect(text()).toContain('Update Lody on Studio');
    expect(machine.commands).toEqual([]);
  });

  it('says a remote Mac is offline, but keeps talking to this machine directly', async () => {
    const offline = createFakeMachine({ devices: [device({ udid: 'a' })] });
    await renderPanel({ machine: offline, presence: 'synced' });
    expect(text()).toContain('Studio is offline');
    expect(offline.commands).toEqual([]);
    act(() => root?.unmount());
    container?.remove();

    const local = createFakeMachine({
      devices: [device({ udid: 'phone', name: 'iPhone 16', state: 'Booted' })],
    });
    await renderPanel({ machine: local, presence: 'synced', localMachine: true });
    expect(text()).not.toContain('offline');
    expect(text()).toContain('iPhone 16');
    expect(local.commands).toContainEqual({ action: 'list' });
  });

  it('starts a shut-down device and polls the operation until the viewer is ready', async () => {
    vi.useFakeTimers();
    const machine = createFakeMachine({ devices: [device({ udid: 'phone', name: 'iPhone 16' })] });
    await renderPanel({ machine });
    // On open the panel recovers any preview without naming an operation.
    expect(machine.commands).toContainEqual({ action: 'status', operationId: undefined });

    await click('Start and preview');
    expect(machine.commands).toContainEqual({ action: 'start', udid: 'phone' });
    // Cancel names the operation, so it waits for the machine to name one.
    expect(button('Cancel').disabled).toBe(true);

    await machine.answerNext(answer({ preview: preview({ phase: 'booting' }) }));
    expect(text()).toContain('Starting the simulator');
    expect(button('Cancel').disabled).toBe(false);

    machine.setPreview(preview({ phase: 'ready', viewerUrl: VIEWER_URL }));
    await advance(1_000);
    expect(machine.commands).toContainEqual({ action: 'status', operationId: 'op-1' });
    const frame = container?.querySelector('iframe');
    expect(frame?.getAttribute('src')).toBe(VIEWER_URL);
    expect(frame?.getAttribute('referrerpolicy')).toBe('no-referrer');
    expect(text()).not.toContain('viewer.example');

    await act(async () => {
      window.dispatchEvent(
        new MessageEvent('message', {
          data: {
            type: 'lody:ios-simulator:state',
            operationId: 'op-1',
            state: 'ready',
            width: 100,
            height: 200,
          },
          origin: VIEWER_ORIGIN,
          source: frame?.contentWindow,
        })
      );
    });
    // Ready is not polled: the viewer reports its own stream.
    const reads = machine.commands.length;
    await advance(60_000);
    expect(machine.commands.length).toBe(reads);
  });

  it('greets the viewer at its exact origin and trusts only that frame', async () => {
    const machine = createFakeMachine({
      devices: [device({ udid: 'phone', state: 'Booted', occupancy: 'this-session' })],
      preview: preview({ phase: 'ready', viewerUrl: VIEWER_URL, transport: 'local' }),
    });
    const { render } = await renderPanel({ machine });
    const frame = container?.querySelector('iframe') as HTMLIFrameElement;
    const posted: Array<[unknown, string]> = [];
    vi.spyOn(frame.contentWindow!, 'postMessage').mockImplementation(((
      message: unknown,
      origin: string
    ) => posted.push([message, origin])) as never);

    await act(async () => {
      frame.dispatchEvent(new Event('load'));
    });
    expect(posted).toEqual([
      [{ type: 'lody:ios-simulator:init', operationId: 'op-1', visible: true }, VIEWER_ORIGIN],
    ]);

    const dropped = {
      type: 'lody:ios-simulator:state',
      operationId: 'op-1',
      state: 'disconnected',
    };
    await act(async () => {
      window.dispatchEvent(
        new MessageEvent('message', { data: dropped, origin: VIEWER_ORIGIN, source: window })
      );
    });
    await act(async () => {
      window.dispatchEvent(
        new MessageEvent('message', {
          data: dropped,
          origin: 'https://wrong.example',
          source: frame.contentWindow,
        })
      );
      window.dispatchEvent(
        new MessageEvent('message', {
          data: { ...dropped, operationId: 'stale' },
          origin: VIEWER_ORIGIN,
          source: frame.contentWindow,
        })
      );
    });
    expect(text()).not.toContain('lost its connection');
    await act(async () => {
      window.dispatchEvent(
        new MessageEvent('message', {
          data: dropped,
          origin: VIEWER_ORIGIN,
          source: frame.contentWindow,
        })
      );
    });
    await flush();
    expect(text()).toContain('The viewer lost its connection.');

    // Hiding the panel keeps the frame and tells the viewer instead.
    await render(false);
    expect(container?.querySelector('iframe')).toBe(frame);
    expect(posted.at(-1)).toEqual([
      { type: 'lody:ios-simulator:visibility', operationId: 'op-1', visible: false },
      VIEWER_ORIGIN,
    ]);
  });

  it('offers restore if a visible viewer never reports a first frame', async () => {
    vi.useFakeTimers();
    const machine = createFakeMachine({
      devices: [device({ udid: 'phone', state: 'Booted' })],
      preview: preview({ phase: 'ready', viewerUrl: VIEWER_URL }),
    });
    await renderPanel({ machine });
    expect(text()).not.toContain('lost its connection');
    await advance(25_000);
    expect(text()).toContain('The viewer hit an error.');
    expect(button('Restore').disabled).toBe(false);
  });

  it('cancels a preparing preview by stopping its exact operation', async () => {
    const machine = createFakeMachine({
      devices: [device({ udid: 'phone', name: 'iPhone 16', state: 'Booted' })],
      preview: preview({ phase: 'connecting', operationId: 'op-9' }),
    });
    await renderPanel({ machine });
    expect(text()).toContain('Connecting the viewer');

    await click('Cancel');
    expect(machine.commands).toContainEqual({ action: 'stop', operationId: 'op-9' });
    await machine.answerNext(
      answer({ preview: preview({ phase: 'closed', operationId: 'op-9' }) })
    );
    expect(button('Preview').disabled).toBe(false);
  });

  it('reports a start that never becomes ready instead of polling forever', async () => {
    vi.useFakeTimers();
    const machine = createFakeMachine({
      devices: [device({ udid: 'phone', state: 'Booted' })],
      preview: preview({ phase: 'connecting' }),
    });
    await renderPanel({ machine });
    for (let poll = 0; poll <= IOS_SIMULATOR_PREPARING_MAX_POLLS; poll += 1) await advance(1_000);
    expect(text()).toContain('The preview took too long to start');
    const reads = machine.commands.length;
    await advance(10_000);
    expect(machine.commands.length).toBe(reads);
    expect(button('Stop preview').disabled).toBe(false);
  });

  it('offers Restore after the preview closed, as a new start', async () => {
    const machine = createFakeMachine({
      devices: [device({ udid: 'phone', state: 'Booted', occupancy: 'this-session' })],
      preview: preview({ phase: 'closed' }),
    });
    await renderPanel({ machine });
    expect(text()).toContain('The preview ended.');
    await click('Restore');
    expect(machine.commands).toContainEqual({ action: 'start', udid: 'phone' });
  });

  it('never offers a preview of a device another Session controls', async () => {
    const machine = createFakeMachine({
      devices: [
        device({ udid: 'free', name: 'iPhone 16', state: 'Booted' }),
        device({
          udid: 'taken',
          name: 'iPhone 16 Pro',
          state: 'Booted',
          occupancy: 'other-session',
        }),
      ],
    });
    writeIosSimulatorSelectedDevice(
      { accountId: 'user-1', workspaceId: WORKSPACE, machineId: MACHINE, sessionId: SESSION.id },
      'taken'
    );
    await renderPanel({ machine });
    expect(text()).toContain('Another session is using this simulator');
    expect(() => button('Preview')).toThrow();
    expect(() => button('Start and preview')).toThrow();
  });

  it('explains a Mac without Xcode and copies redacted diagnostics', async () => {
    const machine = createFakeMachine({
      devices: [],
      list: answer({
        success: false,
        error: 'environment',
        message: 'xcrun failed at /Users/alice/Library via https://relay.example/?token=abc',
      }),
    });
    await renderPanel({ machine });
    expect(text()).toContain('Xcode isn’t set up on Studio');
    expect(text()).not.toContain('relay.example');
    expect(text()).not.toContain('alice');

    await click('Copy diagnostics');
    const copied = vi.mocked(writeTextToClipboard).mock.calls.at(-1)?.[0] ?? '';
    expect(copied).toContain('error=environment');
    expect(copied).not.toContain('alice');
    expect(copied).not.toContain('relay.example');
  });
});
