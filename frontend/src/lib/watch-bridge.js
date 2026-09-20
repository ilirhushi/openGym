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
 * no paired Watch, or no plan that day: there is nothing the caller needs to react to either way. */
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
