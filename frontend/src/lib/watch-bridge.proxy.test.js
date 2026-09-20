// Regression cover for the bug that made the whole Watch feature inert on a real iPhone while
// every unit test passed: watch-bridge.js's plugin() let Capacitor's plugin Proxy become a
// promise's own resolution value, the runtime took it for a thenable, and `await plugin()` never
// settled. Nothing reached the native side — no failed call to see, just silence.
//
// watch-bridge.test.js could not catch it: its mock hands back a plain `{ addListener }` object,
// which is not thenable, so the await it is meant to exercise always resolved. The mock below is
// the part that matters — a proxy that behaves like the real registerPlugin()'s, whose get-trap
// answers EVERY property name (`then` included) with a method wrapper that drops the callbacks
// it is handed. See @capacitor/core's registerPlugin, and coach-secrets.js for the same bug in
// the Coach's SecureStorage path (issues #42, #58).
import { describe, expect, it, vi, beforeEach } from 'vitest'

vi.mock('./mobile.js', () => ({
  MOBILE: true,
  readJsonFile: async () => null,
  writeJsonFile: async () => {}
}))

const accessed = []
let listenerAttached = null

vi.mock('@capacitor/core', () => ({
  registerPlugin: () => new Proxy({}, {
    get(_, prop) {
      accessed.push(prop)
      switch (prop) {
        // The two names the real proxy special-cases, and the only two.
        case '$$typeof': return undefined
        case 'toJSON': return () => ({})
        default:
          return (...args) => {
            if (prop === 'addListener') { listenerAttached = args[0]; return Promise.resolve({ remove() {} }) }
            if (prop === 'getStatus') {
              return Promise.resolve({ supported: true, paired: true, watchAppInstalled: true, reachable: false })
            }
            if (prop === 'syncTodayPlan') return Promise.resolve()
            // An undeclared method — `then` above all — reaches native as nothing at all. The
            // real wrapper ignores the (resolve, reject) it was handed and returns a promise
            // that rejects out of band, so a runtime awaiting this thenable waits forever.
            return new Promise(() => {})
          }
      }
    }
  })
}))

// Guards the whole point of these tests: a hang must fail, not stall the suite until vitest's
// own timeout makes it look like an unrelated flake.
const within = (promise, ms = 1000) => Promise.race([
  promise,
  new Promise((_, reject) => setTimeout(() => reject(new Error(`hung: did not settle within ${ms}ms`)), ms))
])

describe('plugin() never lets the Capacitor proxy become a promise value', () => {
  beforeEach(() => { accessed.length = 0; listenerAttached = null })

  it('getWatchStatus() resolves with the native status instead of hanging', async () => {
    const { getWatchStatus } = await import('./watch-bridge.js')
    await expect(within(getWatchStatus())).resolves.toEqual({
      supported: true, paired: true, watchAppInstalled: true, reachable: false
    })
  })

  it('initWatchBridge() gets as far as attaching its native listener', async () => {
    const { initWatchBridge } = await import('./watch-bridge.js')
    await within(initWatchBridge(() => {}))
    expect(listenerAttached).toBe('watchSessionReceived')
  })

  it('syncTodayPlanToWatch() reaches the native call', async () => {
    const { syncTodayPlanToWatch } = await import('./watch-bridge.js')
    await within(syncTodayPlanToWatch(
      { routines: [], dayPlan: {}, week: {}, workouts: [], exWeights: {}, unit: 'kg', active: null, customEx: [] },
      '2026-09-22'
    ))
    expect(accessed).toContain('syncTodayPlan')
  })

  it('never reads `then` off the proxy (the thenable trap itself)', async () => {
    const { getWatchStatus } = await import('./watch-bridge.js')
    await within(getWatchStatus())
    // The assertion that would have failed before the fix: promise resolution probes `.then`
    // on any value it is handed, so a bare proxy shows up here the moment it is returned.
    expect(accessed).not.toContain('then')
  })
})
