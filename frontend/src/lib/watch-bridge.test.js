import { describe, expect, it, vi, beforeEach } from 'vitest'
import { planPushPayload, decideWatchImport, isWatchSessionSeen, withWatchSessionSeen } from './watch-bridge.js'

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
