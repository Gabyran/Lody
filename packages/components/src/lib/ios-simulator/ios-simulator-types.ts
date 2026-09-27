import type { MachineId, SessionId } from '@lody/shared';

/**
 * Frontend port for the iOS Simulator side panel.
 *
 * These are VIEW types. The typed Machine RPC contract (`ios-simulator/list`,
 * `start-preview`, `status`, `cancel-start`, `stop-preview`) and its
 * authentication belong to the runtime that implements `IosSimulatorClient`;
 * that implementation maps its DTOs onto these shapes. The panel never sees a
 * credential: the only capability-bearing value it touches is the opaque
 * `viewerUrl` it loads into the viewer iframe, and it never displays it.
 */

export type IosSimulatorTarget = {
  machineId: MachineId;
  sessionId: SessionId;
};

export type IosSimulatorRuntime = {
  /** Stable runtime identifier, e.g. `com.apple.CoreSimulator.SimRuntime.iOS-18-2`. */
  id: string;
  /** Display name, e.g. `iOS 18.2`. */
  name: string;
  /** `iOS`, `watchOS`, `tvOS`, `visionOS`, … Unknown platforms still group by runtime. */
  platform: string;
  version: string;
  available: boolean;
  unavailableReason?: string;
};

export type IosSimulatorDeviceFamily = 'iphone' | 'ipad' | 'watch' | 'tv' | 'vision' | 'other';

export type IosSimulatorDeviceState =
  | 'booted'
  | 'booting'
  | 'shutdown'
  | 'shutting-down'
  | 'unknown';

/**
 * Who controls a device. One Session controls a device across every machine
 * client and workspace; nobody may take it over. A holder in a Session the
 * requester cannot see arrives without a title.
 */
export type IosSimulatorOccupancy =
  | { kind: 'free' }
  | { kind: 'this-session' }
  | { kind: 'other-session'; sessionTitle?: string };

export type IosSimulatorDevice = {
  udid: string;
  name: string;
  runtimeId: string;
  family?: IosSimulatorDeviceFamily;
  state: IosSimulatorDeviceState;
  available: boolean;
  unavailableReason?: string;
  occupancy: IosSimulatorOccupancy;
  /** Screen size in any unit; only its aspect ratio is used. */
  screen?: { width: number; height: number };
};

export type IosSimulatorErrorCode =
  | 'xcode-missing'
  | 'device-occupied'
  | 'device-unavailable'
  | 'device-not-found'
  | 'boot-failed'
  | 'stream-failed'
  | 'timeout'
  | 'cancelled'
  | 'unsupported'
  | 'unauthorized'
  | 'internal';

export type IosSimulatorError = {
  /** A known code, or any string a newer machine reports. */
  code: IosSimulatorErrorCode | (string & {});
  message?: string;
  retryable?: boolean;
};

export type IosSimulatorListResult =
  | { ok: true; runtimes: IosSimulatorRuntime[]; devices: IosSimulatorDevice[] }
  | { ok: false; error: IosSimulatorError };

export type IosSimulatorPreparingStage = 'booting-device' | 'starting-stream' | 'connecting';

/**
 * `direct`: the viewer is served on this machine (same-machine Electron) and
 * keeps working while the cloud is unreachable. `remote`: it travels through a
 * tunnel whose address the UI never shows.
 */
export type IosSimulatorConnectionKind = 'direct' | 'remote';

export type IosSimulatorInterruptionReason = 'expired' | 'connection-lost' | 'viewer-closed';

export type IosSimulatorPreviewStatus =
  | { phase: 'idle' }
  | {
      phase: 'preparing';
      udid: string;
      stage: IosSimulatorPreparingStage | (string & {});
    }
  | {
      phase: 'ready';
      udid: string;
      viewerUrl: string;
      connection: IosSimulatorConnectionKind;
    }
  | {
      phase: 'interrupted';
      udid: string;
      connection: IosSimulatorConnectionKind;
      reason: IosSimulatorInterruptionReason | (string & {});
    }
  | { phase: 'failed'; udid?: string; error: IosSimulatorError };

export type IosSimulatorStartRequest = {
  udid: string;
  /** Boot a shut-down device first ("Start and preview"). */
  boot: boolean;
};

/**
 * Transport failures reject; domain outcomes resolve as values. `stopPreview`
 * ends this Session's preview and releases its hold on the device; it never
 * shuts the device down.
 */
export interface IosSimulatorClient {
  list(target: IosSimulatorTarget): Promise<IosSimulatorListResult>;
  startPreview(
    target: IosSimulatorTarget,
    request: IosSimulatorStartRequest
  ): Promise<IosSimulatorPreviewStatus>;
  status(target: IosSimulatorTarget): Promise<IosSimulatorPreviewStatus>;
  cancelStart(target: IosSimulatorTarget): Promise<IosSimulatorPreviewStatus>;
  stopPreview(target: IosSimulatorTarget): Promise<IosSimulatorPreviewStatus>;
}
