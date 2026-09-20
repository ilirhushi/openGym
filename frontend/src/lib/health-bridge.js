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
