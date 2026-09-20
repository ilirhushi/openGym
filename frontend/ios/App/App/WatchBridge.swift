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
        let payload = call.getString("payload")
        do {
            try WCSession.default.updateApplicationContext(["payload": payload as Any])
            call.resolve()
        } catch {
            // No paired Watch, or the Watch app isn't installed — not an error the caller acts on.
            call.resolve()
        }
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
