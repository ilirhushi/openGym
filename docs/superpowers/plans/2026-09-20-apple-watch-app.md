# Apple Watch App (Phase 1: Start & Log a Workout) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a user start today's scheduled workout on their Apple Watch and log straight/warmup
sets (reps, time, or cardio mode) entirely from the wrist, phone optional, with the session syncing
back to the iPhone app to finish (progression, PRs, history) once reconnected.

**Architecture:** A native SwiftUI watchOS app (new Xcode target, paired to the existing Capacitor
iPhone app) persists a locally-synced copy of "today's plan" and runs the session fully offline.
A new `WatchBridge` Capacitor plugin on the iPhone side relays that plan out via
`WCSession.updateApplicationContext` and relays completed sessions back in via
`WCSession.transferUserInfo`. All domain logic (routine resolution, progression, PRs) stays in the
existing JS store — the Watch only ever sends/receives plain JSON, it never computes progression.

**Tech Stack:** SwiftUI + `WatchConnectivity` (watchOS, no new dependency — ships with the OS),
Capacitor local plugin (Swift, same pattern as the existing `PrintPlugin`), Zustand store (JS),
Vitest for JS tests.

**Spec:** `docs/superpowers/specs/2026-09-20-apple-watch-app-design.md`

## Global Constraints

- No new App Store distribution: the Watch app is built/run from Xcode alongside the iPhone app
  (free signing or AltStore), same as `docs/MOBILE.md` already documents for iOS.
- watchOS cannot run Capacitor/WKWebView — the Watch app must be native SwiftUI. Not a choice.
- No new JS dependencies (CONTRIBUTING.md: dependency-light is a hard constraint). The only new
  dependency anywhere is Apple's own `WatchConnectivity` framework (ships with the OS).
- Phase 1 set types only: warmup + straight work sets, modes reps/time/cardio. No drop-sets,
  rest-pause, or per-side (unilateral) sets on the Watch — flatten those to a straight row when
  building the payload. (Phase 2, out of scope for this plan.)
- Watch-independent: the Watch must start and fully log a session with the phone unreachable.
  The Watch never runs progression — the phone always finishes the workout.
- Today's plan only: no routine browser on the Watch.
- Training-logic changes need a unit test in `src/lib` beside the code (CONTRIBUTING.md). Native
  Swift has no test harness in this repo today — Swift tasks are manually verified instead
  (documented per-task, not silently skipped).

---

## Task 1: Watch plan payload builder (`lib/watch-sync.js`)

**Files:**
- Create: `frontend/src/lib/watch-sync.js`
- Test: `frontend/src/lib/watch-sync.test.js`

**Interfaces:**
- Consumes: `effectiveRoutineIds(S, iso)`, `lastEntryFor(S, exId)`, `bestWeightFor` (unused here),
  `bestWeightForEntry(entry)` from `./history.js`; `buildCombinedEntries(st, routineIds)`,
  `deriveSessionName(names)` from `./session-merge.js`; `exOr(id)` from `./exercises.js`;
  `phaseForSet(set)` from `./workout-model.js`; `todayISO()` from `./format.js`.
- Produces: `flattenSetForWatch(set)` and `buildWatchPlanPayload(S, iso)`, consumed by Task 3
  (`lib/watch-bridge.js`) to build what gets sent to the Watch.

- [ ] **Step 1: Write the failing test**

```js
// frontend/src/lib/watch-sync.test.js
import { describe, expect, it } from 'vitest'
import { flattenSetForWatch, buildWatchPlanPayload } from './watch-sync.js'

describe('flattenSetForWatch', () => {
  it('keeps a straight reps row as-is', () => {
    expect(flattenSetForWatch({ w: 60, r: 8, done: true })).toEqual({ phase: 'work', w: 60, r: 8, done: false })
  })
  it('marks a warmup row', () => {
    expect(flattenSetForWatch({ w: 20, r: 8, warmup: true })).toEqual({ phase: 'warmup', w: 20, r: 8, done: false })
  })
  it('keeps a time-mode row\'s sec/w', () => {
    expect(flattenSetForWatch({ sec: 45, w: 5, done: false })).toEqual({ phase: 'work', sec: 45, w: 5, done: false })
  })
  it('keeps a cardio row\'s min/speed', () => {
    expect(flattenSetForWatch({ min: 20, speed: 8 })).toEqual({ phase: 'work', min: 20, speed: 8, done: false })
  })
  it('flattens a drop-set row to its own main w/r, dropping type/drops', () => {
    expect(flattenSetForWatch({ w: 60, r: 8, type: 'dropset', drops: [{ w: 48, r: 8 }] }))
      .toEqual({ phase: 'work', w: 60, r: 8, done: false })
  })
  it('flattens a per-side row to its synced scalar aggregate', () => {
    const side = { sides: { L: { w: 20, r: 6, done: true }, R: { w: 20, r: 6, done: true } }, w: 20, r: 12, done: true }
    expect(flattenSetForWatch(side)).toEqual({ phase: 'work', w: 20, r: 12, done: false })
  })
})

describe('buildWatchPlanPayload', () => {
  const routine = { id: 'r1', name: 'Push Day', ex: [{ id: 'bench-press', sets: 1, reps: 8, weight: 60 }] }
  const S = { routines: [routine], dayPlan: {}, week: { mon: ['r1'] }, workouts: [], exWeights: {}, unit: 'kg', active: null, customEx: [] }

  it('returns null when nothing is scheduled that day', () => {
    expect(buildWatchPlanPayload({ ...S, week: {} }, '2026-09-21')).toBeNull()
  })
  it('builds a slim per-exercise payload for a scheduled day', () => {
    // 2026-09-21 is a Monday
    const payload = buildWatchPlanPayload(S, '2026-09-21')
    expect(payload.date).toBe('2026-09-21')
    expect(payload.routineIds).toEqual(['r1'])
    expect(payload.name).toBe('Push Day')
    expect(payload.activeOnPhone).toBe(false)
    expect(payload.entries).toHaveLength(1)
    expect(payload.entries[0].id).toBe('bench-press')
    expect(payload.entries[0].sets[0]).toMatchObject({ phase: 'work', done: false })
  })
  it('reflects an already-started phone session', () => {
    const payload = buildWatchPlanPayload({ ...S, active: { id: 'a1' } }, '2026-09-21')
    expect(payload.activeOnPhone).toBe(true)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd frontend && npx vitest run src/lib/watch-sync.test.js`
Expected: FAIL — `Cannot find module './watch-sync.js'` (or similar import error).

- [ ] **Step 3: Write minimal implementation**

```js
// frontend/src/lib/watch-sync.js
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
    entries: entries.map(entry => {
      const last = lastEntryFor(S, entry.id)
      return {
        id: entry.id,
        label: exOr(entry.id).n,
        target: entry.target,
        lastTime: last ? { d: last.d, w: bestWeightForEntry({ target: last.target, sets: last.sets }) || null } : null,
        sets: entry.sets.map(flattenSetForWatch),
      }
    }),
    activeOnPhone: !!S.active,
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd frontend && npx vitest run src/lib/watch-sync.test.js`
Expected: PASS (all 8 cases).

- [ ] **Step 5: Commit**

```bash
cd frontend && git add src/lib/watch-sync.js src/lib/watch-sync.test.js
git commit -m "Add watch-sync: build the Watch's today's-plan payload

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

## Task 2: Merge a completed Watch session back into history (`lib/watch-import.js`)

**Files:**
- Create: `frontend/src/lib/watch-import.js`
- Test: `frontend/src/lib/watch-import.test.js`

**Interfaces:**
- Consumes: `buildCompletedWorkout(active, opts)` from `./finish-workout.js`;
  `insertChronological(workouts, w)`, `workoutsOn(S, iso)` from `./backfill.js`;
  `bestWeightFor(S, exId)`, `bestWeightForEntry(entry)`, `isWarmupRow(set)`,
  `workoutVolume(w)` from `./history.js`; `is1RMRecord(S, exId, entry)` from `./onerm.js`.
- Produces: `activeFromWatchPayload(payload)`, `computeWatchPRs(st, active)`,
  `finishWatchSession(st, payload, { replaceId })` — returns
  `{ workouts, exWeights, w, prs, e1prs }` — consumed by Task 3's store wiring.

- [ ] **Step 1: Write the failing test**

```js
// frontend/src/lib/watch-import.test.js
import { describe, expect, it } from 'vitest'
import { activeFromWatchPayload, computeWatchPRs, finishWatchSession } from './watch-import.js'

const payload = (over = {}) => ({
  watchSessionId: 'w1', date: '2026-09-21', start: 1000, end: 5000,
  routineIds: ['r1'], name: 'Push Day',
  entries: [{ id: 'bench-press', sets: [
    { phase: 'warmup', w: 20, r: 8, done: true },
    { phase: 'work', w: 62.5, r: 8, done: true },
  ] }],
  ...over,
})

describe('activeFromWatchPayload', () => {
  it('shapes the payload like buildCompletedWorkout expects an active session', () => {
    const active = activeFromWatchPayload(payload())
    expect(active).toMatchObject({ id: 'w1', d: '2026-09-21', start: 1000, routineIds: ['r1'], name: 'Push Day', bw: null })
    expect(active.entries).toHaveLength(1)
  })
})

describe('computeWatchPRs', () => {
  it('reports a PR when the top set beats every prior best', () => {
    const st = { workouts: [], unit: 'kg' }
    const active = activeFromWatchPayload(payload())
    const { prs } = computeWatchPRs(st, active)
    expect(prs).toEqual(['bench-press'])
  })
  it('reports no PR when a heavier set already exists', () => {
    const st = { workouts: [{ d: '2026-09-01', entries: [{ id: 'bench-press', sets: [{ w: 70, r: 5, done: true }] }] }], unit: 'kg' }
    const active = activeFromWatchPayload(payload())
    const { prs } = computeWatchPRs(st, active)
    expect(prs).toEqual([])
  })
})

describe('finishWatchSession', () => {
  it('inserts a new workout and updates exWeights when there is no same-day conflict', () => {
    const st = { workouts: [], exWeights: {}, unit: 'kg' }
    const { workouts, exWeights, w, prs } = finishWatchSession(st, payload())
    expect(workouts).toHaveLength(1)
    expect(workouts[0].id).toBe('w1')
    expect(w.entries[0].sets).toHaveLength(2)
    expect(exWeights['bench-press']).toMatchObject({ w: 62.5, d: '2026-09-21' })
    expect(prs).toEqual(['bench-press'])
  })
  it('replaces the named workout instead of adding a second one when replaceId is given', () => {
    const existing = { id: 'old', d: '2026-09-21', entries: [] }
    const st = { workouts: [existing], exWeights: {}, unit: 'kg' }
    const { workouts } = finishWatchSession(st, payload(), { replaceId: 'old' })
    expect(workouts.map(w => w.id)).toEqual(['w1'])
  })
  it('keeps an existing same-day workout when no replaceId is given', () => {
    const existing = { id: 'old', d: '2026-09-21', start: 500, entries: [] }
    const st = { workouts: [existing], exWeights: {}, unit: 'kg' }
    const { workouts } = finishWatchSession(st, payload())
    expect(workouts.map(w => w.id).sort()).toEqual(['old', 'w1'])
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd frontend && npx vitest run src/lib/watch-import.test.js`
Expected: FAIL — `Cannot find module './watch-import.js'`.

- [ ] **Step 3: Write minimal implementation**

```js
// frontend/src/lib/watch-import.js
// Folding a session logged on the Watch back into the phone's history — the design doc's "phone
// always finishes the workout" decision (§3). This deliberately does NOT reuse the backfill
// machinery's PR/exWeights suppression (lib/backfill.js completeBackfill, via sheets.jsx
// doFinishWorkout's `past` branch): a workout logged on the Watch happened today, same as a
// workout logged live on the phone, so it earns PRs and updates exWeights the same way a live
// finish does. Only the "is there already a workout this day" splice logic is shared, via
// insertChronological.
import { buildCompletedWorkout } from './finish-workout.js'
import { insertChronological } from './backfill.js'
import { bestWeightFor, bestWeightForEntry, isWarmupRow, workoutVolume } from './history.js'
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
 * Returns the pieces the store needs to apply — pure, no store access.
 */
export function finishWatchSession(st, payload, { replaceId = null } = {}) {
  const active = activeFromWatchPayload(payload)
  const { prs, e1prs } = computeWatchPRs(st, active)
  const w = buildCompletedWorkout(active, { end: payload.end, prs })
  w.vol = workoutVolume(w)
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd frontend && npx vitest run src/lib/watch-import.test.js`
Expected: PASS (all 5 cases).

- [ ] **Step 5: Commit**

```bash
cd frontend && git add src/lib/watch-import.js src/lib/watch-import.test.js
git commit -m "Add watch-import: fold a completed Watch session into history

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

## Task 3: Wire the JS↔native bridge and the same-day merge sheet

**Files:**
- Create: `frontend/src/lib/watch-bridge.js`
- Test: `frontend/src/lib/watch-bridge.test.js`
- Modify: `frontend/src/sheets.jsx` (export `SameDayChoice` and `FinishSummary`; add
  `handleIncomingWatchSession`)
- Modify: `frontend/src/store/useStore.js` (call `initWatchBridge` alongside `initReminderSync`;
  push the plan payload from `persist()`)

**Interfaces:**
- Consumes: `MOBILE` from `./mobile.js`; `buildWatchPlanPayload` from `./watch-sync.js`;
  `finishWatchSession` from `./watch-import.js`; `workoutsOn` from `./backfill.js`.
- Produces: `syncTodayPlanToWatch(S)`, `initWatchBridge(getState, applyImport)` from
  `watch-bridge.js` — `applyImport` is the callback the store passes in to actually mutate
  `S.workouts`/`S.exWeights` (kept out of this file so it stays pure/testable without the store).

- [ ] **Step 1: Write the failing test**

```js
// frontend/src/lib/watch-bridge.test.js
import { describe, expect, it, vi, beforeEach } from 'vitest'
import { planPushPayload, decideWatchImport } from './watch-bridge.js'

describe('planPushPayload', () => {
  it('returns null off mobile (nothing to push, no plugin to call)', () => {
    expect(planPushPayload({ routines: [], dayPlan: {}, week: {}, workouts: [], exWeights: {}, unit: 'kg', active: null, customEx: [] }, '2026-09-22')).toBeNull()
  })
})

describe('decideWatchImport', () => {
  it('applies directly when there is no same-day conflict', () => {
    const apply = vi.fn()
    const askUser = vi.fn()
    const st = { workouts: [], exWeights: {}, unit: 'kg' }
    const payload = { watchSessionId: 'w1', date: '2026-09-21', start: 0, end: 1, routineIds: [], name: 'Push', entries: [] }
    decideWatchImport(st, payload, { apply, askUser })
    expect(apply).toHaveBeenCalledTimes(1)
    expect(askUser).not.toHaveBeenCalled()
  })
  it('asks the user to choose when there is already a workout that day', () => {
    const apply = vi.fn()
    const askUser = vi.fn()
    const st = { workouts: [{ id: 'old', d: '2026-09-21', start: 100, entries: [] }], exWeights: {}, unit: 'kg' }
    const payload = { watchSessionId: 'w1', date: '2026-09-21', start: 0, end: 1, routineIds: [], name: 'Push', entries: [] }
    decideWatchImport(st, payload, { apply, askUser })
    expect(askUser).toHaveBeenCalledTimes(1)
    expect(apply).not.toHaveBeenCalled()
    const [existing] = askUser.mock.calls[0]
    expect(existing.map(w => w.id)).toEqual(['old'])
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd frontend && npx vitest run src/lib/watch-bridge.test.js`
Expected: FAIL — `Cannot find module './watch-bridge.js'`.

- [ ] **Step 3: Write minimal implementation**

```js
// frontend/src/lib/watch-bridge.js
// The JS side of the phone <-> Watch bridge (design doc §4.1). The native half is the
// `WatchBridge` Capacitor plugin (Task 4). This file stays store-agnostic and testable: it takes
// state in, returns plain data or calls the callbacks it's given, and never imports the store or
// sheets.jsx directly (sheets.jsx's merge UI is wired in from useStore.js, Step 3b below, so
// there's no import cycle between the store and the UI layer).
import { MOBILE } from './mobile.js'
import { buildWatchPlanPayload } from './watch-sync.js'
import { finishWatchSession } from './watch-import.js'
import { workoutsOn } from './backfill.js'

/** Today's plan, or null when there's nothing to sync (off mobile, or no plan that day). */
export function planPushPayload(S, iso) {
  if (!MOBILE) return null
  return buildWatchPlanPayload(S, iso)
}

let pluginPromise = null
async function plugin() {
  if (!MOBILE) return null
  if (!pluginPromise) {
    pluginPromise = import('@capacitor/core')
      .then(({ registerPlugin }) => registerPlugin('WatchBridge'))
      .catch(() => null)
  }
  return pluginPromise
}

/** Push the latest today's-plan payload out to a paired Watch. Silently a no-op with no plugin,
 * no paired Watch, or no plan that day — there is nothing the caller needs to react to either way. */
export async function syncTodayPlanToWatch(S, iso) {
  const payload = planPushPayload(S, iso)
  const p = await plugin()
  if (!p) return
  try { await p.syncTodayPlan({ payload: payload ? JSON.stringify(payload) : null }) } catch (e) { /* no paired Watch */ }
}

/**
 * Decide how to fold one incoming completed Watch session into history: straight through when
 * there's no same-day workout already, otherwise hand the choice to `askUser` (the same
 * replace-or-add decision `sheets.jsx`'s SameDayChoice already makes for backfilled workouts).
 * `apply(result)` receives `finishWatchSession`'s return value; `askUser(existing, choose)` is
 * given the conflicting workouts and a `choose(replaceId | null)` callback to resolve with.
 */
export function decideWatchImport(st, payload, { apply, askUser }) {
  const existing = workoutsOn(st, payload.date)
  if (!existing.length) { apply(finishWatchSession(st, payload)); return }
  askUser(existing, replaceId => apply(finishWatchSession(st, payload, { replaceId })))
}

/** Register the native listener for completed Watch sessions. `onSession(payload)` is called
 * once per incoming session (already JSON.parsed). No-op off mobile. */
export async function initWatchBridge(onSession) {
  const p = await plugin()
  if (!p) return
  p.addListener('watchSessionReceived', ev => {
    try { onSession(JSON.parse(ev.payload)) } catch (e) { /* malformed payload — drop it */ }
  })
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd frontend && npx vitest run src/lib/watch-bridge.test.js`
Expected: PASS (both cases).

- [ ] **Step 5: Export `SameDayChoice` and `FinishSummary` from `sheets.jsx`, add the handler**

In `frontend/src/sheets.jsx`, find `function SameDayChoice(` (defined right after `LogPastWorkout`,
around line 1826) and `function FinishSummary(` (defined right before `export function
finishWorkout()`, around line 2060 — search for `function FinishSummary`). Add the `export`
keyword to both declarations (they are otherwise unchanged):

```js
export function SameDayChoice({ iso, existing, onReplace, onAdd, close }) {
```

```js
export function FinishSummary({ w, prs, e1prs, close }) {
```

Then, near the bottom of the "workout lifecycle" section (after `doFinishWorkout`, i.e. after the
closing brace that currently ends the file's line ~2140), add:

```js
/* ============================ Apple Watch session import ============================ */
// A session logged on the Watch arrives here already finished (design doc §3: the Watch never
// runs progression) — this only decides same-day placement and applies the result, reusing the
// existing SameDayChoice sheet for the conflict case instead of inventing a new one.
export function handleIncomingWatchSession(payload) {
  const st = S()
  decideWatchImport(st, payload, {
    apply: ({ workouts, exWeights, w, prs, e1prs }) => {
      update(s => { s.workouts = workouts; s.exWeights = exWeights })
      useStore.getState().autoBackupNow()
      ui().openSheet(close => <FinishSummary w={w} prs={prs} e1prs={e1prs} close={close} />, { kind: 'center', locked: true })
    },
    askUser: (existing, choose) => {
      ui().openSheet(c => <SameDayChoice iso={payload.date} existing={existing} close={c}
        onReplace={id => { c(); choose(id) }} onAdd={() => { c(); choose(null) }} />, { kind: 'center' })
    },
  })
}
```

Add the import at the top of `sheets.jsx`, alongside the other `lib/` imports:

```js
import { decideWatchImport } from './lib/watch-bridge.js'
```

- [ ] **Step 6: Wire it into `useStore.js`**

In `frontend/src/store/useStore.js`, add the import alongside the existing `mobile.js` import
(line 8):

```js
import { syncTodayPlanToWatch, initWatchBridge } from '../lib/watch-bridge.js'
```

Right after `initReminderSync(() => get().S)` (line 129), start the incoming-session listener.
`handleIncomingWatchSession` is imported lazily (like the existing `useUI.js` imports in this
file) to avoid a cycle, since `sheets.jsx` imports from the store:

```js
import('../sheets.jsx').then(({ handleIncomingWatchSession }) => initWatchBridge(handleIncomingWatchSession))
```

Inside `nativePersist` (the function defined at line 133, which already debounces `nativeSave`/
`syncReminder` on every mobile persist), push the latest plan to the Watch on the same debounce:

```js
const nativePersist = () => {
  clearTimeout(saveTm)
  saveTm = setTimeout(() => {
    saveTm = null
    nativeSave(get().S)
    syncReminder(get().S)
    syncTodayPlanToWatch(get().S)
  }, 800)
}
```

And in `onAppActive(() => checkRev())` (line 197), also push on foreground — a Watch that's been
out of range should get the latest plan the moment the phone comes back:

```js
onAppActive(() => { checkRev(); if (MOBILE) syncTodayPlanToWatch(get().S) })
```

- [ ] **Step 7: Run the full frontend test suite**

Run: `cd frontend && npm test`
Expected: PASS — no existing test broken by the two `export` additions or the new imports.

- [ ] **Step 8: Commit**

```bash
cd frontend && git add src/lib/watch-bridge.js src/lib/watch-bridge.test.js src/sheets.jsx src/store/useStore.js
git commit -m "Wire the phone-side Watch bridge into the store and finish flow

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

## Task 4: `WatchBridge` Capacitor plugin (iPhone-side native code)

**Files:**
- Create: `frontend/ios/App/App/WatchBridge.swift`
- Create: `frontend/ios/App/App/WatchBridge.m`
- Modify: `frontend/ios/App/App/AppDelegate.swift`

**Interfaces:**
- Consumes: nothing from earlier JS tasks directly — this is the native counterpart Task 3's
  `registerPlugin('WatchBridge')` calls (`syncTodayPlan({payload})`) and listens to
  (`watchSessionReceived` event, `{payload}` data).
- Produces: the `WatchBridge` plugin surface `syncTodayPlan(payload: string | null)` and the
  `watchSessionReceived` event, consumed by the Watch app (Task 6) on the other end of the
  `WCSession`.

This task has no JS test — it is native Swift, following the existing `PrintPlugin.swift` /
`PrintPlugin.m` pattern exactly (`frontend/ios/App/App/PrintPlugin.swift`). Verification is
manual (Step 4).

- [ ] **Step 1: Create the plugin**

```swift
// frontend/ios/App/App/WatchBridge.swift
import Foundation
import Capacitor
import WatchConnectivity

/**
 * Relays "today's plan" out to a paired Apple Watch and completed Watch sessions back in.
 * See docs/superpowers/specs/2026-09-20-apple-watch-app-design.md §4.1.
 *
 * Usage from JS:
 *   import { registerPlugin } from '@capacitor/core';
 *   const WatchBridge = registerPlugin('WatchBridge');
 *   await WatchBridge.syncTodayPlan({ payload: JSON.stringify(planOrNull) });
 *   WatchBridge.addListener('watchSessionReceived', ({ payload }) => { ... });
 */
@objc(WatchBridge)
public class WatchBridge: CAPPlugin, WCSessionDelegate {

    public override func load() {
        guard WCSession.isSupported() else { return }
        let session = WCSession.default
        session.delegate = self
        session.activate()
    }

    @objc func syncTodayPlan(_ call: CAPPluginCall) {
        guard WCSession.isSupported(), WCSession.default.activationState == .activated else {
            call.resolve()
            return
        }
        let payload = call.getString("payload")
        do {
            try WCSession.default.updateApplicationContext(["payload": payload as Any])
            call.resolve()
        } catch {
            // No paired Watch, or the Watch app isn't installed — not an error the caller acts on.
            call.resolve()
        }
    }

    // MARK: WCSessionDelegate

    public func session(_ session: WCSession, activationDidCompleteWith activationState: WCSessionActivationState, error: Error?) {}
    public func sessionDidBecomeInactive(_ session: WCSession) {}
    public func sessionDidDeactivate(_ session: WCSession) { session.activate() }

    // A completed session, sent from the Watch via transferUserInfo (queued, background-capable —
    // delivered here whether the app was foreground, background, or just-launched for this).
    public func session(_ session: WCSession, didReceiveUserInfo userInfo: [String: Any] = [:]) {
        guard let payload = userInfo["payload"] as? String else { return }
        notifyListeners("watchSessionReceived", data: ["payload": payload])
    }
}
```

```objc
// frontend/ios/App/App/WatchBridge.m
#import <Foundation/Foundation.h>
#import <Capacitor/Capacitor.h>

// Bridges the Swift WatchBridge plugin into Capacitor's Objective-C plugin registry.
CAP_PLUGIN(WatchBridge, "WatchBridge",
           CAP_PLUGIN_METHOD(syncTodayPlan, CAPPluginReturnPromise);
)
```

- [ ] **Step 2: Activate the session at launch**

`WCSession` activation happens in the plugin's `load()` above (Capacitor calls `load()` once
per registered plugin at bridge setup, which already runs at app launch) — no `AppDelegate.swift`
change is actually required for activation itself. Confirm this by reading
`frontend/ios/App/App/AppDelegate.swift`: it has no plugin-registration code to modify (Capacitor
plugins registered via `CAP_PLUGIN` are auto-discovered), so this step is a no-op — recorded here
so a reviewer doesn't go looking for a missing edit.

- [ ] **Step 3: Add both files to the Xcode project**

Open `frontend/ios/App/App.xcworkspace` in Xcode. Right-click the `App` group (which already
contains `PrintPlugin.swift`/`PrintPlugin.m`) → **Add Files to "App"...** → select
`WatchBridge.swift` and `WatchBridge.m` → ensure **Target: App** is checked → Add.

- [ ] **Step 4: Manual verification**

Build and run the iPhone app on a device or simulator (`npx cap open ios` after
`npm run build:mobile`, per `docs/MOBILE.md`). Confirm:
- The build succeeds with `WatchBridge.swift`/`.m` included (no missing-symbol errors).
- From Safari's Web Inspector (attached to the running app's WebView), running
  `window.Capacitor.Plugins.WatchBridge.syncTodayPlan({ payload: null })` in the console resolves
  without throwing (there's no paired Watch app yet at this point in the plan — that's fine, the
  plugin is expected to resolve regardless per Step 1's `call.resolve()` on failure).

- [ ] **Step 5: Commit**

```bash
git add frontend/ios/App/App/WatchBridge.swift frontend/ios/App/App/WatchBridge.m
git commit -m "Add WatchBridge Capacitor plugin (iPhone side of the Watch sync)

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

## Task 5: Create the WatchApp Xcode target

**Files:**
- Create (via Xcode, not by hand): `frontend/ios/App/WatchApp/` — the new target's source group
- Modify: `frontend/ios/App/App.xcodeproj/project.pbxproj` (Xcode writes this)

This step is Xcode-GUI-only — `project.pbxproj` is not hand-edited in this plan; scripting a new
target into it reliably without Xcode itself is far more error-prone than using the target
wizard, and the wizard is what `docs/MOBILE.md` already assumes for the existing iOS target.

- [ ] **Step 1: Add the target**

In Xcode, with `frontend/ios/App/App.xcworkspace` open: **File → New → Target...** → **watchOS**
tab → **App** → Next. Fill in:
- **Product Name:** `WatchApp`
- **Team:** the same free/personal team already used for the `App` target (Settings → Signing &
  Capabilities on the existing target shows which)
- **Bundle Identifier:** `ch.duartesantos.opengym.watchkitapp` (matches `capacitor.config.json`'s
  `appId` of `ch.duartesantos.opengym`, `.watchkitapp` suffix per Apple's convention)
- **Interface:** SwiftUI, **Language:** Swift
- **Include Notification Scene:** unchecked (out of scope, design doc §9)
- Ensure **Embed in Companion Application** is set to `App` — this is what pairs the Watch app to
  the existing iPhone app instead of creating a standalone one.

Finish. Xcode creates `frontend/ios/App/WatchApp/` with a default `WatchAppApp.swift` and
`ContentView.swift`, adds a `WatchApp Watch App` scheme, and wires the embed automatically.

- [ ] **Step 2: Remove the placeholder content**

Delete the boilerplate `ContentView.swift`'s body content (Task 7 replaces it with `TodayView`) —
leave the file itself in place, Task 7 edits it.

- [ ] **Step 3: Manual verification**

Build the `WatchApp Watch App` scheme (Product → Build, with that scheme selected) targeting a
watchOS Simulator. Confirm it builds and launches showing the default SwiftUI "Hello, World"
placeholder. Also rebuild the `App` scheme (the iPhone target) to confirm embedding the new Watch
app didn't break the existing iOS build.

- [ ] **Step 4: Commit**

```bash
git add frontend/ios/App/WatchApp frontend/ios/App/App.xcodeproj
git commit -m "Add the WatchApp Xcode target, paired to the existing iOS app

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

## Task 6: Watch-side connectivity and local session store

**Files:**
- Create: `frontend/ios/App/WatchApp/WatchConnectivitySession.swift`
- Create: `frontend/ios/App/WatchApp/WatchSessionStore.swift`

**Interfaces:**
- Consumes: the JSON shapes Tasks 1 & 3 define — the today's-plan payload (`watch-sync.js`'s
  `buildWatchPlanPayload` output) received via `didReceiveApplicationContext`, and sends back the
  completed-session shape `watch-import.js`'s `activeFromWatchPayload` expects, via
  `transferUserInfo`.
- Produces: `WatchSessionStore` (`ObservableObject`, `@Published var plan: WatchPlan?`,
  `@Published var activeSession: WatchActiveSession?`), consumed by Tasks 7–9's views.

No JS test; no Swift test harness exists in this repo (per Global Constraints). Verified manually
in Step 4 and again end-to-end in Task 10.

- [ ] **Step 1: Define the plan/session models and local persistence**

```swift
// frontend/ios/App/WatchApp/WatchSessionStore.swift
import Foundation
import Combine

// Mirrors the phase-1 subset of watch-sync.js's buildWatchPlanPayload output.
struct WatchSet: Codable, Identifiable {
    var id = UUID()
    var phase: String        // "warmup" | "work"
    var w: Double?
    var r: Int?
    var sec: Double?
    var min: Double?
    var speed: Double?
    var done: Bool
    enum CodingKeys: String, CodingKey { case phase, w, r, sec, min, speed, done }
}

struct WatchEntry: Codable, Identifiable {
    var id: String            // exercise id, matches entry.id on the phone
    var label: String
    var sets: [WatchSet]
}

struct WatchPlan: Codable {
    var date: String
    var routineIds: [String]
    var name: String?
    var entries: [WatchEntry]
    var activeOnPhone: Bool
}

// The Watch's own copy of an in-progress or finished session — independent of `plan` once
// started (design doc §5.1: "independent from that point on").
struct WatchActiveSession: Codable {
    var watchSessionId: String
    var date: String
    var start: Double
    var end: Double?
    var routineIds: [String]
    var name: String?
    var entries: [WatchEntry]
    var synced: Bool = false
}

final class WatchSessionStore: ObservableObject {
    static let shared = WatchSessionStore()

    @Published var plan: WatchPlan?
    @Published var activeSession: WatchActiveSession?

    private let planKey = "opengym.watch.plan"
    private let sessionKey = "opengym.watch.activeSession"
    private let defaults = UserDefaults.standard

    private init() {
        plan = Self.load(planKey, as: WatchPlan.self, from: defaults)
        activeSession = Self.load(sessionKey, as: WatchActiveSession.self, from: defaults)
    }

    func applyIncomingPlan(_ plan: WatchPlan?) {
        self.plan = plan
        Self.save(plan, key: planKey, to: defaults)
    }

    func startSession() {
        guard let plan = plan else { return }
        let session = WatchActiveSession(
            watchSessionId: UUID().uuidString,
            date: plan.date, start: Date().timeIntervalSince1970 * 1000,
            routineIds: plan.routineIds, name: plan.name, entries: plan.entries
        )
        activeSession = session
        Self.save(session, key: sessionKey, to: defaults)
    }

    // Called after every set edit (Task 8) so a killed Watch app loses nothing (design doc §7:
    // "Kill the Watch app mid-session ... is any completed set lost?").
    func persistActiveSession() {
        Self.save(activeSession, key: sessionKey, to: defaults)
    }

    func finishSession() -> WatchActiveSession? {
        guard var session = activeSession else { return nil }
        session.end = Date().timeIntervalSince1970 * 1000
        activeSession = session
        Self.save(session, key: sessionKey, to: defaults)
        return session
    }

    func clearFinishedSession() {
        activeSession = nil
        defaults.removeObject(forKey: sessionKey)
    }

    private static func load<T: Decodable>(_ key: String, as type: T.Type, from defaults: UserDefaults) -> T? {
        guard let data = defaults.data(forKey: key) else { return nil }
        return try? JSONDecoder().decode(T.self, from: data)
    }
    private static func save<T: Encodable>(_ value: T?, key: String, to defaults: UserDefaults) {
        guard let value = value, let data = try? JSONEncoder().encode(value) else {
            defaults.removeObject(forKey: key)
            return
        }
        defaults.set(data, forKey: key)
    }
}
```

- [ ] **Step 2: Wire `WatchConnectivity`**

```swift
// frontend/ios/App/WatchApp/WatchConnectivitySession.swift
import Foundation
import WatchConnectivity

// The Watch side of the bridge (counterpart to the iPhone's WatchBridge.swift, Task 4).
final class WatchConnectivitySession: NSObject, WCSessionDelegate, ObservableObject {
    static let shared = WatchConnectivitySession()

    private override init() {
        super.init()
        guard WCSession.isSupported() else { return }
        WCSession.default.delegate = self
        WCSession.default.activate()
    }

    func session(_ session: WCSession, activationDidCompleteWith activationState: WCSessionActivationState, error: Error?) {}

    // Latest today's-plan payload from the phone (WCSession's own latest-value-wins semantics —
    // design doc §4.1). Delivered even if this app wasn't running.
    func session(_ session: WCSession, didReceiveApplicationContext applicationContext: [String: Any]) {
        guard let payloadString = applicationContext["payload"] as? String else {
            DispatchQueue.main.async { WatchSessionStore.shared.applyIncomingPlan(nil) }
            return
        }
        guard let data = payloadString.data(using: .utf8),
              let plan = try? JSONDecoder().decode(WatchPlan.self, from: data) else { return }
        DispatchQueue.main.async { WatchSessionStore.shared.applyIncomingPlan(plan) }
    }

    // Sends a completed session back to the phone. transferUserInfo queues it with the OS and
    // retries delivery — it does not require the phone to be reachable right now (design doc
    // §4, the "watch-independent" requirement).
    func sendCompletedSession(_ session: WatchActiveSession) {
        guard let data = try? JSONEncoder().encode(session),
              let payloadString = String(data: data, encoding: .utf8) else { return }
        WCSession.default.transferUserInfo(["payload": payloadString])
    }
}
```

- [ ] **Step 3: Activate on launch**

In `frontend/ios/App/WatchApp/WatchAppApp.swift` (created by Xcode in Task 5), ensure the
connectivity session is instantiated at launch:

```swift
import SwiftUI

@main
struct WatchApp_Watch_AppApp: App {
    // Touching .shared here activates WCSession before any view needs it.
    private let connectivity = WatchConnectivitySession.shared

    var body: some Scene {
        WindowGroup {
            ContentView()
        }
    }
}
```

(Keep the existing struct name Xcode generated — it may differ slightly, e.g.
`WatchApp_Watch_AppApp`; match whatever Xcode named it in Task 5, only add the `connectivity`
property and its initializer comment.)

- [ ] **Step 4: Manual verification**

Build and run both the `App` and `WatchApp Watch App` schemes in paired iPhone + Watch
Simulators (Xcode → Window → Devices and Simulators, pair a Watch simulator to an iPhone
simulator if not already paired). From the iPhone app's Web Inspector console, call
`window.Capacitor.Plugins.WatchBridge.syncTodayPlan({ payload: JSON.stringify({date: "2026-09-21", routineIds: [], name: "Test", entries: [], activeOnPhone: false}) })`.
Set a breakpoint in `WatchConnectivitySession.session(_:didReceiveApplicationContext:)` on the
Watch target and confirm it's hit with that payload.

- [ ] **Step 5: Commit**

```bash
git add frontend/ios/App/WatchApp/WatchConnectivitySession.swift frontend/ios/App/WatchApp/WatchSessionStore.swift frontend/ios/App/WatchApp/WatchAppApp.swift
git commit -m "Add Watch-side connectivity session and local persistence

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

## Task 7: `TodayView` — the Watch app's home screen

**Files:**
- Modify: `frontend/ios/App/WatchApp/ContentView.swift` (rename in place to serve as `TodayView`)

**Interfaces:**
- Consumes: `WatchSessionStore.shared.plan` / `.activeSession` (Task 6).
- Produces: navigates to `SessionView` (Task 8) via a `NavigationLink`, started from
  `WatchSessionStore.shared.startSession()`.

- [ ] **Step 1: Implement the three states**

Design doc §4.4 / §5.1: no plan synced yet, a plan with nothing active, and "already started on
iPhone" (informational only — design doc §5.3, the Watch does not block on this).

```swift
// frontend/ios/App/WatchApp/ContentView.swift
import SwiftUI

struct ContentView: View {
    @ObservedObject var store = WatchSessionStore.shared
    @State private var startedSession: WatchActiveSession?

    var body: some View {
        NavigationStack {
            Group {
                if store.activeSession != nil {
                    // A session is already running locally (e.g. the app relaunched mid-workout)
                    // — go straight back into it rather than re-showing Start.
                    Color.clear.onAppear { startedSession = store.activeSession }
                } else if let plan = store.plan {
                    planView(plan)
                } else {
                    VStack(spacing: 8) {
                        Text("Not synced yet").font(.headline)
                        Text("Open the iPhone app once to sync today's plan.")
                            .font(.caption).multilineTextAlignment(.center).foregroundStyle(.secondary)
                    }.padding()
                }
            }
            .navigationDestination(item: $startedSession) { session in
                SessionView(session: session)
            }
        }
    }

    @ViewBuilder
    private func planView(_ plan: WatchPlan) -> some View {
        VStack(spacing: 10) {
            Text(plan.name ?? "Workout").font(.headline)
            Text("\(plan.entries.count) exercises").font(.caption).foregroundStyle(.secondary)
            if plan.activeOnPhone {
                Text("Already started on iPhone").font(.caption2).foregroundStyle(.orange)
            }
            Button("Start") {
                store.startSession()
                startedSession = store.activeSession
            }
            .buttonStyle(.borderedProminent)
        }.padding()
    }
}
```

`WatchActiveSession` needs `Identifiable` for `navigationDestination(item:)` — add it in
`WatchSessionStore.swift` (Task 6's file, a one-line addition):

```swift
struct WatchActiveSession: Codable, Identifiable {
    var id: String { watchSessionId }
    // ...(existing fields unchanged)
```

- [ ] **Step 2: Manual verification**

Run the Watch app in the Simulator with no plan synced yet — confirm the "Not synced yet" state.
Send a plan via the iPhone app's Web Inspector console (same call as Task 6 Step 4) — confirm the
view updates to show the plan and a Start button without relaunching the Watch app (SwiftUI
`@Published`/`@ObservedObject` should pick it up live). Tap Start — confirm it navigates onward
(to whatever `SessionView` currently renders — a placeholder is fine until Task 8 lands, as long
as the app doesn't crash).

- [ ] **Step 3: Commit**

```bash
git add frontend/ios/App/WatchApp/ContentView.swift frontend/ios/App/WatchApp/WatchSessionStore.swift
git commit -m "Add TodayView: the Watch app's Start screen

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

## Task 8: `SessionView` — logging sets, and the rest timer

**Files:**
- Create: `frontend/ios/App/WatchApp/SessionView.swift`
- Create: `frontend/ios/App/WatchApp/RestTimerView.swift`

**Interfaces:**
- Consumes: `WatchActiveSession` (Task 6), navigated to from `TodayView` (Task 7).
- Produces: mutates `WatchSessionStore.shared.activeSession` in place via
  `WatchSessionStore.shared.persistActiveSession()` after every set edit; presents
  `RestTimerView` after a work set is marked done.

- [ ] **Step 1: Implement set logging**

Each exercise is its own screen (Digital Crown scrolls the set list); Next/Back pages between
exercises. Mode is read off each set's own fields (`sec`/`min`+`speed`/`w`+`r` — matching
`flattenSetForWatch`'s phase-1 shapes from Task 1), so the same view renders all three modes.

```swift
// frontend/ios/App/WatchApp/SessionView.swift
import SwiftUI

struct SessionView: View {
    @State var session: WatchActiveSession
    @State private var exerciseIndex = 0
    @State private var showRest = false

    var body: some View {
        TabView(selection: $exerciseIndex) {
            ForEach(session.entries.indices, id: \.self) { i in
                exerciseView(i).tag(i)
            }
        }
        .tabViewStyle(.page)
        .sheet(isPresented: $showRest) { RestTimerView(seconds: 90) { showRest = false } }
        .toolbar {
            ToolbarItem(placement: .confirmationAction) {
                Button("Finish") { finish() }
            }
        }
    }

    @ViewBuilder
    private func exerciseView(_ i: Int) -> some View {
        let entry = session.entries[i]
        List {
            Section(entry.label) {
                ForEach(entry.sets.indices, id: \.self) { j in
                    setRow(entryIndex: i, setIndex: j)
                }
            }
        }
    }

    @ViewBuilder
    private func setRow(entryIndex i: Int, setIndex j: Int) -> some View {
        let set = session.entries[i].sets[j]
        HStack {
            Text(set.phase == "warmup" ? "W" : "\(j + 1)").font(.caption2).foregroundStyle(.secondary)
            if set.sec != nil {
                Stepper("\(Int(set.sec ?? 0))s", value: Binding(
                    get: { session.entries[i].sets[j].sec ?? 0 },
                    set: { session.entries[i].sets[j].sec = $0 }), in: 0...600, step: 5)
            } else if set.min != nil {
                Text("\(Int(set.min ?? 0)) min @ \(String(format: "%.1f", set.speed ?? 0))")
            } else {
                Stepper(value: Binding(
                    get: { session.entries[i].sets[j].w ?? 0 },
                    set: { session.entries[i].sets[j].w = $0 }), in: 0...500, step: 2.5) {
                    Text("\(String(format: "%.1f", set.w ?? 0)) x \(set.r ?? 0)")
                }
            }
            Spacer()
            Button {
                toggleDone(entryIndex: i, setIndex: j)
            } label: {
                Image(systemName: set.done ? "checkmark.circle.fill" : "circle")
            }.buttonStyle(.plain)
        }
    }

    private func toggleDone(entryIndex i: Int, setIndex j: Int) {
        session.entries[i].sets[j].done.toggle()
        WatchSessionStore.shared.activeSession = session
        WatchSessionStore.shared.persistActiveSession()
        if session.entries[i].sets[j].done && session.entries[i].sets[j].phase == "work" {
            showRest = true
        }
    }

    private func finish() {
        WatchSessionStore.shared.activeSession = session
        guard let finished = WatchSessionStore.shared.finishSession() else { return }
        WatchConnectivitySession.shared.sendCompletedSession(finished)
        WatchSessionStore.shared.clearFinishedSession()
    }
}
```

```swift
// frontend/ios/App/WatchApp/RestTimerView.swift
import SwiftUI
import WatchKit

struct RestTimerView: View {
    let seconds: Int
    var onDone: () -> Void
    @State private var remaining: Int
    @State private var timer: Timer?

    init(seconds: Int, onDone: @escaping () -> Void) {
        self.seconds = seconds
        self.onDone = onDone
        _remaining = State(initialValue: seconds)
    }

    var body: some View {
        VStack(spacing: 10) {
            Text("\(remaining)s").font(.system(size: 40, weight: .bold, design: .rounded))
            Button("Skip") { finish() }
        }
        .onAppear { start() }
        .onDisappear { timer?.invalidate() }
    }

    private func start() {
        timer = Timer.scheduledTimer(withTimeInterval: 1, repeats: true) { _ in
            remaining -= 1
            if remaining <= 0 { finish() }
        }
    }

    private func finish() {
        timer?.invalidate()
        WKInterfaceDevice.current().play(.success)
        onDone()
    }
}
```

- [ ] **Step 2: Manual verification**

Run the Watch app, sync a plan with at least two exercises across the three modes (send a
hand-built payload via the Web Inspector console, matching Task 1's `flattenSetForWatch` output
shapes for `w`/`r`, `sec`+`w`, and `min`+`speed` rows), Start, log a few sets, confirm:
- Marking a work set done presents `RestTimerView`, counts down, and haptic-buzzes at zero.
- Force-quitting the Watch app mid-session (via the Simulator's app switcher) and relaunching
  resumes into `SessionView` with the same logged sets intact (Task 6's `persistActiveSession`).
- **Finish** stops the session and returns to `TodayView`.

- [ ] **Step 3: Commit**

```bash
git add frontend/ios/App/WatchApp/SessionView.swift frontend/ios/App/WatchApp/RestTimerView.swift
git commit -m "Add SessionView: log sets and run the rest timer on the Watch

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

## Task 9: Idempotent sync-back on the phone (redelivery-safe)

**Files:**
- Modify: `frontend/src/lib/watch-bridge.js`
- Test: `frontend/src/lib/watch-bridge.test.js` (extend)

**Interfaces:**
- Consumes: `readJsonFile(name)`, `writeJsonFile(name, data)` from `./mobile.js`.
- Produces: `isWatchSessionSeen(seenIds, watchSessionId)`, `withWatchSessionSeen(seenIds, watchSessionId)`
  (pure, capped-size helpers), wired into `initWatchBridge`'s listener so a redelivered
  `transferUserInfo` (design doc §5.2 — the OS can redeliver after a partial failure) is a no-op.

- [ ] **Step 1: Write the failing test**

```js
// append to frontend/src/lib/watch-bridge.test.js
import { isWatchSessionSeen, withWatchSessionSeen } from './watch-bridge.js'

describe('watch session idempotency', () => {
  it('is not seen until recorded', () => {
    expect(isWatchSessionSeen([], 'w1')).toBe(false)
  })
  it('is seen once recorded', () => {
    const seen = withWatchSessionSeen([], 'w1')
    expect(isWatchSessionSeen(seen, 'w1')).toBe(true)
  })
  it('keeps only the most recent 50 ids', () => {
    let seen = []
    for (let i = 0; i < 60; i++) seen = withWatchSessionSeen(seen, `w${i}`)
    expect(seen).toHaveLength(50)
    expect(isWatchSessionSeen(seen, 'w0')).toBe(false)
    expect(isWatchSessionSeen(seen, 'w59')).toBe(true)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd frontend && npx vitest run src/lib/watch-bridge.test.js`
Expected: FAIL — `isWatchSessionSeen`/`withWatchSessionSeen` are not exported yet.

- [ ] **Step 3: Implement and wire it in**

Add to `frontend/src/lib/watch-bridge.js`:

```js
const SEEN_LIMIT = 50

/** Has this Watch session id already been applied? Redelivery-safe (design doc §5.2). */
export function isWatchSessionSeen(seenIds, watchSessionId) {
  return seenIds.includes(watchSessionId)
}

/** Record a session id as applied, keeping only the most recent SEEN_LIMIT. */
export function withWatchSessionSeen(seenIds, watchSessionId) {
  return [...seenIds.filter(id => id !== watchSessionId), watchSessionId].slice(-SEEN_LIMIT)
}
```

Then update `initWatchBridge` in the same file to persist and check seen ids, using the same
device-local JSON file pattern `mobile.js` already uses for the pairing/coach files:

```js
import { readJsonFile, writeJsonFile } from './mobile.js'

const SEEN_FILE = 'opengym-watch-seen.json'

export async function initWatchBridge(onSession) {
  const p = await plugin()
  if (!p) return
  let seenIds = (await readJsonFile(SEEN_FILE)) || []
  p.addListener('watchSessionReceived', async ev => {
    let payload
    try { payload = JSON.parse(ev.payload) } catch (e) { return }
    if (!payload?.watchSessionId || isWatchSessionSeen(seenIds, payload.watchSessionId)) return
    seenIds = withWatchSessionSeen(seenIds, payload.watchSessionId)
    await writeJsonFile(SEEN_FILE, seenIds)
    onSession(payload)
  })
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd frontend && npx vitest run src/lib/watch-bridge.test.js`
Expected: PASS (all cases, including the 3 new idempotency ones).

- [ ] **Step 5: Run the full frontend suite once more**

Run: `cd frontend && npm test`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
cd frontend && git add src/lib/watch-bridge.js src/lib/watch-bridge.test.js
git commit -m "Make Watch session sync-back idempotent against redelivery

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

## Task 10: Docs and end-to-end failure-mode verification

**Files:**
- Modify: `docs/MOBILE.md`

No new test — this task documents the feature and manually runs the design doc's own
failure-mode scenarios (spec §7), which by construction cannot be found by tests derived from the
same design.

- [ ] **Step 1: Document the Watch app in `docs/MOBILE.md`**

Add a new section after "### Connecting the app to your own server" (around line 42, before
"## Prerequisites"):

```markdown
### Apple Watch companion

The iOS app has an optional Apple Watch companion (`frontend/ios/App/WatchApp`) that starts and
logs today's scheduled workout from the wrist, phone optional. It's a native SwiftUI app, not a
Capacitor/web view — watchOS doesn't support that. The Watch keeps its own local copy of today's
plan (synced from the phone via `WatchConnectivity` whenever the plan changes or the phone comes
back into range) and can run a whole session with the phone unreachable; the iPhone app is what
finishes the workout (progression, PRs, history) once the two devices reconnect.

Build it the same way as the iPhone app: open `ios/App/App.xcworkspace` in Xcode, select the
`WatchApp Watch App` scheme, and run it on a paired Watch (Simulator or a physical Watch paired
to the iPhone you're running the `App` scheme on). Free Xcode signing applies here too, same
7-day renewal as the iPhone app (see "iPhone — what's actually possible" below).

Phase 1 (current): straight work + warmup sets, reps/time/cardio modes, today's plan only. No
drop-sets, rest-pause, or per-side sets on the Watch yet — those still need the phone or the web
app; see `docs/superpowers/specs/2026-09-20-apple-watch-app-design.md` §8 for the planned
follow-on.
```

- [ ] **Step 2: Run the design doc's failure-mode scenarios manually**

Using paired iPhone + Watch Simulators (or physical devices), work through each scenario from
`docs/superpowers/specs/2026-09-20-apple-watch-app-design.md` §7 and confirm the stated
expectation holds:

1. Start a Watch session, background/quit the iPhone app for the rest of the session, finish on
   the Watch, then relaunch the iPhone app — confirm the workout appears in History with correct
   sets, and (if it set a new top weight) shows as a PR.
2. Force-quit the Watch app mid-session, relaunch — confirm the in-progress sets are still there
   (Task 6/8's local persistence).
3. Start a workout on the Watch, then independently start and finish a different workout on the
   phone the same day — confirm the same-day choice sheet (Task 3) appears when the Watch session
   arrives, and neither workout is silently lost.
4. Manually resend the same `transferUserInfo` payload twice (e.g. by calling
   `WatchConnectivitySession.shared.sendCompletedSession(_:)` twice with the same session in a
   debugger) — confirm only one workout appears in History (Task 9's idempotency).
5. Sync a plan, start a session on the Watch, then edit the routine on the phone (remove an
   exercise) while the Watch session is still running — confirm the Watch keeps running its
   already-started session unchanged (it committed to a snapshot at Start, per Task 6's
   `startSession()` copying `plan.entries` into the new `WatchActiveSession`).

Record the outcome of each (pass/fail + notes) in the PR description or commit message for this
task — this plan does not prescribe a fixed place for that write-up beyond "don't lose it before
requesting review."

- [ ] **Step 3: Commit**

```bash
git add docs/MOBILE.md
git commit -m "Document the Apple Watch companion app

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```
