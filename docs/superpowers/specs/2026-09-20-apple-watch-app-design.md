# Apple Watch app: start & log a workout — design

Status: approved for planning
Owner: Ilir Hushi

## 1. Purpose

openGym's mobile app (`frontend/ios`, Capacitor) has no watchOS companion. The goal of this
phase is to let someone start today's workout on their Apple Watch and log weights/reps
entirely from the wrist, phone optional. This is phase 1 of a two-phase project (see §8);
it does not attempt full feature parity with the phone's session screen.

## 2. Constraints from the existing app

- **No App Store distribution** (`docs/MOBILE.md`): the iOS app is sideloaded via free Xcode
  signing or AltStore. A watchOS companion app follows the same path — built and installed
  from Xcode alongside the iPhone app, no TestFlight/App Store review needed for personal use.
- **watchOS cannot run Capacitor.** There is no WKWebView-equivalent story on watchOS, so the
  Watch app must be a native SwiftUI target. This is not a design choice, it's a platform limit.
- **The mobile flavor has no backend** (`VITE_MOBILE=1`): state lives in `opengym-state.json`
  in the iPhone app's private storage (`lib/mobile.js` `nativeSave`/`nativeLoad`), pushed there
  from the Zustand store (`store/useStore.js`). The Watch app must not introduce a server
  dependency either.
- **Dependency-light is a hard constraint** (CONTRIBUTING.md): no new JS dependencies. The one
  new native dependency is Apple's own `WatchConnectivity` framework (ships with the OS, not a
  package).

## 3. Decisions from brainstorming

- **Watch-independent.** The Watch must be able to start and fully log a workout with the
  iPhone unreachable (locker, different room). Sync back happens whenever connectivity returns.
- **Phone always finishes the workout.** The Watch never runs `progression.js`. It records raw
  completed sets; the iPhone app applies progression, PRs, and history exactly the way it does
  today, the first time it reconnects to that Watch session.
- **Today's plan only.** The Watch shows one thing: start today's scheduled routine (from the
  phone's weekly plan / `effectiveRoutineIds`). No routine browser on the Watch in phase 1.
- **Phase 1 set types:** warmup + straight work sets, all three modes (reps/time/cardio). No
  drop-sets, rest-pause, or per-side (unilateral) sets on the Watch yet (phase 2, §8).

## 4. Architecture

```
iPhone (Capacitor/JS)                              Apple Watch (native SwiftUI)
──────────────────────                              ───────────────────────────
useStore.js (S, S.active)                           WatchSessionStore (local, on-Watch)
     │  after: plan edit, beginWorkout,                   │
     │  foreground, weight change                         │
     ▼                                                     │
WatchBridge.syncTodayPlan(payload)  ──────────────────►    │  updateApplicationContext
 (new Capacitor plugin, iPhone side)   WCSession           │  (latest value wins, delivered
     │                                                     │   next time Watch app runs)
     │                                                     ▼
     │                                              Watch UI: Start → run session → log
     │                                              sets locally (works with no phone)
     │                                                     │
     │  ◄────────────────────────────────────────────────  │  transferUserInfo
WatchBridge fires JS event                 WCSession        (queued, background-delivered,
 `watchSessionReceived`                                       redelivery-safe)
     │
     ▼
store: treat as `beginBackfill`-style import → `buildCompletedWorkout` → existing
finish/progression/PR path (unchanged)
```

### 4.1 iPhone side — `WatchBridge` Capacitor plugin

New local plugin at `frontend/ios/App/App/WatchBridge.swift` (+ `.m` bridge), following the
existing `PrintPlugin` pattern exactly (`CAPPlugin` subclass, registered via `CAP_PLUGIN` macro,
consumed from JS via `registerPlugin('WatchBridge')`). Responsibilities:

- Owns a `WCSession` (activated in `AppDelegate` at launch, guarded by
  `WCSession.isSupported()` — false on any device without a paired Watch or on Watch-less
  iPhones, so every call is a no-op there, never a crash).
- `syncTodayPlan(payload)` (JS → native): forwards `payload` verbatim to
  `session.updateApplicationContext(_:)`. Non-blocking, resolves immediately; delivery is
  best-effort and only the latest call's payload survives, which is exactly what "today's plan"
  needs (no history of stale plans to reconcile).
- `WCSessionDelegate.session(_:didReceiveUserInfo:)` (native, background-capable): on receipt,
  notifies JS listeners via `self.notifyListeners("watchSessionReceived", data: userInfo)`. If
  the JS runtime isn't currently loaded (app was killed), iOS queues the delivery and Capacitor
  replays pending native events once the WebView reloads — same mechanism already relied on for
  push notifications elsewhere in the app; no new plumbing needed there.
- No other business logic lives in Swift. Plan resolution, progression, and persistence stay in
  JS exactly as they are today.

### 4.2 What `syncTodayPlan` sends

Built in JS (a new small pure helper, `lib/watch-sync.js`, alongside the other `lib/` helpers,
tested like the rest of that directory) whenever the payload could have changed: after
`beginWorkout`, after a plan/routine edit, and on `onAppActive` (mirrors the existing
`initReminderSync` trigger pattern in `mobile.js`).

```jsonc
{
  "date": "2026-09-20",
  "routineIds": ["r_push"],
  "name": "Push Day",
  "bw": null,                      // weigh-in prompt is phone-only; Watch never asks
  "entries": [
    {
      "id": "e1", "exId": "bench-press", "label": "Bench Press",
      "mode": "reps", "unit": "kg",
      "target": { "sets": 3, "reps": 8, "w": 62.5 },
      "lastTime": { "w": 60, "r": 8, "d": "2026-09-13" },   // for on-Watch reference only
      "sets": [ { "phase": "warmup", "w": 40, "r": 8 }, { "phase": "work", "w": 62.5, "r": 8 } ]
    }
  ],
  "activeOnPhone": false   // true if S.active is already set — Watch shows "already started
                           // on iPhone" instead of offering a second Start (see §5.3)
}
```

`entries`/`target`/`lastTime` are derived on the JS side by the same code the phone session
screen already uses (`buildCombinedEntries`, `history.js` lookups) — no duplicated logic, just a
projection into a smaller, Watch-shaped payload. Drop-set/rest-pause/per-side fields are
stripped in phase 1 even if a routine defines them (a straight work set with the row's own `w`/
`r` is sent instead) — see §8.

### 4.3 What the Watch sends back

Sent once per finished session via `transferUserInfo` (queued and retried by the OS, survives
the Watch or phone being unreachable, restarted, or killed mid-transfer):

```jsonc
{
  "kind": "completedSession",
  "watchSessionId": "w_9f2a...",     // Watch-generated, for idempotency (§5.2)
  "date": "2026-09-20",
  "start": 1758345600000, "end": 1758349200000,
  "routineIds": ["r_push"],
  "name": "Push Day",
  "entries": [
    { "id": "e1", "sets": [ { "phase": "warmup", "w": 40, "r": 8, "done": true },
                             { "phase": "work",   "w": 62.5, "r": 8, "done": true } ] }
  ]
}
```

This is intentionally a subset of the phone's `active` shape (`sheets.jsx` `beginWorkout` /
`finish-workout.js` `buildCompletedWorkout`) — enough for `buildCompletedWorkout` to run
unmodified once the entries are merged onto matching routine entries by `id`.

### 4.4 Watch app (new Xcode target)

New target `frontend/ios/App/WatchApp` (paired watchOS app + extension in one modern unified
target, Xcode 15+ style), bundle id `ch.duartesantos.opengym.watchkitapp`, added to the existing
`App.xcodeproj` (not a separate project — keeps one `xcodebuild`/signing story, consistent with
`docs/MOBILE.md`'s existing free-signing instructions, which this doc extends rather than
replaces).

- **`WatchSessionStore`** (Swift, `ObservableObject`): holds the last-synced plan (persisted to
  `UserDefaults` or a small JSON file in the Watch app's local container — irrelevant which,
  it's device-local scratch, not shared with the phone) and the in-progress/finished session.
- **Views:** `TodayView` (routine name, Start button, or "already started on iPhone" /
  "no plan synced yet" states), `SessionView` (current exercise, set list, weight/reps entry via
  Digital Crown + steppers, a Done tick per set), `RestTimerView` (countdown + haptic on
  completion, `WKInterfaceDevice.current().play(.success)`), `SummaryView` (post-finish
  confirmation, "synced" vs. "will sync when phone is nearby").
- **`WatchConnectivitySession`**: thin wrapper mirroring `WatchBridge` — receives
  `didReceiveApplicationContext` (today's plan), sends `transferUserInfo` (completed session) and
  `transferCurrentComplicationUserInfo`/`sendMessage` are not used in phase 1 (no complication,
  no live phone round-trip requirement per the watch-independent decision).
- Entirely offline-capable: `TodayView` renders from whatever was last synced even with zero
  connectivity; `SessionView` never blocks on the phone being reachable.

## 5. Data flow details

### 5.1 Starting a session

Watch reads its locally persisted plan payload (§4.2). If none has ever synced, `TodayView`
shows "Open the iPhone app once to sync today's plan" (there is no path to a workout with zero
prior sync — the Watch has no routine data of its own). Tapping Start builds a local session
struct from the payload's `entries`, independent from that point on.

### 5.2 Idempotent sync-back

`transferUserInfo` can redeliver the same payload (OS retry after a partial failure). The phone
side keys incoming sessions by `watchSessionId` and keeps a small rolling set of the last N
processed ids (persisted alongside other device-local facts, `readJsonFile`/`writeJsonFile` in
`mobile.js`) so a redelivered payload is a no-op, not a duplicate workout.

### 5.3 Conflict: phone already has an active session

If `S.active` is already set when a Watch session is *started* (stale `activeOnPhone: true` in
the last-synced payload, or the phone starts one after the Watch already did), the Watch does
not block — it keeps running its own local session regardless of what the phone does
concurrently, since the two are independent until sync-back. The conflict is resolved at
**merge** time, on the phone, using the same "existing workout that day" flow the phone already
has for backfilled workouts (`sheets.jsx` `SameDayChoice`: replace vs. add as a second workout
that day). No new UI concept — the Watch's incoming session is just routed through that existing
sheet instead of always calling `buildCompletedWorkout` and appending directly.

### 5.4 Phone app not running / Watch app never opened

- `WCSession.isSupported()` false (no paired Watch, or Watch app not installed): `WatchBridge`
  methods become no-ops; nothing on the phone UI changes or errors.
- Watch app installed but never opened, or opened with no sync yet: `TodayView`'s
  "not synced yet" state (§5.1). No crash, no blank screen.
- Phone app force-quit when the Watch's `transferUserInfo` arrives: OS wakes/queues delivery for
  next launch per `WCSessionDelegate` semantics; on next launch the pending transfer is delivered
  before the user interacts with anything, so the merge sheet (§5.3) can appear on launch if
  needed.

## 6. Testing

- `lib/watch-sync.js` (payload projection) gets a `*.test.js` beside it per CONTRIBUTING.md,
  covering: routine resolution matches `effectiveRoutineIds`, drop-set/rest-pause/per-side rows
  are flattened to a straight set, `activeOnPhone` reflects `S.active`.
- The merge path (`watchSessionReceived` → `buildCompletedWorkout` → same-day conflict) gets a
  unit test beside `finish-workout.js` exercising: clean merge (no existing workout that day),
  conflict → replace, conflict → add second workout, redelivered `watchSessionId` → no-op.
- Native Swift (`WatchBridge`, `WatchSessionStore`, views) has no existing test harness in this
  repo (no Swift tests anywhere today) — manual verification only, documented as a testing gap
  in the implementation plan rather than silently skipped.

## 7. Failure-mode scenarios to verify manually before calling this done

(Per CLAUDE.md: tests derived from the design can't find errors in the design — these probe
the design's edges deliberately.)

- Start a Watch session, then never bring the phone back in range for the rest of the day —
  does the workout still show up correctly once the phone finally reconnects the next day?
- Kill the Watch app mid-session (crash or force-quit) — is any completed set lost, or does
  `WatchSessionStore`'s local persistence survive it?
- Start a workout on the Watch, then independently start a different workout on the phone the
  same day, finish both — does the same-day conflict sheet appear, and does neither workout
  silently overwrite the other?
- Let the same `transferUserInfo` redeliver twice (simulate by resending the same
  `watchSessionId`) — confirm no duplicate workout appears in history.
- Sync today's plan, then edit the routine on the phone (e.g. remove an exercise) *while* a
  session is already running on the Watch — the Watch should keep running the session it
  already started, not surprise-mutate it, since it committed to a snapshot at Start.

## 8. Phase 2 (explicitly out of scope here)

Drop-sets, rest-pause, per-side sets on the Watch. Same sync plumbing (§4), richer payload
fields (`type`, `drops`/`clusters`, `sides`) and Watch-side set-editing UI. Gets its own spec
once phase 1 has shipped and the sync layer has proven itself.

## 9. Out of scope (not planned at all, not even phase 2)

- Routine browsing / picking any routine from the Watch (decision in §3: today's plan only).
- Watch-side progression computation.
- Watch complications, notifications, or a standalone (non-companion) Watch app mode.
- "Connect to my server" remote mode on the Watch — the Watch only ever talks to its paired
  iPhone, never a server directly.
