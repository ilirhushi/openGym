import { describe, expect, it } from 'vitest'
import { activeFromWatchPayload, computeWatchPRs, finishWatchSession } from './watch-import.js'

const payload = (over = {}) => ({
  watchSessionId: 'w1', date: '2026-09-21', start: 1000, end: 5000,
  routineIds: ['r1'], name: 'Push Day',
  entries: [{ id: 'bench-press', sets: [
    { phase: 'warmup', w: 20, r: 8, done: true },
    { phase: 'work', w: 62.5, r: 8, done: true },
  ] }],
  ...over,
})

describe('activeFromWatchPayload', () => {
  it('shapes the payload like buildCompletedWorkout expects an active session', () => {
    const active = activeFromWatchPayload(payload())
    expect(active).toMatchObject({ id: 'w1', d: '2026-09-21', start: 1000, routineIds: ['r1'], name: 'Push Day', bw: null })
    expect(active.entries).toHaveLength(1)
  })
})

describe('computeWatchPRs', () => {
  it('reports a PR when the top set beats every prior best', () => {
    const st = { workouts: [], unit: 'kg' }
    const active = activeFromWatchPayload(payload())
    const { prs } = computeWatchPRs(st, active)
    expect(prs).toEqual(['bench-press'])
  })
  it('reports no PR when a heavier set already exists', () => {
    const st = { workouts: [{ d: '2026-09-01', entries: [{ id: 'bench-press', sets: [{ w: 70, r: 5, done: true }] }] }], unit: 'kg' }
    const active = activeFromWatchPayload(payload())
    const { prs } = computeWatchPRs(st, active)
    expect(prs).toEqual([])
  })
})

describe('finishWatchSession', () => {
  it('inserts a new workout and updates exWeights when there is no same-day conflict', () => {
    const st = { workouts: [], exWeights: {}, unit: 'kg' }
    const { workouts, exWeights, w, prs } = finishWatchSession(st, payload())
    expect(workouts).toHaveLength(1)
    expect(workouts[0].id).toBe('w1')
    expect(w.entries[0].sets).toHaveLength(2)
    expect(exWeights['bench-press']).toMatchObject({ w: 62.5, d: '2026-09-21' })
    expect(prs).toEqual(['bench-press'])
  })
  it('replaces the named workout instead of adding a second one when replaceId is given', () => {
    const existing = { id: 'old', d: '2026-09-21', entries: [] }
    const st = { workouts: [existing], exWeights: {}, unit: 'kg' }
    const { workouts } = finishWatchSession(st, payload(), { replaceId: 'old' })
    expect(workouts.map(w => w.id)).toEqual(['w1'])
  })
  it('keeps an existing same-day workout when no replaceId is given', () => {
    const existing = { id: 'old', d: '2026-09-21', start: 500, entries: [] }
    const st = { workouts: [existing], exWeights: {}, unit: 'kg' }
    const { workouts } = finishWatchSession(st, payload())
    expect(workouts.map(w => w.id).sort()).toEqual(['old', 'w1'])
  })
  it('returns null instead of inserting a phantom workout when nothing was actually logged', () => {
    const st = { workouts: [], exWeights: {}, unit: 'kg' }
    const emptySession = payload({ entries: [{ id: 'bench-press', sets: [{ phase: 'work', w: 0, r: 0, done: false }] }] })
    expect(finishWatchSession(st, emptySession)).toBeNull()
  })
  it('round-trips rid/noProg through to the inserted workout entry', () => {
    const st = { workouts: [], exWeights: {}, unit: 'kg' }
    const rehab = payload({ entries: [{ id: 'bench-press', rid: 'routine-2', noProg: true, sets: [
      { phase: 'work', w: 40, r: 10, done: true },
    ] } ] })
    const { w } = finishWatchSession(st, rehab)
    expect(w.entries[0]).toMatchObject({ rid: 'routine-2', noProg: true })
  })
})
