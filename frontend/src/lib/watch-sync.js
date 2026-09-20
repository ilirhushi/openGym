// The slim, phase-1 projection of "today's plan" sent to the Watch (design doc §4.2). Reuses
// the exact same routine-resolution and last-time lookups the phone session screen uses — this
// is a smaller view of the same data, not a second implementation of it. Drop-sets, rest-pause,
// and per-side sets are flattened to a straight row: the Watch does not support them in phase 1
// (see the design doc §8), so a routine that plans one still gets a startable Watch session.
import { effectiveRoutineIds, lastEntryFor, bestWeightForEntry } from './history.js'
import { buildCombinedEntries, deriveSessionName } from './session-merge.js'
import { exOr } from './exercises.js'
import { phaseForSet } from './workout-model.js'
import { todayISO } from './format.js'

export function flattenSetForWatch(set) {
  const phase = phaseForSet(set)
  if (set.min != null || set.speed != null) return { phase, min: set.min, speed: set.speed, done: false }
  if (set.sec != null) return { phase, sec: set.sec, w: set.w || 0, done: false }
  return { phase, w: set.w || 0, r: set.r || 0, done: false }
}

/** Today's (or `iso`'s) plan, shaped for the Watch. Null when nothing is scheduled that day. */
export function buildWatchPlanPayload(S, iso = todayISO()) {
  const routineIds = effectiveRoutineIds(S, iso)
  if (!routineIds.length) return null
  const { entries, routineIds: rids, routines } = buildCombinedEntries(S, routineIds)
  if (!entries.length) return null
  return {
    date: iso,
    routineIds: rids,
    name: deriveSessionName(routines.map(r => r.name)),
    // The Watch has no other way to know this: it renders a weight beside a unit label and
    // nothing else crosses the WatchConnectivity boundary. Defaulted rather than passed through
    // bare so a state written before the unit setting existed labels sets "kg" (the app's own
    // default) instead of leaving the Watch with an empty label.
    unit: S.unit === 'lb' ? 'lb' : 'kg',
    entries: entries.map(entry => {
      const last = lastEntryFor(S, entry.id)
      return {
        id: entry.id,
        label: exOr(entry.id).n,
        target: entry.target,
        lastTime: last ? { d: last.d, w: bestWeightForEntry({ target: last.target, sets: last.sets }) || null } : null,
        sets: entry.sets.map(flattenSetForWatch),
        // Round-tripped opaque to the Watch (never read there — see WatchEntry) and read back on
        // return: buildCompletedWorkout freezes noProg per entry at finish time (progression.js's
        // "which routine counts" rule), and rid is which routine a multi-routine day's entry came
        // from. Dropping either on the Watch trip would unfreeze a rehab-routine entry's
        // exclusion, or lose which routine a combined session's entry belongs to.
        ...(entry.rid ? { rid: entry.rid } : {}),
        ...(entry.noProg === true ? { noProg: true } : {}),
      }
    }),
    activeOnPhone: !!S.active,
  }
}
