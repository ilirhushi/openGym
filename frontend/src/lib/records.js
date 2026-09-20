// Best-ever value per exercise, independent of the live PR flags set during logging
// (import-csv.js / import-hevy.js always leave `prs: []`), so imported and backfilled
// history still produces personal records.
import { isAssisted } from './exercises.js'
import { metricEntriesForExercise, bestWeightForEntry, completedRepsOf } from './history.js'
import { best1RM } from './onerm.js'

/**
 * Metric data for one exercise in one workout: the mode it was logged in, its completed rows
 * in that mode, and (for reps mode) the best loaded set. Also used by lib/plateaus.js, which
 * needs the same per-session read.
 */
export function metricDataOf(workout, id) {
  const entries = metricEntriesForExercise(workout, id)
  const mode = entries.at(-1)?.mode || null
  const sameMode = entries.filter(item => item.mode === mode)
  const best = mode === 'reps' ? Math.max(0, ...sameMode.map(item => bestWeightForEntry(item.entry))) : 0
  return { mode, entries: sameMode, rows: sameMode.flatMap(item => item.rows), best }
}

export const rowMetric = (mode, row) =>
  mode === 'cardio' ? (row.speed || 0)
    : mode === 'distance' ? (row.m || 0)
      : mode === 'time' ? (row.sec || 0)
        : (row.w || 0)

/**
 * Best-ever value per exercise, with the date it was set. An exercise can appear more than
 * once: a loaded exercise gets both a best top-set-weight record and (when it has one) a best
 * estimated-1RM record, since they can happen on different dates.
 */
export function personalRecords(S) {
  const workouts = S.workouts || []
  const ids = [...new Set(workouts.flatMap(w => (w.entries || []).map(e => e.id)))]
  const out = []
  ids.forEach(id => {
    let bestWeight = null
    let bestReps = null
    let bestOther = null // speed / distance / time
    workouts.forEach(w => {
      const data = metricDataOf(w, id)
      if (!data.mode) return
      const t = w.start || new Date(w.d).getTime()
      if (data.mode === 'reps') {
        if (data.best > 0) {
          const better = isAssisted(id)
            ? (bestWeight == null || data.best < bestWeight.value)
            : (bestWeight == null || data.best > bestWeight.value)
          if (better) bestWeight = { value: data.best, date: w.d, t, metric: 'weight' }
        } else {
          const reps = Math.max(0, ...data.rows.map(completedRepsOf))
          if (reps > 0 && (bestReps == null || reps > bestReps.value)) bestReps = { value: reps, date: w.d, t, metric: 'reps' }
        }
      } else {
        const value = Math.max(0, ...data.rows.map(row => rowMetric(data.mode, row)))
        if (value > 0 && (bestOther == null || value > bestOther.value)) {
          bestOther = { value, date: w.d, t, metric: data.mode === 'cardio' ? 'speed' : data.mode }
        }
      }
    })
    if (bestWeight) out.push({ id, ...bestWeight })
    if (bestReps) out.push({ id, ...bestReps })
    if (bestOther) out.push({ id, ...bestOther })
    const e1 = best1RM(S, id)
    if (e1) out.push({ id, value: e1.est, date: e1.d, t: e1.t, metric: 'e1rm' })
  })
  return out.sort((a, b) => b.t - a.t)
}
