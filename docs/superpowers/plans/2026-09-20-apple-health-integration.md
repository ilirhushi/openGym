# Apple Health Integration and Watch Heart-Rate Tracking Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** On the Capacitor iOS build, finishing a workout writes it to Apple Health, the Apple Watch companion runs a real `HKWorkoutSession` so wrist-logged sessions capture heart rate and active energy, and the weigh-in prompt prefills from Health.

**Architecture:** All policy (whether to write, what type, whether a body-weight reading is fresh enough) lives in `frontend/src/lib/health.js`, a pure helper with unit tests. A locally written Capacitor plugin (`Health.swift`) is transport only and contains no decision logic, because this repo has no Swift test harness. On watchOS the Watch owns its own `HKWorkoutSession` and saves the `HKWorkout` itself, reporting back through one new optional field on the existing sync-back payload so the phone knows not to write a second record.

**Tech Stack:** React 19 + Vite, Zustand, Vitest, Capacitor 6 (iOS), Swift/SwiftUI, HealthKit, WatchConnectivity. No new npm dependency. No new native dependency (HealthKit ships with the OS).

**Spec:** `docs/superpowers/specs/2026-09-20-health-integration-design.md`

## Global Constraints

- **No new npm dependencies.** CONTRIBUTING.md treats this as a hard constraint, not a preference. Frontend is React + Router + Zustand and nothing else.
- **No new native dependencies.** HealthKit ships with iOS. Do not add CocoaPods entries.
- **No linter or formatter is configured.** Match surrounding style by hand: two-space indent, no semicolons in JS, single quotes.
- **Anything deciding what gets recorded is a pure helper in `frontend/src/lib/` with a `*.test.js` beside it** (CONTRIBUTING.md). Native files must contain no such decision.
- **iOS only.** Android Health Connect is explicitly deferred (spec §10.1). Do not add Android code, Gradle entries, or `isAndroid()` branches for health.
- **Health data must never reach openGym's server** on any deployment. Nothing added here may go through `lib/api.js` or `pushState`.
- **Only a live phone finish writes to Health.** Backfill, workout edits, CSV/Hevy import and demo seed must not (spec §3.4).
- **Never use em dashes** in code, comments, commit messages or docs.
- **Commit message style:** sentence case, no `feat:`/`fix:` prefixes. Match existing history, for example "Add design spec for Stats page progress cards".
- **New UI strings:** `t('...')` falls back to English when a locale pack lacks the key. `lib/locale-coverage.test.js` gates only two specific pre-existing keys, so new strings do not break it and do not require translating into every locale in this plan.
- **Run tests from `frontend/`:** `npm test` runs the whole suite, `npx vitest run src/lib/health.test.js` runs one file.

---

## File Structure

| File | Status | Responsibility |
| --- | --- | --- |
| `frontend/src/lib/health.js` | create | All policy. Pure. Imports nothing native and nothing from the store. |
| `frontend/src/lib/health.test.js` | create | Unit tests for the above. |
| `frontend/src/lib/health-bridge.js` | create | Boxed Capacitor plugin access plus the device-local last-write status file. No policy. |
| `frontend/src/lib/health-bridge.proxy.test.js` | create | Regression cover for the Capacitor proxy thenable trap. |
| `frontend/ios/App/App/Health.swift` | create | HealthKit transport: permissions, save workout, read body mass. |
| `frontend/ios/App/App/Health.m` | create | ObjC bridge registering the plugin and its methods. |
| `frontend/ios/App/WatchApp/WatchHealthSession.swift` | create | Owns the `HKWorkoutSession` and `HKLiveWorkoutBuilder` lifecycle on the Watch, including degraded start and orphan recovery. |
| `frontend/src/lib/watch-import.js` | modify | Carry the Watch's heart-rate summary onto the workout record. |
| `frontend/src/sheets.jsx` | modify | The single finish hook, the Watch-import fallback write, and the weigh-in prefill. |
| `frontend/src/views/Settings.jsx` | modify | Opt-in toggle and passive last-write status line. |
| `frontend/src/store/useStore.js` | modify | One new default (`health: false`). |
| `frontend/ios/App/WatchApp/WatchSessionStore.swift` | modify | New `health` field on the session struct, and wiring to `WatchHealthSession`. |
| `docs/MOBILE.md` | modify | Record the HealthKit capability requirement and the free-signing finding. |

**Deviation from spec §4.1, deliberate:** the spec listed the `HKWorkoutSession` lifecycle as an edit to `WatchSessionStore.swift`. This plan puts it in a new `WatchHealthSession.swift` instead. `WatchSessionStore` is currently a focused 135-line persistence object, and folding a HealthKit state machine with its own delegate callbacks and recovery path into it would give one file two unrelated responsibilities. `WatchSessionStore` keeps owning session data; `WatchHealthSession` owns HealthKit.

---

### Task 1: Health policy helper

This is the only file in the feature that makes decisions. Everything else is transport or wiring.

**Files:**
- Create: `frontend/src/lib/health.js`
- Test: `frontend/src/lib/health.test.js`

**Interfaces:**
- Consumes: nothing. This file imports nothing at all, which is what keeps it trivially testable.
- Produces:
  - `shouldWriteWorkout({ enabled, past, fromWatch, healthSaved }) -> boolean`
  - `workoutHealthType(w) -> 'strength' | 'cardio'`
  - `healthWorkoutPayload(w) -> { start: number, end: number, type: string, title: string, id: string } | null`
  - `bodyWeightPrefill(read, { now, maxAgeMs }) -> number | null` (kilograms, never converted)
  - `HEALTH_BW_MAX_AGE_MS` (number)

- [ ] **Step 1: Write the failing tests**

Create `frontend/src/lib/health.test.js`:

```js
import { describe, expect, it } from 'vitest'
import {
  shouldWriteWorkout, workoutHealthType, healthWorkoutPayload,
  bodyWeightPrefill, HEALTH_BW_MAX_AGE_MS,
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
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd frontend && npx vitest run src/lib/health.test.js`
Expected: FAIL, "Failed to resolve import ./health.js".

- [ ] **Step 3: Write the implementation**

Create `frontend/src/lib/health.js`:

```js
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

const isCardioSet = s => !!s && (s.min != null || s.speed != null)

/**
 * May this finished workout be written to Health?
 *
 * `past` is a backfilled session, `fromWatch` a session logged on the Apple Watch, and
 * `healthSaved` whether that Watch already saved the HKWorkout itself. The invariant across all
 * of it is exactly one health record per session, never zero and never two (spec section 5.2).
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
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd frontend && npx vitest run src/lib/health.test.js`
Expected: PASS, all tests green.

- [ ] **Step 5: Run the full suite to confirm nothing regressed**

Run: `cd frontend && npm test`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add frontend/src/lib/health.js frontend/src/lib/health.test.js
git commit -m "Add pure Apple Health policy helper with tests"
```

---

### Task 2: Health plugin bridge

Transport and the device-local status file. No decisions here.

**Files:**
- Create: `frontend/src/lib/health-bridge.js`
- Test: `frontend/src/lib/health-bridge.proxy.test.js`

**Interfaces:**
- Consumes: `MOBILE`, `readJsonFile`, `writeJsonFile` from `./mobile.js` (all already exported).
- Produces:
  - `requestHealthPermissions() -> Promise<{ write: boolean } | null>`
  - `saveHealthWorkout(descriptor) -> Promise<boolean>`
  - `readLatestBodyWeight() -> Promise<{ kg: number, at: number } | null>`
  - `getHealthAuth() -> Promise<{ write: boolean } | null>`
  - `readHealthStatus() -> Promise<{ ok: boolean, at: number } | null>`

**Why the odd-looking plugin box:** `registerPlugin()` returns a Proxy whose get-trap answers every property name, `then` included, with a native-method wrapper that drops the callbacks it is handed. Letting that Proxy become a promise's own resolution value makes the promise never settle, and the await hangs forever with no error and no failed native call to see. This repo has hit that bug twice already (issues #42, #58, see `coach-secrets.js` and `watch-bridge.js`). Copy the boxed `{ p }` pattern exactly.

- [ ] **Step 1: Write the failing test**

Create `frontend/src/lib/health-bridge.proxy.test.js`:

```js
// Regression cover for the Capacitor proxy thenable trap, the bug that made the entire Watch
// feature inert on a real iPhone while every unit test passed. registerPlugin() hands back a
// Proxy whose get-trap answers EVERY property name (`then` included) with a native-method
// wrapper that drops its callbacks, so a promise resolving to the proxy never settles. See
// watch-bridge.proxy.test.js, coach-secrets.js, and issues #42 and #58.
import { describe, expect, it, vi, beforeEach } from 'vitest'

vi.mock('./mobile.js', () => ({
  MOBILE: true,
  readJsonFile: async () => null,
  writeJsonFile: async () => {},
}))

const accessed = []

vi.mock('@capacitor/core', () => ({
  registerPlugin: () => new Proxy({}, {
    get(_, prop) {
      accessed.push(prop)
      switch (prop) {
        // The two names the real proxy special-cases, and the only two.
        case '$$typeof': return undefined
        case 'toJSON': return () => ({})
        default:
          return (...args) => {
            if (prop === 'requestPermissions') return Promise.resolve({ write: true })
            if (prop === 'getAuth') return Promise.resolve({ write: true })
            if (prop === 'saveWorkout') return Promise.resolve({ ok: true })
            if (prop === 'readLatestBodyWeight') return Promise.resolve({ kg: 82.4, at: 1000 })
            // An undeclared method, `then` above all, reaches native as nothing at all and
            // returns a promise that never settles.
            return new Promise(() => {})
          }
      }
    },
  }),
}))

// A hang must fail loudly rather than stall the suite until vitest's own timeout makes it look
// like an unrelated flake.
const within = (promise, ms = 1000) => Promise.race([
  promise,
  new Promise((_, reject) => setTimeout(() => reject(new Error(`hung: did not settle within ${ms}ms`)), ms)),
])

describe('health-bridge never lets the Capacitor proxy become a promise value', () => {
  beforeEach(() => { accessed.length = 0 })

  it('requestHealthPermissions() resolves instead of hanging', async () => {
    const { requestHealthPermissions } = await import('./health-bridge.js')
    await expect(within(requestHealthPermissions())).resolves.toEqual({ write: true })
  })

  it('saveHealthWorkout() reaches the native call and reports success', async () => {
    const { saveHealthWorkout } = await import('./health-bridge.js')
    await expect(within(saveHealthWorkout({
      start: 1, end: 2, type: 'strength', title: 'Push Day', id: 'wk_1',
    }))).resolves.toBe(true)
    expect(accessed).toContain('saveWorkout')
  })

  it('readLatestBodyWeight() resolves with the native reading', async () => {
    const { readLatestBodyWeight } = await import('./health-bridge.js')
    await expect(within(readLatestBodyWeight())).resolves.toEqual({ kg: 82.4, at: 1000 })
  })

  it('never reads `then` off the proxy (the trap itself)', async () => {
    const { getHealthAuth } = await import('./health-bridge.js')
    await within(getHealthAuth())
    expect(accessed).not.toContain('then')
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd frontend && npx vitest run src/lib/health-bridge.proxy.test.js`
Expected: FAIL, "Failed to resolve import ./health-bridge.js".

- [ ] **Step 3: Write the implementation**

Create `frontend/src/lib/health-bridge.js`:

```js
// Transport for the Apple Health integration: the native plugin plus the device-local record of
// how the last write went. Every decision lives in lib/health.js instead, so this file has no
// branching beyond "is there a plugin at all".
import { MOBILE, readJsonFile, writeJsonFile } from './mobile.js'

const STATUS_FILE = 'opengym-health-status.json'

// The loaded plugin travels inside a plain object, never as a promise's own value. Capacitor's
// registerPlugin() hands out a Proxy whose get-trap answers EVERY property name with a
// native-method wrapper, `then` included (it special-cases only `$$typeof` and `toJSON`). A
// promise that resolves to the proxy itself therefore takes it for a thenable and calls
// proxy.then(resolve, reject); that wrapper drops both callbacks, so the promise never settles
// and the await hangs forever with no error and no failed native call to see. Identical box, and
// identical reason, to watch-bridge.js and coach-secrets.js (issues #42, #58).
//
// This applies to an `async function`'s return value too, not only an explicit .then(), hence a
// plain function rather than an async one.
let pluginPromise = null
function plugin() {
  if (!MOBILE) return Promise.resolve({ p: null })
  if (!pluginPromise) {
    pluginPromise = import('@capacitor/core')
      .then(({ registerPlugin }) => ({ p: registerPlugin('Health') }))
      .catch(e => { console.error('Health plugin unavailable:', e); return { p: null } })
  }
  return pluginPromise
}

/** Raise the HealthKit permission sheet. Only ever called from a direct user action (the
 * Settings toggle), never at launch. Null when there is no plugin to ask. */
export async function requestHealthPermissions() {
  const { p } = await plugin()
  if (!p) return null
  try { return await p.requestPermissions() } catch (e) { console.error('Health.requestPermissions failed:', e); return null }
}

/** Current write authorization. Write status is queryable; read status deliberately is not, so
 * this reports the write direction only (spec section 6.2). */
export async function getHealthAuth() {
  const { p } = await plugin()
  if (!p) return null
  try { return await p.getAuth() } catch (e) { console.error('Health.getAuth failed:', e); return null }
}

/** Write one workout. Fire-and-forget by contract: the caller must not await this in a path the
 * user is waiting on, and a false return must never be surfaced as an error over the finish
 * summary. The workout is already in openGym's own history by this point either way. */
export async function saveHealthWorkout(descriptor) {
  const { p } = await plugin()
  if (!p) return false
  let ok = false
  try {
    const r = await p.saveWorkout(descriptor)
    ok = !!r?.ok
  } catch (e) {
    console.error('Health.saveWorkout failed:', e)
  }
  await writeJsonFile(STATUS_FILE, { ok, at: Date.now() })
  return ok
}

/** Latest body-mass sample in kilograms, or null. Null covers both "denied" and "no data":
 * HealthKit makes those indistinguishable on purpose, so there is nothing to tell apart. */
export async function readLatestBodyWeight() {
  const { p } = await plugin()
  if (!p) return null
  try {
    const r = await p.readLatestBodyWeight()
    return Number.isFinite(r?.kg) ? { kg: r.kg, at: r.at } : null
  } catch (e) { console.error('Health.readLatestBodyWeight failed:', e); return null }
}

/** How the last write went, for the passive Settings line. Device-local, never synced. */
export async function readHealthStatus() {
  return (await readJsonFile(STATUS_FILE)) || null
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd frontend && npx vitest run src/lib/health-bridge.proxy.test.js`
Expected: PASS.

- [ ] **Step 5: Run the full suite**

Run: `cd frontend && npm test`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add frontend/src/lib/health-bridge.js frontend/src/lib/health-bridge.proxy.test.js
git commit -m "Add Health plugin bridge with proxy-trap regression cover"
```

---

### Task 3: Carry the Watch heart-rate summary onto the workout record

Pure JS and independently testable, so it lands before any Swift is written.

**Files:**
- Modify: `frontend/src/lib/watch-import.js`
- Test: `frontend/src/lib/watch-import.test.js` (exists, add cases)

**Interfaces:**
- Consumes: nothing new.
- Produces: `finishWatchSession` unchanged in signature, but the returned `w` now carries an optional `hr: { avg?: number, max?: number, kcal?: number }` when the incoming payload had a `health` object with at least one figure.

- [ ] **Step 1: Write the failing tests**

Append to `frontend/src/lib/watch-import.test.js`. Match the existing file's helpers for building `st` and a payload; if it has a payload factory, reuse it rather than writing a second one.

```js
describe('heart-rate summary from the Watch', () => {
  const base = {
    watchSessionId: 'w_1', date: '2026-09-20', start: 1000, end: 2000,
    routineIds: ['r1'], name: 'Push Day',
    entries: [{ id: 'bench', sets: [{ phase: 'work', w: 60, r: 8, done: true }] }],
  }
  const st = { workouts: [], exWeights: {}, bodyweight: [] }

  it('stores avg, max and kcal on the workout record', () => {
    const r = finishWatchSession(st, { ...base, health: { saved: true, avgHr: 142, maxHr: 171, kcal: 486 } })
    expect(r.w.hr).toEqual({ avg: 142, max: 171, kcal: 486 })
  })

  it('omits hr entirely when the Watch sent no health object', () => {
    const r = finishWatchSession(st, base)
    expect('hr' in r.w).toBe(false)
  })

  // saved:false means the session ran with sensors but the HKWorkout save failed. The figures
  // are still real and still worth keeping; only the "already in Health" claim is false.
  it('keeps the figures even when the Watch could not save to Health', () => {
    const r = finishWatchSession(st, { ...base, health: { saved: false, avgHr: 130, maxHr: 150, kcal: 300 } })
    expect(r.w.hr).toEqual({ avg: 130, max: 150, kcal: 300 })
  })

  it('writes only the figures that are present', () => {
    const r = finishWatchSession(st, { ...base, health: { saved: true, avgHr: 142 } })
    expect(r.w.hr).toEqual({ avg: 142 })
  })

  it('omits hr when the health object carries no figures at all', () => {
    const r = finishWatchSession(st, { ...base, health: { saved: false } })
    expect('hr' in r.w).toBe(false)
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd frontend && npx vitest run src/lib/watch-import.test.js`
Expected: FAIL on the first case, `r.w.hr` is undefined.

- [ ] **Step 3: Write the implementation**

In `frontend/src/lib/watch-import.js`, inside `finishWatchSession`, immediately after the existing `w.vol = workoutVolume(w)` line, add:

```js
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
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd frontend && npx vitest run src/lib/watch-import.test.js`
Expected: PASS.

- [ ] **Step 5: Run the full suite**

Run: `cd frontend && npm test`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add frontend/src/lib/watch-import.js frontend/src/lib/watch-import.test.js
git commit -m "Carry the Watch heart-rate summary onto the imported workout"
```

---

### Task 4: The iOS Health plugin

Native transport. No test harness exists for Swift in this repo, which is exactly why this file holds no decisions. Verification is manual and specified below.

**Files:**
- Create: `frontend/ios/App/App/Health.swift`
- Create: `frontend/ios/App/App/Health.m`
- Modify: `frontend/ios/App/App/Info.plist`
- Modify: `frontend/ios/App/App.xcodeproj` (HealthKit capability, via Xcode UI)

**Interfaces:**
- Consumes: the descriptor shape produced by `healthWorkoutPayload` in Task 1.
- Produces, to JS via `registerPlugin('Health')`:
  - `requestPermissions() -> { write: Bool }`
  - `getAuth() -> { write: Bool }`
  - `saveWorkout({ start, end, type, title, id }) -> { ok: Bool }`
  - `readLatestBodyWeight() -> { kg: Double, at: Double }` or `{}` when there is nothing to report

- [ ] **Step 1: Add the HealthKit capability and usage strings**

In Xcode, open `frontend/ios/App/App.xcworkspace`, select the **App** target, Signing & Capabilities, "+ Capability", add **HealthKit**. Do not tick Clinical Health Records.

Then add to `frontend/ios/App/App/Info.plist`, inside the top-level `<dict>`:

```xml
	<key>NSHealthUpdateUsageDescription</key>
	<string>openGym saves your finished workouts to Apple Health. Nothing is sent anywhere else.</string>
	<key>NSHealthShareUsageDescription</key>
	<string>openGym reads your latest body weight to prefill the weigh-in before a workout. Nothing is sent anywhere else.</string>
```

Both keys are required. An app that touches HealthKit without them is terminated by the OS on first access, not warned.

- [ ] **Step 2: Write the ObjC bridge**

Create `frontend/ios/App/App/Health.m`:

```objc
#import <Foundation/Foundation.h>
#import <Capacitor/Capacitor.h>

// Registers the Swift plugin with Capacitor's ObjC runtime. Mirrors WatchBridge.m exactly.
CAP_PLUGIN(Health, "Health",
           CAP_PLUGIN_METHOD(requestPermissions, CAPPluginReturnPromise);
           CAP_PLUGIN_METHOD(getAuth, CAPPluginReturnPromise);
           CAP_PLUGIN_METHOD(saveWorkout, CAPPluginReturnPromise);
           CAP_PLUGIN_METHOD(readLatestBodyWeight, CAPPluginReturnPromise);
)
```

- [ ] **Step 3: Write the Swift plugin**

Create `frontend/ios/App/App/Health.swift`:

```swift
import Foundation
import Capacitor
import HealthKit

/**
 * Apple Health transport for openGym. See
 * docs/superpowers/specs/2026-09-20-health-integration-design.md.
 *
 * This file deliberately contains no decision about WHETHER a workout should be written, or what
 * kind of workout it is. That lives in frontend/src/lib/health.js, where it is unit tested; this
 * repo has no Swift test harness, so logic placed here would be logic nobody can cover.
 *
 * Usage from JS:
 *   const Health = registerPlugin('Health');
 *   await Health.requestPermissions();                       // { write: Bool }
 *   await Health.saveWorkout({ start, end, type, title, id }); // { ok: Bool }
 *   await Health.readLatestBodyWeight();                      // { kg, at } or {}
 */
@objc(Health)
public class Health: CAPPlugin {
    private let store = HKHealthStore()

    private var shareTypes: Set<HKSampleType> {
        [HKObjectType.workoutType()]
    }
    private var readTypes: Set<HKObjectType> {
        guard let bodyMass = HKObjectType.quantityType(forIdentifier: .bodyMass) else { return [] }
        return [bodyMass]
    }

    private func writeAuthorized() -> Bool {
        store.authorizationStatus(for: HKObjectType.workoutType()) == .sharingAuthorized
    }

    @objc func requestPermissions(_ call: CAPPluginCall) {
        guard HKHealthStore.isHealthDataAvailable() else {
            call.resolve(["write": false])
            return
        }
        store.requestAuthorization(toShare: shareTypes, read: readTypes) { [weak self] _, error in
            if let error = error {
                NSLog("[Health] requestAuthorization failed: \(error.localizedDescription)")
            }
            // `success` only reports that the sheet completed, not what the user chose, so the
            // write status is queried separately. Read status is deliberately not queryable.
            call.resolve(["write": self?.writeAuthorized() ?? false])
        }
    }

    @objc func getAuth(_ call: CAPPluginCall) {
        guard HKHealthStore.isHealthDataAvailable() else {
            call.resolve(["write": false])
            return
        }
        call.resolve(["write": writeAuthorized()])
    }

    @objc func saveWorkout(_ call: CAPPluginCall) {
        guard HKHealthStore.isHealthDataAvailable(), writeAuthorized() else {
            call.resolve(["ok": false])
            return
        }
        // Milliseconds on the JS side, seconds in Foundation.
        let startMs = call.getDouble("start") ?? 0
        let endMs = call.getDouble("end") ?? 0
        guard startMs > 0, endMs > startMs else {
            call.resolve(["ok": false])
            return
        }
        let start = Date(timeIntervalSince1970: startMs / 1000)
        let end = Date(timeIntervalSince1970: endMs / 1000)

        // openGym's vocabulary, mapped to Apple's here and nowhere else.
        let activity: HKWorkoutActivityType =
            call.getString("type") == "cardio" ? .mixedCardio : .traditionalStrengthTraining

        let config = HKWorkoutConfiguration()
        config.activityType = activity

        // HKWorkout's initialisers are deprecated from iOS 17; HKWorkoutBuilder is the supported
        // way to write a finished workout. No samples are added: openGym has no sensor data on
        // the phone, and inventing an active-energy figure would present a guess to Health as a
        // measurement (spec section 3.5).
        let builder = HKWorkoutBuilder(healthStore: store, configuration: config, device: .local())
        var metadata: [String: Any] = [:]
        if let title = call.getString("title"), !title.isEmpty {
            metadata[HKMetadataKeyWorkoutBrandName] = title
        }
        if let id = call.getString("id") {
            metadata["openGymWorkoutId"] = id
        }

        builder.beginCollection(withStart: start) { began, beginError in
            guard began else {
                NSLog("[Health] beginCollection failed: \(beginError?.localizedDescription ?? "unknown")")
                call.resolve(["ok": false])
                return
            }
            let finish = {
                builder.endCollection(withEnd: end) { ended, endError in
                    guard ended else {
                        NSLog("[Health] endCollection failed: \(endError?.localizedDescription ?? "unknown")")
                        call.resolve(["ok": false])
                        return
                    }
                    builder.finishWorkout { workout, finishError in
                        if let finishError = finishError {
                            NSLog("[Health] finishWorkout failed: \(finishError.localizedDescription)")
                        }
                        call.resolve(["ok": workout != nil])
                    }
                }
            }
            if metadata.isEmpty {
                finish()
            } else {
                builder.addMetadata(metadata) { _, metaError in
                    if let metaError = metaError {
                        NSLog("[Health] addMetadata failed: \(metaError.localizedDescription)")
                    }
                    // Metadata is a nicety; the workout itself still goes in without it.
                    finish()
                }
            }
        }
    }

    @objc func readLatestBodyWeight(_ call: CAPPluginCall) {
        guard HKHealthStore.isHealthDataAvailable(),
              let bodyMass = HKObjectType.quantityType(forIdentifier: .bodyMass) else {
            call.resolve([:])
            return
        }
        let sort = NSSortDescriptor(key: HKSampleSortIdentifierEndDate, ascending: false)
        let query = HKSampleQuery(sampleType: bodyMass, predicate: nil, limit: 1, sortDescriptors: [sort]) { _, samples, error in
            // A denied read and an empty store are indistinguishable here by design, and both
            // resolve the same way: nothing to prefill with (spec section 6.2).
            if let error = error {
                NSLog("[Health] body-mass query failed: \(error.localizedDescription)")
            }
            guard let sample = samples?.first as? HKQuantitySample else {
                call.resolve([:])
                return
            }
            let kg = sample.quantity.doubleValue(for: .gramUnit(with: .kilo))
            call.resolve(["kg": kg, "at": sample.endDate.timeIntervalSince1970 * 1000])
        }
        store.execute(query)
    }
}
```

- [ ] **Step 4: Build to verify it compiles**

Run: `cd frontend && npm run build:mobile`
Then in Xcode, Product > Build for the App target (or `xcodebuild -workspace ios/App/App.xcworkspace -scheme App -destination 'generic/platform=iOS' build`).
Expected: build succeeds. A "HealthKit entitlement missing" error at this stage means Step 1's capability was not actually added to the App target.

- [ ] **Step 5: Verify on a device manually**

There is no automated coverage for this file, so verify by hand and record the result in the commit message:
1. Run on a real iPhone (HealthKit is unavailable on some simulators).
2. From Safari Web Inspector against the app's WebView, run `await registerPlugin('Health').requestPermissions()`. Expect the Health permission sheet, and `{ write: true }` after allowing.
3. Run `await registerPlugin('Health').saveWorkout({ start: Date.now() - 3600000, end: Date.now(), type: 'strength', title: 'Manual test', id: 'test_1' })`. Expect `{ ok: true }`, and a strength-training workout visible in the Health app under Browse > Activity > Workouts.
4. Run `await registerPlugin('Health').readLatestBodyWeight()`. With a body-weight entry in Health, expect `{ kg, at }`; with none, expect `{}`.

- [ ] **Step 6: Commit**

```bash
git add frontend/ios/App/App/Health.swift frontend/ios/App/App/Health.m frontend/ios/App/App/Info.plist frontend/ios/App/App.xcodeproj
git commit -m "Add the iOS Health plugin and its HealthKit capability"
```

---

### Task 5: Settings toggle, status line, and the finish hook

The opt-in, and the one place a live finish reaches Health.

**Files:**
- Modify: `frontend/src/store/useStore.js:31` area (the `DEF` object)
- Modify: `frontend/src/views/Settings.jsx`
- Modify: `frontend/src/sheets.jsx` (`doFinishWorkout`, and `handleIncomingWatchSession`)

**Interfaces:**
- Consumes: `shouldWriteWorkout`, `healthWorkoutPayload` (Task 1); `saveHealthWorkout`, `requestHealthPermissions`, `getHealthAuth`, `readHealthStatus` (Task 2).
- Produces: `S.health` (boolean, default `false`) as the single opt-in flag read at finish time.

- [ ] **Step 1: Add the default**

In `frontend/src/store/useStore.js`, in the `DEF` object, after the `heatmapMetric: 'time',` line, add:

```js
  // Apple Health sync, off until the user turns it on in Settings (iOS mobile build only).
  // Read at finish time, never captured at workout start, so turning it off mid-session takes
  // effect immediately. Health data itself never leaves the device and never reaches the server.
  health: false,
```

- [ ] **Step 2: Add the Settings section**

In `frontend/src/views/Settings.jsx`, add to the imports after the `getWatchStatus` import on line 18:

```js
import { requestHealthPermissions, getHealthAuth, readHealthStatus } from '../lib/health-bridge.js'
```

Add state and loading beside the existing Apple Watch status block (after the `watchStatus` `useEffect` that ends around line 98):

```js
  // --- Apple Health ---
  const [healthAuth, setHealthAuth] = useState(null)   // { write } | null
  const [healthStatus, setHealthStatus] = useState(null) // { ok, at } | null
  useEffect(() => {
    if (!MOBILE) return
    isIOS().then(ok => {
      if (!ok) return
      getHealthAuth().then(setHealthAuth)
      readHealthStatus().then(setHealthStatus)
    })
  }, [])
```

Then add a new section immediately after the Apple Watch `</Section>}` block (around line 282):

```jsx
    {/* ---------- Apple Health (docs/superpowers/specs/2026-09-20-health-integration-design.md) ---------- */}
    {MOBILE && ios && <Section title={t('Apple Health')}
      footer={S.health && healthAuth && healthAuth.write === false
        ? t('Writing is turned off for openGym in the Health app. Open Health, then Sharing, Apps, openGym to allow it.')
        : t('Only workouts you finish on this phone are written. Past workouts you log later, edits, and imports are not.')}>
      <Row icon="heart" iconTint="var(--red)" title={t('Save workouts to Health')}
        subtitle={t('Writes the workout time and type when you finish a session. No calories are estimated.')}>
        <Switch checked={S.health === true} onChange={async v => {
          if (!v) { update(s => { s.health = false }); return }
          // The permission sheet is only ever raised by this tap, never at launch.
          const r = await requestHealthPermissions()
          setHealthAuth(r)
          update(s => { s.health = true })
        }} />
      </Row>
      {S.health && healthStatus && healthStatus.ok === false && (
        <Row icon="clock" iconTint="var(--orange)" title={t('Last write failed')}
          subtitle={fmtDate(new Date(healthStatus.at).toISOString().slice(0, 10), true)} />
      )}
    </Section>}
```

`fmtDate` is **not** currently imported in `Settings.jsx`. Add it to the existing `../lib/format.js` import on line 7, which today reads `import { ACCENTS, todayISO, localTZ, weekStartOf, MONDAY, SUNDAY, fmtPlate, fmtNum } from '../lib/format.js'`.

- [ ] **Step 3: Add the finish hook**

In `frontend/src/sheets.jsx`, add to the imports near the existing `finish-workout.js` import on line 33:

```js
import { shouldWriteWorkout, healthWorkoutPayload } from './lib/health.js'
import { saveHealthWorkout } from './lib/health-bridge.js'
```

In `doFinishWorkout`, immediately after the `useStore.getState().autoBackupNow()` line, add:

```js
  // Apple Health, live finishes only. `past` is the backfill discriminator, so a workout logged
  // into the past never rewrites the user's Health history (spec section 3.4). Fire-and-forget on
  // purpose: doFinishWorkout must not become async, must not wait on HealthKit, and a failed
  // health write must never surface an error over the finish summary. The workout is already in
  // openGym's own history by this line, so nothing is lost if the write fails.
  const hd = shouldWriteWorkout({ enabled: st.health === true, past }) ? healthWorkoutPayload(w) : null
  if (hd) saveHealthWorkout(hd)
```

- [ ] **Step 4: Add the Watch-import fallback write**

Still in `frontend/src/sheets.jsx`, in `handleIncomingWatchSession`'s `apply` callback, immediately after the `markSeen()` line, add:

```js
      // The Watch normally saves its own HKWorkout, because only the side that ran the session
      // can attach its heart-rate samples. When it could not (no authorization on the Watch, or
      // the save failed), the phone is the only side left that can write it, sensor-less. This
      // is what keeps the invariant at exactly one health record per session, never zero
      // (spec section 5.2).
      const hd = shouldWriteWorkout({
        enabled: S().health === true, fromWatch: true, healthSaved: payload.health?.saved === true,
      }) ? healthWorkoutPayload(w) : null
      if (hd) saveHealthWorkout(hd)
```

- [ ] **Step 5: Run the full suite**

Run: `cd frontend && npm test`
Expected: PASS. No test asserts on `S.health`, and the new `DEF` key is additive.

- [ ] **Step 6: Verify the wiring manually on a device**

1. Settings shows an Apple Health section on an iOS mobile build and does not show it on the web build or on Android.
2. Toggling on raises the permission sheet once.
3. Finish a live workout with the toggle on: it appears in the Health app.
4. Finish a live workout with the toggle off: nothing appears in Health.
5. Log a past workout (backfill) with the toggle on: nothing appears in Health.

- [ ] **Step 7: Commit**

```bash
git add frontend/src/store/useStore.js frontend/src/views/Settings.jsx frontend/src/sheets.jsx
git commit -m "Write finished workouts to Apple Health behind a Settings opt-in"
```

---

### Task 6: Prefill the weigh-in from Health

**Files:**
- Modify: `frontend/src/sheets.jsx` (`BwSheet`, from line 207)

**Interfaces:**
- Consumes: `bodyWeightPrefill` (Task 1), `readLatestBodyWeight` (Task 2), `convertWeight` from `./lib/units.js`.
- Produces: no new exports.

- [ ] **Step 1: Add the imports**

In `frontend/src/sheets.jsx`, extend the Task 5 imports:

```js
import { shouldWriteWorkout, healthWorkoutPayload, bodyWeightPrefill } from './lib/health.js'
import { saveHealthWorkout, readLatestBodyWeight } from './lib/health-bridge.js'
```

`sheets.jsx` does not import from `./lib/units.js` today, so add the import outright:

```js
import { convertWeight } from './lib/units.js'
```

- [ ] **Step 2: Add the prefill effect**

In `BwSheet`, immediately after `const [v, setV] = useState(bw ? bw.w : 70)`, add:

```js
  // Apple Health prefill: a scale reading from this morning beats last session's number. This
  // only ever moves the slider, it never writes anything. The user still confirms, and openGym
  // logs its own entry, so training data is never mutated without them seeing it (spec 3.6).
  useEffect(() => {
    if (!MOBILE || st.health !== true) return
    // Already weighed in today by hand: their own number wins over the scale's.
    if (st.bodyweight.some(b => b.d === todayISO())) return
    let cancelled = false
    readLatestBodyWeight().then(r => {
      if (cancelled) return
      const kg = bodyWeightPrefill(r)
      if (kg == null) return
      setV(convertWeight(kg, 'kg', unit))
    })
    return () => { cancelled = true }
  }, [])
```

`useEffect` (line 1), `MOBILE` (line 32) and `todayISO` (line 6) are already imported in `sheets.jsx`, so no other import changes are needed for this step.

- [ ] **Step 3: Run the full suite**

Run: `cd frontend && npm test`
Expected: PASS. `MOBILE` is false in the test environment, so the effect returns immediately and no existing sheet test changes behaviour.

- [ ] **Step 4: Verify manually on a device**

1. With a body-weight entry added to Health today and none in openGym, start a workout: the weigh-in slider opens at the Health value, converted if the profile is in lb.
2. With a Health entry older than 36 hours: the slider opens at openGym's last value instead.
3. With openGym already holding today's entry: the slider opens at openGym's value, not Health's.
4. With the toggle off: no prefill, and no permission prompt.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/sheets.jsx
git commit -m "Prefill the weigh-in from the latest Apple Health body weight"
```

---

### Task 7: The Watch workout session

The half that produces heart rate. Native, manually verified.

**Files:**
- Create: `frontend/ios/App/WatchApp/WatchHealthSession.swift`
- Modify: `frontend/ios/App/WatchApp/WatchSessionStore.swift`
- Modify: `frontend/ios/App/WatchApp/ContentView.swift:43`
- Modify: `frontend/ios/App/WatchApp/SessionView.swift:328`
- Modify: `frontend/ios/App/App.xcodeproj` (HealthKit capability plus the Workout Processing background mode on the WatchApp target)

**Interfaces:**
- Consumes: nothing from JS.
- Produces: the optional `health` object on the existing `transferUserInfo` payload, consumed by `finishWatchSession` in Task 3. `WatchActiveSession` is `Codable` and is encoded directly as the payload, so adding the field to the struct is what puts it on the wire.

- [ ] **Step 1: Add the Watch capability and background mode**

In Xcode, select the **WatchApp** target, Signing & Capabilities:
1. "+ Capability", add **HealthKit**. This is independent of the App target's capability; adding it to the phone does not add it to the watch.
2. "+ Capability", add **Background Modes**, and tick **Workout processing**.

Without Workout processing the `HKWorkoutSession` gets no extended runtime and the session dies when the wrist drops, which is the single most confusing possible failure for the user.

The WatchApp target also needs the same two `NSHealthUpdateUsageDescription` and `NSHealthShareUsageDescription` keys in its own Info.plist.

- [ ] **Step 2: Write the HealthKit session owner**

Create `frontend/ios/App/WatchApp/WatchHealthSession.swift`:

```swift
import Foundation
import HealthKit

/**
 * Owns the Watch's HKWorkoutSession and its live builder, and nothing else. See
 * docs/superpowers/specs/2026-09-20-health-integration-design.md sections 5.2 and 9.
 *
 * Kept out of WatchSessionStore deliberately: that object is the session's persistence, this one
 * is a HealthKit state machine with its own delegate callbacks and its own recovery path. They
 * fail independently and are easier to reason about apart.
 *
 * The design decision this file exists to honour: the Watch, not the phone, saves the HKWorkout,
 * because only the side that ran the session can attach its heart-rate samples to it.
 */
final class WatchHealthSession: NSObject {
    static let shared = WatchHealthSession()

    private let store = HKHealthStore()
    private var session: HKWorkoutSession?
    private var builder: HKLiveWorkoutBuilder?

    /// True while a live session is running. `false` here means the phone must write the workout.
    private(set) var running = false

    func requestAuthorization() {
        guard HKHealthStore.isHealthDataAvailable() else { return }
        let share: Set<HKSampleType> = [HKObjectType.workoutType()]
        var read: Set<HKObjectType> = [HKObjectType.workoutType()]
        if let hr = HKObjectType.quantityType(forIdentifier: .heartRate) { read.insert(hr) }
        if let kcal = HKObjectType.quantityType(forIdentifier: .activeEnergyBurned) { read.insert(kcal) }
        store.requestAuthorization(toShare: share, read: read) { _, error in
            if let error = error {
                NSLog("[WatchHealth] requestAuthorization failed: \(error.localizedDescription)")
            }
        }
    }

    /**
     * Start collecting. Returns whether a live session is actually running.
     *
     * A false return is a normal outcome, not an error to surface: watchOS permits exactly ONE
     * active HKWorkoutSession at a time, so a forgotten Outdoor Walk in Apple's own Workout app
     * makes this fail. The Watch session must still start and still log sets in that case, just
     * without sensors (spec section 9.1). Never let this block the workout.
     */
    @discardableResult
    func start() -> Bool {
        guard HKHealthStore.isHealthDataAvailable() else { return false }
        // Recover from an orphan before starting a second one (spec section 9.2).
        if running { endQuietly() }

        let config = HKWorkoutConfiguration()
        config.activityType = .traditionalStrengthTraining
        config.locationType = .indoor
        do {
            let s = try HKWorkoutSession(healthStore: store, configuration: config)
            let b = s.associatedWorkoutBuilder()
            b.dataSource = HKLiveWorkoutDataSource(healthStore: store, workoutConfiguration: config)
            s.delegate = self
            session = s
            builder = b
            let now = Date()
            s.startActivity(with: now)
            b.beginCollection(withStart: now) { ok, error in
                if !ok {
                    NSLog("[WatchHealth] beginCollection failed: \(error?.localizedDescription ?? "unknown")")
                }
            }
            running = true
            return true
        } catch {
            // The concurrent-session case lands here. Degrade, do not fail.
            NSLog("[WatchHealth] could not start a workout session: \(error.localizedDescription)")
            session = nil
            builder = nil
            running = false
            return false
        }
    }

    /**
     * Stop collecting and save the HKWorkout. `completion` receives the summary to put on the
     * sync-back payload, or nil when there was no live session at all (in which case the payload
     * carries no `health` key and the phone writes the workout itself).
     */
    func finish(completion: @escaping (WatchHealthSummary?) -> Void) {
        guard running, let session = session, let builder = builder else {
            completion(nil)
            return
        }
        self.running = false
        let end = Date()
        session.end()
        builder.endCollection(withEnd: end) { [weak self] _, error in
            if let error = error {
                NSLog("[WatchHealth] endCollection failed: \(error.localizedDescription)")
            }
            let avg = self?.average(builder, .heartRate)
            let max = self?.maximum(builder, .heartRate)
            let kcal = self?.sum(builder, .activeEnergyBurned)
            builder.finishWorkout { workout, finishError in
                if let finishError = finishError {
                    NSLog("[WatchHealth] finishWorkout failed: \(finishError.localizedDescription)")
                }
                self?.session = nil
                self?.builder = nil
                // saved:false is a real, distinct case: the session ran and the figures are real,
                // but the HKWorkout is not in Health, so the phone must write it (spec 5.2).
                completion(WatchHealthSummary(saved: workout != nil, avgHr: avg, maxHr: max, kcal: kcal))
            }
        }
    }

    /// End an orphaned session without saving. Called on launch when a session survived a
    /// force-quit: it would otherwise hold the green indicator and drain the battery until the
    /// Watch reboots (spec section 9.2).
    func endQuietly() {
        session?.end()
        builder?.discardWorkout()
        session = nil
        builder = nil
        running = false
    }

    /// Recover after a crash or force-quit. Safe to call unconditionally at launch.
    func recoverOrphanedSession() {
        guard HKHealthStore.isHealthDataAvailable() else { return }
        store.recoverActiveWorkoutSession { [weak self] recovered, error in
            if let error = error {
                NSLog("[WatchHealth] recoverActiveWorkoutSession failed: \(error.localizedDescription)")
            }
            guard let recovered = recovered else { return }
            NSLog("[WatchHealth] recovered an orphaned workout session, ending it")
            self?.session = recovered
            self?.builder = recovered.associatedWorkoutBuilder()
            self?.running = true
            self?.endQuietly()
        }
    }

    private func statistics(_ builder: HKLiveWorkoutBuilder, _ id: HKQuantityTypeIdentifier) -> HKStatistics? {
        guard let type = HKObjectType.quantityType(forIdentifier: id) else { return nil }
        return builder.statistics(for: type)
    }
    private func average(_ builder: HKLiveWorkoutBuilder, _ id: HKQuantityTypeIdentifier) -> Double? {
        let unit = HKUnit.count().unitDivided(by: .minute())
        return statistics(builder, id)?.averageQuantity()?.doubleValue(for: unit)
    }
    private func maximum(_ builder: HKLiveWorkoutBuilder, _ id: HKQuantityTypeIdentifier) -> Double? {
        let unit = HKUnit.count().unitDivided(by: .minute())
        return statistics(builder, id)?.maximumQuantity()?.doubleValue(for: unit)
    }
    private func sum(_ builder: HKLiveWorkoutBuilder, _ id: HKQuantityTypeIdentifier) -> Double? {
        statistics(builder, id)?.sumQuantity()?.doubleValue(for: .kilocalorie())
    }
}

extension WatchHealthSession: HKWorkoutSessionDelegate {
    func workoutSession(_ workoutSession: HKWorkoutSession,
                        didChangeTo toState: HKWorkoutSessionState,
                        from fromState: HKWorkoutSessionState,
                        date: Date) {
        if toState == .ended || toState == .stopped { running = false }
    }
    func workoutSession(_ workoutSession: HKWorkoutSession, didFailWithError error: Error) {
        NSLog("[WatchHealth] workout session failed: \(error.localizedDescription)")
        running = false
    }
}
```

- [ ] **Step 3: Add the payload field**

In `frontend/ios/App/WatchApp/WatchSessionStore.swift`, add above `struct WatchActiveSession`:

```swift
// What the Watch's HKWorkoutSession measured, sent back to the phone on the existing payload.
// `saved` is the phone's instruction, not a statistic: true means the HKWorkout is already in
// Health and the phone must not write a second one. See the design doc section 5.2.
struct WatchHealthSummary: Codable, Hashable {
    var saved: Bool
    var avgHr: Double?
    var maxHr: Double?
    var kcal: Double?
}
```

And add the field to `WatchActiveSession`, after `var unit: String?`:

```swift
    // Omitted entirely when no live workout session ran, which tells the phone to write the
    // workout itself. WatchActiveSession is encoded straight to the transferUserInfo payload, so
    // this field being Optional is what keeps it off the wire when there is nothing to report.
    var health: WatchHealthSummary?
```

- [ ] **Step 4: Start the HealthKit session at Start, and recover orphans at launch**

In `frontend/ios/App/WatchApp/ContentView.swift`, replace line 43's `store.startSession()` with:

```swift
                store.startSession()
                // Degrades to a sensor-less session when watchOS refuses a second concurrent
                // workout session. Never blocks the workout (design doc section 9.1).
                WatchHealthSession.shared.start()
```

In `frontend/ios/App/WatchApp/WatchAppApp.swift`, inside the app's initialiser or an `.onAppear` on the root view, add:

```swift
        WatchHealthSession.shared.requestAuthorization()
        WatchHealthSession.shared.recoverOrphanedSession()
```

- [ ] **Step 5: Attach the summary at Finish**

In `frontend/ios/App/WatchApp/SessionView.swift`, around line 328, the current code is:

```swift
        guard let finished = WatchSessionStore.shared.finishSession() else { return }
```

Change the finish path so the HealthKit session closes first and its summary rides along. Replace the body of that function from that `guard` down to and including the `sendCompletedSession` call with:

```swift
        guard var finished = WatchSessionStore.shared.finishSession() else { return }
        // Close the HealthKit session before sending: the summary has to be on the payload, and
        // the HKWorkout has to be saved by this side, because only the side that ran the session
        // can attach its heart-rate samples (design doc section 3).
        WatchHealthSession.shared.finish { summary in
            finished.health = summary
            WatchSessionStore.shared.activeSession = finished
            WatchSessionStore.shared.persistActiveSession()
            // sendCompletedSession's completion reports whether the workout was handed to the
            // OS's durable outbox, not whether the phone received it.
            WatchConnectivitySession.shared.sendCompletedSession(finished) { success in
                if success { WatchSessionStore.shared.clearFinishedSession() }
            }
        }
```

Preserve whatever navigation or state the existing function did around those lines; only the ordering and the added `health` assignment change. `WatchHealthSession.finish` calls back on a HealthKit queue, so if the surrounding code touches `@Published` state or SwiftUI navigation, wrap those touches in `DispatchQueue.main.async`.

- [ ] **Step 6: Build and verify manually**

Run: build the WatchApp scheme in Xcode onto a real Apple Watch. The Simulator does not produce heart-rate data.
1. Start a workout on the Watch: the green workout indicator appears at the top of the watch face.
2. Heart rate is collected for the duration (confirm after finishing, in Health).
3. Finish: the workout appears in the iPhone's Health app with a heart-rate curve and an energy figure.
4. The same workout appears in openGym's history with its heart-rate summary, and there is exactly **one** copy of it in Health.

- [ ] **Step 7: Commit**

```bash
git add frontend/ios/App/WatchApp frontend/ios/App/App.xcodeproj
git commit -m "Run a real HKWorkoutSession on the Watch and report its summary back"
```

---

### Task 8: Failure-mode verification and documentation

Spec section 9 exists because tests derived from a design cannot find errors in that design. These probe it deliberately. Every one of them needs a real device and a real watch.

**Files:**
- Modify: `docs/MOBILE.md`

- [ ] **Step 1: Document the capability requirement and the free-signing finding**

Add to `docs/MOBILE.md`, in whichever section covers building and signing:

```markdown
### Apple Health

The App target needs the **HealthKit** capability, and the WatchApp target needs **HealthKit**
plus the **Workout processing** background mode. These are per-target: adding the capability to
the phone does not add it to the watch. Both targets need `NSHealthUpdateUsageDescription` and
`NSHealthShareUsageDescription` in their Info.plist.

Free Xcode signing is enough for all of this. Verified on 2026-09-20 by decoding the provisioning
profiles in `~/Library/Developer/Xcode/UserData/Provisioning Profiles` with
`security cms -D -i <profile>`: a free personal team (personal `TeamName`, 7-day profile
validity) held `com.apple.developer.healthkit`, `com.apple.developer.healthkit.access` and
`com.apple.developer.healthkit.background-delivery` on both an iPhone bundle id and its
`.watchkitapp` bundle id. This is empirical evidence rather than an Apple guarantee, and what
free provisioning grants is Apple's to change, so re-run that command if health features stop
working after a toolchain update.
```

- [ ] **Step 2: Run the failure-mode probes**

Work through each, recording the actual result. A probe that fails is a code change, not a note.

1. **Concurrent workout session.** Start an Outdoor Walk in Apple's Workout app, leave it running, then start a workout in openGym on the Watch. Expected: openGym's session starts and logs sets normally, with no heart rate. On finish, the workout reaches the phone and the phone writes it to Health, so it appears in Health exactly once. Expected failure if built naively: openGym's Watch session refuses to start.
2. **Cancelled halfway.** Start a Watch session, force-quit the Watch app, relaunch. Expected: no lingering green workout indicator, no orphaned session, and no completed set lost from `WatchSessionStore`.
3. **Never happens.** Deny HealthKit on the Watch only, with the phone toggle on. Run a Watch session. Expected: payload arrives with no `health` key, the phone writes the workout sensor-less, one record in Health, no heart rate anywhere.
4. **Turned off mid-flight.** Start a workout with the toggle on, turn it off in Settings before finishing, finish. Expected: nothing written to Health.
5. **Revoked between sessions.** With the toggle on, revoke openGym's write access in Health, then finish a workout. Expected: no crash, no error over the finish summary, the workout still in openGym history, and the "Last write failed" line in Settings.
6. **Redelivery.** Resend the same `watchSessionId` with `health.saved: false`. Expected: the seen-ids guard in `watch-bridge.js` stops it before `finishWatchSession`, so no duplicate workout and no second health record.
7. **Clock skew.** Compare the Watch-written record's start and end in Health against openGym's own `w.start`/`w.end`. Expected: small differences, and nothing in the UI claiming the heart-rate summary covers exactly openGym's window.

- [ ] **Step 3: Commit**

```bash
git add docs/MOBILE.md
git commit -m "Document the HealthKit capability requirements and free-signing verification"
```

---

## Known Gaps

Recorded rather than buried, per CLAUDE.md's rule that a limitation written into a spec is an open ticket:

- **No automated coverage for any Swift in this feature.** `Health.swift` and `WatchHealthSession.swift` are manually verified only, because the repo has no Swift test harness. This is the reason all policy was pushed into `lib/health.js`, but it still means the HealthKit state machine itself is uncovered.
- **Probe 9.2 (orphan recovery) is designed here, not proven.** `recoverActiveWorkoutSession` is the documented API for it, but its behaviour after a force-quit on real hardware is exactly the kind of thing that differs from the documentation. Task 8 step 2.2 is where that gets settled.
- **Android Health Connect is deferred** to its own spec (spec section 10.1), which also has to decide the Kotlin toolchain question before any code.
