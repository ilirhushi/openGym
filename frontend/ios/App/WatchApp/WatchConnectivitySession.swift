import Foundation
import WatchConnectivity
import os

private let log = Logger(subsystem: "agency.prompt-digital.opengym.watchkitapp", category: "connectivity")

// The Watch side of the bridge (counterpart to the iPhone's WatchBridge.swift).
final class WatchConnectivitySession: NSObject, WCSessionDelegate, ObservableObject {
    static let shared = WatchConnectivitySession()

    private override init() {
        super.init()
        guard WCSession.isSupported() else { return }
        WCSession.default.delegate = self
        WCSession.default.activate()
    }

    func session(_ session: WCSession, activationDidCompleteWith activationState: WCSessionActivationState, error: Error?) {
        if activationState == .activated { resendIfNeeded() }
    }

    // Latest today's-plan payload from the phone (WCSession's own latest-value-wins semantics —
    // design doc §4.1). Delivered even if this app wasn't running.
    func session(_ session: WCSession, didReceiveApplicationContext applicationContext: [String: Any]) {
        guard let payloadString = applicationContext["payload"] as? String else {
            DispatchQueue.main.async { WatchSessionStore.shared.applyIncomingPlan(nil) }
            return
        }
        guard let data = payloadString.data(using: .utf8) else {
            log.error("today's-plan payload was not valid UTF-8 — clearing the plan")
            DispatchQueue.main.async { WatchSessionStore.shared.applyIncomingPlan(nil) }
            return
        }
        do {
            let plan = try JSONDecoder().decode(WatchPlan.self, from: data)
            DispatchQueue.main.async { WatchSessionStore.shared.applyIncomingPlan(plan) }
        } catch {
            // A shape change on the JS side (a renamed/retyped field) is the only realistic
            // cause here. There is no Swift test harness in this repo (design doc §6), so this
            // log line is the only diagnostic surface this failure will ever have — and clearing
            // the plan means the Watch degrades to "Not synced yet" instead of silently showing
            // a stale, no-longer-valid plan.
            log.error("failed to decode WatchPlan: \(error.localizedDescription, privacy: .public)")
            DispatchQueue.main.async { WatchSessionStore.shared.applyIncomingPlan(nil) }
        }
    }

    // Sends a completed session back to the phone. transferUserInfo hands the payload to the
    // OS's own durable, cross-launch outbox *immediately* on this call — it does not wait for
    // the phone to actually receive it, which may not happen for hours if it's out of range
    // (design doc §4, the "watch-independent" requirement). That handoff succeeding, not actual
    // delivery, is what `completion` reports and what the caller uses to decide it's safe to
    // discard the local copy: waiting for WCSessionDelegate's `didFinish` (which only fires on
    // real delivery or a permanent failure) would mean a phone that's merely unreachable right
    // now never clears the finished session at all — trapping the Watch on it indefinitely.
    func sendCompletedSession(_ session: WatchActiveSession, completion: @escaping (Bool) -> Void) {
        guard let data = try? JSONEncoder().encode(session),
              let payloadString = String(data: data, encoding: .utf8) else {
            completion(false)
            return
        }
        // transferUserInfo raises an uncatchable ObjC exception if called before activation
        // completes — this guard is the only thing standing between a not-yet-activated session
        // and a crash on Finish.
        guard WCSession.isSupported(), WCSession.default.activationState == .activated else {
            completion(false)
            return
        }
        _ = WCSession.default.transferUserInfo(["payload": payloadString])
        completion(true)
    }

    // Diagnostic only (design doc §6 — no Swift test harness, so a log line is the only
    // visibility this ever gets): whether a queued transfer was eventually delivered. Never used
    // to decide whether the local copy is safe to discard — see sendCompletedSession above.
    func session(_ session: WCSession, didFinish userInfoTransfer: WCSessionUserInfoTransfer, error: Error?) {
        if let error = error {
            log.error("a queued Watch session transfer failed permanently: \(error.localizedDescription, privacy: .public)")
        }
    }

    // A session that finished but never got handed to WCSession (the app launched before
    // activation completed, or a prior attempt's encode failed) stays persisted rather than
    // discarded (SessionView.finish()) — retry the handoff whenever the session (re)activates.
    func resendIfNeeded() {
        guard let session = WatchSessionStore.shared.activeSession, session.end != nil else { return }
        sendCompletedSession(session) { success in
            if success { WatchSessionStore.shared.clearFinishedSession() }
        }
    }
}
