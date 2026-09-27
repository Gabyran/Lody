import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import test from 'node:test'
import { acquireDesktopLease } from './desktop-exclusion.ts'
import { createDesktopLaunchBuffer } from './desktop-launch-buffer.ts'
import { createDesktopQuitBarrier } from './desktop-shutdown.ts'
import {
  RendererStorageState,
  WindowStorageBarrier,
  createQuitCoordinator,
  createSessionEndGuard,
  resolveUnsavedBeforeQuit,
  tearDownWindows
} from '@lody/shared/renderer-storage-barrier'

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

void test('an OS session end holds for unsaved storage and runs the same quit barrier', async () => {
  const renderer = new RendererStorageState()
  const quitCheck = {
    timeoutMs: 3_000,
    setTimer: () => null,
    clearTimer: () => {},
    send: (windowId, requestId) => {
      // The window's final flush is still refused.
      queueMicrotask(() => renderer.handleQuitCheckResult(windowId, requestId, 1_000))
      return true
    }
  }
  const answers = [false, true]
  const asked = []
  const coordinator = createQuitCoordinator({
    unsavedSince: () => resolveUnsavedBeforeQuit({ cliUnsavedSince: null, renderer, quitCheck }),
    confirmDiscard: async (since) => {
      asked.push(since)
      return answers.shift()
    },
    setAppQuitting: () => {}
  })
  let stopCalls = 0
  let exited = 0
  const quitBarrier = createDesktopQuitBarrier({
    confirmQuit: coordinator.approve,
    stop: async () => {
      stopCalls++
    },
    quit: () => {
      exited++
    },
    reportFailure: () => {}
  })
  // `app.quit()`: Electron emits `before-quit`, which the barrier handles.
  let quitting = Promise.resolve()
  const guard = createSessionEndGuard({
    unsavedSince: () => renderer.earliestUnsaved(),
    quitApproved: coordinator.isApproved,
    requestQuit: () => {
      quitting = quitBarrier({ preventDefault() {} })
    }
  })
  /** A shutdown with no `before-quit`; true when the app held it. */
  const endSession = () => {
    let held = false
    guard({
      preventDefault() {
        held = true
      }
    })
    return held
  }

  // Healthy: the shutdown goes ahead at once, and nobody is asked.
  assert.equal(endSession(), false)
  await quitting
  assert.deepEqual(asked, [])
  assert.equal(exited, 0)

  // Window 7's storage refused changes: the shutdown is held and the quit asks.
  renderer.report(7, 1_000)
  assert.equal(endSession(), true)
  await quitting
  assert.deepEqual(asked, [1_000])
  assert.equal(stopCalls, 0)
  assert.equal(exited, 0)

  // They cancelled to keep the changes; the next attempt is held and asked again.
  assert.equal(endSession(), true)
  await quitting
  assert.deepEqual(asked, [1_000, 1_000])
  assert.equal(exited, 1)
  assert.equal(stopCalls, 1)

  // Approved: a repeated session end is not held any longer.
  assert.equal(endSession(), false)
})

void test('a window that does not answer, or cannot be asked, keeps its last report', async () => {
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

  // Not being able to ask a window is not proof that it saved.
  const unreachable = await renderer.checkBeforeQuit({
    timeoutMs: 3_000,
    setTimer: () => null,
    clearTimer: () => {},
    send: () => false
  })
  assert.equal(unreachable, 1_000)
  assert.equal(
    await resolveUnsavedBeforeQuit({
      cliUnsavedSince: 2_000,
      renderer,
      quitCheck: { timeoutMs: 1, send: () => false }
    }),
    1_000
  )
})

/** A window whose renderer answers `storage.quitCheck` with `answer.since`. */
const createBarrierHarness = (options = {}) => {
  const state = new RendererStorageState()
  const answer = { since: 1_000 }
  const confirms = []
  const lost = []
  const clock = { now: 0 }
  let confirmAnswer = false
  const barrier = new WindowStorageBarrier({
    state,
    quitApproved: () => options.quitting ?? false,
    now: () => clock.now,
    confirmDiscard: async (since, kind) => {
      confirms.push([since, kind])
      return confirmAnswer
    },
    reportLost: (windowId, since) => lost.push([windowId, since]),
    quitCheck: {
      timeoutMs: 3_000,
      setTimer: () => null,
      clearTimer: () => {},
      send: (windowId, requestId) => {
        queueMicrotask(() => state.handleQuitCheckResult(windowId, requestId, answer.since))
        return true
      }
    }
  })
  return {
    state,
    barrier,
    answer,
    confirms,
    lost,
    clock,
    setConfirm: (value) => {
      confirmAnswer = value
    }
  }
}

void test('closing a window with unsaved storage changes flushes, asks, and keeps it on cancel', async () => {
  const { state, barrier, answer, confirms } = createBarrierHarness()
  state.report(7, 1_000)
  let closes = 0
  const close = () => {
    closes++
  }

  // The renderer cancelled its unload; its final flush is still refused.
  barrier.noteIntent(7, 'close', close)
  assert.equal(barrier.onUnloadPrevented(7), false)
  await barrier.whenDecided(7)
  assert.deepEqual(confirms, [[1_000, 'close']])
  assert.equal(closes, 0)
  assert.equal(state.unsavedSince(7), 1_000)

  // Space was freed: the next attempt's flush saves everything, so the close goes ahead.
  answer.since = null
  barrier.noteIntent(7, 'close', close)
  assert.equal(barrier.onUnloadPrevented(7), false)
  await barrier.whenDecided(7)
  assert.equal(closes, 1)
  assert.deepEqual(confirms, [[1_000, 'close']])
  assert.equal(state.unsavedSince(7), null)
  // The repeated close is let through, until the window's document goes away.
  assert.equal(barrier.onUnloadPrevented(7), true)
  barrier.documentGone(7)
  assert.equal(barrier.onUnloadPrevented(7), false)
})

void test('a discarded reload goes through; quitting and renderer loss are handled', async () => {
  const discard = createBarrierHarness()
  discard.state.report(9, 5_000)
  discard.answer.since = 5_000
  discard.setConfirm(true)
  let reloads = 0
  discard.barrier.noteIntent(9, 'reload', () => {
    reloads++
  })
  assert.equal(discard.barrier.onUnloadPrevented(9), false)
  await discard.barrier.whenDecided(9)
  assert.deepEqual(discard.confirms, [[5_000, 'reload']])
  assert.equal(reloads, 1)
  // The renderer still holds unsaved changes and cancels again; the user already chose.
  assert.equal(discard.barrier.onUnloadPrevented(9), true)
  discard.barrier.documentGone(9)
  assert.deepEqual(discard.lost, [])

  const quitting = createBarrierHarness({ quitting: true })
  quitting.state.report(3, 1_000)
  assert.equal(quitting.barrier.onUnloadPrevented(3), true)

  // A crash is not an approved teardown: the loss is reported, not treated as saved.
  const crashed = createBarrierHarness()
  crashed.state.report(4, 7_000)
  crashed.barrier.documentGone(4)
  assert.deepEqual(crashed.lost, [[4, 7_000]])
})

void test('a cancelled quit clears a preset quitting flag, so window close is guarded again', async () => {
  // An updater marks the app as quitting before it asks (its install closes windows first).
  let appQuitting = true
  const state = new RendererStorageState()
  state.report(7, 1_000)
  const asked = []
  let quitAnswer = false
  const coordinator = createQuitCoordinator({
    unsavedSince: async () => state.earliestUnsaved(),
    confirmDiscard: async (since) => {
      asked.push(['quit', since])
      return quitAnswer
    },
    setAppQuitting: (quitting) => {
      appQuitting = quitting
    }
  })
  const barrier = new WindowStorageBarrier({
    state,
    quitApproved: coordinator.isApproved,
    confirmDiscard: async (since, kind) => {
      asked.push([kind, since])
      return false
    },
    quitCheck: {
      timeoutMs: 3_000,
      setTimer: () => null,
      clearTimer: () => {},
      send: (windowId, requestId) => {
        queueMicrotask(() => state.handleQuitCheckResult(windowId, requestId, 1_000))
        return true
      }
    }
  })

  // The user keeps the unsaved changes: the quit is cancelled and the flag cleared.
  assert.equal(await coordinator.approve(), false)
  assert.equal(appQuitting, false)
  // Closing that window later is guarded again: it flushes and asks.
  barrier.noteIntent(7, 'close', () => {})
  assert.equal(barrier.onUnloadPrevented(7), false)
  await barrier.whenDecided(7)
  assert.deepEqual(asked, [
    ['quit', 1_000],
    ['close', 1_000]
  ])

  // An approved quit lets windows go; if the install then fails, they are guarded again.
  quitAnswer = true
  assert.equal(await coordinator.approve(), true)
  assert.equal(barrier.onUnloadPrevented(7), true)
  appQuitting = true
  coordinator.abort()
  assert.equal(appQuitting, false)
  assert.equal(barrier.onUnloadPrevented(7), false)
  await barrier.whenDecided(7)
})

void test('an approval without an intent does not outlive new unsaved data, reuse or its lifetime', async () => {
  const { state, barrier, answer, confirms, lost, clock, setConfirm } = createBarrierHarness()
  setConfirm(true)
  const approveNavigation = async () => {
    // The page started a navigation itself: nothing to repeat on its behalf.
    assert.equal(barrier.onUnloadPrevented(1), false)
    await barrier.whenDecided(1)
  }

  // The reported case: discard approved, then the page keeps editing and a new
  // write is refused before the next unload.
  state.report(1, 100)
  answer.since = 100
  await approveNavigation()
  state.report(1, 200)
  answer.since = 200
  assert.equal(barrier.onUnloadPrevented(1), false)
  await barrier.whenDecided(1)
  assert.deepEqual(confirms.at(-1), [200, 'reload'])

  // A refusal inside the same episode republishes the same `since`; that is news too.
  state.report(1, 200)
  assert.equal(barrier.onUnloadPrevented(1), false)
  await barrier.whenDecided(1)

  // An approval is single use.
  assert.equal(barrier.onUnloadPrevented(1), true)
  assert.equal(barrier.onUnloadPrevented(1), false)
  await barrier.whenDecided(1)

  // And short-lived.
  clock.now += 10_000
  assert.equal(barrier.onUnloadPrevented(1), false)
  await barrier.whenDecided(1)
  assert.equal(confirms.length, 5)

  // The approved unload itself is not a loss; unsaved data that appears after it is.
  assert.equal(barrier.onUnloadPrevented(1), true)
  barrier.documentGone(1)
  assert.deepEqual(lost, [])
  state.report(2, 300)
  barrier.documentGone(2)
  assert.deepEqual(lost, [[2, 300]])
})

/**
 * Two windows about to be torn down (sign-out from window 1). Each window answers
 * its flush with `answers[id]`; confirmations can be held open by the test.
 */
const createTeardownHarness = () => {
  const state = new RendererStorageState()
  const answers = new Map()
  const flushedWindows = []
  // A window whose flush answer the test releases itself.
  const held = new Map()
  const confirms = []
  const lost = []
  const waiters = []
  const barrier = new WindowStorageBarrier({
    state,
    quitApproved: () => false,
    reportLost: (windowId, since) => lost.push([windowId, since]),
    confirmDiscard: (since, kind) => {
      const { promise, resolve } = Promise.withResolvers()
      confirms.push({ since, kind, resolve })
      for (const waiter of waiters.splice(0)) waiter()
      return promise
    },
    quitCheck: {
      timeoutMs: 3_000,
      setTimer: () => null,
      clearTimer: () => {},
      send: (windowId, requestId) => {
        flushedWindows.push(windowId)
        const answer = () =>
          state.handleQuitCheckResult(windowId, requestId, answers.get(windowId) ?? null)
        if (held.has(windowId)) held.get(windowId).resolve(answer)
        else queueMicrotask(answer)
        return true
      }
    }
  })
  /** Holds the next flush of `windowId`; resolves to a function that answers it. */
  const holdFlush = (windowId) => {
    const hold = Promise.withResolvers()
    held.set(windowId, hold)
    return hold.promise.then((answer) => {
      held.delete(windowId)
      return answer
    })
  }
  // Resolves once the barrier is showing its `count`-th question (signalled, not polled).
  const nextQuestion = async (count) => {
    while (confirms.length < count) {
      await new Promise((resolve) => waiters.push(resolve))
    }
    return confirms[count - 1]
  }
  return { state, answers, confirms, lost, barrier, nextQuestion, flushedWindows, holdFlush }
}

void test('a window that becomes unsaved while the user is asked is flushed and asked about again', async () => {
  const { state, answers, confirms, barrier, nextQuestion } = createTeardownHarness()
  state.report(1, 100)
  answers.set(1, 100)
  const approval = barrier.approveTeardown([1, 2], 'sign-out')

  // While the question about window 1 is open, window 2 has its first write refused.
  const first = await nextQuestion(1)
  answers.set(2, 200)
  state.report(2, 200)
  first.resolve(true)

  // The answer did not cover window 2: it is flushed (still refused) and asked about.
  const second = await nextQuestion(2)
  assert.equal(second.since, 100)
  assert.equal(state.unsavedSince(2), 200)
  second.resolve(false)
  assert.equal(await approval, false)
  assert.equal(confirms.length, 2)
})

void test("a window that becomes unsaved during another window's flush gets its own flush first", async () => {
  const { state, answers, confirms, barrier, nextQuestion, flushedWindows, holdFlush } =
    createTeardownHarness()
  state.report(1, 100)
  answers.set(1, 100)
  const answerWindow1 = holdFlush(1)
  const approval = barrier.approveTeardown([1, 2], 'clear-cache')

  // Window 1 is flushing; meanwhile window 2 has a write refused. Its own flush would save it.
  const answer = await answerWindow1
  state.report(2, 200)
  answer()

  // Window 2 is flushed (and saved) before anyone is asked, so the question is only about window 1.
  const question = await nextQuestion(1)
  assert.equal(flushedWindows.includes(2), true)
  assert.equal(state.unsavedSince(2), null)
  assert.equal(question.since, 100)
  question.resolve(true)
  assert.equal(await approval, true)
  assert.equal(confirms.length, 1)
})

void test('teardown destroys a window only once it saved or its current state was approved', async () => {
  // The reported case, end to end: window 2 is not destroyed on window 1's old answer.
  const cancelled = createTeardownHarness()
  cancelled.state.report(1, 100)
  cancelled.answers.set(1, 100)
  const destroyed = []
  const signOut = tearDownWindows({
    barrier: cancelled.barrier,
    windowIds: [1, 2],
    keep: 1,
    kind: 'sign-out',
    destroy: (windowId) => destroyed.push(windowId)
  })
  const first = await cancelled.nextQuestion(1)
  cancelled.answers.set(2, 200)
  cancelled.state.report(2, 200)
  first.resolve(true)
  ;(await cancelled.nextQuestion(2)).resolve(false)
  assert.equal(await signOut, false)
  assert.deepEqual(destroyed, [])
  assert.equal(cancelled.state.unsavedSince(2), 200)

  // Window 2's flush saves in the next round: it is destroyed, and nothing is lost.
  const saved = createTeardownHarness()
  saved.state.report(1, 100)
  saved.answers.set(1, 100)
  const destroyedAfterSave = []
  const signOutAfterSave = tearDownWindows({
    barrier: saved.barrier,
    windowIds: [1, 2],
    keep: 1,
    kind: 'sign-out',
    destroy: (windowId) => {
      destroyedAfterSave.push(windowId)
      saved.barrier.documentGone(windowId)
    }
  })
  const firstAfterSave = await saved.nextQuestion(1)
  saved.state.report(2, 200) // refused once; its flush below saves it
  firstAfterSave.resolve(true)
  ;(await saved.nextQuestion(2)).resolve(true)
  assert.equal(await signOutAfterSave, true)
  assert.deepEqual(destroyedAfterSave, [2])
  assert.deepEqual(saved.lost, [])

  // The last look before destroy(): a report landing right after approval sends it round again.
  const late = createTeardownHarness()
  let injected = false
  const lateBarrier = {
    approveTeardown: async (ids, kind) => {
      const approved = await late.barrier.approveTeardown(ids, kind)
      if (!injected) {
        injected = true
        late.state.report(2, 300)
      }
      return approved
    },
    mayTearDown: (windowId) => late.barrier.mayTearDown(windowId)
  }
  const destroyedLate = []
  const lateSignOut = tearDownWindows({
    barrier: lateBarrier,
    windowIds: [1, 2],
    keep: 1,
    kind: 'sign-out',
    destroy: (windowId) => destroyedLate.push(windowId)
  })
  late.answers.set(2, 300)
  ;(await late.nextQuestion(1)).resolve(false)
  assert.equal(await lateSignOut, false)
  assert.deepEqual(destroyedLate, [])
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
