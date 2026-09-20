// Regression cover for the Capacitor proxy thenable trap, the bug that made the entire Watch
// feature inert on a real iPhone while every unit test passed. registerPlugin() hands back a
// Proxy whose get-trap answers EVERY property name (`then` included) with a native-method
// wrapper that drops its callbacks, so a promise resolving to the proxy never settles. See
// watch-bridge.proxy.test.js, coach-secrets.js, and issues #42 and #58.
import { describe, expect, it, vi, beforeEach } from 'vitest'

vi.mock('./mobile.js', () => ({
  MOBILE: true,
  readJsonFile: async () => null,
  writeJsonFile: async () => {},
}))

const accessed = []

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
            if (prop === 'requestPermissions') return Promise.resolve({ write: true })
            if (prop === 'getAuth') return Promise.resolve({ write: true })
            if (prop === 'saveWorkout') return Promise.resolve({ ok: true })
            if (prop === 'readLatestBodyWeight') return Promise.resolve({ kg: 82.4, at: 1000 })
            // An undeclared method, `then` above all, reaches native as nothing at all and
            // returns a promise that never settles.
            return new Promise(() => {})
          }
      }
    },
  }),
}))

// A hang must fail loudly rather than stall the suite until vitest's own timeout makes it look
// like an unrelated flake.
const within = (promise, ms = 1000) => Promise.race([
  promise,
  new Promise((_, reject) => setTimeout(() => reject(new Error(`hung: did not settle within ${ms}ms`)), ms)),
])

describe('health-bridge never lets the Capacitor proxy become a promise value', () => {
  beforeEach(() => { accessed.length = 0 })

  it('requestHealthPermissions() resolves instead of hanging', async () => {
    const { requestHealthPermissions } = await import('./health-bridge.js')
    await expect(within(requestHealthPermissions())).resolves.toEqual({ write: true })
  })

  it('saveHealthWorkout() reaches the native call and reports success', async () => {
    const { saveHealthWorkout } = await import('./health-bridge.js')
    await expect(within(saveHealthWorkout({
      start: 1, end: 2, type: 'strength', title: 'Push Day', id: 'wk_1',
    }))).resolves.toBe(true)
    expect(accessed).toContain('saveWorkout')
  })

  it('readLatestBodyWeight() resolves with the native reading', async () => {
    const { readLatestBodyWeight } = await import('./health-bridge.js')
    await expect(within(readLatestBodyWeight())).resolves.toEqual({ kg: 82.4, at: 1000 })
  })

  it('never reads `then` off the proxy (the trap itself)', async () => {
    const { getHealthAuth } = await import('./health-bridge.js')
    await within(getHealthAuth())
    expect(accessed).not.toContain('then')
  })
})
