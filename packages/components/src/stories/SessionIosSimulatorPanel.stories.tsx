import type { Meta, StoryObj } from '@storybook/react-vite';
import { fn } from 'storybook/test';
import {
  IosSimulatorPanelView,
  type IosSimulatorPanelViewProps,
} from '@/components/sessions/ios-simulator/ios-simulator-panel-view';
import type {
  IosSimulatorDevice,
  IosSimulatorRuntime,
} from '@/lib/ios-simulator/ios-simulator-types';

const runtimes: IosSimulatorRuntime[] = [
  { id: 'ios-18-2', name: 'iOS 18.2', platform: 'iOS', version: '18.2', available: true },
  { id: 'ios-17-5', name: 'iOS 17.5', platform: 'iOS', version: '17.5', available: true },
  { id: 'watchos-11', name: 'watchOS 11.2', platform: 'watchOS', version: '11.2', available: true },
];

const devices: IosSimulatorDevice[] = [
  {
    udid: 'iphone-16-pro',
    name: 'iPhone 16 Pro',
    runtimeId: 'ios-18-2',
    family: 'iphone',
    state: 'booted',
    available: true,
    occupancy: { kind: 'free' },
    screen: { width: 402, height: 874 },
  },
  {
    udid: 'iphone-16',
    name: 'iPhone 16',
    runtimeId: 'ios-18-2',
    family: 'iphone',
    state: 'shutdown',
    available: true,
    occupancy: { kind: 'free' },
    screen: { width: 393, height: 852 },
  },
  {
    udid: 'ipad-pro',
    name: 'iPad Pro 13-inch (M4)',
    runtimeId: 'ios-18-2',
    family: 'ipad',
    state: 'booted',
    available: true,
    occupancy: { kind: 'other-session', sessionTitle: 'Fix checkout layout' },
    screen: { width: 1032, height: 1376 },
  },
  {
    udid: 'iphone-15',
    name: 'iPhone 15',
    runtimeId: 'ios-17-5',
    family: 'iphone',
    state: 'shutdown',
    available: false,
    unavailableReason: 'The iOS 17.5 runtime is not installed.',
    occupancy: { kind: 'free' },
    screen: { width: 393, height: 852 },
  },
  {
    udid: 'watch-ultra',
    name: 'Apple Watch Ultra 2 (49mm)',
    runtimeId: 'watchos-11',
    family: 'watch',
    state: 'shutdown',
    available: true,
    occupancy: { kind: 'other-session' },
    screen: { width: 410, height: 502 },
  },
];

/** A stand-in for the machine's viewer page: the real one streams the screen. */
const SAMPLE_VIEWER_URL = `data:text/html,${encodeURIComponent(
  '<body style="margin:0;height:100vh;display:grid;place-items:center;background:linear-gradient(160deg,#1c3d7a,#6a2c70);color:#fff;font:600 17px -apple-system,system-ui">9:41</body>'
)}`;

const baseArgs: IosSimulatorPanelViewProps = {
  machineName: 'Studio',
  blocker: null,
  catalog: { phase: 'ready', runtimes, devices },
  selectedUdid: 'iphone-16-pro',
  status: { phase: 'idle' },
  onSelectDevice: fn(),
  onPickerOpenChange: fn(),
  onRefresh: fn(),
  onStart: fn(),
  onCancel: fn(),
  onStop: fn(),
  onRestore: fn(),
  onRetry: fn(),
  onCopyDiagnostics: fn(),
};

const meta = {
  title: 'Sessions/iOS Simulator/Panel',
  component: IosSimulatorPanelView,
  parameters: { layout: 'fullscreen' },
  decorators: [
    (Story) => (
      <div className="h-[720px] w-[460px] border-l border-border bg-background">
        <Story />
      </div>
    ),
  ],
  args: baseArgs,
} satisfies Meta<typeof IosSimulatorPanelView>;

export default meta;
type Story = StoryObj<typeof meta>;

export const ReadyToPreview: Story = {};

export const StartAndPreview: Story = { args: { selectedUdid: 'iphone-16' } };

export const Preparing: Story = {
  args: {
    selectedUdid: 'iphone-16',
    bootRequested: true,
    pendingAction: 'start',
    status: { phase: 'preparing', udid: 'iphone-16', stage: 'starting-stream' },
  },
};

export const PreviewingDirect: Story = {
  args: {
    status: {
      phase: 'ready',
      udid: 'iphone-16-pro',
      viewerUrl: SAMPLE_VIEWER_URL,
      connection: 'direct',
    },
  },
};

export const PreviewingRemote: Story = {
  args: {
    status: {
      phase: 'ready',
      udid: 'iphone-16-pro',
      viewerUrl: SAMPLE_VIEWER_URL,
      connection: 'remote',
    },
  },
};

/** Another device is chosen while this Session previews one: switching ends that preview. */
export const SwitchingDevices: Story = {
  args: {
    selectedUdid: 'iphone-16',
    status: {
      phase: 'ready',
      udid: 'iphone-16-pro',
      viewerUrl: SAMPLE_VIEWER_URL,
      connection: 'remote',
    },
  },
};

export const OccupiedByAnotherSession: Story = { args: { selectedUdid: 'ipad-pro' } };

export const OccupiedOutsideThisWorkspace: Story = { args: { selectedUdid: 'watch-ultra' } };

export const UnavailableDevice: Story = { args: { selectedUdid: 'iphone-15' } };

export const Interrupted: Story = {
  args: {
    status: {
      phase: 'interrupted',
      udid: 'iphone-16-pro',
      connection: 'remote',
      reason: 'expired',
    },
  },
};

export const StreamFailed: Story = {
  args: {
    status: {
      phase: 'failed',
      udid: 'iphone-16-pro',
      error: {
        code: 'stream-failed',
        message: 'simctl io recordVideo exited with status 1',
        retryable: true,
      },
    },
  },
};

export const LoadingCatalog: Story = {
  args: { catalog: { phase: 'loading' }, selectedUdid: null },
};

export const XcodeMissing: Story = {
  args: {
    selectedUdid: null,
    catalog: {
      phase: 'error',
      error: { code: 'xcode-missing', message: 'xcrun: error: unable to find utility "simctl"' },
    },
  },
};

export const NoSimulators: Story = {
  args: { selectedUdid: null, catalog: { phase: 'ready', runtimes, devices: [] } },
};

export const MachineOffline: Story = {
  args: { blocker: 'offline', catalog: { phase: 'loading' }, selectedUdid: null },
};

export const UpdateLodyOnMac: Story = {
  args: { blocker: 'upgrade-required', catalog: { phase: 'loading' }, selectedUdid: null },
};

/** The narrowest side panel: the status word gives way, the device name truncates. */
export const Narrow: Story = {
  decorators: [
    (Story) => (
      <div className="h-[560px] w-[300px] border-l border-border bg-background">
        <Story />
      </div>
    ),
  ],
  args: {
    status: {
      phase: 'ready',
      udid: 'iphone-16-pro',
      viewerUrl: SAMPLE_VIEWER_URL,
      connection: 'direct',
    },
  },
};
