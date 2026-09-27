import assert from 'node:assert/strict'
import test from 'node:test'
import { EventEmitter } from 'node:events'
import {
  installLinuxDebThenQuit,
  resolveLinuxDebInstallPlan,
  runLinuxDebInstall
} from './app-updater-linux-install.ts'
import {
  RendererStorageState,
  WindowStorageBarrier,
  createQuitCoordinator,
  resolveUnsavedBeforeQuit
} from '@lody/shared/renderer-storage-barrier'

function createFakeChild() {
  const child = new EventEmitter()
  child.stderr = new EventEmitter()
  return child
}

/** Resolve pending microtasks without leaning on timers. */
async function drainMicrotasks() {
  await Promise.resolve()
  await Promise.resolve()
}

void test('claims the privileged path only for a downloaded .deb on Linux', () => {
  assert.deepEqual(
    resolveLinuxDebInstallPlan({
      platform: 'linux',
      downloadedFile: '/home/u/.cache/pending/Lody-0.91.1-amd64.deb',
      appImagePath: undefined
    }),
    {
      command: 'pkexec',
      args: [
        '--disable-internal-agent',
        'dpkg',
        '-i',
        '/home/u/.cache/pending/Lody-0.91.1-amd64.deb'
      ]
    }
  )
})

void test('passes a package path with spaces as one unescaped argument', () => {
  const plan = resolveLinuxDebInstallPlan({
    platform: 'linux',
    downloadedFile: '/home/my user/pending/Lody 0.91.1.deb',
    appImagePath: undefined
  })
  assert.deepEqual(plan?.args.at(-1), '/home/my user/pending/Lody 0.91.1.deb')
})

void test('leaves every other install to electron-updater', () => {
  const debFile = '/tmp/Lody.deb'
  assert.equal(
    resolveLinuxDebInstallPlan({
      platform: 'darwin',
      downloadedFile: debFile,
      appImagePath: undefined
    }),
    null
  )
  assert.equal(
    resolveLinuxDebInstallPlan({
      platform: 'win32',
      downloadedFile: debFile,
      appImagePath: undefined
    }),
    null
  )
  // An AppImage rewrites its own file and needs no privileged helper.
  assert.equal(
    resolveLinuxDebInstallPlan({
      platform: 'linux',
      downloadedFile: debFile,
      appImagePath: '/opt/Lody.AppImage'
    }),
    null
  )
  assert.equal(
    resolveLinuxDebInstallPlan({
      platform: 'linux',
      downloadedFile: '/tmp/Lody-0.91.1-x86_64.AppImage',
      appImagePath: undefined
    }),
    null
  )
  assert.equal(
    resolveLinuxDebInstallPlan({
      platform: 'linux',
      downloadedFile: undefined,
      appImagePath: undefined
    }),
    null
  )
})

void test('waits for the installer to exit instead of blocking on the spawn', async () => {
  const child = createFakeChild()
  let settled = false
  const pending = runLinuxDebInstall(
    { command: 'pkexec', args: ['--disable-internal-agent', 'dpkg', '-i', '/tmp/Lody.deb'] },
    () => child
  ).then((result) => {
    settled = true
    return result
  })

  // The privileged helper is still waiting on the password prompt here. The
  // caller must not have a result yet, and the loop must stay free.
  await drainMicrotasks()
  assert.equal(settled, false)

  child.emit('exit', 0, null)
  assert.deepEqual(await pending, { ok: true })
})

void test('spawns the planned command and arguments', async () => {
  const child = createFakeChild()
  const calls = []
  const pending = runLinuxDebInstall(
    { command: 'pkexec', args: ['--disable-internal-agent', 'dpkg', '-i', '/tmp/Lody.deb'] },
    (command, args) => {
      calls.push([command, args])
      return child
    }
  )
  child.emit('exit', 0, null)
  await pending

  assert.deepEqual(calls, [['pkexec', ['--disable-internal-agent', 'dpkg', '-i', '/tmp/Lody.deb']]])
})

void test('reports a dismissed or unauthorized password prompt', async () => {
  const child = createFakeChild()
  const pending = runLinuxDebInstall({ command: 'pkexec', args: [] }, () => child)
  child.emit('exit', 126, null)

  const result = await pending
  assert.equal(result.ok, false)
  assert.match(result.error, /not authorized/i)
})

void test('reports a privileged helper that could not run', async () => {
  const child = createFakeChild()
  const pending = runLinuxDebInstall({ command: 'pkexec', args: [] }, () => child)
  child.stderr.emit('data', 'pkexec must be setuid root\n')
  child.emit('exit', 127, null)

  const result = await pending
  assert.equal(result.ok, false)
  assert.match(result.error, /pkexec exited 127/)
  assert.match(result.error, /pkexec must be setuid root/)
})

void test('reports the installer exit code and its stderr', async () => {
  const child = createFakeChild()
  const pending = runLinuxDebInstall({ command: 'pkexec', args: [] }, () => child)
  child.stderr.emit('data', 'dpkg: error: dpkg frontend lock was locked by another process')
  child.emit('exit', 2, null)

  const result = await pending
  assert.equal(result.ok, false)
  assert.match(result.error, /dpkg exited with code 2/)
  assert.match(result.error, /frontend lock/)
})

void test('treats a signalled installer as a failure rather than a success', async () => {
  const child = createFakeChild()
  const pending = runLinuxDebInstall({ command: 'pkexec', args: [] }, () => child)
  // spawnSync reports this as `status: null`, which electron-updater reads as
  // success and then relaunches into the version it never installed.
  child.emit('exit', null, 'SIGTERM')

  const result = await pending
  assert.equal(result.ok, false)
  assert.match(result.error, /SIGTERM/)
})

void test('reports a helper that could not be spawned at all', async () => {
  const child = createFakeChild()
  const pending = runLinuxDebInstall({ command: 'pkexec', args: [] }, () => child)
  child.emit('error', new Error('spawn pkexec ENOENT'))

  const result = await pending
  assert.equal(result.ok, false)
  assert.match(result.error, /ENOENT/)
})

void test('settles once when a failed spawn emits both error and exit', async () => {
  const child = createFakeChild()
  const pending = runLinuxDebInstall({ command: 'pkexec', args: [] }, () => child)
  child.emit('error', new Error('spawn pkexec ENOENT'))
  child.emit('exit', 0, null)

  const result = await pending
  assert.equal(result.ok, false)
  assert.match(result.error, /ENOENT/)
})

void test('reports a synchronous spawn throw', async () => {
  const result = await runLinuxDebInstall({ command: 'pkexec', args: [] }, () => {
    throw new Error('EACCES')
  })
  assert.equal(result.ok, false)
  assert.match(result.error, /EACCES/)
})

void test('a write refused during the password prompt is guarded and asked about before relaunch', async () => {
  const state = new RendererStorageState()
  let flushAnswer = null
  const quitCheck = {
    timeoutMs: 3_000,
    setTimer: () => null,
    clearTimer: () => {},
    send: (windowId, requestId) => {
      queueMicrotask(() => state.handleQuitCheckResult(windowId, requestId, flushAnswer))
      return true
    }
  }
  const asked = []
  const barrier = new WindowStorageBarrier({
    state,
    quitCheck,
    quitApproved: (windowId) => coordinator.coversWindow(windowId),
    confirmDiscard: async (since, kind) => {
      asked.push([kind, since])
      return false
    }
  })
  const coordinator = createQuitCoordinator({
    unsavedSince: () =>
      resolveUnsavedBeforeQuit({ cliUnsavedSince: null, renderer: state, quitCheck }),
    confirmDiscard: async () => true,
    setAppQuitting: () => {},
    renderer: state,
    windowIds: () => [7],
    approveWindows: (windowIds) => barrier.approveTeardown(windowIds, 'quit')
  })
  const installing = Promise.withResolvers()
  let relaunches = 0

  // Approved before the prompt, with everything saved.
  assert.equal(await coordinator.approve(), true)
  const installed = installLinuxDebThenQuit({
    install: () => installing.promise,
    approveFinal: coordinator.approveFinal,
    abort: coordinator.abort,
    relaunchAndQuit: () => {
      relaunches++
    }
  })

  // The prompt is open; window 7's storage refuses a write, and the user closes it.
  state.report(7, 3_000)
  flushAnswer = 3_000
  barrier.noteIntent(7, 'close', () => {})
  assert.equal(barrier.onUnloadPrevented(7), false)
  await barrier.whenDecided(7)
  assert.deepEqual(asked, [['close', 3_000]])

  // The package installs; before relaunching, the new refusal is flushed and asked about.
  installing.resolve({ ok: true })
  assert.deepEqual(await installed, { ok: false, cancelled: true })
  assert.deepEqual(asked, [
    ['close', 3_000],
    ['quit', 3_000]
  ])
  assert.equal(relaunches, 0)
  assert.equal(coordinator.isApproved(), false)
  assert.equal(barrier.onUnloadPrevented(7), false)
  await barrier.whenDecided(7)
})
