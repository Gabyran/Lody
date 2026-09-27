import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import test from 'node:test'
import { acquireDesktopLease } from './desktop-exclusion.ts'
import { createDesktopLaunchBuffer } from './desktop-launch-buffer.ts'
import { createDesktopQuitBarrier } from './desktop-shutdown.ts'
import { RendererStorageState, resolveUnsavedBeforeQuit } from './renderer-storage-state.ts'

const loopback = { host: '127.0.0.1', port: 0 }

void test('desktop ownership excludes a second owner and can be handed off after close', async (t) => {
  const stable = await acquireDesktopLease(loopback)
  assert.ok(stable)
  t.after(() => stable.close())
  const endpoint = { ...loopback, port: stable.port }
  assert.equal(await acquireDesktopLease(endpoint), null)
  await stable.close()
  const nightly = await acquireDesktopLease(endpoint)
  assert.ok(nightly)
  t.after(() => nightly.close())
  assert.equal(await acquireDesktopLease(endpoint), null)
})

void test('crashing an owner releases the OS lease without deleting a lock file', async (t) => {
  const moduleUrl = new URL('./desktop-exclusion.ts', import.meta.url).href
  const child = spawn(
    process.execPath,
    [
      '--experimental-strip-types',
      '--input-type=module',
      '-e',
      `
    const { acquireDesktopLease } = await import(${JSON.stringify(moduleUrl)});
    const lease = await acquireDesktopLease({ host: '127.0.0.1', port: 0 });
    process.on('message', () => {});
    process.send({ port: lease.port });
  `
    ],
    { stdio: ['ignore', 'ignore', 'inherit', 'ipc'] }
  )
  t.after(() => child.kill('SIGKILL'))
  const [{ port }] = await Promise.race([
    once(child, 'message'),
    once(child, 'exit').then(() => {
      throw new Error('Lease owner exited before ready')
    })
  ])
  const endpoint = { ...loopback, port }
  assert.equal(await acquireDesktopLease(endpoint), null)
  const exited = once(child, 'exit')
  child.kill('SIGKILL')
  await exited
  const replacement = await acquireDesktopLease(endpoint)
  assert.ok(replacement)
  t.after(() => replacement.close())
})

void test('lease setup errors fail rather than admitting an unprotected desktop', async () => {
  await assert.rejects(acquireDesktopLease({ host: '127.0.0.1', port: -1 }))
})

void test('startup retains login and activation events until the application is loaded', () => {
  const buffer = createDesktopLaunchBuffer()
  const received = []
  buffer.push({ url: 'ai.lody.nightly://auth/callback#pending-attempt' })
  buffer.push({ activate: true })
  assert.deepEqual(received, [])
  buffer.bind((event) => received.push(event))
  buffer.push({ url: 'ai.lody.nightly://workspace/after-ready' })
  assert.deepEqual(received, [
    { url: 'ai.lody.nightly://auth/callback#pending-attempt' },
    { activate: true },
    { url: 'ai.lody.nightly://workspace/after-ready' }
  ])
  assert.throws(() => buffer.bind(() => {}), /already bound/)
})

void test('startup event buffer bounds memory and retains the most recent login', () => {
  const buffer = createDesktopLaunchBuffer()
  for (let i = 0; i < 40; i++) buffer.push({ url: `lody://workspace/${i}` })
  buffer.push({ url: 'lody://auth/callback#new-attempt' })
  const received = []
  buffer.bind((event) => received.push(event))
  assert.equal(received.length, 32)
  assert.deepEqual(received[0], { url: 'lody://workspace/9' })
  assert.deepEqual(received.at(-1), { url: 'lody://auth/callback#new-attempt' })
})

void test('quit asks first and stays open when the user cancels', async () => {
  const answers = [false, true]
  let stopCalls = 0
  let quitCalls = 0
  const handler = createDesktopQuitBarrier({
    confirmQuit: async () => answers.shift(),
    stop: async () => {
      stopCalls++
    },
    quit: () => {
      quitCalls++
    },
    reportFailure: () => {}
  })
  let prevented = false
  await handler({
    preventDefault() {
      prevented = true
    }
  })
  assert.equal(prevented, true)
  assert.equal(stopCalls, 0)
  assert.equal(quitCalls, 0)
  await handler({ preventDefault() {} })
  assert.equal(stopCalls, 1)
  assert.equal(quitCalls, 1)
})

void test('quit warns for a window whose storage refused changes, even with a healthy agent', async () => {
  const renderer = new RendererStorageState()
  renderer.report(7, 1_000)
  let windowAnswer = 1_000
  const asked = []
  const quitCheck = {
    timeoutMs: 3_000,
    setTimer: () => null,
    clearTimer: () => {},
    send: (windowId, requestId) => {
      asked.push(windowId)
      // The window runs its final flush, then answers with what is still unsaved.
      queueMicrotask(() => renderer.handleQuitCheckResult(windowId, requestId, windowAnswer))
      return true
    }
  }
  const warnings = []
  let stopCalls = 0
  const handler = createDesktopQuitBarrier({
    confirmQuit: async () => {
      const since = await resolveUnsavedBeforeQuit({ cliUnsavedSince: null, renderer, quitCheck })
      if (since === null) return true
      warnings.push(since)
      return false // the user cancels to free space first
    },
    stop: async () => {
      stopCalls++
    },
    quit: () => {},
    reportFailure: () => {}
  })
  await handler({ preventDefault() {} })
  assert.deepEqual(asked, [7])
  assert.deepEqual(warnings, [1_000])
  assert.equal(stopCalls, 0)

  // Space was freed: the window's final flush saves everything, so quitting proceeds.
  windowAnswer = null
  await handler({ preventDefault() {} })
  assert.deepEqual(warnings, [1_000])
  assert.equal(stopCalls, 1)
})

void test('a window that does not answer keeps its last report; a destroyed one is forgotten', async () => {
  const renderer = new RendererStorageState()
  renderer.report(7, 1_000)
  let fire
  const silent = renderer.checkBeforeQuit({
    timeoutMs: 3_000,
    setTimer: (callback) => {
      fire = callback
      return 1
    },
    clearTimer: () => {},
    send: () => true
  })
  fire()
  assert.equal(await silent, 1_000)

  const gone = await renderer.checkBeforeQuit({
    timeoutMs: 3_000,
    setTimer: () => null,
    clearTimer: () => {},
    send: () => false
  })
  assert.equal(gone, null)
  assert.equal(
    await resolveUnsavedBeforeQuit({
      cliUnsavedSince: 2_000,
      renderer,
      quitCheck: { timeoutMs: 1, send: () => false }
    }),
    2_000
  )
})

void test('quit waits for execution exit, retains ownership on failure, and allows retry', async () => {
  const stopped = Promise.withResolvers()
  const failed = Promise.withResolvers()
  const quit = Promise.withResolvers()
  let stopping = stopped.promise
  let stopCalls = 0
  let finalQuitPrevented
  const handler = createDesktopQuitBarrier({
    stop: () => {
      stopCalls++
      return stopping
    },
    quit: () => {
      finalQuitPrevented = false
      void handler({
        preventDefault() {
          finalQuitPrevented = true
        }
      })
      quit.resolve()
    },
    reportFailure: (error) => failed.resolve(error)
  })
  let prevented = false
  void handler({
    preventDefault() {
      prevented = true
    }
  })
  assert.equal(prevented, true)
  // Repeated quit must share the pending shutdown instead of running it twice.
  void handler({ preventDefault() {} })
  const error = new Error('CLI still alive')
  stopped.reject(error)
  assert.equal(await failed.promise, error)
  assert.equal(finalQuitPrevented, undefined)
  assert.equal(stopCalls, 1)
  stopping = Promise.resolve()
  void handler({ preventDefault() {} })
  await quit.promise
  assert.equal(finalQuitPrevented, false)
})
