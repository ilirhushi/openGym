import { create } from 'zustand'
import { uid } from '../lib/format.js'
import { beep, countdown, holdSession, hush, restOver, vibrate } from '../lib/sound.js'
import { api } from '../lib/api.js'
import { t } from '../lib/i18n.js'
import { deviceId } from '../lib/push.js'
import { useStore } from './useStore.js'

// Fire-and-forget: lets the server push a "rest over" alert if this tab gets suspended
// before the local timer completes. No-ops for guests / offline. The device id keeps the
// timer this browser's own: a desktop tab finishing its rest on screen used to cancel the
// alert the phone in the gym was waiting for, because the server held one timer per account.
const pushRestTimer = sec => { if (useStore.getState().user) api('/api/push/rest-timer', { method: 'POST', body: JSON.stringify({ seconds: sec, deviceId: deviceId() }) }).catch(() => {}) }
const cancelPushRestTimer = () => { if (useStore.getState().user) api('/api/push/rest-timer/cancel', { method: 'POST', body: JSON.stringify({ deviceId: deviceId() }) }).catch(() => {}) }

const notificationsSupported = () => typeof window !== 'undefined' && 'Notification' in window
let requestRestNotificationPermissionP = null

// Set the moment the tab goes hidden, never cleared here — timerTick/workTick read and
// clear it themselves once they're running visible again. Lets a completion tick tell
// "the countdown hit zero while the app was actually open" from "it hit zero while
// backgrounded/closed and we're only just catching up now that it's open again" — the
// latter must skip beep/vibrate/flash/toast and rely solely on the push notification.
let pageHiddenAt = null
if (typeof document !== 'undefined') {
  document.addEventListener('visibilitychange', () => { if (document.hidden) pageHiddenAt = Date.now() })
}

const requestRestNotificationPermission = async () => {
  if (!notificationsSupported()) return false
  if (Notification.permission === 'granted') return true
  if (Notification.permission === 'denied') return false
  if (!requestRestNotificationPermissionP) {
    requestRestNotificationPermissionP = Notification.requestPermission()
      .then(perm => perm === 'granted')
      .catch(() => false)
      .finally(() => {
        requestRestNotificationPermissionP = null
      })
  }
  return requestRestNotificationPermissionP
}

const maybeRestNotification = async () => {
  if (!notificationsSupported()) return
  if (!document.hidden && document.visibilityState !== 'hidden') return
  // The browser cannot un-grant Notification permission from JS, so "Push notifications" off
  // in Settings has to be its own flag — otherwise this local alert kept firing after the
  // toggle was turned off (issue #239).
  if (useStore.getState().S.pushOptOut) return
  if (Notification.permission !== 'granted' && !(await requestRestNotificationPermission())) return
  try {
    // Android Chrome forbids the Notification constructor (Illegal constructor) - the
    // service-worker registration path is the one that actually pops there.
    // Same tag as the server's rest-timer push (api/push-messages.js), closed by hand first the
    // way sw.js does: should both ever be shown for one rest, the tray holds one, not two.
    const tag = 'rest-timer'
    const reg = await navigator.serviceWorker?.getRegistration?.()
    if (reg?.showNotification) {
      try { for (const n of await reg.getNotifications?.({ tag }) || []) n.close() } catch { /* */ }
      reg.showNotification(t('Rest over — next set!'), { body: t('Rest over — next set!'), tag, renotify: true })
      return
    }
    new Notification(t('Rest over — next set!'), { body: t('Rest over — next set!'), tag })
  } catch {
    // Intentionally ignore: notification APIs vary by browser and policy in edge cases.
  }
}

let toastTm = null
let timerInt = null
let timerTick = null
// What a rest hands over to when it is over (Workout.handOver: the screen moves on, and a timed
// exercise's next hold starts). Fires when the rest runs out or is skipped, never on a plain
// stopRest(). A rest that ran out while the app was hidden fires on the first tick back on
// screen, and says so (seenLive = false) — that is how the caller knows not to start a hold
// nobody watched.
let restDone = null
// Whether the running rest has already had its hidden-page "rest over" (see timerTick). Reset by
// startRest; a flag rather than a key on endsAt, which ±15 s moves.
let hiddenAlerted = false
let workInt = null
let workTick = null
let workDone = null
const MAX_WORK_OVERTIME_SEC = 15 * 60

export const useUI = create((set, get) => ({
  sheets: [],          // { id, render:(close)=>JSX, kind:'sheet'|'center', locked }
  toastMsg: '',
  timer: null,         // rest countdown between sets — { left, total, endsAt, forIdx, kind, phase, ready? }
                       // forIdx: index of the active entry whose set started the rest (undefined when unknown)
                       // kind: which rest-over sound plays — 'set' | 'round' | 'block' (supersetFlow.restKind)
                       // phase: the set a 'set' rest leads into — 'warmup' | 'work' | null (supersetFlow.restSetPhase)
                       // ready: the countdown reached zero and is waiting to be dismissed
  work: null,          // work countdown DURING a timed set (issue #16) — { left, total, endsAt, label, set, forIdx, overtime? }
                       // set: { phase: 'warmup' | 'work', n, of } — which hold of the exercise (workout-model.holdPosition)
                       // forIdx: index of the active entry being held (undefined when unknown); kept current like the rest's
  timerFlashId: 0,     // changing the id retriggers the theme-blink visual alert

  flashTimer() {
    if (!useStore.getState().S.timerFlash) return
    set(s => ({ timerFlashId: s.timerFlashId + 1 }))
  },

  openSheet(render, { kind = 'sheet', locked = false } = {}) {
    const id = uid()
    set(s => ({ sheets: [...s.sheets, { id, render, kind, locked }] }))
    const close = () => get().closeSheet(id)
    return { id, close, lock: v => set(s => ({ sheets: s.sheets.map(x => x.id === id ? { ...x, locked: v } : x) })) }
  },
  closeSheet(id) { set(s => ({ sheets: s.sheets.filter(x => x.id !== id) })) },
  closeAll() { set({ sheets: [] }) },

  toast(msg) {
    set({ toastMsg: msg })
    clearTimeout(toastTm)
    toastTm = setTimeout(() => set({ toastMsg: '' }), 2200)
  },

  startRest(sec, forIdx, kind, phase, onDone) {
    get().stopRest()
    // Rest timer set to Off. Stopping and returning rather than starting a zero-length timer
    // keeps every caller honest: the four places that start a rest do not each need to know.
    // Off also drops onDone: a hand-over rides on the rest, so with no rest the next hold waits
    // for a tap like any other.
    if (!(sec > 0)) return
    // And the hold, the other way round from startWork: the two must never run together (see the
    // work timer below). A set ticked by hand while its hold ran used to leave both going — the
    // rest bar with its Skip and ±15 s hidden behind the hold bar, and then the hold reaching
    // zero under a rest that was still counting down, beeping its own end and logging the full
    // target for a set nobody was holding any more. Below the guard, not above it: a rest that
    // does not start has nothing to run alongside the hold, and taking the hold down for it
    // would throw away a plank in progress for nothing. What it held is kept either way —
    // abandonWork, not stopWork.
    get().abandonWork()
    // Nothing clears pageHiddenAt but a tick, so an app switch with no timer running left it set
    // for good. The next timer's first tick then read it as "this countdown ran out while the app
    // was away" and finished in silence — a one-second rest, started on screen, over on screen,
    // with no beep, no vibration and no flash. Each timer starts from where the page is now.
    pageHiddenAt = document.hidden ? Date.now() : null
    restDone = typeof onDone === 'function' ? onDone : null
    hiddenAlerted = false
    const endsAt = Date.now() + sec * 1000
    set({ timer: { left: sec, total: sec, endsAt, forIdx, kind, phase } })
    // The last seconds are queued now, inside the tap that finished the set, rather than beeped
    // by the ticks below — the ticks stop running when the phone goes in a pocket (lib/sound.js
    // countdown). Every exit from this timer calls stopRest, which calls them off.
    countdown(useStore.getState().S.sound, sec)
    holdSession(true)      // so the phone's volume buttons reach the timer, not the ringer
    requestRestNotificationPermission()
    pushRestTimer(sec)
    timerTick = () => {
      const tm = get().timer
      if (!tm || tm.ready) return
      const left = Math.max(0, Math.round((tm.endsAt - Date.now()) / 1000))
      // A hidden page changes nothing on screen. With the audio session held for the whole rest
      // (holdSession) the page keeps running while the phone is locked or the app switched away —
      // where it used to be frozen — and this tick started arriving there: a re-render every
      // second, and at zero the toast, the hand-over and a local notification, all done to a
      // screen nobody is looking at. That doubled the "rest over" alert (this one plus the server
      // push), and iOS was left with a page laid out while it was not showing it: on return the
      // tab bar and the timer bar sat where the page had been, scrolling with it. So a hidden tick
      // leaves everything to the tick that visibilitychange fires when the page is back — exactly
      // what a frozen page did. The one thing a hidden page owes is the alert, and a signed-in
      // device already gets it from the push pushRestTimer scheduled; a guest has no push, so the
      // local notification stands in — once per rest, since the interval keeps calling.
      if (document.hidden) {
        if (left <= 0 && !useStore.getState().user && !hiddenAlerted) {
          hiddenAlerted = true
          maybeRestNotification()
        }
        return
      }
      const seenLive = pageHiddenAt === null
      pageHiddenAt = null
      // Back on screen after a lock or an app switch. The queued countdown froze with the audio
      // clock while the page was away, so it would now tick late; queue it again against the
      // time that is really left. Fires once, on the first tick back.
      if (!seenLive && left > 0) countdown(useStore.getState().S.sound, left)
      if (left === tm.left) return
      const snd = useStore.getState().S.sound
      if (left <= 0) {
        if (seenLive) {
          restOver(snd, tm.kind)
          vibrate([200, 100, 200]); get().flashTimer()
        }
        // The toast also greets a rest that ran out while the app was hidden: a countdown that
        // silently vanished on reopen reads like a bug. Only the loud parts (beep, vibration,
        // flash) are gated on having been watched.
        get().toast(t('Rest over — next set!'))
        maybeRestNotification()
        cancelPushRestTimer()
        if (timerInt) clearInterval(timerInt); timerInt = null
        if (timerTick) document.removeEventListener('visibilitychange', timerTick); timerTick = null
        const done = restDone
        const at = tm.forIdx
        restDone = null
        if (!done) {
          // Nothing to hand over to (a caller with no onDone): the bar lingers as "Ready" rather
          // than vanishing, until Dismiss or the next timer starting clears it for real.
          hush()
          set({ timer: { ...tm, left: 0, ready: true } })
          return
        }
        // The hand-over gets the rest's owner as it is now, not as it was when the rest started:
        // an exercise added, removed or moved above it re-pointed forIdx along the way. It is
        // also told whether the countdown actually ran out on screen: a rest that expired in
        // your pocket must not start a hold nobody watched, but moving the screen on to the
        // next exercise is exactly what you want waiting for you when you unlock the phone.
        get().stopRest()
        done(at, seenLive)
        return
      }
      set({ timer: { ...tm, left } })
    }
    timerInt = setInterval(timerTick, 1000)
    document.addEventListener('visibilitychange', timerTick)
  },
  addRest(sec) {
    const tm = get().timer
    if (!tm) return
    if (tm.ready) { if (sec > 0) get().startRest(sec, tm.forIdx); else get().stopRest(); return }
    const left = tm.left + sec
    // taking off more than is left means "I'm ready now" — same as skipping, and it keeps a
    // negative duration out of both the progress bar and the server-side push schedule
    if (left <= 0) { get().skipRest(); return }
    set({ timer: { ...tm, left, total: tm.total + sec, endsAt: tm.endsAt + sec * 1000 } })
    countdown(useStore.getState().S.sound, left)   // the end moved; so do the last five seconds
    pushRestTimer(left)
  },
  // The active list changed shape (an exercise removed or inserted at `at`): keep the rest
  // pointing at the same exercise. Returns nothing; the caller decides whether to stop instead.
  shiftRestOwner(at, delta) {
    const tm = get().timer
    if (tm && tm.forIdx >= at) set({ timer: { ...tm, forIdx: tm.forIdx + delta } })
    const wk = get().work
    if (wk && wk.forIdx >= at) set({ work: { ...wk, forIdx: wk.forIdx + delta } })
  },
  // "I'm ready now": the rest is over early, and whatever it was going to hand over to happens
  // now. The Skip button and −15 s past zero come here; everything else that ends a rest
  // (a new rest, a hold starting, an exercise removed, the workout discarded) uses stopRest.
  skipRest() {
    const done = restDone
    const at = get().timer?.forIdx
    get().stopRest()
    if (done) done(at, true)             // you are looking at it — you tapped Skip
  },
  // Sounds or the volume changed in Settings while a timer runs: the countdown for this timer
  // was queued at its loudness, seconds ago, so re-queue it at the new one. Without this a
  // change made mid-rest — which is exactly when you make it, because that is when you heard
  // the timer — would not be audible until the next rest.
  restartCountdown() {
    const left = get().timer?.left ?? get().work?.left
    if (left != null) countdown(useStore.getState().S.sound, left)
  },
  stopRest() {
    restDone = null
    hush()
    holdSession(false)
    if (timerInt) clearInterval(timerInt); timerInt = null
    if (timerTick) document.removeEventListener('visibilitychange', timerTick); timerTick = null
    if (get().timer) cancelPushRestTimer()
    set({ timer: null })
  },

  /* ---- work timer (issue #16) ----
     Times the set itself, not the recovery after it. Kept separate from the rest timer on
     purpose: the two mean opposite things, they must never run together, and a work set is
     something you are watching — so it gets no server push (that endpoint says "rest over",
     and a plank does not need a notification you are staring at anyway).
     `onDone(elapsedSec, forIdx, abandoned?)` is called on a normal finish (countdown reaches
     zero or an early Done), on abandonment (a rest or another hold displaced this one), and
     never otherwise. The elapsed time is what actually gets logged, so stopping at 0:38 of a
     0:45 hold records 0:38 rather than crediting the full target. forIdx is the held entry's
     index as it is then — an exercise added above it during the hold moved it (shiftRestOwner).
     `abandoned` is true only when a rest/hold displaced this one before it finished: the row
     must not be ticked off, since what was held is real but the set was not completed. */
  startWork(sec, label, onDone, setInfo, forIdx) {
    get().abandonWork()   // a hold this one replaces keeps what it held, same as a rest replacing one
    get().stopRest()
    const total = Math.max(1, Math.round(sec) || 1)
    const endsAt = Date.now() + total * 1000
    workDone = onDone
    pageHiddenAt = document.hidden ? Date.now() : null   // see startRest: a stale hide is not a catch-up
    set({ work: { left: total, total, endsAt, label, set: setInfo || null, forIdx, overtime: useStore.getState().S.timedSetOvertime === true } })
    countdown(useStore.getState().S.sound, total)
    holdSession(true)
    workTick = () => {
      const wk = get().work
      if (!wk) return
      const left = Math.max(wk.overtime ? -MAX_WORK_OVERTIME_SEC : 0, Math.round((wk.endsAt - Date.now()) / 1000))
      // A hidden page changes nothing on screen — see timerTick. A hold has no push to fall back
      // on and nothing to alert: it finishes, and logs its full length, on the tick that runs
      // when the page is back.
      if (document.hidden) return
      const seenLive = pageHiddenAt === null
      pageHiddenAt = null
      // Back on screen after a lock or an app switch. The queued countdown froze with the audio
      // clock while the page was away, so it would now tick late; queue it again against the
      // time that is really left. Fires once, on the first tick back.
      if (!seenLive && left > 0) countdown(useStore.getState().S.sound, left)
      if (left === wk.left) return
      const snd = useStore.getState().S.sound
      if (left <= 0) {
        if (seenLive && !wk.alerted) {
          beep(snd, 880, 0.15); beep(snd, 880, 0.15, 0.25); beep(snd, 1320, 0.4, 0.5)
          vibrate([200, 100, 200]); get().flashTimer()
        }
        if (wk.overtime && left > -MAX_WORK_OVERTIME_SEC) { set({ work: { ...wk, left, alerted: true } }); return }
        const done = workDone
        get().stopWork()
        if (done) done(wk.total - left, wk.forIdx)
        return
      }
      set({ work: { ...wk, left } })
    }
    workInt = setInterval(workTick, 1000)
    document.addEventListener('visibilitychange', workTick)
  },
  // Ended the hold early — log what was actually held.
  finishWorkEarly() {
    const wk = get().work
    if (!wk) return
    const startedAt = wk.endsAt - wk.total * 1000
    const elapsed = Math.max(1, Math.min(wk.total + (wk.overtime ? MAX_WORK_OVERTIME_SEC : 0), Math.round((Date.now() - startedAt) / 1000)))
    const done = workDone
    vibrate(30)
    get().stopWork()
    if (done) done(elapsed, wk.forIdx)
  },
  // A rest is starting while a hold runs that is not the one being ticked — a set finished on
  // another row, or on another exercise, which the List layout puts one tap away. The hold cannot
  // survive (the two must never run together) but the time it held is real, so it is handed back
  // before it goes and its own row keeps it. The `abandoned` flag tells the owner this was not a
  // finish: the row is not ticked off and earns no rest of its own, since the rest that displaced
  // the hold is the one now running.
  abandonWork() {
    const wk = get().work
    if (!wk) { get().stopWork(); return }
    const elapsed = wk.total - wk.left
    const done = workDone
    get().stopWork()
    // Under two seconds there is nothing to keep: that is a play button tapped by accident, or
    // tapped and thought better of, and rounding it up to one second the way an early finish does
    // would write a one-second plank over a real plan. (finishWorkEarly's Math.max(1, …) is right
    // for what it is: you pressed Done, so you held it, however briefly.)
    if (done && elapsed >= 2) done(elapsed, wk.forIdx, true)
  },
  // Abandon without logging anything.
  stopWork() {
    hush()
    holdSession(false)
    if (workInt) clearInterval(workInt); workInt = null
    if (workTick) document.removeEventListener('visibilitychange', workTick); workTick = null
    workDone = null
    set({ work: null })
  }
}))
