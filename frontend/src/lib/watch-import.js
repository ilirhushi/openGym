// Folding a session logged on the Watch back into the phone's history, the design doc's "phone
// always finishes the workout" decision (§3). This deliberately does NOT reuse the backfill
// machinery's PR/exWeights suppression (lib/backfill.js completeBackfill, via sheets.jsx
// doFinishWorkout's `past` branch): a workout logged on the Watch happened today, same as a
// workout logged live on the phone, so it earns PRs and updates exWeights the same way a live
// finish does. Only the "is there already a workout this day" splice logic is shared, via
// insertChronological.
import { buildCompletedWorkout } from './finish-workout.js'
import { insertChronological } from './backfill.js'
import { bestWeightFor, bestWeightForEntry, workoutVolume } from './history.js'
import { isWarmupRow } from './workout-model.js'
import { is1RMRecord } from './onerm.js'

/** Shape a Watch payload (Task 1's counterpart, sent back from the Watch) as an "active"
 * session, the same shape buildCompletedWorkout expects from a live/backfilled phone session. */
export function activeFromWatchPayload(payload) {
  return {
    id: payload.watchSessionId,
    d: payload.date,
    start: payload.start,
    routineIds: payload.routineIds || [],
    name: payload.name,
    bw: null,
    entries: payload.entries,
  }
}

/** Same PR/estimated-1RM-record logic as sheets.jsx doFinishWorkout's live-finish branch. */
export function computeWatchPRs(st, active) {
  const prs = []
  const e1prs = []
  active.entries.forEach(e => {
    const mx = Math.max(0, ...e.sets.filter(s => s.done && !isWarmupRow(s)).map(s => s.w || 0))
    if (mx > 0 && mx > bestWeightFor(st, e.id)) prs.push(e.id)
    const rec = is1RMRecord(st, e.id, e)
    if (rec && !prs.includes(e.id)) e1prs.push({ id: e.id, ...rec })
  })
  return { prs, e1prs }
}

/**
 * Fold one completed Watch session into `st.workouts` / `st.exWeights`.
 * `replaceId`, when given (the user's choice in the same-day merge sheet — Task 3), is an
 * existing same-day workout to overwrite; omitted, the session is inserted alongside whatever
 * is already on that day, in chronological order (insertChronological).
 * Returns the pieces the store needs to apply, pure, no store access. Returns null when nothing
 * was actually logged (Start tapped, then Finish with no set checked off) — buildCompletedWorkout
 * already drops every entry with no completed work, so an all-empty session would otherwise
 * insert a phantom zero-set workout into history with nothing to show for it.
 */
export function finishWatchSession(st, payload, { replaceId = null } = {}) {
  const active = activeFromWatchPayload(payload)
  const { prs, e1prs } = computeWatchPRs(st, active)
  const w = buildCompletedWorkout(active, { end: payload.end, prs })
  if (!w.entries.length) return null
  w.vol = workoutVolume(w)
  // What the Watch's HKWorkoutSession measured, when there was one. Written only when there is
  // at least one figure, matching the convention buildCompletedWorkout already follows for rid,
  // noProg and note: an ordinary session stays byte-for-byte the shape it always was, and older
  // profiles read back identically. `saved` is deliberately not stored: it is a fact about the
  // Health write, consumed at import time, not a property of the workout.
  const hr = {}
  if (Number.isFinite(payload.health?.avgHr)) hr.avg = payload.health.avgHr
  if (Number.isFinite(payload.health?.maxHr)) hr.max = payload.health.maxHr
  if (Number.isFinite(payload.health?.kcal)) hr.kcal = payload.health.kcal
  if (Object.keys(hr).length) w.hr = hr
  const kept = replaceId ? st.workouts.filter(x => x.id !== replaceId) : st.workouts
  const workouts = insertChronological(kept, w)
  const exWeights = { ...st.exWeights }
  w.entries.forEach(e => {
    const mx = bestWeightForEntry(e)
    if (mx > 0) {
      const cur = exWeights[e.id]
      if (!cur || mx > cur.w) exWeights[e.id] = { w: mx, d: w.d }
    }
  })
  return { workouts, exWeights, w, prs, e1prs }
}
