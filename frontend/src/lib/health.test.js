import { describe, expect, it } from 'vitest'
import {
  shouldWriteWorkout, workoutHealthType, healthWorkoutPayload,
  bodyWeightPrefill, shouldPhoneWriteWatchWorkout, HEALTH_BW_MAX_AGE_MS,
} from './health.js'

const workout = (over = {}) => ({
  id: 'wk_1', name: 'Push Day', start: 1000, end: 2000,
  entries: [{ id: 'bench', sets: [{ phase: 'work', w: 60, r: 8, done: true }] }],
  ...over,
})

describe('shouldWriteWorkout', () => {
  it('writes a live phone finish when the setting is on', () => {
    expect(shouldWriteWorkout({ enabled: true })).toBe(true)
  })
  it('writes nothing at all when the setting is off', () => {
    expect(shouldWriteWorkout({ enabled: false })).toBe(false)
    expect(shouldWriteWorkout({ enabled: false, fromWatch: true, healthSaved: false })).toBe(false)
  })
  it('never writes a backfilled past workout', () => {
    expect(shouldWriteWorkout({ enabled: true, past: true })).toBe(false)
  })
  it('skips a Watch session the Watch already saved', () => {
    expect(shouldWriteWorkout({ enabled: true, fromWatch: true, healthSaved: true })).toBe(false)
  })
  // The row that encodes the one-record-per-session invariant (spec section 5.2): the Watch ran
  // the session but could not save it, so the phone is the only side left that can.
  it('writes a Watch session the Watch failed to save', () => {
    expect(shouldWriteWorkout({ enabled: true, fromWatch: true, healthSaved: false })).toBe(true)
  })
  it('defaults every optional flag to the safe reading', () => {
    expect(shouldWriteWorkout({})).toBe(false)
  })
})

describe('workoutHealthType', () => {
  it('calls an all-cardio session cardio', () => {
    expect(workoutHealthType(workout({ entries: [
      { id: 'run', sets: [{ phase: 'work', min: 30, speed: 10, done: true }] },
    ] }))).toBe('cardio')
  })
  it('calls a mixed session strength rather than splitting it', () => {
    expect(workoutHealthType(workout({ entries: [
      { id: 'run', sets: [{ phase: 'work', min: 10, done: true }] },
      { id: 'bench', sets: [{ phase: 'work', w: 60, r: 8, done: true }] },
    ] }))).toBe('strength')
  })
  it('ignores sets that were never completed', () => {
    expect(workoutHealthType(workout({ entries: [
      { id: 'run', sets: [{ phase: 'work', min: 10, done: true }, { phase: 'work', w: 60, r: 8, done: false }] },
    ] }))).toBe('cardio')
  })
  it('falls back to strength when nothing was completed', () => {
    expect(workoutHealthType(workout({ entries: [] }))).toBe('strength')
  })
})

describe('healthWorkoutPayload', () => {
  it('projects the fields HealthKit needs and nothing else', () => {
    expect(healthWorkoutPayload(workout())).toEqual({
      start: 1000, end: 2000, type: 'strength', title: 'Push Day', id: 'wk_1',
    })
  })
  it('returns null for a workout with no entries', () => {
    expect(healthWorkoutPayload(workout({ entries: [] }))).toBeNull()
  })
  it('returns null when the time window is missing or inverted', () => {
    expect(healthWorkoutPayload(workout({ end: null }))).toBeNull()
    expect(healthWorkoutPayload(workout({ start: 2000, end: 1000 }))).toBeNull()
    expect(healthWorkoutPayload(workout({ start: 1000, end: 1000 }))).toBeNull()
  })
  it('tolerates a nameless session', () => {
    expect(healthWorkoutPayload(workout({ name: null })).title).toBe('')
  })
  it('returns null for nothing', () => {
    expect(healthWorkoutPayload(null)).toBeNull()
  })
})

describe('bodyWeightPrefill', () => {
  const now = 1_000_000_000
  it('returns the reading in kilograms, unconverted', () => {
    expect(bodyWeightPrefill({ kg: 82.4, at: now - 1000 }, { now })).toBe(82.4)
  })
  it('drops a reading older than the staleness window', () => {
    expect(bodyWeightPrefill({ kg: 82.4, at: now - HEALTH_BW_MAX_AGE_MS - 1 }, { now })).toBeNull()
  })
  it('keeps a reading exactly at the window edge', () => {
    expect(bodyWeightPrefill({ kg: 82.4, at: now - HEALTH_BW_MAX_AGE_MS }, { now })).toBe(82.4)
  })
  // A read that failed and a read that found nothing are indistinguishable through HealthKit
  // (spec section 6.2), so both arrive here as null and both mean "do not prefill".
  it('returns null for a null read', () => {
    expect(bodyWeightPrefill(null, { now })).toBeNull()
  })
  it('rejects nonsense values', () => {
    expect(bodyWeightPrefill({ kg: 0, at: now }, { now })).toBeNull()
    expect(bodyWeightPrefill({ kg: -5, at: now }, { now })).toBeNull()
    expect(bodyWeightPrefill({ kg: 'heavy', at: now }, { now })).toBeNull()
    expect(bodyWeightPrefill({ kg: 82, at: null }, { now })).toBeNull()
  })
  it('rejects a reading dated in the future beyond clock tolerance', () => {
    expect(bodyWeightPrefill({ kg: 82, at: now + 10 * 60 * 1000 }, { now })).toBeNull()
  })
})

// The routing rule applied to the raw Watch sync-back payload. These rows exist because the
// field path is the part that can rot: `payload.health?.saved` against `payload?.health?.saved`,
// or a rename on the Swift side, would otherwise route every Watch session wrong with nothing
// failing (spec section 5.2).
describe('shouldPhoneWriteWatchWorkout', () => {
  it('writes when the payload carries no health key at all: the Watch never saved one', () => {
    expect(shouldPhoneWriteWatchWorkout({ watchSessionId: 'w1' }, true)).toBe(true)
  })
  it('does not write when the Watch already saved the record', () => {
    expect(shouldPhoneWriteWatchWorkout({ health: { saved: true, avgHr: 142 } }, true)).toBe(false)
  })
  it('writes when the Watch ran sensors but failed to save', () => {
    expect(shouldPhoneWriteWatchWorkout({ health: { saved: false, avgHr: 142 } }, true)).toBe(true)
  })
  // Same answer as an absent key, which is the safe direction: one record rather than none.
  it('treats a missing payload as "no health key" instead of throwing', () => {
    expect(shouldPhoneWriteWatchWorkout(null, true)).toBe(true)
    expect(shouldPhoneWriteWatchWorkout(undefined, true)).toBe(true)
  })
  it('never writes with the toggle off, whatever the payload says', () => {
    expect(shouldPhoneWriteWatchWorkout({ watchSessionId: 'w1' }, false)).toBe(false)
    expect(shouldPhoneWriteWatchWorkout({ health: { saved: false } }, false)).toBe(false)
    expect(shouldPhoneWriteWatchWorkout(null, false)).toBe(false)
  })
})
