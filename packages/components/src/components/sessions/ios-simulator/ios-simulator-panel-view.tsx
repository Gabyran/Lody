import type { CSSProperties, ReactNode } from 'react';
import * as stylex from '@stylexjs/stylex';
import { Check, Copy } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Button } from '@lody/ui/button';
import { Spinner } from '@lody/ui/spinner';
import { colors, shadow } from '@lody/ui/tokens/colors.stylex';
import { corner, radius, space, text } from '@lody/ui/tokens/scales.stylex';
import {
  canStartIosSimulatorPreview,
  getIosSimulatorDeviceAction,
  getIosSimulatorStatusUdid,
} from '@/lib/ios-simulator/ios-simulator-model';
import type {
  IosSimulatorDevice,
  IosSimulatorError,
  IosSimulatorPreparingStage,
  IosSimulatorPreviewStatus,
  IosSimulatorRuntime,
} from '@/lib/ios-simulator/ios-simulator-types';
import {
  IosSimulatorConnectionStatus,
  type IosSimulatorPendingAction,
} from './ios-simulator-connection-status';
import {
  IOS_SIMULATOR_PREPARING_STAGES,
  useIosSimulatorDeviceStateLabel,
  useIosSimulatorErrorCopy,
  useIosSimulatorStageLabel,
} from './ios-simulator-copy';
import { IosSimulatorDevicePicker } from './ios-simulator-device-picker';
import { getIosSimulatorAspectRatio, IosSimulatorViewer } from './ios-simulator-viewer';

export type IosSimulatorCatalogState =
  | { phase: 'loading' }
  | { phase: 'error'; error: IosSimulatorError }
  | { phase: 'ready'; runtimes: IosSimulatorRuntime[]; devices: IosSimulatorDevice[] };

/** Why the panel cannot talk to the machine at all. Checked before anything else. */
export type IosSimulatorPanelBlocker =
  /** The Mac's Lody predates the simulator protocol. */
  | 'upgrade-required'
  /** The Mac is offline and is not this machine. */
  | 'offline'
  /** This app build has no simulator client. */
  | 'client-unavailable';

export type IosSimulatorPanelViewProps = {
  machineName: string;
  blocker: IosSimulatorPanelBlocker | null;
  catalog: IosSimulatorCatalogState;
  refreshing?: boolean;
  selectedUdid: string | null;
  status: IosSimulatorPreviewStatus;
  pendingAction?: IosSimulatorPendingAction;
  /** Whether the preparing sequence includes booting the device. */
  bootRequested?: boolean;
  /** The viewer is mounted only while the panel is on screen. */
  active?: boolean;
  leadingSlot?: ReactNode;
  onSelectDevice: (udid: string) => void;
  onPickerOpenChange?: (open: boolean) => void;
  onRefresh: () => void;
  onStart: (device: IosSimulatorDevice) => void;
  onCancel: () => void;
  onStop: () => void;
  onRestore: () => void;
  onRetry: () => void;
  onCopyDiagnostics: () => void;
};

const styles = stylex.create({
  root: {
    display: 'flex',
    flexDirection: 'column',
    height: '100%',
    minHeight: 0,
    backgroundColor: colors.background,
    color: colors.label,
  },
  toolbar: {
    boxSizing: 'border-box',
    display: 'flex',
    alignItems: 'center',
    gap: space[1],
    minWidth: 0,
    paddingInline: space[1.5],
    paddingBottom: space[1.5],
    // Clears the notch in the mobile drill; desktop keeps `--safe-area-top: 0`.
    paddingTop: `calc(${space[1.5]} + var(--safe-area-top, 0px))`,
    containerType: 'inline-size',
  },
  pickerSlot: { display: 'flex', flexGrow: 1, flexShrink: 1, minWidth: 0 },
  statusSlot: { display: 'flex', flexShrink: 0, marginInlineStart: 'auto' },
  /** The region under the toolbar, one luminance step off the page. */
  stage: {
    display: 'flex',
    flexDirection: 'column',
    flexGrow: 1,
    minHeight: 0,
    backgroundColor: colors.secondaryBackground,
  },
  center: {
    boxSizing: 'border-box',
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    justifyContent: 'center',
    flexGrow: 1,
    minHeight: 0,
    gap: space[3],
    padding: space[6],
    textAlign: 'center',
  },
  message: {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    gap: space[1],
    maxWidth: '22rem',
  },
  title: {
    margin: 0,
    fontSize: text.subheadlineSize,
    lineHeight: text.subheadlineLeading,
    fontWeight: 600,
    color: colors.label,
    overflowWrap: 'anywhere',
  },
  detail: {
    margin: 0,
    fontSize: text.footnoteSize,
    lineHeight: '18px',
    color: colors.secondaryLabel,
    overflowWrap: 'anywhere',
  },
  raw: {
    margin: 0,
    fontSize: text.captionSize,
    lineHeight: text.captionLeading,
    color: colors.tertiaryLabel,
    overflowWrap: 'anywhere',
    maxWidth: '22rem',
  },
  actions: {
    display: 'flex',
    flexWrap: 'wrap',
    alignItems: 'center',
    justifyContent: 'center',
    gap: space[1.5],
  },
  /**
   * The screen slot: the device's own shape, empty, at the size the live
   * screen will take — so starting a preview lights the slot in place instead
   * of swapping one layout for another. Nothing is in it yet, so it is a well.
   */
  deviceStage: {
    boxSizing: 'border-box',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    flexGrow: 1,
    minHeight: 0,
    padding: space[4],
    containerType: 'size',
  },
  slot: {
    boxSizing: 'border-box',
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    justifyContent: 'center',
    gap: space[3],
    width: 'min(100cqw, calc(100cqh * var(--ios-simulator-aspect)))',
    aspectRatio: 'var(--ios-simulator-aspect)',
    minWidth: '12rem',
    maxWidth: '100%',
    maxHeight: '100%',
    padding: space[4],
    overflow: 'hidden',
    borderRadius: radius.large,
    cornerShape: corner.shape,
    backgroundColor: colors.wellBackground,
    boxShadow: shadow.inset,
    textAlign: 'center',
  },
  deviceName: {
    margin: 0,
    fontSize: text.headlineSize,
    lineHeight: text.headlineLeading,
    fontWeight: 600,
    letterSpacing: text.controlTracking,
    color: colors.label,
    overflowWrap: 'anywhere',
  },
  deviceMeta: {
    margin: 0,
    fontSize: text.footnoteSize,
    lineHeight: text.footnoteLeading,
    color: colors.secondaryLabel,
  },
  stages: {
    margin: 0,
    padding: 0,
    listStyle: 'none',
    display: 'flex',
    flexDirection: 'column',
    gap: space[1.5],
    textAlign: 'start',
  },
  stageRow: {
    display: 'flex',
    alignItems: 'center',
    gap: space[2],
    fontSize: text.footnoteSize,
    lineHeight: text.footnoteLeading,
    color: colors.tertiaryLabel,
  },
  stageCurrent: { color: colors.label, fontWeight: 500 },
  stageDone: { color: colors.secondaryLabel },
  stageMark: {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    width: '14px',
    height: '14px',
    flexShrink: 0,
  },
  stageDot: {
    width: '5px',
    height: '5px',
    borderRadius: radius.full,
    cornerShape: corner.round,
    backgroundColor: colors.tertiaryLabel,
  },
});

function Message({
  title,
  detail,
  raw,
  children,
}: {
  title: string;
  detail?: string;
  raw?: string;
  children?: ReactNode;
}) {
  return (
    <div {...stylex.props(styles.center)} role="status" aria-live="polite">
      <div {...stylex.props(styles.message)}>
        <p {...stylex.props(styles.title)}>{title}</p>
        {detail ? <p {...stylex.props(styles.detail)}>{detail}</p> : null}
      </div>
      {children ? <div {...stylex.props(styles.actions)}>{children}</div> : null}
      {raw ? <p {...stylex.props(styles.raw)}>{raw}</p> : null}
    </div>
  );
}

function DeviceSlot({
  device,
  children,
}: {
  device: IosSimulatorDevice | null;
  children: ReactNode;
}) {
  const aspect = { '--ios-simulator-aspect': String(getIosSimulatorAspectRatio(device?.screen)) };
  return (
    <div {...stylex.props(styles.deviceStage)}>
      <div
        {...stylex.props(styles.slot)}
        style={aspect as CSSProperties}
        data-testid="ios-simulator-slot"
      >
        {children}
      </div>
    </div>
  );
}

function PreparingSteps({ stage, includeBoot }: { stage: string; includeBoot: boolean }) {
  const stageLabel = useIosSimulatorStageLabel();
  const steps = IOS_SIMULATOR_PREPARING_STAGES.filter(
    (step) => includeBoot || step !== 'booting-device' || stage === 'booting-device'
  );
  const currentIndex = steps.indexOf(stage as IosSimulatorPreparingStage);
  if (currentIndex === -1) {
    return (
      <ol {...stylex.props(styles.stages)}>
        <li {...stylex.props(styles.stageRow, styles.stageCurrent)} aria-current="step">
          <span {...stylex.props(styles.stageMark)}>
            <Spinner size="small" label={null} />
          </span>
          {stageLabel(stage)}
        </li>
      </ol>
    );
  }
  return (
    <ol {...stylex.props(styles.stages)}>
      {steps.map((step, index) => {
        const done = index < currentIndex;
        const current = index === currentIndex;
        return (
          <li
            key={step}
            {...stylex.props(
              styles.stageRow,
              done && styles.stageDone,
              current && styles.stageCurrent
            )}
            aria-current={current ? 'step' : undefined}
          >
            <span {...stylex.props(styles.stageMark)}>
              {done ? (
                <Check size={14} aria-hidden />
              ) : current ? (
                <Spinner size="small" label={null} />
              ) : (
                <span {...stylex.props(styles.stageDot)} />
              )}
            </span>
            {stageLabel(step)}
          </li>
        );
      })}
    </ol>
  );
}

/**
 * Presentation only. The controller owns the Machine RPC calls, polling and the
 * remembered device; this decides what the stage says for each state.
 */
export function IosSimulatorPanelView({
  machineName,
  blocker,
  catalog,
  refreshing = false,
  selectedUdid,
  status,
  pendingAction = null,
  bootRequested = false,
  active = true,
  leadingSlot,
  onSelectDevice,
  onPickerOpenChange,
  onRefresh,
  onStart,
  onCancel,
  onStop,
  onRestore,
  onRetry,
  onCopyDiagnostics,
}: IosSimulatorPanelViewProps) {
  const { t } = useTranslation();
  const stateLabel = useIosSimulatorDeviceStateLabel();
  const errorCopy = useIosSimulatorErrorCopy();
  const runtimes = catalog.phase === 'ready' ? catalog.runtimes : [];
  const devices = catalog.phase === 'ready' ? catalog.devices : [];
  const deviceByUdid = new Map(devices.map((device) => [device.udid, device]));
  const runtimeById = new Map(runtimes.map((runtime) => [runtime.id, runtime]));
  const selected = selectedUdid ? (deviceByUdid.get(selectedUdid) ?? null) : null;
  const statusUdid = getIosSimulatorStatusUdid(status);
  const statusDevice = statusUdid ? (deviceByUdid.get(statusUdid) ?? null) : null;
  const busy = pendingAction !== null;

  const copyDiagnosticsButton = (
    <Button type="button" variant="ghost" size="small" onClick={onCopyDiagnostics}>
      <Copy size={14} aria-hidden />
      {t('sessions.iosSimulator.connection.copyDiagnostics', 'Copy diagnostics')}
    </Button>
  );

  const renderStage = (): ReactNode => {
    if (blocker === 'upgrade-required' || blocker === 'client-unavailable') {
      return (
        <Message
          title={
            blocker === 'upgrade-required'
              ? t('sessions.iosSimulator.blocker.upgradeTitle', 'Update Lody on {{machine}}', {
                  machine: machineName,
                })
              : t('sessions.iosSimulator.blocker.clientTitle', 'Update this app')
          }
          detail={
            blocker === 'upgrade-required'
              ? t(
                  'sessions.iosSimulator.blocker.upgradeDetail',
                  'Previewing simulators needs a newer Lody on the Mac this session runs on. Update it there, then reopen this tab.'
                )
              : t(
                  'sessions.iosSimulator.blocker.clientDetail',
                  'This version of Lody can’t show simulators yet. Update the app, then reopen this tab.'
                )
          }
        />
      );
    }
    if (blocker === 'offline') {
      return (
        <Message
          title={t('sessions.iosSimulator.blocker.offlineTitle', '{{machine}} is offline', {
            machine: machineName,
          })}
          detail={t(
            'sessions.iosSimulator.blocker.offlineDetail',
            'Its simulators appear here when it’s back online. Nothing on it has been stopped.'
          )}
        />
      );
    }
    if (catalog.phase === 'loading') {
      return (
        <Message
          title={t(
            'sessions.iosSimulator.catalog.loading',
            'Looking for simulators on {{machine}}…',
            {
              machine: machineName,
            }
          )}
        >
          <Spinner size="small" label={null} />
        </Message>
      );
    }
    if (catalog.phase === 'error') {
      const copy = errorCopy(catalog.error, machineName);
      return (
        <Message title={copy.title} detail={copy.detail} raw={catalog.error.message}>
          <Button
            type="button"
            variant="secondary"
            size="small"
            disabled={refreshing}
            onClick={onRefresh}
          >
            {t('sessions.iosSimulator.action.refresh', 'Refresh')}
          </Button>
          {copyDiagnosticsButton}
        </Message>
      );
    }
    if (devices.length === 0) {
      return (
        <Message
          title={t('sessions.iosSimulator.catalog.emptyTitle', 'No simulators on {{machine}}', {
            machine: machineName,
          })}
          detail={t(
            'sessions.iosSimulator.catalog.emptyDetail',
            'Add one in Xcode under Window › Devices and Simulators, then refresh.'
          )}
        >
          <Button
            type="button"
            variant="secondary"
            size="small"
            disabled={refreshing}
            onClick={onRefresh}
          >
            {t('sessions.iosSimulator.action.refresh', 'Refresh')}
          </Button>
        </Message>
      );
    }

    const showingStatusDevice = statusUdid !== null && statusUdid === selectedUdid;
    if (showingStatusDevice && status.phase === 'ready') {
      return active ? (
        <IosSimulatorViewer
          viewerUrl={status.viewerUrl}
          title={t('sessions.iosSimulator.viewerTitle', '{{device}} screen', {
            device: statusDevice?.name ?? '',
          })}
          screen={statusDevice?.screen}
        />
      ) : null;
    }
    if (showingStatusDevice && status.phase === 'preparing') {
      return (
        <DeviceSlot device={statusDevice}>
          <p {...stylex.props(styles.deviceName)}>{statusDevice?.name}</p>
          <PreparingSteps stage={status.stage} includeBoot={bootRequested} />
          <Button
            type="button"
            variant="secondary"
            size="small"
            disabled={pendingAction === 'cancel'}
            onClick={onCancel}
          >
            {t('sessions.iosSimulator.action.cancel', 'Cancel')}
          </Button>
        </DeviceSlot>
      );
    }
    if (showingStatusDevice && status.phase === 'interrupted') {
      return (
        <DeviceSlot device={statusDevice}>
          <p {...stylex.props(styles.deviceName)}>{statusDevice?.name}</p>
          <p {...stylex.props(styles.detail)}>
            {status.reason === 'expired'
              ? t('sessions.iosSimulator.interrupted.expired', 'The preview expired.')
              : t(
                  'sessions.iosSimulator.interrupted.lost',
                  'The connection to the preview was lost.'
                )}{' '}
            {t('sessions.iosSimulator.interrupted.stillRunning', 'The simulator is still running.')}
          </p>
          <div {...stylex.props(styles.actions)}>
            <Button
              type="button"
              variant="primary"
              size="small"
              disabled={busy}
              onClick={onRestore}
            >
              {t('sessions.iosSimulator.action.restore', 'Restore')}
            </Button>
            <Button type="button" variant="ghost" size="small" disabled={busy} onClick={onStop}>
              {t('sessions.iosSimulator.action.stop', 'Stop preview')}
            </Button>
          </div>
        </DeviceSlot>
      );
    }
    if (status.phase === 'failed' && (statusUdid === null || statusUdid === selectedUdid)) {
      const copy = errorCopy(status.error, machineName);
      return (
        <Message title={copy.title} detail={copy.detail} raw={status.error.message}>
          {status.error.retryable !== false ? (
            <Button type="button" variant="primary" size="small" disabled={busy} onClick={onRetry}>
              {t('sessions.iosSimulator.action.retry', 'Try again')}
            </Button>
          ) : null}
          {copyDiagnosticsButton}
        </Message>
      );
    }

    if (!selected) {
      return (
        <Message
          title={t('sessions.iosSimulator.choose.title', 'Choose a simulator')}
          detail={t(
            'sessions.iosSimulator.choose.detail',
            'Pick a device and OS version above. Simulators in use by another session can’t be previewed here.'
          )}
        />
      );
    }

    const action = getIosSimulatorDeviceAction(selected, status);
    const runtime = runtimeById.get(selected.runtimeId);
    const state = stateLabel(selected, status);
    const switching =
      statusDevice &&
      statusDevice.udid !== selected.udid &&
      (status.phase === 'ready' || status.phase === 'preparing' || status.phase === 'interrupted');
    return (
      <DeviceSlot device={selected}>
        <div {...stylex.props(styles.message)}>
          <p {...stylex.props(styles.deviceName)}>{selected.name}</p>
          <p {...stylex.props(styles.deviceMeta)}>
            {[runtime?.name, state.label].filter(Boolean).join(' · ')}
          </p>
        </div>
        {canStartIosSimulatorPreview(action) ? (
          <Button
            type="button"
            variant="primary"
            size="small"
            disabled={busy}
            onClick={() => onStart(selected)}
          >
            {action.kind === 'start-and-preview'
              ? t('sessions.iosSimulator.action.startAndPreview', 'Start and preview')
              : t('sessions.iosSimulator.action.preview', 'Preview')}
          </Button>
        ) : null}
        {action.kind === 'occupied' ? (
          <p {...stylex.props(styles.detail)}>
            {action.sessionTitle
              ? t(
                  'sessions.iosSimulator.occupied.named',
                  '“{{session}}” is using this simulator. One session controls a simulator at a time.',
                  { session: action.sessionTitle }
                )
              : t(
                  'sessions.iosSimulator.occupied.anonymous',
                  'Another session is using this simulator. One session controls a simulator at a time.'
                )}
          </p>
        ) : null}
        {action.kind === 'unavailable' ? (
          <p {...stylex.props(styles.detail)}>
            {action.reason ??
              t(
                'sessions.iosSimulator.unavailable.detail',
                'Xcode reports this simulator as unavailable, usually because its runtime is missing.'
              )}
          </p>
        ) : null}
        {action.kind === 'settling' ? (
          <p {...stylex.props(styles.detail)}>
            {t(
              'sessions.iosSimulator.settling.detail',
              'It can be started again once it has shut down.'
            )}
          </p>
        ) : null}
        {switching && canStartIosSimulatorPreview(action) ? (
          <p {...stylex.props(styles.detail)}>
            {t(
              'sessions.iosSimulator.switching.detail',
              'This ends the preview of {{device}}; it keeps running.',
              { device: statusDevice.name }
            )}
          </p>
        ) : null}
        {switching ? (
          <Button
            type="button"
            variant="ghost"
            size="small"
            onClick={() => onSelectDevice(statusDevice.udid)}
          >
            {t('sessions.iosSimulator.switching.back', 'Back to {{device}}', {
              device: statusDevice.name,
            })}
          </Button>
        ) : null}
      </DeviceSlot>
    );
  };

  const pickerDisabled = blocker !== null || catalog.phase !== 'ready' || devices.length === 0;
  return (
    <div {...stylex.props(styles.root)} data-testid="ios-simulator-panel">
      <div {...stylex.props(styles.toolbar)}>
        {leadingSlot}
        <div {...stylex.props(styles.pickerSlot)}>
          <IosSimulatorDevicePicker
            runtimes={runtimes}
            devices={devices}
            status={status}
            selectedUdid={selectedUdid}
            disabled={pickerDisabled}
            refreshing={refreshing}
            onSelect={onSelectDevice}
            onOpenChange={onPickerOpenChange}
            onRefresh={onRefresh}
          />
        </div>
        {blocker === null ? (
          <div {...stylex.props(styles.statusSlot)}>
            <IosSimulatorConnectionStatus
              status={status}
              deviceName={statusDevice?.name}
              pendingAction={pendingAction}
              onRetry={onRetry}
              onRestore={onRestore}
              onCancel={onCancel}
              onStop={onStop}
              onCopyDiagnostics={onCopyDiagnostics}
            />
          </div>
        ) : null}
      </div>
      <div {...stylex.props(styles.stage)}>{renderStage()}</div>
    </div>
  );
}
