import { describe, expect, it } from 'vitest'
import { flattenSetForWatch, buildWatchPlanPayload } from './watch-sync.js'

describe('flattenSetForWatch', () => {
  it('keeps a straight reps row as-is', () => {
    expect(flattenSetForWatch({ w: 60, r: 8, done: true })).toEqual({ phase: 'work', w: 60, r: 8, done: false })
  })
  it('marks a warmup row', () => {
    expect(flattenSetForWatch({ w: 20, r: 8, warmup: true })).toEqual({ phase: 'warmup', w: 20, r: 8, done: false })
  })
  it('keeps a time-mode row\'s sec/w', () => {
    expect(flattenSetForWatch({ sec: 45, w: 5, done: false })).toEqual({ phase: 'work', sec: 45, w: 5, done: false })
  })
  it('keeps a cardio row\'s min/speed', () => {
    expect(flattenSetForWatch({ min: 20, speed: 8 })).toEqual({ phase: 'work', min: 20, speed: 8, done: false })
  })
  it('flattens a drop-set row to its own main w/r, dropping type/drops', () => {
    expect(flattenSetForWatch({ w: 60, r: 8, type: 'dropset', drops: [{ w: 48, r: 8 }] }))
      .toEqual({ phase: 'work', w: 60, r: 8, done: false })
  })
  it('flattens a per-side row to its synced scalar aggregate', () => {
    const side = { sides: { L: { w: 20, r: 6, done: true }, R: { w: 20, r: 6, done: true } }, w: 20, r: 12, done: true }
    expect(flattenSetForWatch(side)).toEqual({ phase: 'work', w: 20, r: 12, done: false })
  })
})

describe('buildWatchPlanPayload', () => {
  const routine = { id: 'r1', name: 'Push Day', ex: [{ id: 'bench-press', sets: 1, reps: 8, weight: 60 }] }
  const S = { routines: [routine], dayPlan: {}, week: { 1: ['r1'] }, workouts: [], exWeights: {}, unit: 'kg', active: null, customEx: [] }

  it('returns null when nothing is scheduled that day', () => {
    expect(buildWatchPlanPayload({ ...S, week: {} }, '2026-09-21')).toBeNull()
  })
  it('builds a slim per-exercise payload for a scheduled day', () => {
    // 2026-09-21 is a Monday
    const payload = buildWatchPlanPayload(S, '2026-09-21')
    expect(payload.date).toBe('2026-09-21')
    expect(payload.routineIds).toEqual(['r1'])
    expect(payload.name).toBe('Push Day')
    expect(payload.activeOnPhone).toBe(false)
    expect(payload.entries).toHaveLength(1)
    expect(payload.entries[0].id).toBe('bench-press')
    expect(payload.entries[0].sets[0]).toMatchObject({ phase: 'work', done: false })
  })
  it('reflects an already-started phone session', () => {
    const payload = buildWatchPlanPayload({ ...S, active: { id: 'a1' } }, '2026-09-21')
    expect(payload.activeOnPhone).toBe(true)
  })
})
