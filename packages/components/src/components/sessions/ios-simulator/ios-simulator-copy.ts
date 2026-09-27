import { useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { getIosSimulatorDeviceAction } from '@/lib/ios-simulator/ios-simulator-model';
import type {
  IosSimulatorDevice,
  IosSimulatorError,
  IosSimulatorPreparingStage,
  IosSimulatorPreviewStatus,
} from '@/lib/ios-simulator/ios-simulator-types';

export type IosSimulatorStateLabel = {
  label: string;
  /** `live`: this Session's preview. `blocked`: nothing can be started on it here. */
  tone: 'rest' | 'live' | 'blocked';
};

/** One word for a device's condition, as the picker row and the stage both say it. */
export function useIosSimulatorDeviceStateLabel() {
  const { t } = useTranslation();
  return useCallback(
    (device: IosSimulatorDevice, status: IosSimulatorPreviewStatus): IosSimulatorStateLabel => {
      const action = getIosSimulatorDeviceAction(device, status);
      switch (action.kind) {
        case 'current':
          return {
            label: t('sessions.iosSimulator.state.previewing', 'Previewing'),
            tone: 'live',
          };
        case 'occupied':
          return { label: t('sessions.iosSimulator.state.inUse', 'In use'), tone: 'blocked' };
        case 'unavailable':
          return {
            label: t('sessions.iosSimulator.state.unavailable', 'Unavailable'),
            tone: 'blocked',
          };
        case 'settling':
          return {
            label: t('sessions.iosSimulator.state.shuttingDown', 'Shutting down…'),
            tone: 'rest',
          };
        default:
          break;
      }
      if (device.state === 'booted') {
        return { label: t('sessions.iosSimulator.state.booted', 'Booted'), tone: 'rest' };
      }
      if (device.state === 'booting') {
        return { label: t('sessions.iosSimulator.state.booting', 'Booting…'), tone: 'rest' };
      }
      return { label: t('sessions.iosSimulator.state.shutdown', 'Shut down'), tone: 'rest' };
    },
    [t]
  );
}

export const IOS_SIMULATOR_PREPARING_STAGES: readonly IosSimulatorPreparingStage[] = [
  'booting-device',
  'starting-stream',
  'connecting',
];

export function useIosSimulatorStageLabel() {
  const { t } = useTranslation();
  return useCallback(
    (stage: string): string => {
      switch (stage) {
        case 'booting-device':
          return t('sessions.iosSimulator.stage.bootingDevice', 'Starting the simulator');
        case 'starting-stream':
          return t('sessions.iosSimulator.stage.startingStream', 'Starting the screen stream');
        case 'connecting':
          return t('sessions.iosSimulator.stage.connecting', 'Connecting the viewer');
        default:
          return t('sessions.iosSimulator.stage.preparing', 'Preparing the preview');
      }
    },
    [t]
  );
}

export type IosSimulatorErrorCopy = { title: string; detail: string };

/** What went wrong, and what the person can do about it. The raw message stays below. */
export function useIosSimulatorErrorCopy() {
  const { t } = useTranslation();
  return useCallback(
    (error: IosSimulatorError, machineName: string): IosSimulatorErrorCopy => {
      switch (error.code) {
        case 'xcode-missing':
          return {
            title: t(
              'sessions.iosSimulator.error.xcodeMissing',
              'Xcode isn’t set up on {{machine}}',
              {
                machine: machineName,
              }
            ),
            detail: t(
              'sessions.iosSimulator.error.xcodeMissingDetail',
              'Install Xcode and an iOS Simulator runtime on that Mac, open Xcode once to finish setup, then refresh.'
            ),
          };
        case 'device-occupied':
          return {
            title: t('sessions.iosSimulator.error.occupied', 'Another session took this simulator'),
            detail: t(
              'sessions.iosSimulator.error.occupiedDetail',
              'One session controls a simulator at a time. Choose another simulator, or stop the preview in the session using it.'
            ),
          };
        case 'device-unavailable':
        case 'device-not-found':
          return {
            title: t('sessions.iosSimulator.error.unavailable', 'This simulator isn’t available'),
            detail: t(
              'sessions.iosSimulator.error.unavailableDetail',
              'It may have been deleted, or its runtime is missing. Refresh the list or choose another simulator.'
            ),
          };
        case 'boot-failed':
          return {
            title: t('sessions.iosSimulator.error.bootFailed', 'The simulator didn’t start'),
            detail: t(
              'sessions.iosSimulator.error.bootFailedDetail',
              'Try again. If it keeps failing, open Simulator on that Mac to see what it reports.'
            ),
          };
        case 'stream-failed':
          return {
            title: t('sessions.iosSimulator.error.streamFailed', 'The screen stream didn’t start'),
            detail: t(
              'sessions.iosSimulator.error.streamFailedDetail',
              'The simulator is still running. Try again, or copy the diagnostics for a bug report.'
            ),
          };
        case 'timeout':
          return {
            title: t('sessions.iosSimulator.error.timeout', 'The Mac took too long to answer'),
            detail: t(
              'sessions.iosSimulator.error.timeoutDetail',
              'It may be busy starting the simulator. Try again in a moment.'
            ),
          };
        case 'unsupported':
          return {
            title: t('sessions.iosSimulator.error.unsupported', 'Update Lody on {{machine}}', {
              machine: machineName,
            }),
            detail: t(
              'sessions.iosSimulator.error.unsupportedDetail',
              'This version of Lody on that Mac can’t stream simulators yet.'
            ),
          };
        case 'unauthorized':
          return {
            title: t(
              'sessions.iosSimulator.error.unauthorized',
              'You can’t control simulators here'
            ),
            detail: t(
              'sessions.iosSimulator.error.unauthorizedDetail',
              'Only people allowed to run this session can preview its Mac’s simulators.'
            ),
          };
        default:
          return {
            title: t('sessions.iosSimulator.error.generic', 'The preview stopped with an error'),
            detail: t(
              'sessions.iosSimulator.error.genericDetail',
              'Try again, or copy the diagnostics for a bug report.'
            ),
          };
      }
    },
    [t]
  );
}
