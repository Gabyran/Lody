// @vitest-environment jsdom

import { afterEach, describe, expect, it } from 'vitest';
import {
  buildIosSimulatorDiagnostics,
  getIosSimulatorDeviceAction,
  getIosSimulatorPanelAvailability,
  getIosSimulatorStatusPollMs,
  groupIosSimulatorDevices,
  readIosSimulatorSelectedDevice,
  redactIosSimulatorText,
  resolveIosSimulatorSelection,
  writeIosSimulatorSelectedDevice,
} from '../src/lib/ios-simulator/ios-simulator-model';
import type {
  IosSimulatorDevice,
  IosSimulatorPreviewStatus,
  IosSimulatorRuntime,
} from '../src/lib/ios-simulator/ios-simulator-types';

const runtimes: IosSimulatorRuntime[] = [
  { id: 'rt.ios-17-5', name: 'iOS 17.5', platform: 'iOS', version: '17.5', available: true },
  {
    id: 'rt.watchos-11',
    name: 'watchOS 11.0',
    platform: 'watchOS',
    version: '11.0',
    available: true,
  },
  { id: 'rt.ios-18-2', name: 'iOS 18.2', platform: 'iOS', version: '18.2', available: true },
];

const device = (overrides: Partial<IosSimulatorDevice> & { udid: string }): IosSimulatorDevice => ({
  name: overrides.udid,
  runtimeId: 'rt.ios-18-2',
  family: 'iphone',
  state: 'shutdown',
  available: true,
  occupancy: { kind: 'free' },
  ...overrides,
});

const devices: IosSimulatorDevice[] = [
  device({ udid: 'ipad', name: 'iPad Air', family: 'ipad' }),
  device({ udid: 'pro-10', name: 'iPhone 10 Pro' }),
  device({ udid: 'pro-9', name: 'iPhone 9 Pro' }),
  device({ udid: 'old', name: 'iPhone 15', runtimeId: 'rt.ios-17-5', state: 'booted' }),
  device({ udid: 'watch', name: 'Apple Watch Ultra', runtimeId: 'rt.watchos-11', family: 'watch' }),
  device({ udid: 'orphan', name: 'iPhone SE', runtimeId: 'rt.ios-16-0' }),
];

const IDLE: IosSimulatorPreviewStatus = { phase: 'idle' };

describe('iOS Simulator availability', () => {
  it('offers the tab only when the target machine is a Mac', () => {
    expect(getIosSimulatorPanelAvailability(null)).toBe('hidden');
    expect(getIosSimulatorPanelAvailability({ os: 'linux' })).toBe('hidden');
    expect(
      getIosSimulatorPanelAvailability({ os: 'win32', protocolCapabilities: { iosSimulator: 1 } })
    ).toBe('hidden');
  });

  it('keeps the tab on an old Mac so it can ask for an update', () => {
    expect(getIosSimulatorPanelAvailability({ os: 'darwin' })).toBe('upgrade-required');
    expect(
      getIosSimulatorPanelAvailability({ os: 'darwin', protocolCapabilities: { iosSimulator: 1 } })
    ).toBe('available');
  });
});

describe('groupIosSimulatorDevices', () => {
  it('groups by runtime, newest iOS first, and sorts names naturally', () => {
    const groups = groupIosSimulatorDevices(runtimes, devices);
    expect(groups.map((group) => group.runtime.name)).toEqual([
      'iOS 18.2',
      'iOS 17.5',
      'watchOS 11.0',
      'ios 16 0',
    ]);
    // iPhones before iPads, and "9" before "10".
    expect(groups[0]?.devices.map((entry) => entry.udid)).toEqual(['pro-9', 'pro-10', 'ipad']);
  });

  it('keeps a device whose runtime is missing from the catalog', () => {
    const orphanGroup = groupIosSimulatorDevices(runtimes, devices).at(-1);
    expect(orphanGroup?.devices.map((entry) => entry.udid)).toEqual(['orphan']);
    expect(orphanGroup?.runtime.available).toBe(false);
  });

  it('searches name and runtime together and filters by runtime', () => {
    expect(
      groupIosSimulatorDevices(runtimes, devices, { query: 'iphone 17' }).flatMap((group) =>
        group.devices.map((entry) => entry.udid)
      )
    ).toEqual(['old']);
    expect(
      groupIosSimulatorDevices(runtimes, devices, { runtimeId: 'rt.watchos-11' }).flatMap((group) =>
        group.devices.map((entry) => entry.udid)
      )
    ).toEqual(['watch']);
    expect(groupIosSimulatorDevices(runtimes, devices, { query: 'pixel' })).toEqual([]);
  });
});

describe('getIosSimulatorDeviceAction', () => {
  it('starts a shut-down device and previews a booted one', () => {
    expect(getIosSimulatorDeviceAction(device({ udid: 'a' }), IDLE)).toEqual({
      kind: 'start-and-preview',
    });
    expect(getIosSimulatorDeviceAction(device({ udid: 'a', state: 'booted' }), IDLE)).toEqual({
      kind: 'preview',
    });
  });

  it('never offers a takeover of a device another Session controls', () => {
    expect(
      getIosSimulatorDeviceAction(
        device({
          udid: 'a',
          state: 'booted',
          occupancy: { kind: 'other-session', sessionTitle: 'Fix login' },
        }),
        IDLE
      )
    ).toEqual({ kind: 'occupied', sessionTitle: 'Fix login' });
  });

  it('reports the Session’s own preview as current in every live phase', () => {
    const own = device({ udid: 'a', state: 'booted', occupancy: { kind: 'this-session' } });
    for (const status of [
      { phase: 'preparing', udid: 'a', stage: 'connecting' },
      { phase: 'ready', udid: 'a', viewerUrl: 'http://x', connection: 'direct' },
      { phase: 'interrupted', udid: 'a', connection: 'remote', reason: 'expired' },
    ] satisfies IosSimulatorPreviewStatus[]) {
      expect(getIosSimulatorDeviceAction(own, status)).toEqual({ kind: 'current' });
    }
    expect(
      getIosSimulatorDeviceAction(own, {
        phase: 'failed',
        udid: 'a',
        error: { code: 'stream-failed' },
      })
    ).toEqual({ kind: 'preview' });
  });

  it('reports unavailable and mid-shutdown devices', () => {
    expect(
      getIosSimulatorDeviceAction(
        device({ udid: 'a', available: false, unavailableReason: 'runtime missing' }),
        IDLE
      )
    ).toEqual({ kind: 'unavailable', reason: 'runtime missing' });
    expect(
      getIosSimulatorDeviceAction(device({ udid: 'a', state: 'shutting-down' }), IDLE)
    ).toEqual({
      kind: 'settling',
    });
  });
});

describe('resolveIosSimulatorSelection', () => {
  const ready: IosSimulatorPreviewStatus = {
    phase: 'ready',
    udid: 'pro-9',
    viewerUrl: 'http://x',
    connection: 'direct',
  };

  it('puts a choice made in the panel above the live preview', () => {
    expect(resolveIosSimulatorSelection(devices, { chosenUdid: 'ipad', status: ready })).toBe(
      'ipad'
    );
  });

  it('puts the live preview above the remembered device', () => {
    expect(resolveIosSimulatorSelection(devices, { preferredUdid: 'ipad', status: ready })).toBe(
      'pro-9'
    );
    expect(resolveIosSimulatorSelection(devices, { preferredUdid: 'ipad', status: IDLE })).toBe(
      'ipad'
    );
  });

  it('falls back to a held, then booted, then free device and ignores unknown ids', () => {
    const held = [...devices, device({ udid: 'held', occupancy: { kind: 'this-session' } })];
    expect(resolveIosSimulatorSelection(held, { preferredUdid: 'gone', status: IDLE })).toBe(
      'held'
    );
    expect(resolveIosSimulatorSelection(devices, { status: IDLE })).toBe('old');
    const noneBooted = devices.map((entry) => ({ ...entry, state: 'shutdown' as const }));
    expect(resolveIosSimulatorSelection(noneBooted, { status: IDLE })).toBe('ipad');
    expect(resolveIosSimulatorSelection([], { status: IDLE })).toBeNull();
  });
});

describe('status polling', () => {
  it('polls only while something is changing or being watched', () => {
    expect(getIosSimulatorStatusPollMs({ phase: 'preparing', udid: 'a', stage: 'x' })).toBe(1_500);
    expect(
      getIosSimulatorStatusPollMs({
        phase: 'ready',
        udid: 'a',
        viewerUrl: 'u',
        connection: 'remote',
      })
    ).toBe(15_000);
    expect(getIosSimulatorStatusPollMs(IDLE)).toBeNull();
    expect(getIosSimulatorStatusPollMs({ phase: 'failed', error: { code: 'timeout' } })).toBeNull();
  });
});

describe('selected-device preference', () => {
  afterEach(() => window.localStorage.clear());

  it('is scoped to workspace, machine and Session', () => {
    const scope = { workspaceId: 'w1', machineId: 'm1', sessionId: 's1' };
    writeIosSimulatorSelectedDevice(scope, 'pro-9');
    expect(readIosSimulatorSelectedDevice(scope)).toBe('pro-9');
    expect(readIosSimulatorSelectedDevice({ ...scope, workspaceId: 'w2' })).toBeNull();
    expect(readIosSimulatorSelectedDevice({ ...scope, machineId: 'm2' })).toBeNull();
    expect(readIosSimulatorSelectedDevice({ ...scope, sessionId: 's2' })).toBeNull();
    expect(readIosSimulatorSelectedDevice(null)).toBeNull();
  });
});

describe('diagnostics', () => {
  it('redacts URLs, secrets, ids and home directories', () => {
    expect(
      redactIosSimulatorText(
        'GET https://abc.trycloudflare.com/view?token=s3cret failed token=abc123 for 0A1B2C3D-1111-2222-3333-444455556666 at /Users/alice/Library aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
      )
    ).toBe('GET <url> failed token=<redacted> for <id> at /Users/<user>/Library <redacted>');
  });

  it('never carries the viewer URL of a ready preview', () => {
    const text = buildIosSimulatorDiagnostics({
      now: new Date('2026-09-27T00:00:00.000Z'),
      machine: { os: 'darwin', cliVersion: '1.2.3', online: 'online', local: false },
      availability: 'available',
      status: {
        phase: 'ready',
        udid: 'pro-9',
        viewerUrl: 'https://secret-tunnel.example/viewer?capability=xyz',
        connection: 'remote',
      },
      device: devices[2],
      runtime: runtimes[2],
      catalog: { phase: 'ready', deviceCount: devices.length },
    });
    expect(text).toContain('preview: ready connection=remote');
    expect(text).toContain('device: iPhone 9 Pro');
    expect(text).not.toContain('secret-tunnel');
    expect(text).not.toContain('capability');
  });
});
