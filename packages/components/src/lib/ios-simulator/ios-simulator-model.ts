import { machineSupportsProtocolCapability, type MachineProtocolCapabilities } from '@lody/shared';
import type {
  IosSimulatorDevice,
  IosSimulatorDeviceFamily,
  IosSimulatorPreviewStatus,
  IosSimulatorRuntime,
} from './ios-simulator-types';

/**
 * Placeholder until the shared contract exports the daemon capability key.
 * Keep every read behind `getIosSimulatorPanelAvailability` so the swap is one line.
 */
export const IOS_SIMULATOR_PROTOCOL_CAPABILITY = 'iosSimulator';
export const IOS_SIMULATOR_PROTOCOL_VERSION = 1;

export type IosSimulatorPanelAvailability = 'hidden' | 'upgrade-required' | 'available';

/**
 * The tab exists only for a Session whose TARGET machine is a Mac. That machine
 * may be too old to answer the simulator RPCs; the tab still appears so it can
 * say so, rather than silently missing on the one machine that could run it.
 */
export function getIosSimulatorPanelAvailability(
  machine:
    | { os?: string | null; protocolCapabilities?: MachineProtocolCapabilities }
    | null
    | undefined
): IosSimulatorPanelAvailability {
  if (machine?.os !== 'darwin') return 'hidden';
  return machineSupportsProtocolCapability(
    machine,
    IOS_SIMULATOR_PROTOCOL_CAPABILITY,
    IOS_SIMULATOR_PROTOCOL_VERSION
  )
    ? 'available'
    : 'upgrade-required';
}

export type IosSimulatorDeviceGroup = {
  runtime: IosSimulatorRuntime;
  devices: IosSimulatorDevice[];
};

const PLATFORM_ORDER = ['ios', 'ipados', 'watchos', 'tvos', 'visionos', 'xros'];
const FAMILY_ORDER: IosSimulatorDeviceFamily[] = [
  'iphone',
  'ipad',
  'watch',
  'tv',
  'vision',
  'other',
];

const naturalCollator = new Intl.Collator('en', { numeric: true, sensitivity: 'base' });

const platformRank = (platform: string): number => {
  const index = PLATFORM_ORDER.indexOf(platform.toLowerCase());
  return index === -1 ? PLATFORM_ORDER.length : index;
};

const familyRank = (family: IosSimulatorDeviceFamily | undefined): number =>
  FAMILY_ORDER.indexOf(family ?? 'other');

/** Runtimes read newest-first inside each platform, platforms in Xcode's order. */
export function compareIosSimulatorRuntimes(a: IosSimulatorRuntime, b: IosSimulatorRuntime) {
  return (
    platformRank(a.platform) - platformRank(b.platform) ||
    naturalCollator.compare(a.platform, b.platform) ||
    naturalCollator.compare(b.version, a.version) ||
    naturalCollator.compare(a.name, b.name)
  );
}

const compareDevices = (a: IosSimulatorDevice, b: IosSimulatorDevice) =>
  familyRank(a.family) - familyRank(b.family) ||
  naturalCollator.compare(a.name, b.name) ||
  a.udid.localeCompare(b.udid);

const unknownRuntime = (runtimeId: string): IosSimulatorRuntime => ({
  id: runtimeId,
  name: runtimeId.split('.').pop()?.replace(/-/g, ' ') || runtimeId,
  platform: '',
  version: '',
  available: false,
});

export type IosSimulatorDeviceFilter = {
  query?: string;
  /** Restrict to one runtime; `null` keeps every runtime. */
  runtimeId?: string | null;
};

/**
 * Every device, grouped under its runtime. A device whose runtime is missing
 * from the catalog still appears, under a group named after its id: hiding it
 * would make the picker disagree with `simctl list`.
 */
export function groupIosSimulatorDevices(
  runtimes: readonly IosSimulatorRuntime[],
  devices: readonly IosSimulatorDevice[],
  filter: IosSimulatorDeviceFilter = {}
): IosSimulatorDeviceGroup[] {
  const runtimeById = new Map(runtimes.map((runtime) => [runtime.id, runtime]));
  const tokens = (filter.query ?? '').trim().toLowerCase().split(/\s+/).filter(Boolean);
  const byRuntime = new Map<string, IosSimulatorDevice[]>();
  for (const device of devices) {
    if (filter.runtimeId && device.runtimeId !== filter.runtimeId) continue;
    const runtime = runtimeById.get(device.runtimeId) ?? unknownRuntime(device.runtimeId);
    if (tokens.length > 0) {
      const haystack = `${device.name} ${runtime.name} ${runtime.platform}`.toLowerCase();
      if (!tokens.every((token) => haystack.includes(token))) continue;
    }
    const list = byRuntime.get(device.runtimeId);
    if (list) list.push(device);
    else byRuntime.set(device.runtimeId, [device]);
  }
  return [...byRuntime.entries()]
    .map(([runtimeId, list]) => ({
      runtime: runtimeById.get(runtimeId) ?? unknownRuntime(runtimeId),
      devices: list.sort(compareDevices),
    }))
    .sort((a, b) => compareIosSimulatorRuntimes(a.runtime, b.runtime));
}

/** Runtimes that actually hold a device, for the filter row. */
export function getIosSimulatorFilterRuntimes(
  runtimes: readonly IosSimulatorRuntime[],
  devices: readonly IosSimulatorDevice[]
): IosSimulatorRuntime[] {
  return groupIosSimulatorDevices(runtimes, devices).map((group) => group.runtime);
}

/** The device the Session's current preview (in any phase) is about, if any. */
export function getIosSimulatorStatusUdid(status: IosSimulatorPreviewStatus): string | null {
  return status.phase === 'idle' ? null : (status.udid ?? null);
}

export type IosSimulatorDeviceAction =
  /** This Session already previews (or is preparing) this device. */
  | { kind: 'current' }
  | { kind: 'preview' }
  | { kind: 'start-and-preview' }
  /** Another Session controls it; there is no takeover. */
  | { kind: 'occupied'; sessionTitle?: string }
  | { kind: 'unavailable'; reason?: string }
  /** The device is mid-shutdown; it can be started once that settles. */
  | { kind: 'settling' };

export function getIosSimulatorDeviceAction(
  device: IosSimulatorDevice,
  status: IosSimulatorPreviewStatus
): IosSimulatorDeviceAction {
  if (
    getIosSimulatorStatusUdid(status) === device.udid &&
    (status.phase === 'preparing' || status.phase === 'ready' || status.phase === 'interrupted')
  ) {
    return { kind: 'current' };
  }
  if (!device.available) return { kind: 'unavailable', reason: device.unavailableReason };
  if (device.occupancy.kind === 'other-session') {
    return { kind: 'occupied', sessionTitle: device.occupancy.sessionTitle };
  }
  if (device.state === 'shutting-down') return { kind: 'settling' };
  if (device.state === 'booted' || device.state === 'booting') return { kind: 'preview' };
  return { kind: 'start-and-preview' };
}

/** Whether a device may be chosen to act on. Occupied and unavailable devices stay listed. */
export function canStartIosSimulatorPreview(action: IosSimulatorDeviceAction): boolean {
  return action.kind === 'preview' || action.kind === 'start-and-preview';
}

/**
 * Which device the panel shows. A choice made in this panel wins; otherwise
 * the Session's own preview — the device it controls — then the remembered
 * choice, then a device this Session already holds, then the first booted free
 * device, then the first free one.
 */
export function resolveIosSimulatorSelection(
  devices: readonly IosSimulatorDevice[],
  {
    chosenUdid = null,
    preferredUdid = null,
    status,
  }: {
    chosenUdid?: string | null;
    preferredUdid?: string | null;
    status: IosSimulatorPreviewStatus;
  }
): string | null {
  const known = new Set(devices.map((device) => device.udid));
  if (chosenUdid && known.has(chosenUdid)) return chosenUdid;
  const statusUdid = getIosSimulatorStatusUdid(status);
  if (statusUdid && status.phase !== 'failed' && known.has(statusUdid)) return statusUdid;
  if (preferredUdid && known.has(preferredUdid)) return preferredUdid;
  const held = devices.find((device) => device.occupancy.kind === 'this-session');
  if (held) return held.udid;
  const free = devices.filter((device) => device.available && device.occupancy.kind === 'free');
  return (free.find((device) => device.state === 'booted') ?? free[0])?.udid ?? null;
}

/** Status polling cadence. Only a visible panel polls at all. */
export function getIosSimulatorStatusPollMs(status: IosSimulatorPreviewStatus): number | null {
  switch (status.phase) {
    case 'preparing':
      return 1_500;
    case 'ready':
      return 15_000;
    default:
      return null;
  }
}

// ---------------------------------------------------------------------------
// Selected-device preference: local, per workspace + machine + Session. It is a
// preference, not a cache, so a cache clear keeps it.

const SELECTED_DEVICE_KEY = 'lody:iosSimulatorSelectedDevice';

export type IosSimulatorPreferenceScope = {
  workspaceId: string;
  machineId: string;
  sessionId: string;
};

export const getIosSimulatorSelectedDeviceStorageKey = (scope: IosSimulatorPreferenceScope) =>
  `${SELECTED_DEVICE_KEY}:${scope.workspaceId}:${scope.machineId}:${scope.sessionId}`;

export function readIosSimulatorSelectedDevice(
  scope: IosSimulatorPreferenceScope | null
): string | null {
  if (!scope || typeof window === 'undefined') return null;
  try {
    const value = window.localStorage.getItem(getIosSimulatorSelectedDeviceStorageKey(scope));
    return value && value.length <= 128 ? value : null;
  } catch {
    return null;
  }
}

export function writeIosSimulatorSelectedDevice(
  scope: IosSimulatorPreferenceScope | null,
  udid: string
): void {
  if (!scope || typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(getIosSimulatorSelectedDeviceStorageKey(scope), udid);
  } catch {
    // Storage full or disabled: the choice simply is not remembered.
  }
}

// ---------------------------------------------------------------------------
// Diagnostics. Copied text may be pasted anywhere, so it never carries a URL
// (the viewer address holds a capability and a remote tunnel is private), a
// long opaque token, a device UDID, or a home-directory user name.

const URL_PATTERN = /\b[a-z][a-z0-9+.-]*:\/\/[^\s"'<>]+/gi;
const UUID_PATTERN = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;
const SECRET_ASSIGNMENT_PATTERN =
  /\b(token|secret|key|password|auth|authorization|proof|nonce|signature)(\s*[=:]\s*)[^\s,;&]+/gi;
const OPAQUE_TOKEN_PATTERN = /\b[A-Za-z0-9_-]{32,}\b/g;
const HOME_PATTERN = /(\/(?:Users|home)\/)[^/\s]+/g;

export function redactIosSimulatorText(text: string): string {
  return text
    .replace(URL_PATTERN, '<url>')
    .replace(SECRET_ASSIGNMENT_PATTERN, '$1$2<redacted>')
    .replace(UUID_PATTERN, '<id>')
    .replace(OPAQUE_TOKEN_PATTERN, '<redacted>')
    .replace(HOME_PATTERN, '$1<user>');
}

export type IosSimulatorDiagnosticsInput = {
  now: Date;
  machine: { os?: string | null; cliVersion?: string | null; online: string; local: boolean };
  availability: IosSimulatorPanelAvailability;
  status: IosSimulatorPreviewStatus;
  device?: IosSimulatorDevice | null;
  runtime?: IosSimulatorRuntime | null;
  catalog: { phase: string; deviceCount?: number; errorCode?: string; errorMessage?: string };
};

export function buildIosSimulatorDiagnostics(input: IosSimulatorDiagnosticsInput): string {
  const { status, device, runtime } = input;
  const lines = [
    'Lody iOS Simulator diagnostics',
    `time: ${input.now.toISOString()}`,
    `machine: os=${input.machine.os ?? 'unknown'} cli=${input.machine.cliVersion ?? 'unknown'} presence=${input.machine.online} local=${input.machine.local}`,
    `protocol: ${input.availability}`,
    `catalog: ${input.catalog.phase}${input.catalog.deviceCount == null ? '' : ` devices=${input.catalog.deviceCount}`}${input.catalog.errorCode ? ` error=${input.catalog.errorCode}` : ''}`,
  ];
  if (input.catalog.errorMessage) lines.push(`catalog-error: ${input.catalog.errorMessage}`);
  if (device) {
    lines.push(
      `device: ${device.name} family=${device.family ?? 'unknown'} state=${device.state} available=${device.available} occupancy=${device.occupancy.kind}`
    );
    if (device.unavailableReason) lines.push(`device-unavailable: ${device.unavailableReason}`);
  }
  if (runtime) lines.push(`runtime: ${runtime.name} available=${runtime.available}`);
  switch (status.phase) {
    case 'idle':
      lines.push('preview: idle');
      break;
    case 'preparing':
      lines.push(`preview: preparing stage=${status.stage}`);
      break;
    case 'ready':
      // The viewer URL is deliberately absent, not redacted: it is a capability.
      lines.push(`preview: ready connection=${status.connection}`);
      break;
    case 'interrupted':
      lines.push(`preview: interrupted connection=${status.connection} reason=${status.reason}`);
      break;
    case 'failed':
      lines.push(
        `preview: failed code=${status.error.code} retryable=${status.error.retryable ?? 'unknown'}`
      );
      if (status.error.message) lines.push(`preview-error: ${status.error.message}`);
      break;
  }
  return redactIosSimulatorText(lines.join('\n'));
}
