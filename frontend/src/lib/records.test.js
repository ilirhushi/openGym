import { describe, it, expect } from 'vitest'
import { personalRecords, metricDataOf } from './records.js'
import { EXDB, isAssisted } from './exercises.js'

const LIFT = EXDB.find(e => e.bp !== 'cardio' && !['upper legs', 'lower legs', 'back', 'hips', 'glutes'].includes(e.bp) && !['body weight', 'band', 'resistance band'].includes(e.eq) && !e.n.toLowerCase().includes('assist')).id
const BW_ONLY = EXDB.find(e => e.eq === 'body weight' && !e.n.toLowerCase().includes('assist')).id
const CARDIO = EXDB.find(e => e.bp === 'cardio').id
const ASSISTED = EXDB.find(e => isAssisted(e.id)).id

const w = (id, day, sets, target) => ({ d: day, start: new Date(day).getTime(), entries: [{ id, target, sets }] })

describe('metricDataOf', () => {
  it('reads the best loaded set in a reps-mode workout', () => {
    const workout = w(LIFT, '2026-09-01', [{ w: 60, r: 5, done: true }, { w: 65, r: 3, done: true }], { sets: 2, reps: 5, weight: 60 })
    const data = metricDataOf(workout, LIFT)
    expect(data.mode).toBe('reps')
    expect(data.best).toBe(65)
  })

  it('reports no mode for a workout that never trained the exercise', () => {
    const workout = w(LIFT, '2026-09-01', [{ w: 60, r: 5, done: true }], { sets: 1, reps: 5, weight: 60 })
    expect(metricDataOf(workout, 'some-other-id').mode).toBeNull()
  })
})

describe('personalRecords', () => {
  it('finds the heaviest set ever and the date it happened, not just the most recent', () => {
    const S = {
      workouts: [
        w(LIFT, '2026-09-01', [{ w: 100, r: 5, done: true }], { sets: 1, reps: 5, weight: 100 }),
        w(LIFT, '2026-09-05', [{ w: 90, r: 5, done: true }], { sets: 1, reps: 5, weight: 90 }),
      ]
    }
    const record = personalRecords(S).find(r => r.id === LIFT && r.metric === 'weight')
    expect(record).toEqual({ id: LIFT, value: 100, date: '2026-09-01', t: new Date('2026-09-01').getTime(), metric: 'weight' })
  })

  it('also records the best estimated 1RM, separately from the best top-set weight', () => {
    const S = {
      workouts: [
        w(LIFT, '2026-09-01', [{ w: 100, r: 1, done: true }], { sets: 1, reps: 1, weight: 100 }),
        w(LIFT, '2026-09-05', [{ w: 80, r: 10, done: true }], { sets: 1, reps: 10, weight: 80 }),
      ]
    }
    const records = personalRecords(S).filter(r => r.id === LIFT)
    expect(records.find(r => r.metric === 'weight').value).toBe(100)
    expect(records.find(r => r.metric === 'e1rm').date).toBe('2026-09-05')
  })

  it('records best rep count for a bodyweight-only exercise instead of a weight it never carried', () => {
    const S = {
      workouts: [
        w(BW_ONLY, '2026-09-01', [{ w: 0, r: 8, done: true }], { sets: 1, reps: 8 }),
        w(BW_ONLY, '2026-09-05', [{ w: 0, r: 12, done: true }], { sets: 1, reps: 8 }),
      ]
    }
    const record = personalRecords(S).find(r => r.id === BW_ONLY)
    expect(record).toEqual({ id: BW_ONLY, value: 12, date: '2026-09-05', t: new Date('2026-09-05').getTime(), metric: 'reps' })
  })

  it('records top speed for a cardio exercise', () => {
    const S = {
      workouts: [
        w(CARDIO, '2026-09-01', [{ min: 20, speed: 10, done: true }], { mode: 'cardio' }),
        w(CARDIO, '2026-09-05', [{ min: 20, speed: 12, done: true }], { mode: 'cardio' }),
      ]
    }
    const record = personalRecords(S).find(r => r.id === CARDIO)
    expect(record).toEqual({ id: CARDIO, value: 12, date: '2026-09-05', t: new Date('2026-09-05').getTime(), metric: 'speed' })
  })

  it('treats the smallest assistance weight as the record for an assisted exercise', () => {
    const S = {
      workouts: [
        w(ASSISTED, '2026-09-01', [{ w: 40, r: 5, done: true }], { sets: 1, reps: 5, weight: 40 }),
        w(ASSISTED, '2026-09-05', [{ w: 30, r: 5, done: true }], { sets: 1, reps: 5, weight: 30 }),
      ]
    }
    const record = personalRecords(S).find(r => r.id === ASSISTED && r.metric === 'weight')
    expect(record.value).toBe(30)
    expect(record.date).toBe('2026-09-05')
  })

  it('sorts records most-recently-achieved first across exercises', () => {
    const S = {
      workouts: [
        w(LIFT, '2026-09-01', [{ w: 100, r: 5, done: true }], { sets: 1, reps: 5, weight: 100 }),
        w(BW_ONLY, '2026-09-10', [{ w: 0, r: 8, done: true }], { sets: 1, reps: 8 }),
      ]
    }
    expect(personalRecords(S)[0].id).toBe(BW_ONLY)
  })

  it('produces no records from a workout with no completed sets', () => {
    const S = { workouts: [w(LIFT, '2026-09-01', [{ w: 100, r: 5, done: false }], { sets: 1, reps: 5, weight: 100 })] }
    expect(personalRecords(S).find(r => r.id === LIFT)).toBeUndefined()
  })
})
