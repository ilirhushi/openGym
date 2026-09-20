// Flags exercises that have stopped improving: reuses the progression engine's own stall
// tracking for exercises it actively manages, and a plain no-new-best rule for everything
// else. Never a second opinion where the engine already has one.
import { isAssisted } from './exercises.js'
import { modeOf, completedRepsOf } from './history.js'
import { sessionsFor, stallCount, policyFor, DELOAD_AFTER } from './progression.js'
import { metricDataOf, rowMetric } from './records.js'

// The first routine (in plan order) that trains this exercise with progression turned on for
// it, i.e. the same policy nextPrescription would use for its next session.
function activePolicyFor(S, exId) {
  for (const routine of S.routines || []) {
    const cfg = (routine.ex || []).find(e => e.id === exId)
    if (!cfg) continue
    const mode = modeOf(cfg)
    const policy = policyFor(cfg, routine, mode)
    if (policy !== 'off') return { cfg, mode, policy }
  }
  return null
}

// Chronological series of this exercise's tracked value: top-set weight, or reps/speed/
// distance/time for exercises that never carry a weight. Restricted to whichever mode the
// most recent session was logged in, so a mode change mid-history does not mix two metrics.
function valueSeriesOf(workouts, exId) {
  const perWorkout = workouts.map(w => metricDataOf(w, exId))
  let mode = null
  for (let i = perWorkout.length - 1; i >= 0; i--) {
    if (perWorkout[i].mode) { mode = perWorkout[i].mode; break }
  }
  if (!mode) return { mode: null, repsOnly: false, points: [] }
  const repsOnly = mode === 'reps' && !perWorkout.some(d => d.mode === 'reps' && d.best > 0)
  const points = []
  workouts.forEach((w, i) => {
    const data = perWorkout[i]
    if (data.mode !== mode) return
    const value = mode === 'reps'
      ? (repsOnly ? Math.max(0, ...data.rows.map(completedRepsOf)) : data.best)
      : Math.max(0, ...data.rows.map(row => rowMetric(mode, row)))
    if (value > 0) points.push(value)
  })
  return { mode, repsOnly, points }
}

// True when no consecutive pair within the last 4 points shows an improvement (per
// higherIsBetter direction) - i.e. the trailing 4 sessions never beat the one right before them.
function isFlatOverLast4(points, higherIsBetter) {
  if (points.length < 4) return false
  const last4 = points.slice(-4)
  for (let i = 1; i < last4.length; i++) {
    const improved = higherIsBetter ? last4[i] > last4[i - 1] : last4[i] < last4[i - 1]
    if (improved) return false
  }
  return true
}

export function stalledExercises(S) {
  const workouts = S.workouts || []
  const ids = [...new Set(workouts.flatMap(w => (w.entries || []).map(e => e.id)))]
  const out = []
  ids.forEach(id => {
    const active = activePolicyFor(S, id)
    if (active) {
      const sessions = sessionsFor(S, id, active.cfg).filter(s => s.mode === active.mode)
      const stalls = stallCount(sessions, active.policy)
      const threshold = DELOAD_AFTER[active.policy] || 3
      if (stalls >= threshold) out.push({ id, kind: 'engine', reason: ['{0} sessions without progressing', stalls] })
      return
    }
    const { mode, repsOnly, points } = valueSeriesOf(workouts, id)
    if (!mode) return
    const higherIsBetter = !(mode === 'reps' && !repsOnly && isAssisted(id))
    if (isFlatOverLast4(points, higherIsBetter)) {
      out.push({ id, kind: 'fallback', reason: ['No improvement in {0} sessions', 4] })
    }
  })
  return out
}
