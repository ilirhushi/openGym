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
 *   const status = await WatchBridge.getStatus(); // { supported, paired, watchAppInstalled, reachable }
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
        // A rest day (or the plan-side finding nothing scheduled) sends payload: null. An
        // Optional bridges to NSNull, which is not a property-list type and makes
        // updateApplicationContext throw — so an empty context, not a null value, is how "no
        // plan today" reaches the Watch. The Watch's own listener already treats a missing
        // "payload" key as "clear the plan" (WatchConnectivitySession.swift).
        let context: [String: Any] = call.getString("payload").map { ["payload": $0] } ?? [:]
        do {
            try WCSession.default.updateApplicationContext(context)
            call.resolve()
        } catch {
            // No paired Watch, or the Watch app isn't installed — not an error the caller acts on.
            call.resolve()
        }
    }

    // For Settings → the Watch companion status row: whether this iPhone can talk to a Watch at
    // all, whether one is paired, and whether the openGym Watch app is actually installed on it
    // (it isn't distributed via any store — see docs/MOBILE.md — so "paired but not installed"
    // is an expected, common state, not an error).
    @objc func getStatus(_ call: CAPPluginCall) {
        guard WCSession.isSupported() else {
            call.resolve(["supported": false, "paired": false, "watchAppInstalled": false, "reachable": false])
            return
        }
        let session = WCSession.default
        call.resolve([
            "supported": true,
            "paired": session.isPaired,
            "watchAppInstalled": session.isWatchAppInstalled,
            "reachable": session.isReachable,
        ])
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
