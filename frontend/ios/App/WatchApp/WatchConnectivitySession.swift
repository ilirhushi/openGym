import Foundation
import WatchConnectivity

// The Watch side of the bridge (counterpart to the iPhone's WatchBridge.swift).
final class WatchConnectivitySession: NSObject, WCSessionDelegate, ObservableObject {
    static let shared = WatchConnectivitySession()

    private override init() {
        super.init()
        guard WCSession.isSupported() else { return }
        WCSession.default.delegate = self
        WCSession.default.activate()
    }

    func session(_ session: WCSession, activationDidCompleteWith activationState: WCSessionActivationState, error: Error?) {}

    // Latest today's-plan payload from the phone (WCSession's own latest-value-wins semantics —
    // design doc §4.1). Delivered even if this app wasn't running.
    func session(_ session: WCSession, didReceiveApplicationContext applicationContext: [String: Any]) {
        guard let payloadString = applicationContext["payload"] as? String else {
            DispatchQueue.main.async { WatchSessionStore.shared.applyIncomingPlan(nil) }
            return
        }
        guard let data = payloadString.data(using: .utf8),
              let plan = try? JSONDecoder().decode(WatchPlan.self, from: data) else { return }
        DispatchQueue.main.async { WatchSessionStore.shared.applyIncomingPlan(plan) }
    }

    // Sends a completed session back to the phone. transferUserInfo queues it with the OS and
    // retries delivery — it does not require the phone to be reachable right now (design doc
    // §4, the "watch-independent" requirement).
    func sendCompletedSession(_ session: WatchActiveSession) {
        guard let data = try? JSONEncoder().encode(session),
              let payloadString = String(data: data, encoding: .utf8) else { return }
        WCSession.default.transferUserInfo(["payload": payloadString])
    }
}
