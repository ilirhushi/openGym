# Apple Health integration and Watch heart-rate tracking: design

Status: approved for planning
Owner: Ilir Hushi
Date: 2026-09-20

## 1. Purpose

On the Capacitor iOS build (`VITE_MOBILE=1`), finishing a workout should put that workout into
Apple Health. On Apple Watch,
the existing watchOS companion should additionally run a real `HKWorkoutSession`, so a session
logged from the wrist records heart rate and active energy the way any first-class workout app
does, and so it gets the green in-progress indicator and extended runtime that watchOS grants
only to a live workout session.

This extends the Apple Watch phase-1 work (`2026-09-20-apple-watch-app-design.md`), which built
the phone/Watch sync plumbing but deliberately contained no HealthKit code. That plumbing is
reused verbatim here; the payload gains one optional field and nothing else about it changes.

Android (Health Connect) is deliberately deferred to a follow-up spec. See §10.1 for what this
design owes it.

## 2. Constraints from the existing app

- **Dependency-light is a hard constraint** (CONTRIBUTING.md). No new npm dependency, and on iOS
  no new native dependency either: HealthKit ships with the OS. Native access is a locally written
  Capacitor plugin, in the pattern `WatchBridge` and `PrintPlugin` already establish.
- **Anything that decides what gets recorded is a pure helper in `lib/` with a test beside it**
  (CONTRIBUTING.md). This is load-bearing here, because the repo has no Swift or Kotlin test
  harness at all. Every decision therefore lives in JS; the native files contain no branching
  logic about whether or what to write.
- **No third party, and no phoning home.** Health data never reaches a third party, and openGym
  never sends anything anywhere on its own. What this does not mean is that a measurement attached
  to your own workout record is stripped out of it: the `hr` summary (section 5.3) rides on the
  workout record and therefore syncs to *your own* self-hosted server with that record, exactly
  like every other field on it. Nothing added here opens a new network path, and on the
  self-hosted web build this whole feature is absent, not degraded.
- **No telemetry, user owns their data** (README). Health access is opt-in, off by default, and
  the permission prompt is only ever raised by a direct user action.
- **Sideloaded distribution** (`docs/MOBILE.md`): free Xcode signing, 7-day profiles. See §6 for
  the entitlement verification this required.

## 3. Decisions from brainstorming

1. **Write workouts, read body weight.** openGym pushes workouts into the health store, and
   reads body weight back. It does not read foreign workouts: a workout logged in another app
   has no routine or entries, so it could only ever be a second-class row in history and would
   confuse progression.
2. **On Watch sessions, the Watch writes and the phone skips.** The Watch runs the
   `HKWorkoutSession`, so it is the only side holding the heart-rate samples; only a workout
   saved by the Watch can have those samples associated with it. The phone is told, in the
   sync-back payload, that the record already exists.
3. **iOS first, behind a platform-agnostic JS seam.** Health Connect is deferred to its own spec
   (§10.1). `lib/health.js` and the plugin interface are nonetheless designed platform-neutral
   rather than HealthKit-shaped, so the Android implementation can slot in behind the same seam
   instead of forcing a retrofit. Android will not get heart rate whenever it does land: that
   needs a Wear OS companion, which is out of scope here and there.
4. **Only a live phone finish writes.** Backfilled past workouts, edits of already-logged
   workouts (`lib/session-edit.js`), CSV/Hevy imports and demo seeding never touch the health
   store. Rationale: a backfill would retroactively rewrite the user's Health history, and an
   edit would require openGym to delete a health record it previously wrote, which is a
   destructive operation on the user's own health data for a cosmetic gain.
5. **No invented calories.** A phone-written workout carries duration and type only. openGym has
   no sensor data on the phone, so any active-energy figure would be a guess presented to Health
   as measurement, and it would contradict whatever the Watch reports for similar sessions.
6. **Body weight is a prefill, never a silent import.** Reading Health prefills the weigh-in
   prompt; the user confirms and openGym logs its own entry. No watermark, no background sync, no
   per-day dedupe rule, and no path by which training data mutates without the user seeing it.
7. **Heart-rate summary is stored in openGym too**, not only in Health, so History and the finish
   summary can show it offline and so the data is not invisible outside Apple's ecosystem. The
   summary only, not the per-second series: the full curve would bloat `state-<uid>.json` and the
   localStorage-persisted store on every workout.
8. **Policy lives in JS, the native layer is dumb.** See §4.

## 4. Architecture

```
                    +--------------- lib/health.js (pure, tested) ----------------+
                    |  shouldWriteWorkout({ past, fromWatch, healthSaved, on })   |
                    |  healthWorkoutPayload(w)            -> descriptor | null    |
                    |  bodyWeightPrefill(read, now)       -> kg | null            |
                    +------------------------------+------------------------------+
                                                   | plain data only
 sheets.jsx doFinishWorkout --------------------->  |
   (live branch only: `past` is false)              |
                                                    v
                    lib/health-bridge.js: boxed registerPlugin('Health'), MOBILE-gated
                      requestPermissions() / saveWorkout(d) / readLatestBodyWeight()
                         |
              iOS: App/Health.swift + Health.m
              HKHealthStore.save(HKWorkout)
              read HKQuantityType .bodyMass

 watchOS: WatchApp/WatchSessionStore.swift
   Start  -> HKWorkoutSession + HKLiveWorkoutBuilder begin (green indicator,
             extended runtime, live heartRate + activeEnergyBurned collection)
   Finish -> builder.finishWorkout(): the HKWorkout is saved ON THE WATCH
          -> existing transferUserInfo payload gains `health: { saved, avgHr, maxHr, kcal }`
          -> phone stores the summary on the workout record and writes nothing to Health
```

### 4.1 New and touched files

| File | Status | Role |
| --- | --- | --- |
| `frontend/src/lib/health.js` + `health.test.js` | new | all policy; imports nothing native |
| `frontend/src/lib/health-bridge.js` + `health-bridge.proxy.test.js` | new | plugin box, MOBILE gate |
| `frontend/ios/App/App/Health.swift` + `Health.m` | new | HealthKit calls, no logic |
| `frontend/src/sheets.jsx` | edit | one guarded call in `doFinishWorkout`; weigh-in prefill |
| `frontend/ios/App/WatchApp/WatchSessionStore.swift` | edit | `HKWorkoutSession` lifecycle |
| `frontend/src/lib/watch-import.js` | edit | carry the `health` summary onto the record |
| `frontend/src/views/Settings.jsx` | edit | the opt-in toggle and status line |

### 4.2 Why the policy is in JS

`Health.swift` contains no conditional deciding whether a workout should be written or what type
it is. Two reasons. First, that logic would have to be reimplemented in Kotlin when Health Connect
lands (§10.1), and the two copies would drift. Second, it would sit in the only layer of this repo
with no tests, while CONTRIBUTING.md requires exactly this class of logic to be a tested pure
helper. The native file is transport.

### 4.3 The finish hook

`doFinishWorkout` (`sheets.jsx:2664`) handles both the live and the backfilled case through a
local `past = !!A.backfill` flag, so "live only" is a guard inside one function rather than a
choice spread across call sites. The call is fire-and-forget: `doFinishWorkout` does not become
`async`, does not await the write, and never surfaces an error over the finish summary.

Note on why this is not an event subscriber: `buildCompletedWorkout` is reached from five places
(live finish, backfill, Watch import, `session-edit.js`, CSV/Hevy import). A listener on a shared
"workout finished" event would silently opt all five into writing to Health, including retroactive
edits of records already there, and would make that opt-in invisible at every emit site.

## 5. Data contracts

### 5.1 The health descriptor (JS to native)

```jsonc
{
  "start": 1758345600000,   // w.start
  "end":   1758349200000,   // w.end
  "type":  "strength",      // "strength" | "cardio"
  "title": "Push Day",      // w.name
  "id":    "wk_9f2a"        // w.id, written as a metadata key for traceability
}
```

Deliberately not HealthKit-shaped. `"strength"` and `"cardio"` are openGym's vocabulary, mapped
in the native layer to `HKWorkoutActivityType.traditionalStrengthTraining`, and, when Health
Connect lands, to `ExerciseSessionRecord.EXERCISE_TYPE_STRENGTH_TRAINING`. Putting a platform enum
in the pure helper would make it untestable without a native shim and would bake Apple naming into
a seam Android has to share.

**Type rule:** `"cardio"` when every completed entry is a cardio-mode set (the `min`/`speed`
shape `watch-sync.js` already discriminates on), otherwise `"strength"`. A mixed session is
`"strength"`: splitting it would mean writing two health records for one workout.

### 5.2 Watch sync-back payload extension

The `completedSession` payload gains one optional object, and nothing else changes:

```jsonc
"health": { "saved": true, "avgHr": 142, "maxHr": 171, "kcal": 486 }
```

- **Absent**: the Watch had no HealthKit authorization, or could not start a workout session
  (§9.1). The phone writes the workout itself, sensor-less.
- **`saved: false`**: the session ran with sensors but `finishWorkout()` failed to save. The phone
  writes the workout itself, sensor-less, and keeps whatever HR summary was collected.
- **`saved: true`**: the record exists in Health already. The phone writes nothing.

The invariant this encodes is **exactly one health record per session, never zero and never two.**

**Known and accepted: a same-day "replace" can leave two records in Health.** If a workout is
finished live on the phone (and written to Health), and a Watch session then arrives for the same
day and the user chooses "replace", openGym's history holds one workout while Health holds two.
This is a direct consequence of decision 3.4: openGym never deletes the user's health records, so
the record the replaced workout already produced stays where it is. The invariant above is
per-session, not per-history-row, and a replace collapses two sessions into one row after the
fact. Deleting health data the user did not ask us to delete is the worse of the two options, so
this is accepted rather than fixed.

### 5.3 The workout record

Following the convention already established in `finish-workout.js` (`rid`, `noProg`, `note` are
written only when set, so an ordinary session stays byte-for-byte what it always was), the
summary lands as one optional key:

```jsonc
{ /* existing workout */, "hr": { "avg": 142, "max": 171, "kcal": 486 } }
```

This needs **no change to `finish-workout.js`**. `watch-import.js` already post-decorates the
built record (`w.vol = workoutVolume(w)`) and sets `w.hr` the same way. Every non-Watch workout
is unchanged on disk, and older profiles read back identically.

Because `hr` is an ordinary key on the workout record, it syncs to the user's own self-hosted
server along with the rest of that record, through the same `pushState` path every workout field
already takes. That is consistent with section 2 and deliberate: the point of storing the summary
in openGym at all (decision 3.7) is that it not be locked inside Apple's ecosystem, and a workout
that syncs everywhere except its heart rate would defeat that. No third party sees it and openGym
never phones home; it lands on the user's own server, where their training data already lives.

### 5.4 Body weight read

`readLatestBodyWeight()` returns `{ kg: 82.4, at: 1758345600000 }` or `null`. Kilograms always at
the native boundary; `lib/units.js` handles display conversion as it already does. `at` is
required because prefilling from a three-week-old scale reading is worse than not prefilling:
`bodyWeightPrefill` drops anything outside a staleness window.

## 6. Permissions and entitlements

### 6.1 Opt-in

Off by default. One Settings toggle, rendered only when `MOBILE && isIOS()`. The
permission prompt is raised by that tap and at no other time. For a self-hosted, no-telemetry app,
a health-permission dialog appearing unprompted at first launch would be the wrong first
impression, independent of what the app then does with the data.

### 6.2 The read/write asymmetry that shapes the code

HealthKit deliberately makes **read** authorization opaque: an app cannot distinguish "the user
denied body-weight read" from "the user granted it and has no data", because the difference would
itself leak health information. `readLatestBodyWeight()` therefore has one observable failure mode
for its caller: it returns `null` and the weigh-in prompt does not prefill. No error, no nag,
because openGym genuinely cannot know which case it is in.

**Write** status is queryable, so the Settings toggle can honestly report "denied in Health
settings" for the write direction only. Do not write a UI that claims to know read status.

### 6.3 Native prerequisites

Each of these can silently break a build or a runtime behaviour, so each is an explicit plan task:

- iOS: HealthKit capability on the app target **and independently on the WatchApp target**;
  `NSHealthShareUsageDescription` and `NSHealthUpdateUsageDescription` in `Info.plist`; the
  **Workout Processing** background mode on the Watch target. Without that background mode the
  `HKWorkoutSession` does not receive extended runtime and the session dies when the wrist drops,
  which is the single most confusing possible failure for the user.

### 6.4 Free-signing entitlement check (verified, 2026-09-20)

`docs/MOBILE.md` documents sideloading under free Xcode signing, and free personal teams support
only a restricted entitlement set, so whether HealthKit is available to sideloaders was an open
risk before this design was accepted. It was verified empirically rather than assumed.

Method: decode the provisioning profiles in
`~/Library/Developer/Xcode/UserData/Provisioning Profiles` with
`security cms -D -i <profile>` and inspect `TeamName`, `ExpirationDate` and `Entitlements`.

Result: on a team identified as free personal (personal `TeamName`, and the 7-day
creation-to-expiry window that only free provisioning produces), profiles were found carrying
`com.apple.developer.healthkit`, `com.apple.developer.healthkit.access` and
`com.apple.developer.healthkit.background-delivery`, on both an iPhone bundle id and its
`.watchkitapp` bundle id.

Conclusion: **HealthKit is grantable under free Xcode signing, on both the phone and the Watch
target.** Sideloading self-hosters get this feature, subject to the 7-day re-signing cycle
`docs/MOBILE.md` already describes. No paid account is required and no reduced feature set is
needed for the sideload path.

Caveats to carry forward: this is evidence from one Apple ID on one machine, not an Apple
documented guarantee, and what free provisioning grants is Apple's to change. The method above is
recorded so the conclusion can be re-checked rather than trusted indefinitely.

## 7. Failure handling

One attempt per write, no retry queue. The realistic failure modes are "permission revoked" and
"health store unavailable", and a retry fixes neither. Failures are recorded to a device-local
status file via the existing `writeJsonFile` in `mobile.js` and surfaced only as a passive line in
Settings, for example `Last write: failed, 20 Sep`. Nothing interrupts the finish flow: no sheet,
no toast, no blocking await. A health-store write failing must never make a user think their
workout was not logged, because it was: openGym's own history is written first and independently.

## 8. Testing

Unit tests in `frontend/src/lib/health.test.js`, beside the code:

- `shouldWriteWorkout`: true for a live finish with the toggle on; false for `past`, for a
  `session-edit` rebuild, for CSV/Hevy import, and for a Watch session with `health.saved === true`;
  **true** for a Watch session with `health.saved === false`. That last case is the row encoding the
  one-record-per-session invariant (§5.2) and should be written first.
- `healthWorkoutPayload`: all-cardio entries produce `"cardio"`; mixed produce `"strength"`; a
  workout with no completed entries produces `null`.
- `bodyWeightPrefill`: `null` past the staleness window; `null` on a `null` read; no unit
  conversion applied.

`health-bridge.js` gets the same proxy-trap regression test `watch-bridge.proxy.test.js` already
establishes: assert the boxed `{ p }` wrapper and that a bare `registerPlugin` result is never
awaited. That bug has occurred twice in this repo (issues #42, #58) and this bridge is the third
place it can recur.

**Native testing gap, stated rather than skipped:** there is no Swift test harness in this repo.
`Health.swift` and the `HKWorkoutSession` lifecycle are manually verified only. This is the reason
§4.2 pushes every decision out of those files.

## 9. Failure-mode scenarios to verify manually before calling this done

Per CLAUDE.md, tests derived from a design cannot find errors in that design. These are written
against it.

### 9.1 Concurrent workout session (a design hole, specified here rather than discovered later)

watchOS permits **one active `HKWorkoutSession` at a time.** If the user has a session running in
Apple's Workout app (a forgotten Outdoor Walk, for instance), openGym's `session.begin()` fails.

Required behaviour: **degrade, do not fail.** The Watch session still starts and still logs sets,
with no heart rate, no energy, and `health` omitted from the sync-back payload, which routes the
write to the phone per §5.2. A naive implementation lets a forgotten walk block openGym's Watch
app entirely, so this must be built deliberately and verified.

### 9.2 Cancelled halfway

Force-quit the Watch app mid-session. An `HKWorkoutSession` can survive as an orphan, holding the
green indicator and draining battery until the Watch reboots. On next launch the Watch app must
detect an in-progress session and either resume it or end it. `WatchSessionStore` already persists
its own session locally, so there is somewhere for the recovery hook to live, but the HealthKit
side needs its own explicit recovery: the two are not the same state.

### 9.3 Never happens

Toggle on, but HealthKit denied on the Watch only. Every Watch session then arrives without
`health` and gets a sensor-less phone write. Confirm this is understood as intended behaviour and
not a silent downgrade that nobody notices for months.

### 9.4 Turned off mid-flight

Start a workout with sync on, toggle it off before finishing. The setting must be read at finish
time, not captured at start, so nothing is written.

### 9.5 Revoked between sessions

Revoke write permission in Health settings while the toggle is still on, then finish a workout.
Expect: no crash, no error over the summary, and the failed-write line in Settings.

### 9.6 Redelivery

Resend the same `watchSessionId` with `health.saved: false`. The existing seen-ids guard in
`watch-bridge.js` should stop it before `finishWatchSession` runs, so no second health record is
written. This is the most likely source of a duplicate in Health, so assert it explicitly.

### 9.7 Clock skew

The Watch-written record's start and end come from the Watch; openGym's `w.start`/`w.end` come
from the same session but may differ slightly. Confirm the stored `hr` summary is not presented in
a way that implies it covers exactly openGym's own time window.

## 10. Out of scope

- Reading foreign workouts from Health into openGym history (§3.1).
- Writing estimated calories for phone-only workouts (§3.5).
- Writing on backfill, on edit of a logged workout, on CSV/Hevy import, or on demo seed (§3.4).
- The full per-second heart-rate series in openGym's own records (§3.7).
- Android Health Connect in this spec (deferred, see §10.1), and a Wear OS companion at all.
- Any health data reaching a third party, or openGym sending anything anywhere on its own (see
  section 2: the `hr` summary on a workout record syncs to the user's own server with that record,
  and no new network path is added).
- Route/GPS data, VO2 max, sleep, or any health type beyond workouts and body weight.

### 10.1 Deferred: Android Health Connect

Health Connect is a follow-up spec, not a later phase of this one. What this design owes it:

- The JS seam (`lib/health.js`, `lib/health-bridge.js`) is already platform-neutral (§5.1), so the
  follow-up adds a native implementation behind the existing interface and should not need to
  change the pure helpers or their tests. If it does, that is a signal this seam was drawn wrong.
- Facts already established, so the follow-up does not rediscover them: the Android module is
  **Java-only today** (`PrintPlugin.java`, `InstallPlugin.java`, package `ch.duartesantos.opengym`)
  with no Kotlin toolchain configured, while Health Connect's client API is Kotlin-first and built
  on `suspend` functions. Enabling the Kotlin Gradle plugin versus hand-rolling `Continuation` glue
  in Java is the first decision that spec has to make, and it is a build-level decision, not a
  detail.
- Health Connect additionally requires the `androidx.health.connect:connect-client` artifact,
  read/write permission declarations, and **a privacy-policy `Activity` with the
  `ACTION_SHOW_PERMISSIONS_RATIONALE` intent filter**. Permissions are refused outright without
  that Activity, so it is a hard gate, not a nicety.
- Body-weight read (§3.6) and the write-sites rule (§3.4) carry over unchanged; only the transport
  differs.
