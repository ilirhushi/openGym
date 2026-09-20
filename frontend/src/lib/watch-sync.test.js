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
  // The Watch shows a weight next to a unit and has no other source for it: the payload is the
  // only thing that crosses. Without this it either prints a bare number or, worse, labels a
  // pound lifter's sets "kg".
  it('carries the unit so the Watch can label a weight', () => {
    expect(buildWatchPlanPayload(S, '2026-09-21').unit).toBe('kg')
    expect(buildWatchPlanPayload({ ...S, unit: 'lb' }, '2026-09-21').unit).toBe('lb')
  })
  it('falls back to kg when state carries no unit', () => {
    const { unit, ...noUnit } = S
    expect(buildWatchPlanPayload(noUnit, '2026-09-21').unit).toBe('kg')
  })
  // The Watch ran a hardcoded 90s because the payload carried no rest at all, so every exercise
  // rested the same and Settings' rest timer did nothing on the wrist.
  it('carries the global rest timer on each entry', () => {
    const payload = buildWatchPlanPayload({ ...S, restSec: 120 }, '2026-09-21')
    expect(payload.entries[0].rest).toBe(120)
  })
  it("prefers an exercise's own restSec over the global one", () => {
    const own = { ...routine, ex: [{ ...routine.ex[0], restSec: 240 }] }
    const payload = buildWatchPlanPayload({ ...S, routines: [own], restSec: 90 }, '2026-09-21')
    expect(payload.entries[0].rest).toBe(240)
  })
  // restSec 0 is the rest timer switched off (v1.2.11), not a missing value, and the Watch has
  // to be able to tell those apart or it falls back to its own default and rests anyway.
  it('carries a zero rest as zero, meaning the timer is off', () => {
    const payload = buildWatchPlanPayload({ ...S, restSec: 0 }, '2026-09-21')
    expect(payload.entries[0].rest).toBe(0)
  })
  it('carries warmupRest only when the exercise asks for its own', () => {
    const plain = buildWatchPlanPayload(S, '2026-09-21')
    expect(plain.entries[0].warmupRest).toBeUndefined()
    const own = { ...routine, ex: [{ ...routine.ex[0], warmupRestSec: 30 }] }
    const payload = buildWatchPlanPayload({ ...S, routines: [own] }, '2026-09-21')
    expect(payload.entries[0].warmupRest).toBe(30)
  })
  it('carries rid and noProg so a rehab routine stays excluded from progression when logged on the Watch', () => {
    const rehab = { id: 'r2', name: 'Rehab', excludeFromProgression: true, ex: [{ id: 'band-pull', sets: 1, reps: 15, weight: 0 }] }
    const combined = { ...S, routines: [routine, rehab], week: { 1: ['r1', 'r2'] } }
    const payload = buildWatchPlanPayload(combined, '2026-09-21')
    const pushEntry = payload.entries.find(e => e.id === 'bench-press')
    const rehabEntry = payload.entries.find(e => e.id === 'band-pull')
    expect(pushEntry.rid).toBe('r1')
    expect(pushEntry.noProg).toBeUndefined()
    expect(rehabEntry).toMatchObject({ rid: 'r2', noProg: true })
  })
})
