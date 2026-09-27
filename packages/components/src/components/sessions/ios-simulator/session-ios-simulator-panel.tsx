import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useAtomValue } from 'jotai';
import { useTranslation } from 'react-i18next';
import type { SessionMeta } from '@lody/shared';
import { activeWorkspaceRuntimeAtom } from '@/atoms';
import { localMachineIdAtom } from '@/atoms/local-probe';
import { getMachineMetaByIdAtomFamily } from '@/atoms/machines';
import { machineOnlineStatusAtomFamily } from '@/atoms/presence';
import { writeTextToClipboard } from '@/lib/clipboard';
import { toast } from '@/lib/toast';
import {
  buildIosSimulatorDiagnostics,
  getIosSimulatorPanelAvailability,
  getIosSimulatorStatusPollMs,
  getIosSimulatorStatusUdid,
  readIosSimulatorSelectedDevice,
  resolveIosSimulatorSelection,
  writeIosSimulatorSelectedDevice,
  type IosSimulatorPreferenceScope,
} from '@/lib/ios-simulator/ios-simulator-model';
import type {
  IosSimulatorClient,
  IosSimulatorDevice,
  IosSimulatorPreviewStatus,
  IosSimulatorTarget,
} from '@/lib/ios-simulator/ios-simulator-types';
import type { IosSimulatorPendingAction } from './ios-simulator-connection-status';
import {
  IosSimulatorPanelView,
  type IosSimulatorCatalogState,
  type IosSimulatorPanelBlocker,
} from './ios-simulator-panel-view';

type SessionIosSimulatorPanelProps = {
  session: Pick<SessionMeta, 'id' | 'machineId'>;
  /** On screen: the only state in which it polls or mounts the viewer. */
  active?: boolean;
  leadingSlot?: ReactNode;
  /** Defaults to the active workspace runtime's client. */
  client?: IosSimulatorClient | null;
};

const IDLE: IosSimulatorPreviewStatus = { phase: 'idle' };

const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/**
 * The iOS Simulator side panel for one Session. Its state is its own — never
 * the Browser's — and it is keyed by Session and machine so nothing carries
 * across an in-place switch. Unmounting never stops a preview: panel mount is
 * not preview ownership.
 */
export function SessionIosSimulatorPanel(props: SessionIosSimulatorPanelProps) {
  return (
    <SessionIosSimulatorPanelController
      key={`${props.session.id}:${props.session.machineId}`}
      {...props}
    />
  );
}

function SessionIosSimulatorPanelController({
  session,
  active = true,
  leadingSlot,
  client: clientOverride,
}: SessionIosSimulatorPanelProps) {
  const { t } = useTranslation();
  const runtime = useAtomValue(activeWorkspaceRuntimeAtom);
  const client = clientOverride === undefined ? (runtime?.iosSimulator ?? null) : clientOverride;
  const machine = useAtomValue(getMachineMetaByIdAtomFamily(session.machineId));
  const machineOnline = useAtomValue(machineOnlineStatusAtomFamily(session.machineId));
  const localMachineId = useAtomValue(localMachineIdAtom);
  const isLocalMachine = localMachineId === session.machineId;
  const availability = getIosSimulatorPanelAvailability(machine);
  // Same-machine Electron talks to the local daemon directly, so cloud presence
  // going offline does not cut it off.
  const blocker: IosSimulatorPanelBlocker | null =
    availability === 'upgrade-required'
      ? 'upgrade-required'
      : !client
        ? 'client-unavailable'
        : machineOnline === 'offline' && !isLocalMachine
          ? 'offline'
          : null;

  const target = useMemo<IosSimulatorTarget>(
    () => ({ machineId: session.machineId, sessionId: session.id }),
    [session.id, session.machineId]
  );
  const preferenceScope = useMemo<IosSimulatorPreferenceScope | null>(
    () =>
      runtime
        ? { workspaceId: runtime.workspaceId, machineId: session.machineId, sessionId: session.id }
        : null,
    [runtime, session.id, session.machineId]
  );

  const [catalog, setCatalog] = useState<IosSimulatorCatalogState>({ phase: 'loading' });
  const [refreshing, setRefreshing] = useState(false);
  const [status, setStatus] = useState<IosSimulatorPreviewStatus>(IDLE);
  const [pendingAction, setPendingAction] = useState<IosSimulatorPendingAction>(null);
  const [bootRequested, setBootRequested] = useState(false);
  const [chosenUdid, setChosenUdid] = useState<string | null>(null);
  const [preferredUdid] = useState(() => readIosSimulatorSelectedDevice(preferenceScope));

  // Every status read takes a ticket; an answer to an older ticket is stale.
  // Actions bump it too, so a poll that raced an action loses to it.
  const statusEpoch = useRef(0);
  const actionEpoch = useRef(0);
  const catalogEpoch = useRef(0);
  const clientRef = useRef(client);
  clientRef.current = client;

  const refreshCatalog = useCallback(async () => {
    const current = clientRef.current;
    if (!current) return;
    const epoch = ++catalogEpoch.current;
    setRefreshing(true);
    try {
      const result = await current.list(target);
      if (epoch !== catalogEpoch.current) return;
      setCatalog(
        result.ok
          ? { phase: 'ready', runtimes: result.runtimes, devices: result.devices }
          : { phase: 'error', error: result.error }
      );
    } catch (error) {
      if (epoch !== catalogEpoch.current) return;
      setCatalog({
        phase: 'error',
        error: { code: 'internal', message: errorMessage(error), retryable: true },
      });
    } finally {
      if (epoch === catalogEpoch.current) setRefreshing(false);
    }
  }, [target]);

  const refreshStatus = useCallback(async () => {
    const current = clientRef.current;
    if (!current) return;
    const epoch = ++statusEpoch.current;
    try {
      const next = await current.status(target);
      if (epoch === statusEpoch.current) setStatus(next);
    } catch {
      // A failed status read keeps what is on screen; only an authoritative
      // answer changes the preview's phase.
    }
  }, [target]);

  const live = active && blocker === null;
  const loadedRef = useRef(false);
  useEffect(() => {
    if (!live) return;
    if (!loadedRef.current) {
      loadedRef.current = true;
      void refreshCatalog();
    }
    void refreshStatus();
  }, [live, refreshCatalog, refreshStatus]);

  const pollMs = live && pendingAction === null ? getIosSimulatorStatusPollMs(status) : null;
  useEffect(() => {
    if (pollMs === null) return undefined;
    const timer = setTimeout(() => void refreshStatus(), pollMs);
    return () => clearTimeout(timer);
  }, [pollMs, refreshStatus, status]);

  // A preview that settles changes what the list says (booted, held by us).
  const previousPhase = useRef(status.phase);
  useEffect(() => {
    const was = previousPhase.current;
    previousPhase.current = status.phase;
    if (was === 'preparing' && status.phase !== 'preparing' && live) void refreshCatalog();
  }, [live, refreshCatalog, status.phase]);

  const devices = useMemo(() => (catalog.phase === 'ready' ? catalog.devices : []), [catalog]);
  const selectedUdid = resolveIosSimulatorSelection(devices, {
    chosenUdid,
    preferredUdid,
    status,
  });

  const handleSelectDevice = useCallback(
    (udid: string) => {
      setChosenUdid(udid);
      writeIosSimulatorSelectedDevice(preferenceScope, udid);
    },
    [preferenceScope]
  );

  const runAction = useCallback(
    async (
      kind: Exclude<IosSimulatorPendingAction, null>,
      udid: string | undefined,
      call: (current: IosSimulatorClient) => Promise<IosSimulatorPreviewStatus>
    ) => {
      const current = clientRef.current;
      if (!current) return;
      // Only a newer action supersedes this one. A poll never does: it would
      // drop the answer and leave the action pending forever.
      const actionId = ++actionEpoch.current;
      statusEpoch.current += 1;
      setPendingAction(kind);
      const settle = (next: IosSimulatorPreviewStatus) => {
        if (actionId !== actionEpoch.current) return;
        // Polls issued before this answer are older than it.
        statusEpoch.current += 1;
        setStatus(next);
      };
      try {
        settle(await call(current));
      } catch (error) {
        settle({
          phase: 'failed',
          udid,
          error: { code: 'internal', message: errorMessage(error), retryable: true },
        });
      } finally {
        if (actionId === actionEpoch.current) setPendingAction(null);
        void refreshCatalog();
      }
    },
    [refreshCatalog]
  );

  const startPreview = useCallback(
    (device: IosSimulatorDevice) => {
      const boot = device.state !== 'booted' && device.state !== 'booting';
      setBootRequested(boot);
      handleSelectDevice(device.udid);
      setStatus({
        phase: 'preparing',
        udid: device.udid,
        stage: boot ? 'booting-device' : 'starting-stream',
      });
      void runAction('start', device.udid, (current) =>
        current.startPreview(target, { udid: device.udid, boot })
      );
    },
    [handleSelectDevice, runAction, target]
  );

  const statusUdid = getIosSimulatorStatusUdid(status) ?? undefined;
  const handleCancel = useCallback(() => {
    void runAction('cancel', statusUdid, (current) => current.cancelStart(target));
  }, [runAction, statusUdid, target]);
  const handleStop = useCallback(() => {
    void runAction('stop', statusUdid, (current) => current.stopPreview(target));
  }, [runAction, statusUdid, target]);
  const handleRestore = useCallback(() => {
    if (!statusUdid) return;
    setBootRequested(false);
    void runAction('start', statusUdid, (current) =>
      current.startPreview(target, { udid: statusUdid, boot: false })
    );
  }, [runAction, statusUdid, target]);
  const handleRetry = useCallback(() => {
    const device = statusUdid ? devices.find((candidate) => candidate.udid === statusUdid) : null;
    if (device) {
      startPreview(device);
      return;
    }
    void refreshCatalog();
    void refreshStatus();
  }, [devices, refreshCatalog, refreshStatus, startPreview, statusUdid]);

  const handlePickerOpenChange = useCallback(
    (open: boolean) => {
      if (open && live) void refreshCatalog();
    },
    [live, refreshCatalog]
  );

  const handleCopyDiagnostics = useCallback(async () => {
    const device =
      devices.find((candidate) => candidate.udid === (statusUdid ?? selectedUdid)) ?? null;
    const runtimeEntry =
      device && catalog.phase === 'ready'
        ? (catalog.runtimes.find((candidate) => candidate.id === device.runtimeId) ?? null)
        : null;
    const text = buildIosSimulatorDiagnostics({
      now: new Date(),
      machine: {
        os: machine?.os,
        cliVersion: machine?.cliVersion,
        online: machineOnline,
        local: isLocalMachine,
      },
      availability,
      status,
      device,
      runtime: runtimeEntry,
      catalog:
        catalog.phase === 'ready'
          ? { phase: 'ready', deviceCount: catalog.devices.length }
          : catalog.phase === 'error'
            ? {
                phase: 'error',
                errorCode: catalog.error.code,
                errorMessage: catalog.error.message,
              }
            : { phase: blocker ?? 'loading' },
    });
    if (await writeTextToClipboard(text)) {
      toast.success(t('sessions.iosSimulator.diagnosticsCopied', 'Diagnostics copied'));
    } else {
      toast.error(t('sessions.iosSimulator.diagnosticsCopyFailed', 'Couldn’t copy diagnostics'));
    }
  }, [
    availability,
    blocker,
    catalog,
    devices,
    isLocalMachine,
    machine?.cliVersion,
    machine?.os,
    machineOnline,
    selectedUdid,
    status,
    statusUdid,
    t,
  ]);

  return (
    <IosSimulatorPanelView
      machineName={machine?.name ?? t('sessions.iosSimulator.thisMac', 'this Mac')}
      blocker={blocker}
      catalog={catalog}
      refreshing={refreshing}
      selectedUdid={selectedUdid}
      status={status}
      pendingAction={pendingAction}
      bootRequested={bootRequested}
      active={active}
      leadingSlot={leadingSlot}
      onSelectDevice={handleSelectDevice}
      onPickerOpenChange={handlePickerOpenChange}
      onRefresh={() => void refreshCatalog()}
      onStart={startPreview}
      onCancel={handleCancel}
      onStop={handleStop}
      onRestore={handleRestore}
      onRetry={handleRetry}
      onCopyDiagnostics={() => void handleCopyDiagnostics()}
    />
  );
}
