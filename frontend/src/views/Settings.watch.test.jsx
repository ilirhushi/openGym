// @vitest-environment happy-dom
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import Settings from './Settings.jsx'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

// The Apple Watch companion status row (docs/superpowers/specs/2026-09-20-apple-watch-app-design.md)
// only exists on the native iOS build — never on the web, never on Android. Each test flips the
// platform gates (MOBILE, isIOS) and the native getWatchStatus() result.
const mocks = vi.hoisted(() => {
  const state = { S: null, MOBILE: false, ios: false, watchStatus: null }
  state.snapshot = () => ({
    S: state.S,
    user: null,
    update: mut => {
      const next = structuredClone(state.S)
      mut(next)
      state.S = next
    },
    replaceState: vi.fn(), setUser: vi.fn(), pullState: vi.fn(), pushState: vi.fn(),
    signOut: vi.fn(), signOutAll: vi.fn(), resetDemo: vi.fn(), disconnectServer: vi.fn(),
  })
  return state
})
vi.mock('../store/useStore.js', () => {
  const useStore = selector => selector ? selector(mocks.snapshot()) : mocks.snapshot()
  useStore.getState = mocks.snapshot
  return { useStore, DEF: { reminder: { time: '17:30' } }, hasData: () => false }
})
vi.mock('../store/useUI.js', () => {
  const snap = () => ({ toast: vi.fn(), openSheet: vi.fn() })
  const useUI = selector => selector ? selector(snap()) : snap()
  useUI.getState = snap
  return { useUI }
})
vi.mock('react-router-dom', () => ({ useNavigate: () => () => {} }))
vi.mock('../lib/api.js', () => ({
  api: vi.fn(), webauthnOK: () => false, passkeyLogin: vi.fn(), passkeyRegister: vi.fn(), IS_ANDROID: false,
}))
vi.mock('../lib/push.js', () => ({ pushSupported: () => false, enablePush: vi.fn(), disablePush: vi.fn(), sendTestPush: vi.fn() }))
vi.mock('../lib/wakelock.js', () => ({ wakeLockSupported: () => false }))
vi.mock('../lib/mobile.js', () => ({
  get MOBILE() { return mocks.MOBILE },
  isAndroid: () => Promise.resolve(false),
  isIOS: () => Promise.resolve(mocks.ios),
  shareExport: vi.fn(), syncReminder: vi.fn(),
}))
vi.mock('../lib/watch-bridge.js', () => ({
  getWatchStatus: () => Promise.resolve(mocks.watchStatus),
}))
vi.mock('../lib/update.js', () => ({ checkForUpdate: vi.fn(() => Promise.resolve(null)), downloadAndInstall: vi.fn() }))
vi.mock('./MobileOnboarding.jsx', () => ({ ConnectSheet: () => null }))
vi.mock('../sheets.jsx', () => ({
  starterPlanSheet: vi.fn(), confirmSheet: vi.fn(), importFromApp: vi.fn(),
  importFromHevy: vi.fn(), equipmentProfileSheet: vi.fn(), menuSheet: vi.fn(),
}))

globalThis.__APP_VERSION__ ??= 'test'

let host, root
beforeEach(() => {
  mocks.S = {
    unit: 'kg', restSec: 90, restPauseSec: 15, sound: false, effort: 'none',
    gifSize: 'full', workouts: [], routines: [], exWeights: {},
  }
  mocks.MOBILE = false
  mocks.ios = false
  mocks.watchStatus = null
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})
afterEach(() => {
  act(() => root.unmount())
  host.remove()
})

const mount = async () => {
  await act(async () => { root.render(<Settings />) })
  await act(async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve() })
}
const watchSection = () => [...host.querySelectorAll('.lrow')].find(r =>
  r.textContent.includes('Connected') || r.textContent.includes('Watch app not installed') || r.textContent.includes('No Apple Watch paired'))

describe('Settings — Apple Watch companion status', () => {
  it('web build: no section, never asks for status', async () => {
    await mount()
    expect(watchSection()).toBeUndefined()
  })

  it('mobile build off iOS (Android): no section', async () => {
    mocks.MOBILE = true
    mocks.ios = false
    await mount()
    expect(watchSection()).toBeUndefined()
  })

  it('iOS, no Watch paired: shows the unpaired row', async () => {
    mocks.MOBILE = true
    mocks.ios = true
    mocks.watchStatus = { supported: true, paired: false, watchAppInstalled: false, reachable: false }
    await mount()
    expect(watchSection().textContent).toContain('No Apple Watch paired')
  })

  it('iOS, Watch paired but the openGym Watch app is not installed: shows that row', async () => {
    mocks.MOBILE = true
    mocks.ios = true
    mocks.watchStatus = { supported: true, paired: true, watchAppInstalled: false, reachable: false }
    await mount()
    expect(watchSection().textContent).toContain('Watch app not installed')
  })

  it('iOS, Watch app installed: shows Connected', async () => {
    mocks.MOBILE = true
    mocks.ios = true
    mocks.watchStatus = { supported: true, paired: true, watchAppInstalled: true, reachable: true }
    await mount()
    expect(watchSection().textContent).toContain('Connected')
  })
})
