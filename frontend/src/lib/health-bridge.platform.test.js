// `S.health` is an ordinary synced store key, so an Android phone signed into the same account
// reads the toggle as on and would otherwise attempt a HealthKit write on every finish, then
// record the failure in a Settings row gated `MOBILE && isIOS()` that it can never render. The
// gate belongs in this transport, not at the call site: doFinishWorkout is synchronous by
// contract (spec section 7) and isIOS() is not.
import { describe, expect, it, vi } from 'vitest'

const written = []

vi.mock('./mobile.js', () => ({
  MOBILE: true,
  isIOS: async () => false,
  readJsonFile: async () => null,
  writeJsonFile: async (name, data) => { written.push([name, data]) },
}))

// Reaching @capacitor/core at all would already be the bug, so the mock makes that loud.
vi.mock('@capacitor/core', () => {
  throw new Error('the Health plugin must not be registered off iOS')
})

describe('health-bridge no-ops on a mobile build that is not iOS', () => {
  it('saveHealthWorkout() reports failure and writes no status file', async () => {
    const { saveHealthWorkout } = await import('./health-bridge.js')
    await expect(saveHealthWorkout({ start: 1, end: 2, type: 'strength', title: 'x', id: 'wk_1' })).resolves.toBe(false)
    expect(written).toEqual([])
  })

  it('readLatestBodyWeight() returns null, so the weigh-in simply does not prefill', async () => {
    const { readLatestBodyWeight } = await import('./health-bridge.js')
    await expect(readLatestBodyWeight()).resolves.toBeNull()
  })

  it('requestHealthPermissions() never raises a permission sheet', async () => {
    const { requestHealthPermissions } = await import('./health-bridge.js')
    await expect(requestHealthPermissions()).resolves.toBeNull()
  })

  it('getHealthAuth() returns null', async () => {
    const { getHealthAuth } = await import('./health-bridge.js')
    await expect(getHealthAuth()).resolves.toBeNull()
  })
})
