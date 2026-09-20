// Every decision the Apple Health integration makes lives here: whether a finished workout may
// be written at all, what kind of workout it is, and whether a body-weight reading is fresh
// enough to prefill with. See docs/superpowers/specs/2026-09-20-health-integration-design.md.
//
// This file imports nothing, on purpose. The native plugin (Health.swift) is transport only and
// holds no branching logic, because there is no Swift test harness anywhere in this repo, so
// anything decided in Swift is decided untested. Keeping the policy here keeps it covered.

// How stale a Health body-weight reading may be and still prefill the weigh-in. A day and a
// half covers "weighed myself this morning, training tonight" and an overnight scale sync,
// while still refusing to put last week's number in front of someone as if it were today's.
export const HEALTH_BW_MAX_AGE_MS = 36 * 60 * 60 * 1000

// Tolerance for a reading timestamped slightly ahead of this device's clock: scales and phones
// disagree by seconds routinely. Beyond this the timestamp is not trustworthy enough to use.
const CLOCK_SKEW_MS = 5 * 60 * 1000

// `!= null` rather than truthiness on purpose: a zero-minute or zero-speed row is still a cardio
// row, and treating it as strength would flip the type of a whole session on one empty field.
// This is deliberately the same discriminator, spelled the same way, as the ones in
// watch-sync.js and workout-model.js. Keep the three identical.
const isCardioSet = s => !!s && (s.min != null || s.speed != null)

/**
 * May this finished workout be written to Health?
 *
 * `past` is a backfilled session, `fromWatch` a session logged on the Apple Watch, and
 * `healthSaved` whether that Watch already saved the HKWorkout itself. The invariant across all
 * of it is exactly one health record per session, never zero and never two (spec section 5.2).
 */
/*
 * On the write sites (spec section 8, spec section 3.4): only `past` is enforced here, because
 * only backfill reaches this function at all. The other three sites that spec section 3.4 rules
 * out, session-edit.js, CSV/Hevy import and demo seeding, are blocked structurally: none of them
 * imports health-bridge.js, so none of them has a way to write to Health even if it wanted to.
 * That is a stronger guarantee than a flag check, and an invisible one: a refactor that "just
 * reuses the finish hook" for any of those three would silently undo it, with no test failing,
 * because the guarantee lives in the import graph rather than in this signature.
 */
export function shouldWriteWorkout({ enabled = false, past = false, fromWatch = false, healthSaved = false } = {}) {
  if (!enabled) return false
  // A backfill would rewrite the user's Health history retroactively, and an edit would mean
  // deleting a health record openGym previously wrote. Neither is ours to do (spec section 3.4).
  if (past) return false
  if (fromWatch) return !healthSaved
  return true
}

/** 'cardio' only when every completed set is cardio-shaped; a mixed session is strength, because
 * splitting it would mean writing two health records for one workout (spec section 5.1). */
export function workoutHealthType(w) {
  const sets = (w?.entries || []).flatMap(e => (e?.sets || []).filter(s => s && s.done))
  if (!sets.length) return 'strength'
  return sets.every(isCardioSet) ? 'cardio' : 'strength'
}

/** The descriptor handed to the native layer, or null when there is nothing worth writing.
 * Deliberately not HealthKit-shaped: 'strength'/'cardio' are openGym's words, mapped to platform
 * enums inside Health.swift, so this stays testable and a future Health Connect implementation
 * shares the same seam. */
export function healthWorkoutPayload(w) {
  if (!w || !(w.entries || []).length) return null
  if (!Number.isFinite(w.start) || !Number.isFinite(w.end) || w.end <= w.start) return null
  return {
    start: w.start,
    end: w.end,
    type: workoutHealthType(w),
    title: w.name || '',
    id: w.id,
  }
}

/**
 * The kilogram value to prefill the weigh-in with, or null to leave it alone.
 *
 * Returns kilograms and never converts: kg is the unit at the native boundary, and lib/units.js
 * owns display conversion everywhere else in the app (spec section 5.4). A null `read` covers
 * both "permission denied" and "no data", which HealthKit deliberately makes indistinguishable
 * (spec section 6.2), and both mean the same thing here.
 */
export function bodyWeightPrefill(read, { now = Date.now(), maxAgeMs = HEALTH_BW_MAX_AGE_MS } = {}) {
  if (!read) return null
  const kg = Number(read.kg)
  if (!Number.isFinite(kg) || kg <= 0) return null
  if (!Number.isFinite(read.at)) return null
  if (now - read.at > maxAgeMs) return null
  if (read.at - now > CLOCK_SKEW_MS) return null
  return kg
}

/**
 * Should the phone write the health record for an incoming Apple Watch session?
 *
 * The routing rule is "an absent `health` key means the Watch could not save it, so the phone
 * must" (spec section 5.2), and that rule reads a field off the raw sync-back payload. It lives
 * here rather than inline at the import site so a typo in the path, or a later rename of the
 * field, fails a test instead of silently routing every Watch session to zero records or two.
 */
export function shouldPhoneWriteWatchWorkout(payload, enabled = false) {
  return shouldWriteWorkout({
    enabled,
    fromWatch: true,
    healthSaved: payload?.health?.saved === true,
  })
}
