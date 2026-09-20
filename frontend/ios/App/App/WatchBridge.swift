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
public class WatchBridge: CAPPlugin {
    // WCSessionDelegate lives on a separate NSObject rather than directly on this class — kept
    // isolated while diagnosing why plugin calls to this class weren't reaching native at all,
    // to rule out any interaction between CAPPlugin's own ObjC method dispatch and a second
    // protocol's methods/selectors on the same class.
    private var sessionDelegate: WatchSessionDelegateHandler?

    public override func load() {
        NSLog("[WatchBridge] load() called")
        guard WCSession.isSupported() else { NSLog("[WatchBridge] WCSession.isSupported() = false"); return }
        let delegate = WatchSessionDelegateHandler(owner: self)
        sessionDelegate = delegate
        let session = WCSession.default
        session.delegate = delegate
        session.activate()
        NSLog("[WatchBridge] session.activate() called")
    }

    @objc func syncTodayPlan(_ call: CAPPluginCall) {
        NSLog("[WatchBridge] syncTodayPlan() called")
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
        NSLog("[WatchBridge] getStatus() called")
        guard WCSession.isSupported() else {
            NSLog("[WatchBridge] getStatus(): WCSession.isSupported() = false, resolving")
            call.resolve(["supported": false, "paired": false, "watchAppInstalled": false, "reachable": false])
            return
        }
        let session = WCSession.default
        NSLog("[WatchBridge] getStatus(): activationState=\(session.activationState.rawValue) paired=\(session.isPaired) installed=\(session.isWatchAppInstalled) reachable=\(session.isReachable)")
        call.resolve([
            "supported": true,
            "paired": session.isPaired,
            "watchAppInstalled": session.isWatchAppInstalled,
            "reachable": session.isReachable,
        ])
        NSLog("[WatchBridge] getStatus(): call.resolve() returned")
    }

    // A completed session, sent from the Watch via transferUserInfo (queued, background-capable —
    // delivered here whether the app was foreground, background, or just-launched for this). This
    // delegate call can land before the WebView (and initWatchBridge's JS listener) has finished
    // booting — WCSession activates in load(), at bridge setup, well before that. Without
    // retainUntilConsumed, notifyListeners with no listener yet registered just drops the event:
    // Capacitor only replays a retained event once a listener attaches, never one it discarded.
    fileprivate func handleReceivedUserInfo(_ userInfo: [String: Any]) {
        guard let payload = userInfo["payload"] as? String else { return }
        notifyListeners("watchSessionReceived", data: ["payload": payload], retainUntilConsumed: true)
    }
}

private class WatchSessionDelegateHandler: NSObject, WCSessionDelegate {
    private weak var owner: WatchBridge?

    init(owner: WatchBridge) {
        self.owner = owner
    }

    func session(_ session: WCSession, activationDidCompleteWith activationState: WCSessionActivationState, error: Error?) {}
    func sessionDidBecomeInactive(_ session: WCSession) {}
    func sessionDidDeactivate(_ session: WCSession) { session.activate() }

    func session(_ session: WCSession, didReceiveUserInfo userInfo: [String: Any] = [:]) {
        owner?.handleReceivedUserInfo(userInfo)
    }
}
