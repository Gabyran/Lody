import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useAtomValue } from 'jotai';
import { useTranslation } from 'react-i18next';
import type { IosSimulatorCommand, IosSimulatorResponse, SessionMeta } from '@lody/shared';
import { activeWorkspaceRuntimeAtom, userAtom } from '@/atoms';
import { localMachineIdAtom } from '@/atoms/local-probe';
import { getMachineMetaByIdAtomFamily } from '@/atoms/machines';
import { machineOnlineStatusAtomFamily } from '@/atoms/presence';
import { writeTextToClipboard } from '@/lib/clipboard';
import { toast } from '@/lib/toast';
import {
  IOS_SIMULATOR_PREPARING_MAX_POLLS,
  IOS_SIMULATOR_PREPARING_POLL_MS,
  buildIosSimulatorDiagnostics,
  getIosSimulatorOperationId,
  getIosSimulatorPanelAvailability,
  getIosSimulatorStatusUdid,
  readIosSimulatorSelectedDevice,
  resolveIosSimulatorSelection,
  toIosSimulatorCatalog,
  toIosSimulatorPanelStatus,
  writeIosSimulatorSelectedDevice,
  type IosSimulatorPreferenceScope,
} from '@/lib/ios-simulator/ios-simulator-model';
import type {
  IosSimulatorDeviceEntry,
  IosSimulatorPanelStatus,
  IosSimulatorViewerState,
} from '@/lib/ios-simulator/ios-simulator-types';
import type { IosSimulatorPendingAction } from './ios-simulator-connection-status';
import {
  IosSimulatorPanelView,
  type IosSimulatorCatalogState,
  type IosSimulatorPanelBlocker,
} from './ios-simulator-panel-view';

type SessionIosSimulatorPanelProps = {
  session: Pick<SessionMeta, 'id' | 'machineId'>;
  /** On screen: the only state in which it polls; the viewer is told otherwise. */
  active?: boolean;
  leadingSlot?: ReactNode;
};

const IDLE: IosSimulatorPanelStatus = { phase: 'idle' };

const appOrigin = (): string => (typeof window === 'undefined' ? '' : window.location.origin);

/**
 * The iOS Simulator side panel for one Session. Its state is its own — never
 * the Browser's — and it is keyed by Session and machine so nothing carries
 * across an in-place switch. Unmounting never stops a preview: panel mount is
 * not preview ownership.
 */
export function SessionIosSimulatorPanel(props: SessionIosSimulatorPanelProps) {
  const user = useAtomValue(userAtom);
  const runtime = useAtomValue(activeWorkspaceRuntimeAtom);
  return (
    <SessionIosSimulatorPanelController
      key={`${user?.id}:${runtime?.workspaceId}:${props.session.id}:${props.session.machineId}`}
      {...props}
    />
  );
}

function SessionIosSimulatorPanelController({
  session,
  active = true,
  leadingSlot,
}: SessionIosSimulatorPanelProps) {
  const { t } = useTranslation();
  const runtime = useAtomValue(activeWorkspaceRuntimeAtom);
  const user = useAtomValue(userAtom);
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
      : machineOnline === 'offline' && !isLocalMachine
        ? 'offline'
        : null;

  const preferenceScope = useMemo<IosSimulatorPreferenceScope | null>(
    () =>
      runtime
        ? {
            accountId: user?.id,
            workspaceId: runtime.workspaceId,
            machineId: session.machineId,
            sessionId: session.id,
          }
        : null,
    [runtime, session.id, session.machineId, user?.id]
  );

  const [catalog, setCatalog] = useState<IosSimulatorCatalogState>({ phase: 'loading' });
  const [refreshing, setRefreshing] = useState(false);
  const [status, setStatus] = useState<IosSimulatorPanelStatus>(IDLE);
  const statusRef = useRef(status);
  statusRef.current = status;
  const [viewerState, setViewerState] = useState<IosSimulatorViewerState | null>(null);
  const [viewerReloadKey, setViewerReloadKey] = useState(0);
  const [pendingAction, setPendingAction] = useState<IosSimulatorPendingAction>(null);
  const [bootExpected, setBootExpected] = useState(false);
  const [chosenUdid, setChosenUdid] = useState<string | null>(null);
  const [preferredUdid] = useState(() => readIosSimulatorSelectedDevice(preferenceScope));

  // Every status read takes a ticket; an answer to an older ticket is stale.
  // Actions bump it too, so a poll that raced an action loses to it.
  const statusEpoch = useRef(0);
  const actionEpoch = useRef(0);
  const catalogEpoch = useRef(0);

  const requesterUserId = user?.id ?? null;
  const request = useCallback(
    async (command: IosSimulatorCommand): Promise<IosSimulatorResponse | null> => {
      if (!runtime || !requesterUserId) return null;
      return runtime.requestIosSimulatorControl({
        machineId: session.machineId,
        sessionId: session.id,
        requestedByUserId: requesterUserId,
        command,
      });
    },
    [requesterUserId, runtime, session.id, session.machineId]
  );

  const refreshCatalog = useCallback(async () => {
    const epoch = ++catalogEpoch.current;
    setRefreshing(true);
    try {
      const response = await request({ action: 'list' });
      if (!response || epoch !== catalogEpoch.current) return;
      setCatalog(
        response.success
          ? { phase: 'ready', ...toIosSimulatorCatalog(response.devices ?? []) }
          : {
              phase: 'error',
              error: { code: response.error ?? 'failed', message: response.message },
            }
      );
    } finally {
      if (epoch === catalogEpoch.current) setRefreshing(false);
    }
  }, [request]);

  const refreshStatus = useCallback(async () => {
    const epoch = ++statusEpoch.current;
    const current = statusRef.current;
    const operationId = getIosSimulatorOperationId(current) ?? undefined;
    const response = await request({ action: 'status', operationId });
    if (!response || epoch !== statusEpoch.current) return;
    // A status read that did not reach the machine keeps what is on screen;
    // only an authoritative answer changes the preview's phase.
    if (!response.success && response.error === 'failed') return;
    setStatus(
      toIosSimulatorPanelStatus(response, {
        udid: getIosSimulatorStatusUdid(current) ?? undefined,
        appOrigin: appOrigin(),
      })
    );
  }, [request]);

  const connected = Boolean(runtime && requesterUserId);
  const live = active && blocker === null && connected;
  const loadedRef = useRef(false);
  useEffect(() => {
    if (!live) return;
    if (!loadedRef.current) {
      loadedRef.current = true;
      void refreshCatalog();
    }
    void refreshStatus();
  }, [live, refreshCatalog, refreshStatus]);

  // Preparing is polled, and only so long. Polls count per operation.
  const operationId = getIosSimulatorOperationId(status);
  // Re-arms the poll even when an answer leaves the status unchanged.
  const [pollTick, setPollTick] = useState(0);
  const pollCount = useRef<{ operationId: string | null; count: number }>({
    operationId: null,
    count: 0,
  });
  const polling =
    live && pendingAction === null && status.phase === 'preparing' && operationId !== null;
  useEffect(() => {
    if (!polling || !operationId) return undefined;
    if (pollCount.current.operationId !== operationId) {
      pollCount.current = { operationId, count: 0 };
    }
    if (pollCount.current.count >= IOS_SIMULATOR_PREPARING_MAX_POLLS) {
      statusEpoch.current += 1;
      setStatus((current) =>
        current.phase === 'preparing' && current.operationId === operationId
          ? { phase: 'failed', udid: current.udid, operationId, error: { code: 'timeout' } }
          : current
      );
      return undefined;
    }
    const timer = setTimeout(() => {
      pollCount.current.count += 1;
      void refreshStatus().finally(() => setPollTick((tick) => tick + 1));
    }, IOS_SIMULATOR_PREPARING_POLL_MS);
    return () => clearTimeout(timer);
  }, [operationId, pollTick, polling, refreshStatus]);

  // A new operation has a new viewer, which has not said anything yet.
  useEffect(() => setViewerState(null), [operationId]);

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
      command: IosSimulatorCommand
    ) => {
      // Only a newer action supersedes this one. A poll never does: it would
      // drop the answer and leave the action pending forever.
      const actionId = ++actionEpoch.current;
      statusEpoch.current += 1;
      setPendingAction(kind);
      try {
        const response = await request(command);
        if (!response || actionId !== actionEpoch.current) return;
        // Polls issued before this answer are older than it.
        statusEpoch.current += 1;
        setStatus(
          command.action === 'stop' && response.success
            ? IDLE
            : toIosSimulatorPanelStatus(response, { udid, appOrigin: appOrigin() })
        );
      } finally {
        if (actionId === actionEpoch.current) setPendingAction(null);
        void refreshCatalog();
      }
    },
    [refreshCatalog, request]
  );

  const startPreview = useCallback(
    (device: IosSimulatorDeviceEntry) => {
      setBootExpected(device.state !== 'booted' && device.state !== 'booting');
      handleSelectDevice(device.udid);
      setStatus({ phase: 'preparing', udid: device.udid, stage: 'preparing' });
      void runAction('start', device.udid, { action: 'start', udid: device.udid });
    },
    [handleSelectDevice, runAction]
  );

  const statusUdid = getIosSimulatorStatusUdid(status) ?? undefined;
  const stopOperation = useCallback(
    (kind: 'cancel' | 'stop') => {
      if (!operationId) return;
      void runAction(kind, statusUdid, { action: 'stop', operationId });
    },
    [operationId, runAction, statusUdid]
  );

  const startAgain = useCallback(
    (udid: string) => {
      const device = devices.find((candidate) => candidate.udid === udid);
      if (device) {
        startPreview(device);
        return;
      }
      setBootExpected(false);
      void runAction('start', udid, { action: 'start', udid });
    },
    [devices, runAction, startPreview]
  );

  const handleRestore = useCallback(() => {
    if (status.phase === 'ready') {
      // The stream dropped but the preview may still stand: reload the viewer
      // page and ask the machine where things are.
      setViewerState(null);
      setViewerReloadKey((key) => key + 1);
      void refreshStatus();
      return;
    }
    if (statusUdid) startAgain(statusUdid);
  }, [refreshStatus, startAgain, status.phase, statusUdid]);

  const handleRetry = useCallback(() => {
    if (statusUdid) {
      startAgain(statusUdid);
      return;
    }
    void refreshCatalog();
    void refreshStatus();
  }, [refreshCatalog, refreshStatus, startAgain, statusUdid]);

  const handleViewerStateChange = useCallback(
    (next: IosSimulatorViewerState) => {
      setViewerState(next);
      // A dropped stream may mean the preview itself ended; ask once.
      if (next === 'disconnected' || next === 'error') void refreshStatus();
    },
    [refreshStatus]
  );

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
        ? (catalog.runtimes.find((candidate) => candidate.key === device.runtimeKey) ?? null)
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
      viewerState,
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
    viewerState,
  ]);

  return (
    <IosSimulatorPanelView
      machineName={machine?.name ?? t('sessions.iosSimulator.thisMac', 'this Mac')}
      blocker={blocker}
      catalog={catalog}
      refreshing={refreshing}
      selectedUdid={selectedUdid}
      status={status}
      viewerState={viewerState}
      viewerReloadKey={viewerReloadKey}
      pendingAction={pendingAction}
      bootExpected={bootExpected}
      active={active}
      leadingSlot={leadingSlot}
      onSelectDevice={handleSelectDevice}
      onPickerOpenChange={handlePickerOpenChange}
      onRefresh={() => void refreshCatalog()}
      onStart={startPreview}
      onCancel={() => stopOperation('cancel')}
      onStop={() => stopOperation('stop')}
      onRestore={handleRestore}
      onRetry={handleRetry}
      onCopyDiagnostics={() => void handleCopyDiagnostics()}
      onViewerStateChange={handleViewerStateChange}
    />
  );
}
