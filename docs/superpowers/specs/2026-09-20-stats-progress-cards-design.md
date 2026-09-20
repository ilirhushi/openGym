# Stats page: progress-focused cards

Date: 2026-09-20
Status: approved for implementation

## Problem

`frontend/src/views/Stats.jsx` already shows a lot: workout/streak tiles, weight and body-fat
deltas, a 12-month activity heatmap, muscle balance/fatigue/strength maps, an effort (RIR/RPE)
card, weight/body-fat trend charts, and a per-exercise progress chart (top set, est. 1RM,
effort). What it does not answer, at a glance, is the three questions someone reviewing their
progress actually asks:

1. Is my overall training trending up or down (volume, frequency)?
2. What have I actually achieved, ever (personal records)?
3. What has stopped improving, and needs a change (plateaus)?

This spec adds three cards to answer those, reusing existing data (`w.vol`, the progression
engine's own stall tracking, the mode-detection logic already in `Stats.jsx`) rather than
introducing new persisted fields.

## Non-goals

- No new persisted state. Everything here is derived at render time from `S.workouts` /
  `S.plan`, the same way the rest of `Stats.jsx` works.
- No changes to how PRs are detected/flagged live during logging (`w.prs`, `set.pr` — those stay
  as they are, used elsewhere).
- No changes to the progression engine's own deload/hold/up decisions — the plateau card reads
  its existing `stallCount` output, it doesn't add a second opinion.

## New lib modules

Each is a pure function over `S` (mirroring `lib/onerm.js`, `lib/muscles.js`), with a
same-directory `*.test.js` per CONTRIBUTING.md.

### `lib/training-trend.js`

```
weeklyTrend(workouts, weeks) -> [{ t, vol, count }]
```

Buckets `workouts` into week-start-aligned buckets (respecting the profile's week-start day, the
same convention `weekStartOf`/`streakWeeks` already use), going back `weeks` weeks from now (or
all history when `weeks` is falsy, matching the `range === 0` = "All" convention used elsewhere
on this page). Per bucket:
- `vol`: sum of each workout's cached `w.vol` (already unit-converted tonnage, same field the
  heatmap's volume view reads).
- `count`: number of workouts in that bucket.

No new tonnage math — `w.vol` already exists on every workout.

### `lib/records.js`

```
personalRecords(S) -> [{ id, name, value, unit, date, metric }]
```

For every exercise id that appears in `S.workouts` history (same universe as `exHist` in
`Stats.jsx`), determines its trained mode the same way `Stats.jsx`'s `metricDataOf`/`currentOf`
already do, then finds the best-ever value and the date it was set:

- reps mode, ever loaded: best top-set weight ever (mirrors `bestWeightForEntry`), **and**
  separately the best estimated 1RM ever (`onerm.js`'s `best1RM`) when the exercise has one —
  each is its own record entry since they can happen on different dates.
- reps mode, never loaded (bodyweight-only movements like pull-ups): best rep count in a set
  ever (`completedRepsOf`).
- cardio mode: best top speed ever.
- distance mode: farthest distance ever (converted for display like the existing chart does).
- time mode: longest hold ever.

`metric` on each row is a short discriminator (`'weight' | 'e1rm' | 'reps' | 'speed' |
'distance' | 'time'`) so the UI can render the right unit/label without re-deriving mode.
Results sort by `date` descending (most recently achieved first).

This intentionally does not read `w.prs`/`set.pr`: those are written only at live-logging time
and `import-csv.js`/`import-hevy.js` always write `prs: []`, so a user with imported history
would see no records at all if this reused them.

### `lib/plateaus.js`

```
stalledExercises(S) -> [{ id, name, reason, kind }]
```

For each exercise in `exHist`'s universe:

1. **Engine-tracked path** — if the exercise currently has an entry with an active progression
   policy (`policy !== 'off'`) in some routine in `S.plan`, compute
   `stallCount(sessionsFor(S, exId, fallback), policy)` (both already exported by
   `lib/progression.js`) and flag it when `stalls >= DELOAD_AFTER[policy]`. `reason` reuses the
   same phrasing style as `nextPrescription`'s `why` (e.g. "Missed reps 3 sessions running").
   `kind: 'engine'`.
2. **Fallback path** — every other trained exercise (no active policy, or dropped from every
   routine): take its best-metric series in chronological order (same metric `records.js`
   computes per session, not just the all-time best) and flag it when the last 4 completed
   sessions show no improvement over the session before them (i.e. the value has been flat or
   declining for 4 sessions running). Requires at least 4 sessions of history to evaluate;
   exercises with fewer are never flagged. `reason`: "No improvement in 4 sessions."
   `kind: 'fallback'`.

An exercise never gets both — the engine path takes priority when it applies, since it's the
same signal already driving that exercise's actual prescriptions.

## UI: three new cards in `Stats.jsx`

Placed after the existing `MuscleBalance` / `EffortCard` pair, before the body-weight /
body-fat / exercise-progress `cols` block — continuing the "how's my training going" narrative
before the raw curves.

### Training Volume card

- `Segmented` toggle: Volume (tonnage) / Frequency (workouts per week) — same pattern as
  `MuscleBalance`'s view toggle.
- Range `Segmented`: 30d / 90d / 1Y / All — same values as the existing range control on this
  page.
- `LineChart` of the weekly series from `weeklyTrend`, unit = `S.unit` for volume, "workouts"
  for frequency.
- A small delta line under the chart: average of the last 4 weeks vs. the average of the 4
  weeks before that, colored up/down the same way the body-weight 30d tile is (more volume/
  frequency = accent color, less = the existing "down" color — reusing `bwDeltaColor`'s pattern,
  not its bodyweight-specific direction logic).
- Hidden metric with fewer than 2 weeks of data: falls back to the existing
  `<div className="muted small">` empty-state pattern used elsewhere on this page.

### Personal Records card

- List, most-recent-first, one row per record: exercise name, value + unit, date.
- Capped to the 10 most recent; footer line states the total count when there are more
  ("+12 more"), no drill-down screen for this iteration.
- Empty state: "No personal records yet." (same muted-small pattern).

### Needs Attention card

- List of `stalledExercises` rows: exercise name + `reason`.
- Tapping a row sets the existing `exId` state so the exercise-progress chart further down
  the page jumps to that exercise — no separate detail view.
- The whole card is omitted (not rendered) when `stalledExercises` returns empty — this is a
  "something to look at" card, not a status card, so an empty list should not read as "nothing
  is happening, this is fine."

## Testing

- `training-trend.test.js`, `records.test.js`, `plateaus.test.js` beside their modules, covering
  the derivation logic per CONTRIBUTING.md's rule for anything that reads a logged session back.
- Per this project's review guidance: tests should include failure-mode cases, not just the
  happy path derived from the design above — e.g. an exercise with exactly 4 sessions (boundary
  of the fallback rule), an exercise whose progression policy was turned off mid-history, a
  workout with `vol` missing/0 (legacy/imported record), and an exercise that appears in two
  routines with different policies.
- No changes to existing tests are expected; nothing here touches `finish-workout.js`,
  `session-edit.js`, or the live PR-flagging path.
