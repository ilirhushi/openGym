import { describe, it, expect } from 'vitest'
import { stalledExercises } from './plateaus.js'
import { EXDB, isAssisted } from './exercises.js'

const LIFT = EXDB.find(e => e.bp !== 'cardio' && !['upper legs', 'lower legs', 'back', 'hips', 'glutes'].includes(e.bp) && !['body weight', 'band', 'resistance band'].includes(e.eq) && !e.n.toLowerCase().includes('assist')).id
const BW_ONLY = EXDB.find(e => e.eq === 'body weight' && !e.n.toLowerCase().includes('assist')).id
const ASSISTED = EXDB.find(e => isAssisted(e.id)).id

const workoutFor = (id, day, sets, target) => ({
  d: day, start: new Date(day).getTime(), entries: [{ id, target, sets }]
})

describe('stalledExercises: engine-tracked path (active routine progression)', () => {
  it('flags an exercise whose linear progression has missed reps 3 sessions running', () => {
    const target = { sets: 3, reps: 5, weight: 60 }
    const miss = [{ w: 60, r: 5, done: true }, { w: 60, r: 5, done: true }, { w: 60, r: 3, done: true }]
    const S = {
      routines: [{ id: 'r1', ex: [{ id: LIFT, prog: 'linear' }] }],
      workouts: [
        workoutFor(LIFT, '2026-09-01', miss, target),
        workoutFor(LIFT, '2026-09-03', miss, target),
        workoutFor(LIFT, '2026-09-05', miss, target),
      ]
    }
    const flagged = stalledExercises(S).find(f => f.id === LIFT)
    expect(flagged).toBeTruthy()
    expect(flagged.kind).toBe('engine')
    expect(flagged.reason).toEqual(['{0} sessions without progressing', 3])
  })

  it('does not flag an exercise that is still hitting its reps', () => {
    const target = { sets: 3, reps: 5, weight: 60 }
    const hit = [{ w: 60, r: 5, done: true }, { w: 60, r: 5, done: true }, { w: 60, r: 5, done: true }]
    const S = {
      routines: [{ id: 'r1', ex: [{ id: LIFT, prog: 'linear' }] }],
      workouts: [workoutFor(LIFT, '2026-09-01', hit, target)]
    }
    expect(stalledExercises(S).find(f => f.id === LIFT)).toBeUndefined()
  })

  it('falls back to the plain rule when the routine entry has progression turned off', () => {
    const target = { sets: 1, reps: 5, weight: 60 }
    const flat = [{ w: 60, r: 5, done: true }]
    const S = {
      routines: [{ id: 'r1', ex: [{ id: LIFT, prog: 'off' }] }],
      workouts: [1, 2, 3, 4].map(n => workoutFor(LIFT, `2026-09-0${n}`, flat, target))
    }
    const flagged = stalledExercises(S).find(f => f.id === LIFT)
    expect(flagged.kind).toBe('fallback')
  })
})

describe('stalledExercises: fallback path (no active routine progression)', () => {
  it('flags an exercise with no new best in its last 4 sessions', () => {
    const weights = [100, 105, 100, 100, 100]
    const S = {
      routines: [],
      workouts: weights.map((wt, i) => workoutFor(LIFT, `2026-09-0${i + 1}`, [{ w: wt, r: 5, done: true }], { sets: 1, reps: 5, weight: wt }))
    }
    const flagged = stalledExercises(S).find(f => f.id === LIFT)
    expect(flagged).toBeTruthy()
    expect(flagged.kind).toBe('fallback')
    expect(flagged.reason).toEqual(['No improvement in {0} sessions', 4])
  })

  it('does not flag an exercise that set a new best within its last 4 sessions', () => {
    const weights = [100, 100, 100, 105]
    const S = {
      routines: [],
      workouts: weights.map((wt, i) => workoutFor(LIFT, `2026-09-0${i + 1}`, [{ w: wt, r: 5, done: true }], { sets: 1, reps: 5, weight: wt }))
    }
    expect(stalledExercises(S).find(f => f.id === LIFT)).toBeUndefined()
  })

  it('never flags an exercise with fewer than 4 logged sessions', () => {
    const S = {
      routines: [],
      workouts: [1, 2, 3].map(n => workoutFor(LIFT, `2026-09-0${n}`, [{ w: 100, r: 5, done: true }], { sets: 1, reps: 5, weight: 100 }))
    }
    expect(stalledExercises(S).find(f => f.id === LIFT)).toBeUndefined()
  })

  it('treats a lower assistance weight as the improvement it is for an assisted exercise', () => {
    const weights = [40, 40, 40, 30]
    const S = {
      routines: [],
      workouts: weights.map((wt, i) => workoutFor(ASSISTED, `2026-09-0${i + 1}`, [{ w: wt, r: 5, done: true }], { sets: 1, reps: 5, weight: wt }))
    }
    expect(stalledExercises(S).find(f => f.id === ASSISTED)).toBeUndefined()
  })

  it('treats more reps, not more weight, as the improvement for a bodyweight-only exercise', () => {
    const reps = [8, 8, 8, 10]
    const S = {
      routines: [],
      workouts: reps.map((r, i) => workoutFor(BW_ONLY, `2026-09-0${i + 1}`, [{ w: 0, r, done: true }], { sets: 1, reps: 8 }))
    }
    expect(stalledExercises(S).find(f => f.id === BW_ONLY)).toBeUndefined()
  })
})
