import { handleWindowContentReady } from './window-target'
import { installLocalFileResourceProtocol } from './services/local-file-resource-protocol'
import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  powerMonitor,
  safeStorage,
  webContents
} from 'electron'
import { electronApp, optimizer } from '@electron-toolkit/utils'
import dns from 'node:dns'
import { writeHeapSnapshot } from 'node:v8'
import icon from '../../resources/icon.png?asset'
import macIcon from '../../build/icon-mac.padded.png?asset'
import aquaIcon from '../../resources/app-icons/aqua.png?asset'
import { createElectronAppIconService } from './services/app-icon-service'
import { handleDeepLink, initializeAuthDeepLinks } from './deep-link'
import type { DesktopLaunchEvent } from './services/desktop-launch-buffer'
import { registerLodyProtocolClient } from './protocol-client'
import { registerIpcServices } from './ipc/register-services'
import {
  openMainWindow,
  openOrFocusMainWindow,
  reloadMainWindowForDevbar,
  setMainWindowProductReloadTarget
} from './window'
import {
  getMainWindow,
  liveProductWindowIds,
  productWindows,
  setAppQuitting,
  setWindowsTrayAvailable
} from './window-state'
import { CliService } from './services/cli-service'
import type { DesktopExecutionHost } from './services/desktop-execution-host'
import { createDesktopQuitBarrier } from './services/desktop-shutdown'
import {
  RendererStorageState,
  WindowStorageBarrier,
  createQuitCoordinator,
  createSessionEndGuard,
  resolveUnsavedBeforeQuit,
  type RendererStorageQuitCheckOptions,
  type WindowTeardownKind
} from '@lody/shared/renderer-storage-barrier'
import { setRendererReloadIntentHook } from './renderer-recovery'
import { applyPendingDesktopLocalReset } from './services/local-reset-service'
import { TerminalRelay } from './services/terminal-relay'
import { LoroDataPlaneRelay } from './services/loro-data-plane-relay'
import { NotificationService } from './services/notification-service'
import { AuthService } from './services/auth-service'
import { authClient } from './auth'
import { AppUpdaterService } from './services/app-updater-service'
import { shouldConstructUpdaterEnabled } from './services/app-updater-sparkle-policy'
import { startDevbarDevframeService, stopDevbarDevframeService } from './services/devbar/service'
import { GlobalShortcutsService } from './services/global-shortcuts-service'
import { WindowsTrayService } from './services/windows-tray-service'
import {
  WindowBadgeService,
  bindWindowBadgeToBrowserWindows
} from './services/window-badge-service'
import { setupApplicationMenu, translateMenu } from './menu'
import { isRendererReloadShortcut } from './reload-shortcut'
import {
  flushElectronMainErrorReporting,
  installElectronMainErrorReporting
} from './posthog-error-reporting'
import {
  IPC_PUSH_CHANNELS,
  IPC_SEND_CHANNELS,
  LOCAL_STORAGE_UNSAVED_ISSUE_CODE
} from '@lody/shared/electron-ipc'
import { PublicBrowserService } from './services/public-browser-service'
import { desktopInstallationProfile, isLocalPlatform } from './platform'
import { mainPlatformKind } from './platform'
import { getLocalLoroDataPlaneSocketPath } from '@lody/shared/node/local-ipc'
import { getLocalTerminalSocketPath } from '@lody/shared/node/local-terminal'
import { getInitialDesktopPath, markOnboardingCompleted } from './onboarding-state'
import { handlePreparedWindowState, handleWindowWarmReady } from './window-warm-service'
import { extractDeepLinkFromArgv } from './deep-link-url'
import { shouldHideMainWindowOnAutoLaunch } from './auto-launch-policy'
import {
  getAutoLaunchInvocationStatus,
  getHideWindowOnAutoLaunchEnabled
} from './auto-launch-settings'

const LODY_PROTOCOL = desktopInstallationProfile.desktopProtocol
const PRODUCT_NAME = desktopInstallationProfile.desktopProductName
const DESKTOP_FILE_NAME = `${desktopInstallationProfile.desktopAppId}.desktop`
const DEEP_LINK_DEBUG_PREFIX = '[electron-auth-debug]'
const IS_E2E = !app.isPackaged && process.env.LODY_E2E === '1'
/** How long quit waits for a window to answer its final storage flush. */
const RENDERER_STORAGE_QUIT_CHECK_TIMEOUT_MS = 3_000
declare const __LODY_DESKTOP_BUILD_JSON__: string | null

type E2EBootDiagnostic = { stage: string; error?: string }
type E2EGlobal = typeof globalThis & {
  __LODY_E2E_BOOT_DIAGNOSTIC__?: E2EBootDiagnostic
  __LODY_E2E_WRITE_HEAP_SNAPSHOT__?: (path: string) => string
}

export function startApplication(executionHost?: DesktopExecutionHost): void {
  if (typeof __LODY_DESKTOP_BUILD_JSON__ === 'string') {
    console.info('[desktop-build]', __LODY_DESKTOP_BUILD_JSON__)
  }
  if (IS_E2E) {
    ;(globalThis as E2EGlobal).__LODY_E2E_WRITE_HEAP_SNAPSHOT__ = (path) => writeHeapSnapshot(path)
  }

  function recordE2EBootDiagnostic(stage: string, error?: unknown): void {
    if (!IS_E2E) return
    const diagnostic: E2EBootDiagnostic = { stage }
    if (error !== undefined) {
      diagnostic.error = error instanceof Error ? (error.stack ?? error.message) : String(error)
    }
    const e2eGlobal = globalThis as E2EGlobal
    e2eGlobal.__LODY_E2E_BOOT_DIAGNOSTIC__ = diagnostic
  }

  function logDeepLinkDebug(message: string, meta?: Record<string, unknown>): void {
    if (meta) {
      console.info(DEEP_LINK_DEBUG_PREFIX, message, meta)
      return
    }
    console.info(DEEP_LINK_DEBUG_PREFIX, message)
  }

  if (!isLocalPlatform()) {
    installElectronMainErrorReporting()
  }

  try {
    dns.setDefaultResultOrder('ipv4first')
  } catch (error) {
    console.warn('[Auth] Failed to set DNS result order to ipv4first', error)
  }

  if (!isLocalPlatform()) {
    authClient.setupMain({
      csp: false,
      bridges: true,
      scheme: false,
      // Pin the target to the main window so Better Auth events always reach the
      // visible renderer that owns login state and CLI restart.
      getWindow: () => getMainWindow()
    })
    logDeepLinkDebug('authClient.setupMain initialized', {
      csp: false,
      bridges: true,
      scheme: false
    })
  }

  function createGlobalShortcutsService(iconPath: string): GlobalShortcutsService {
    return new GlobalShortcutsService(
      [
        {
          id: 'app.focus',
          handler: () => {
            openOrFocusMainWindow({ icon: iconPath })
          }
        }
      ],
      {
        onTriggered: (payload) => {
          const target =
            getMainWindow() ?? BrowserWindow.getAllWindows().find((window) => !window.isDestroyed())
          target?.webContents.send(IPC_PUSH_CHANNELS.appGlobalShortcut, payload)
        }
      }
    )
  }

  registerLodyProtocolClient({
    protocol: LODY_PROTOCOL,
    productName: PRODUCT_NAME,
    desktopFileName: DESKTOP_FILE_NAME,
    iconPath: icon,
    log: logDeepLinkDebug
  })

  recordE2EBootDiagnostic('waiting-for-app-ready')
  const appReady = app.whenReady().then(async () => {
    installLocalFileResourceProtocol()
    // Before any window can reopen the local stores: a reset armed with
    // `lody app reset-cache` is the way back for a user whose renderer is wedged,
    // so it has to run while nothing holds that storage open.
    await applyPendingDesktopLocalReset()
    await startDevbarDevframeService()
    recordE2EBootDiagnostic('initializing-services')
    if (process.platform === 'darwin' && !app.isPackaged) app.dock?.setIcon(macIcon)
    const appIconService = createElectronAppIconService(macIcon, aquaIcon)
    if (process.platform === 'darwin' && app.isPackaged) {
      void Promise.resolve()
        .then(() => appIconService.getState())
        .catch((error: unknown) => {
          console.warn('[Electron] Failed to restore app icon', error)
        })
    }

    logDeepLinkDebug('app.whenReady resolved', {
      isDefaultProtocolClient: app.isDefaultProtocolClient(LODY_PROTOCOL),
      protocol: LODY_PROTOCOL
    })
    const authService = new AuthService(
      (state) => {
        // Only redacted lifecycle data goes to diagnostics, never the session.
        console.info('[Auth] login transition', {
          attemptId: state.attemptId,
          phase: state.phase,
          error: state.error
        })
        for (const window of productWindows) {
          if (!window.isDestroyed() && !window.webContents.isDestroyed()) {
            try {
              window.webContents.send('auth.loginState', state)
            } catch {
              // A closing renderer cannot roll back the authoritative result.
              console.warn('[Auth] Login state delivery failed; snapshot remains available')
            }
          }
        }
      },
      () => {
        void cliService.restartAutoStart().catch(() => console.warn('[Auth] CLI restart failed'))
      }
    )
    const cliService = new CliService({
      executionHost,
      resolveBootstrapSession: async () => {
        return await authService.getBootstrapSession()
      }
    })
    if (!isLocalPlatform()) {
      initializeAuthDeepLinks(async (token) => {
        await authService.login.complete(token)
      })
    }
    const terminalRelay = new TerminalRelay(getLocalTerminalSocketPath(mainPlatformKind))
    const rendererStorageState = new RendererStorageState()
    const rendererQuitCheck: RendererStorageQuitCheckOptions = {
      timeoutMs: RENDERER_STORAGE_QUIT_CHECK_TIMEOUT_MS,
      send: (windowId, requestId) => {
        const target = webContents.fromId(windowId)
        if (!target || target.isDestroyed()) return false
        try {
          target.send(IPC_PUSH_CHANNELS.storageQuitCheck, { requestId })
        } catch {
          // Torn down since the check above: it keeps its last report.
          return false
        }
        return true
      }
    }
    // One confirmation for every action that would drop changes held only in memory.
    const confirmStorageLoss = async (
      unsavedSince: number,
      kind: 'quit' | WindowTeardownKind
    ): Promise<boolean> => {
      const proceed = {
        quit: () => translateMenu('desktop.quitUnsaved.quit', 'Quit Anyway'),
        close: () => translateMenu('desktop.quitUnsaved.close', 'Close Anyway'),
        reload: () => translateMenu('desktop.quitUnsaved.reload', 'Reload Anyway'),
        'sign-out': () => translateMenu('desktop.quitUnsaved.signOut', 'Sign Out Anyway'),
        'clear-cache': () => translateMenu('desktop.quitUnsaved.clearCache', 'Clear Anyway')
      }[kind]()
      const { response } = await dialog.showMessageBox({
        type: 'warning',
        buttons: [proceed, translateMenu('desktop.quitUnsaved.cancel', 'Cancel')],
        defaultId: 1,
        cancelId: 1,
        message: translateMenu('desktop.quitUnsaved.title', 'Some changes are not saved'),
        detail: translateMenu(
          kind === 'quit' ? 'desktop.quitUnsaved.detail' : 'desktop.quitUnsaved.windowDetail',
          kind === 'quit'
            ? 'Storage is full, so changes since {{time}} exist only in memory. Quitting now loses them. Free some disk space and wait for the warning to clear before quitting.'
            : 'Storage is full, so changes in this window since {{time}} exist only in memory. Continuing loses them. Free some disk space and wait for the warning to clear first.'
        ).replace('{{time}}', new Date(unsavedSince).toLocaleString())
      })
      return response === 0
    }
    // The one place a quit is approved, whoever starts it (menu, last window,
    // updater): the agent and every window with unsaved storage get a final flush
    // and the user confirms what is still unsaved. Approval lets windows unload
    // freely; a cancelled or failed quit clears it, and the global quitting flag,
    // so window close/reload is guarded again.
    const cliUnsavedSince = (): number | null =>
      cliService
        .getCliState()
        .runtime?.issues.find((issue) => issue.code === LOCAL_STORAGE_UNSAVED_ISSUE_CODE)
        ?.firstSeenAtMs ?? null
    // What main already knows is unsaved, without asking any process.
    const knownUnsavedSince = (): number | null => {
      const cli = cliUnsavedSince()
      const renderer = rendererStorageState.earliestUnsaved()
      if (cli === null) return renderer
      return renderer === null ? cli : Math.min(cli, renderer)
    }
    const quitCoordinator = createQuitCoordinator({
      knownUnsavedSince,
      unsavedSince: async () =>
        await resolveUnsavedBeforeQuit({
          cliUnsavedSince: cliUnsavedSince(),
          renderer: rendererStorageState,
          quitCheck: rendererQuitCheck
        }),
      confirmDiscard: (since) => confirmStorageLoss(since, 'quit'),
      setAppQuitting,
      renderer: rendererStorageState,
      windowIds: liveProductWindowIds,
      approveWindows: (windowIds) => windowStorageBarrier.approveTeardown(windowIds, 'quit')
    })
    const approveQuit = quitCoordinator.approve
    const abortQuit = quitCoordinator.abort
    const windowStorageBarrier = new WindowStorageBarrier({
      state: rendererStorageState,
      quitCheck: rendererQuitCheck,
      quitApproved: quitCoordinator.coversWindow,
      confirmDiscard: (since, kind) => confirmStorageLoss(since, kind),
      reportLost: (windowId, since) => {
        console.error(
          `[Electron] Renderer ${windowId} went away with storage changes unsaved since ${new Date(since).toISOString()}`
        )
      }
    })
    // A shutdown, restart or log-off ends the app without `before-quit` on Windows;
    // with changes known unsaved, hold it and run the ordinary quit instead.
    const sessionEndGuard = createSessionEndGuard({
      unsavedSince: knownUnsavedSince,
      quitApproved: quitCoordinator.coversAll,
      requestQuit: () => setImmediate(() => app.quit())
    })
    if (process.platform !== 'win32') {
      // Electron passes the event to this listener; its typing omits it.
      powerMonitor.on('shutdown', sessionEndGuard as unknown as () => void)
    }
    const reloadWindowGuarded = (window: BrowserWindow, ignoreCache = false): void => {
      const reload = (): void => {
        if (window.isDestroyed()) return
        if (ignoreCache) window.webContents.reloadIgnoringCache()
        else window.webContents.reload()
      }
      windowStorageBarrier.noteIntent(window.webContents.id, 'reload', reload)
      reload()
    }
    setRendererReloadIntentHook((window, redo) => {
      if (!window.isDestroyed())
        windowStorageBarrier.noteIntent(window.webContents.id, 'reload', redo)
    })
    const loroDataPlaneRelay = new LoroDataPlaneRelay(
      getLocalLoroDataPlaneSocketPath(mainPlatformKind)
    )
    loroDataPlaneRelay.setEnabled(cliService.getCliAutoStartEnabled())

    const appUpdaterService = new AppUpdaterService({
      enabled: shouldConstructUpdaterEnabled({
        localPlatform: isLocalPlatform(),
        forceEnable: process.env.LODY_ELECTRON_ENABLE_UPDATER === '1'
      }),
      quit: { approve: approveQuit, approveFinal: quitCoordinator.approveFinal, abort: abortQuit }
    })
    const notificationService = new NotificationService(() => getMainWindow())
    const windowsTrayService = new WindowsTrayService({
      iconPath: icon,
      productName: PRODUCT_NAME,
      openOrFocusMainWindow: () => openOrFocusMainWindow({ icon })
    })
    const windowBadgeService = new WindowBadgeService()
    const publicBrowserService = new PublicBrowserService(() => getMainWindow())
    bindWindowBadgeToBrowserWindows(windowBadgeService)

    if (!isLocalPlatform() && !safeStorage.isEncryptionAvailable()) {
      const isLinux = process.platform === 'linux'
      const hint = isLinux
        ? 'gnome-libsecret was already configured automatically. ' +
          'Ensure gnome-keyring-daemon is running, or try launching with ' +
          '--password-store=kwallet5 or --password-store=basic'
        : 'Check that your OS keychain is configured and accessible.'
      console.warn(
        `[Auth] safeStorage encryption is not available. Authentication may fail. ${hint}`
      )
    }

    electronApp.setAppUserModelId(desktopInstallationProfile.desktopAppId)
    const globalShortcutsService = createGlobalShortcutsService(icon)
    globalShortcutsService.registerAll()
    app.once('will-quit', () => globalShortcutsService.dispose())
    app.on('browser-window-created', (_, window) => {
      // Keep Electron's native Cmd/Ctrl zoom shortcuts available. The toolkit
      // blocks Minus and shifted Equal by default when zoom is not enabled.
      optimizer.watchWindowShortcuts(window, { zoom: true })
      // electron-toolkit deliberately blocks the production reload shortcut.
      // Restore the normal desktop-app behavior requested by the user while
      // leaving Cmd/Ctrl+Shift+R and DevTools handling unchanged.
      window.webContents.on('before-input-event', (event, input) => {
        if (isRendererReloadShortcut(input, process.platform)) {
          event.preventDefault()
          reloadWindowGuarded(window)
        }
      })
      // A window whose own repo holds unsaved changes cancels its unload; the
      // barrier asks it to flush, confirms, and repeats the close or reload.
      const contentsId = window.webContents.id
      window.on('close', (event) => {
        // After every close listener ran: a hidden (not closed) window keeps its renderer.
        queueMicrotask(() => {
          if (event.defaultPrevented || window.isDestroyed()) return
          windowStorageBarrier.noteIntent(contentsId, 'close', () => {
            if (!window.isDestroyed()) window.close()
          })
        })
      })
      window.on('query-session-end', sessionEndGuard)
      window.webContents.on('will-prevent-unload', (event) => {
        if (windowStorageBarrier.onUnloadPrevented(contentsId)) event.preventDefault()
      })
      window.webContents.on('did-navigate', () => windowStorageBarrier.documentGone(contentsId))
      window.webContents.on('render-process-gone', () =>
        windowStorageBarrier.documentGone(contentsId)
      )
      window.webContents.once('destroyed', () => windowStorageBarrier.documentGone(contentsId))
    })

    const completeOnboarding = (window: BrowserWindow): void => {
      markOnboardingCompleted()
      setMainWindowProductReloadTarget(window)
    }
    registerIpcServices({
      appIconService,
      cliService,
      appUpdaterService,
      authService,
      notificationService,
      terminalRelay,
      publicBrowserService,
      loroDataPlaneRelay,
      rendererStorageState,
      windowStorageBarrier,
      windowBadgeService,
      globalShortcutsService,
      getMainWindow,
      completeOnboarding,
      reloadMainWindowForDevbar
    })

    setupApplicationMenu({
      appUpdaterService,
      getMainWindow,
      openOrFocusMainWindow: () => openOrFocusMainWindow({ icon }),
      reloadWindow: reloadWindowGuarded
    })
    const initialPath = getInitialDesktopPath()
    const loginItemSettings = getAutoLaunchInvocationStatus()
    const hideWindowOnAutoLaunch = shouldHideMainWindowOnAutoLaunch({
      preferenceEnabled: getHideWindowOnAutoLaunchEnabled(),
      launchedAtLogin: loginItemSettings.launchedAtLogin,
      initialPath,
      hasInitialDeepLink: Boolean(extractDeepLinkFromArgv(process.argv))
    })
    recordE2EBootDiagnostic('opening-main-window')
    openMainWindow({ icon, initialPath, hideWindowOnAutoLaunch })
    recordE2EBootDiagnostic('main-window-opened')
    // Warmup is off by default and only enabled from Developer mode. When it is
    // enabled, session-windows primes the spare after an auxiliary request so
    // ordinary single-window sessions never pay an idle renderer cost.
    ipcMain.on(IPC_SEND_CHANNELS.appWindowReady, (event) => handleWindowWarmReady(event.sender.id))
    ipcMain.on(IPC_SEND_CHANNELS.appPreparedWindowState, (event, state) => {
      if (event.senderFrame === event.sender.mainFrame)
        handlePreparedWindowState(event.sender.id, state)
    })
    ipcMain.on(IPC_SEND_CHANNELS.appWindowContentReady, (event, target) => {
      if (event.senderFrame === event.sender.mainFrame)
        handleWindowContentReady(event.sender.id, target)
    })
    console.info('[Electron] Initial desktop surface selected', {
      initialPath,
      hideWindowOnAutoLaunch
    })
    setWindowsTrayAvailable(windowsTrayService.start())
    cliService.autoStart(getMainWindow()?.webContents ?? undefined)
    appUpdaterService.start()

    app.on('activate', () => {
      const windows = BrowserWindow.getAllWindows()
      if (windows.length === 0) {
        openMainWindow({ icon })
        return
      }
      openOrFocusMainWindow({ icon })
    })

    const quitBarrier = createDesktopQuitBarrier({
      // The local agent keeps changes in memory while its disk is full; stopping
      // it now drops whatever has not reached disk or the cloud.
      // The agent and every window with unsaved storage are asked first.
      confirmQuit: approveQuit,
      abort: abortQuit,
      // Only the agent: the app stays usable until the final check below passed.
      stop: async () => {
        const [cliResult] = await Promise.allSettled([
          cliService.shutdownForQuit(),
          flushElectronMainErrorReporting(),
          stopDevbarDevframeService()
        ])
        if (cliResult.status === 'rejected') throw cliResult.reason
      },
      // Windows kept running while the agent stopped; a write refused meanwhile
      // was never part of the question, so it is flushed and asked about now.
      confirmFinal: quitCoordinator.approveFinal,
      resume: () => cliService.autoStart(getMainWindow()?.webContents ?? undefined),
      // Only now, with the agent stopped and every window covered.
      quit: () => {
        setWindowsTrayAvailable(false)
        windowsTrayService.stop()
        windowBadgeService.reset()
        terminalRelay.destroy()
        loroDataPlaneRelay.destroy()
        appUpdaterService.stop()
        publicBrowserService.destroyAll()
        setAppQuitting(true)
        app.quit()
      },
      reportFailure: (error) => {
        // A timeout does not prove exit. Keep ownership until quit succeeds.
        console.error('[Electron] Quit blocked by the embedded CLI', error)
        dialog.showErrorBox(
          PRODUCT_NAME,
          'The local agent has not confirmed that it stopped. Lody will stay open to prevent ' +
            'another desktop from using its data. Wait for the agent to stop, then quit again.'
        )
      }
    })
    app.on('before-quit', (event) => {
      void quitBarrier(event)
    })

    process.on('exit', () => {
      setWindowsTrayAvailable(false)
      windowsTrayService.stop()
      terminalRelay.destroy()
      loroDataPlaneRelay.destroy()
      cliService.killAllProcesses()
      appUpdaterService.stop()
      publicBrowserService.destroyAll()
    })
  })
  void appReady.catch((error: unknown) => {
    recordE2EBootDiagnostic('failed', error)
    console.error('[Electron] Fatal error while creating the main window', error)
    if (!IS_E2E) app.exit(1)
  })

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') {
      app.quit()
    }
  })
}

// The entry retains launch events while it acquires ownership and loads this module.
export function handleDesktopLaunch(event: DesktopLaunchEvent): void {
  if (event.url) handleDeepLink(event.url)
  if (event.activate) {
    const window = getMainWindow()
    if (window && !window.isDestroyed()) openOrFocusMainWindow({ icon })
  }
}
