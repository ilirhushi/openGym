import { describe, expect, it, vi, beforeEach } from 'vitest'
import { planPushPayload, decideWatchImport, isWatchSessionSeen, withWatchSessionSeen } from './watch-bridge.js'

// Mock mobile.js to provide in-memory file storage and set MOBILE=true
const fileStore = { data: null }
vi.mock('./mobile.js', () => ({
  MOBILE: true,
  readJsonFile: async () => fileStore.data,
  writeJsonFile: async (_n, d) => { fileStore.data = JSON.parse(JSON.stringify(d)) }
}))

// Mock the Capacitor plugin registration
let capturedHandler = null
vi.mock('@capacitor/core', () => ({
  registerPlugin: () => ({
    addListener: (_event, handler) => { capturedHandler = handler }
  })
}))

describe('planPushPayload', () => {
  it('returns null off mobile (nothing to push, no plugin to call)', () => {
    expect(planPushPayload({ routines: [], dayPlan: {}, week: {}, workouts: [], exWeights: {}, unit: 'kg', active: null, customEx: [] }, '2026-09-22')).toBeNull()
  })
})

describe('decideWatchImport', () => {
  it('applies directly when there is no same-day conflict', () => {
    const apply = vi.fn()
    const askUser = vi.fn()
    const st = { workouts: [], exWeights: {}, unit: 'kg' }
    const payload = { watchSessionId: 'w1', date: '2026-09-21', start: 0, end: 1, routineIds: [], name: 'Push', entries: [] }
    decideWatchImport(st, payload, { apply, askUser })
    expect(apply).toHaveBeenCalledTimes(1)
    expect(askUser).not.toHaveBeenCalled()
  })
  it('asks the user to choose when there is already a workout that day', () => {
    const apply = vi.fn()
    const askUser = vi.fn()
    const st = { workouts: [{ id: 'old', d: '2026-09-21', start: 100, entries: [] }], exWeights: {}, unit: 'kg' }
    const payload = { watchSessionId: 'w1', date: '2026-09-21', start: 0, end: 1, routineIds: [], name: 'Push', entries: [] }
    decideWatchImport(st, payload, { apply, askUser })
    expect(askUser).toHaveBeenCalledTimes(1)
    expect(apply).not.toHaveBeenCalled()
    const [existing] = askUser.mock.calls[0]
    expect(existing.map(w => w.id)).toEqual(['old'])
  })
})

describe('watch session idempotency', () => {
  it('is not seen until recorded', () => {
    expect(isWatchSessionSeen([], 'w1')).toBe(false)
  })
  it('is seen once recorded', () => {
    const seen = withWatchSessionSeen([], 'w1')
    expect(isWatchSessionSeen(seen, 'w1')).toBe(true)
  })
  it('keeps only the most recent 50 ids', () => {
    let seen = []
    for (let i = 0; i < 60; i++) seen = withWatchSessionSeen(seen, `w${i}`)
    expect(seen).toHaveLength(50)
    expect(isWatchSessionSeen(seen, 'w0')).toBe(false)
    expect(isWatchSessionSeen(seen, 'w59')).toBe(true)
  })
})

describe('initWatchBridge redelivery gating', () => {
  it('gates redelivery: onSession is called exactly once for duplicate watchSessionReceived events', async () => {
    // Reset state
    fileStore.data = null
    capturedHandler = null

    // Import initWatchBridge after mocks are in place
    const { initWatchBridge } = await import('./watch-bridge.js')

    const onSessionSpy = vi.fn()
    await initWatchBridge(onSessionSpy)

    // Verify the listener was registered
    expect(capturedHandler).toBeDefined()

    // Simulate the OS delivering the same watchSessionReceived event twice
    const sameEvent = {
      payload: JSON.stringify({
        watchSessionId: 'w1',
        date: '2026-09-21',
        start: 0,
        end: 1,
        routineIds: [],
        name: 'Push',
        entries: []
      })
    }

    // Fire the event twice (simulating redelivery)
    await capturedHandler(sameEvent)
    await capturedHandler(sameEvent)

    // Verify onSession was called exactly once despite two events
    expect(onSessionSpy).toHaveBeenCalledTimes(1)

    // Verify the payload passed was the parsed JSON
    expect(onSessionSpy).toHaveBeenCalledWith(expect.objectContaining({
      watchSessionId: 'w1',
      date: '2026-09-21'
    }))
  })
})
