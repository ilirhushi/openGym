// The JS side of the phone <-> Watch bridge (design doc §4.1). The native half is the
// `WatchBridge` Capacitor plugin (Task 4). This file stays store-agnostic and testable: it takes
// state in, returns plain data or calls the callbacks it's given, and never imports the store or
// sheets.jsx directly (sheets.jsx's merge UI is wired in from useStore.js, Step 3b below, so
// there's no import cycle between the store and the UI layer).
import { MOBILE, readJsonFile, writeJsonFile } from './mobile.js'
import { buildWatchPlanPayload } from './watch-sync.js'
import { finishWatchSession } from './watch-import.js'
import { workoutsOn } from './backfill.js'

const SEEN_LIMIT = 50
const SEEN_FILE = 'opengym-watch-seen.json'

/** Has this Watch session id already been applied? Redelivery-safe (design doc §5.2). */
export function isWatchSessionSeen(seenIds, watchSessionId) {
  return seenIds.includes(watchSessionId)
}

/** Record a session id as applied, keeping only the most recent SEEN_LIMIT. */
export function withWatchSessionSeen(seenIds, watchSessionId) {
  return [...seenIds.filter(id => id !== watchSessionId), watchSessionId].slice(-SEEN_LIMIT)
}

/** Today's plan, or null when there's nothing to sync (off mobile, or no plan that day). */
export function planPushPayload(S, iso) {
  if (!MOBILE) return null
  return buildWatchPlanPayload(S, iso)
}

// The loaded plugin travels inside a plain object, never as a promise's own value — exactly the
// same wrapper, and for exactly the same reason, as coach-secrets.js's plugin() (issues #42,
// #58). Capacitor's registerPlugin() hands out a Proxy whose get-trap answers EVERY property
// name with a native-method wrapper, `then` included (it special-cases only `$$typeof` and
// `toJSON` — see @capacitor/core's registerPlugin). A promise that resolves to the proxy itself
// therefore takes it for a thenable and calls proxy.then(resolve, reject); that wrapper drops
// both callbacks on the floor, so the promise never settles and the await hangs forever with no
// error. `then` isn't a declared plugin method either, so it never even reaches the native side
// — there is no failed call to see, only silence.
//
// Note this applies to an `async function`'s return value too, not just an explicit .then():
// `async function plugin() { return proxy }` assimilates the proxy the same way. Hence the box,
// and hence a plain function rather than an async one.
let pluginPromise = null
function plugin() {
  if (!MOBILE) return Promise.resolve({ p: null })
  if (!pluginPromise) {
    pluginPromise = import('@capacitor/core')
      .then(({ registerPlugin }) => ({ p: registerPlugin('WatchBridge') }))
      .catch(e => { console.error('WatchBridge plugin unavailable:', e); return { p: null } })
  }
  return pluginPromise
}

/** Push the latest today's-plan payload out to a paired Watch. Silently a no-op with no plugin,
 * no paired Watch, or no plan that day: there is nothing the caller needs to react to either way. */
export async function syncTodayPlanToWatch(S, iso) {
  const payload = planPushPayload(S, iso)
  const { p } = await plugin()
  if (!p) return
  try { await p.syncTodayPlan({ payload: payload ? JSON.stringify(payload) : null }) } catch (e) { /* no paired Watch */ }
}

/**
 * Decide how to fold one incoming completed Watch session into history: straight through when
 * there's no same-day workout already, otherwise hand the choice to `askUser` (the same
 * replace-or-add decision `sheets.jsx`'s SameDayChoice already makes for backfilled workouts).
 * `apply(result)` receives `finishWatchSession`'s return value; `askUser(existing, choose)` is
 * given the conflicting workouts and a `choose(replaceId | null)` callback to resolve with.
 *
 * Takes `getState` (a `() => st` thunk) rather than a single `st` snapshot: the askUser path
 * waits on a user decision, which can take a while, and computing the merge against a snapshot
 * taken before the sheet opened would silently clobber anything that changed `st.workouts` in
 * the meantime (a phone workout finished, a server sync merge landing) — `update()` assigns the
 * whole array, not a diff. Re-reading state exactly when the choice resolves avoids that.
 */
export function decideWatchImport(getState, payload, { apply, askUser }) {
  const st = getState()
  const existing = workoutsOn(st, payload.date)
  if (!existing.length) { apply(finishWatchSession(st, payload)); return }
  askUser(existing, replaceId => apply(finishWatchSession(getState(), payload, { replaceId })))
}

/** Watch-pairing status for Settings' "Apple Watch" row: null off mobile, on a non-iOS platform,
 * or if the native call fails; otherwise { supported, paired, watchAppInstalled, reachable }. */
export async function getWatchStatus() {
  const { p } = await plugin()
  if (!p) return null
  try { return await p.getStatus() } catch (e) { console.error('WatchBridge.getStatus failed:', e); return null }
}

/** Register the native listener for completed Watch sessions. `onSession(payload, markSeen)` is
 * called once per incoming session (already JSON.parsed) — `markSeen()` must be called by the
 * caller once (and only once) the session has actually been applied to history, not merely
 * handed off. Marking it seen any earlier would mean a same-day conflict sheet dismissed (or the
 * app killed) before the user chooses loses the workout for good: nothing else holds a durable
 * copy of it once this event has fired, and it isn't redelivered on demand. No-op off mobile. */
export async function initWatchBridge(onSession) {
  const { p } = await plugin()
  if (!p) return
  let seenIds = (await readJsonFile(SEEN_FILE)) || []
  p.addListener('watchSessionReceived', async ev => {
    let payload
    try { payload = JSON.parse(ev.payload) } catch (e) { return }
    if (!payload?.watchSessionId || isWatchSessionSeen(seenIds, payload.watchSessionId)) return
    const markSeen = async () => {
      seenIds = withWatchSessionSeen(seenIds, payload.watchSessionId)
      await writeJsonFile(SEEN_FILE, seenIds)
    }
    onSession(payload, markSeen)
  })
}
