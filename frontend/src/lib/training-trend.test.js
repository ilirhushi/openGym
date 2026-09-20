import { describe, it, expect } from 'vitest'
import { weeklyTrend } from './training-trend.js'
import { MONDAY, SUNDAY } from './format.js'

const at = iso => new Date(iso).getTime()

describe('weeklyTrend', () => {
  it('returns nothing for an empty history', () => {
    expect(weeklyTrend([], 0)).toEqual([])
  })

  it('sums tonnage and counts workouts within the same week', () => {
    const workouts = [
      { d: '2026-09-14', vol: 1000 }, // Monday
      { d: '2026-09-16', vol: 500 },  // Wednesday, same Monday-start week
    ]
    const weekly = weeklyTrend(workouts, 0, MONDAY, at('2026-09-16T12:00:00'))
    expect(weekly).toEqual([{ t: at('2026-09-14T12:00:00'), vol: 1500, count: 2 }])
  })

  it('fills a week with no training as a zero point rather than a gap', () => {
    const workouts = [
      { d: '2026-09-07', vol: 800 }, // week 1 (Monday)
      { d: '2026-09-21', vol: 400 }, // week 3 (Monday), skipping week 2
    ]
    const weekly = weeklyTrend(workouts, 0, MONDAY, at('2026-09-21T12:00:00'))
    expect(weekly.map(w => w.vol)).toEqual([800, 0, 400])
    expect(weekly.map(w => w.count)).toEqual([1, 0, 1])
  })

  it('respects the profile week-start day', () => {
    // 2026-09-20 is a Sunday: a Sunday-start week opens fresh on it; a Monday-start
    // week still counts it as the tail end of the week that began 2026-09-14.
    const workouts = [{ d: '2026-09-16', vol: 100 }, { d: '2026-09-20', vol: 200 }]
    const mondayWeekly = weeklyTrend(workouts, 0, MONDAY, at('2026-09-20T12:00:00'))
    expect(mondayWeekly).toHaveLength(1)
    expect(mondayWeekly[0].vol).toBe(300)
    const sundayWeekly = weeklyTrend(workouts, 0, SUNDAY, at('2026-09-20T12:00:00'))
    expect(sundayWeekly).toHaveLength(2)
  })

  it('limits output to the requested number of trailing weeks', () => {
    const workouts = [
      { d: '2026-08-31', vol: 100 }, // 3 weeks back
      { d: '2026-09-07', vol: 200 }, // 2 weeks back
      { d: '2026-09-14', vol: 300 }, // current week
    ]
    const weekly = weeklyTrend(workouts, 2, MONDAY, at('2026-09-14T12:00:00'))
    expect(weekly.map(w => w.vol)).toEqual([200, 300])
  })

  it('treats a workout with no vol field as zero tonnage without throwing', () => {
    const weekly = weeklyTrend([{ d: '2026-09-14' }], 0, MONDAY, at('2026-09-14T12:00:00'))
    expect(weekly).toEqual([{ t: at('2026-09-14T12:00:00'), vol: 0, count: 1 }])
  })
})
