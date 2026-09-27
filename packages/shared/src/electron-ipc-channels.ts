import type {
  LocalLoroDataPlaneClientMessage,
  LocalLoroDataPlaneServerMessage,
} from './local-loro-data-plane';
import type { TerminalDataEvent, TerminalExitEvent, TerminalTitleEvent } from './terminal-protocol';
import type {
  CliOutputEvent,
  ElectronCliState,
  ElectronLoginState,
  ElectronLocalSessionControlResponseEvent,
  ElectronPublicBrowserState,
  ElectronPublicBrowserInteraction,
  ElectronUpdaterState,
  ElectronWindowTarget,
  PreparedWindowTarget,
  GlobalShortcutTriggeredPayload,
  SessionCompletionNotificationClickPayload,
} from './electron-ipc';

export type IpcPushMap = {
  'terminal.event':
    | TerminalDataEvent
    | TerminalExitEvent
    | TerminalTitleEvent
    | { type: 'error'; code: string; message: string };
  'loro.event': LocalLoroDataPlaneServerMessage;
  'loro.status': boolean;
  'cli.output': CliOutputEvent;
  'cli.state': ElectronCliState;
  'updater.state': ElectronUpdaterState;
  'publicBrowser.state': ElectronPublicBrowserState;
  'publicBrowser.interaction': ElectronPublicBrowserInteraction;
  'sessionControl.response': ElectronLocalSessionControlResponseEvent;
  'app.deepLink': string;
  'auth.loginState': ElectronLoginState;
  'app.menuAction': string;
  'app.fullscreen': boolean;
  'app.nativeTheme': 'light' | 'dark';
  'app.globalShortcut': GlobalShortcutTriggeredPayload;
  'app.sessionCompletionClick': SessionCompletionNotificationClickPayload;
  'app.windowTarget': ElectronWindowTarget;
  'app.prepareWindowTarget': PreparedWindowTarget;
  'app.activatePreparedWindow': PreparedWindowTarget;
  /** Main asks a window with unsaved repo changes to flush now before quitting. */
  'storage.quitCheck': { requestId: string };
};

export type IpcSendMap = {
  'terminal.attach': { terminalId: string; cols: number; rows: number };
  'terminal.input': { terminalId: string; data: string };
  'terminal.resize': { terminalId: string; cols: number; rows: number };
  'terminal.close': { terminalId: string };
  'terminal.closeSession': { sessionId: string };
  'loro.send': LocalLoroDataPlaneClientMessage;
  'loro.subscribe': null;
  'cli.subscribe': null;
  'app.windowReady': null;
  'app.windowContentReady': ElectronWindowTarget;
  'app.preparedWindowState': PreparedWindowTarget & { ready: boolean };
  /**
   * This window's earliest repo change refused for lack of space, or null when all
   * saved. Sent synchronously ({@link IPC_SYNC_SEND_CHANNELS}), on every refused write.
   */
  'storage.rendererUnsaved': {
    since: number | null;
    /** Refused writes so far; a new value is news even when `since` is unchanged. */
    revision?: number;
  };
  /** Answer to `storage.quitCheck`, after the window's final flush attempt. */
  'storage.quitCheckResult': { requestId: string; since: number | null };
};

export const IPC_PUSH_CHANNELS = {
  terminalEvent: 'terminal.event',
  loroEvent: 'loro.event',
  loroStatus: 'loro.status',
  cliOutput: 'cli.output',
  cliState: 'cli.state',
  updaterState: 'updater.state',
  publicBrowserState: 'publicBrowser.state',
  publicBrowserInteraction: 'publicBrowser.interaction',
  sessionControlResponse: 'sessionControl.response',
  appDeepLink: 'app.deepLink',
  authLoginState: 'auth.loginState',
  appMenuAction: 'app.menuAction',
  appFullscreen: 'app.fullscreen',
  appNativeTheme: 'app.nativeTheme',
  appGlobalShortcut: 'app.globalShortcut',
  appSessionCompletionClick: 'app.sessionCompletionClick',
  appWindowTarget: 'app.windowTarget',
  appPrepareWindowTarget: 'app.prepareWindowTarget',
  appActivatePreparedWindow: 'app.activatePreparedWindow',
  storageQuitCheck: 'storage.quitCheck',
} as const satisfies { [K: string]: keyof IpcPushMap };

export const IPC_SEND_CHANNELS = {
  terminalAttach: 'terminal.attach',
  terminalInput: 'terminal.input',
  terminalResize: 'terminal.resize',
  terminalClose: 'terminal.close',
  terminalCloseSession: 'terminal.closeSession',
  loroSend: 'loro.send',
  loroSubscribe: 'loro.subscribe',
  cliSubscribe: 'cli.subscribe',
  appWindowReady: 'app.windowReady',
  appWindowContentReady: 'app.windowContentReady',
  appPreparedWindowState: 'app.preparedWindowState',
  storageRendererUnsaved: 'storage.rendererUnsaved',
  storageQuitCheckResult: 'storage.quitCheckResult',
} as const satisfies { [K: string]: keyof IpcSendMap };

const PUSH_CHANNEL_VALUES: readonly string[] = Object.values(IPC_PUSH_CHANNELS);
const SEND_CHANNEL_VALUES: readonly string[] = Object.values(IPC_SEND_CHANNELS);

export function isIpcPushChannel(channel: string): channel is keyof IpcPushMap {
  return PUSH_CHANNEL_VALUES.includes(channel);
}

export function isIpcSendChannel(channel: string): channel is keyof IpcSendMap {
  return SEND_CHANNEL_VALUES.includes(channel);
}

/**
 * Sends main must have handled before the renderer runs anything else. A window's
 * storage report voids an unload approval main holds for it; sent asynchronously,
 * it could still be in flight when that window's next `beforeunload` is overridden
 * on the strength of the old approval (a separate message, with no ordering between
 * the two). Main answers every one of them.
 */
export const IPC_SYNC_SEND_CHANNELS = [IPC_SEND_CHANNELS.storageRendererUnsaved] as const;

export function isIpcSyncSendChannel(
  channel: string
): channel is (typeof IPC_SYNC_SEND_CHANNELS)[number] {
  return (IPC_SYNC_SEND_CHANNELS as readonly string[]).includes(channel);
}
