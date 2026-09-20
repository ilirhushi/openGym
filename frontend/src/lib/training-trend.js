// Weekly training-volume and workout-frequency trend, feeding the Stats page's Training
// Volume card. Reuses each workout's already-computed `vol` (tonnage), no new per-set math.
import { weekKey, startOfWeek, isoOf, MONDAY } from './format.js'

/**
 * Weekly buckets of tonnage and workout count, oldest first.
 * @param {Array} workouts S.workouts
 * @param {number} weeks how many trailing weeks to include, counting back from `now`; 0 or
 *   negative means "all history back to the oldest workout"
 * @param {number} ws week-start day (format.js MONDAY/SUNDAY)
 * @param {number} now current time in ms, injectable for tests
 */
export function weeklyTrend(workouts, weeks, ws = MONDAY, now = Date.now()) {
  const list = workouts || []
  if (!list.length) return []
  const buckets = new Map()
  list.forEach(w => {
    const key = weekKey(w.d, ws)
    const bucket = buckets.get(key) || { vol: 0, count: 0 }
    bucket.vol += Number(w.vol) || 0
    bucket.count += 1
    buckets.set(key, bucket)
  })
  const nowWeekStart = startOfWeek(isoOf(new Date(now)), ws)
  const oldestIso = list.reduce((min, w) => (w.d < min ? w.d : min), list[0].d)
  const oldestWeekStart = startOfWeek(oldestIso, ws)
  const out = []
  const cursor = new Date(nowWeekStart)
  for (let i = 0; weeks <= 0 || i < weeks; i++) {
    if (cursor < oldestWeekStart) break
    const bucket = buckets.get(isoOf(cursor)) || { vol: 0, count: 0 }
    out.unshift({ t: cursor.getTime(), vol: Math.round(bucket.vol * 10) / 10, count: bucket.count })
    cursor.setDate(cursor.getDate() - 7)
  }
  return out
}
