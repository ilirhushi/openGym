import Foundation
import WatchConnectivity
import os

private let log = Logger(subsystem: "agency.prompt-digital.opengym.watchkitapp", category: "connectivity")

// The Watch side of the bridge (counterpart to the iPhone's WatchBridge.swift).
final class WatchConnectivitySession: NSObject, WCSessionDelegate, ObservableObject {
    static let shared = WatchConnectivitySession()

    // Set right before a transferUserInfo call, cleared once its didFinish delegate callback
    // fires — this app only ever has one completed session in flight at a time (Finish is a
    // single user action), so a single slot is enough, no per-transfer bookkeeping needed.
    private var pendingCompletion: ((Bool) -> Void)?

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

    // Sends a completed session back to the phone. transferUserInfo queues it with the OS and
    // retries delivery — it does not require the phone to be reachable right now (design doc
    // §4, the "watch-independent" requirement). `completion` reports whether the OS accepted the
    // transfer into its durable outbox (not whether the phone has received it yet) — the caller
    // uses that, not phone-reachability, to decide whether it's safe to discard the local copy.
    func sendCompletedSession(_ session: WatchActiveSession, completion: @escaping (Bool) -> Void) {
        guard let data = try? JSONEncoder().encode(session),
              let payloadString = String(data: data, encoding: .utf8) else {
            completion(false)
            return
        }
        guard WCSession.isSupported() else {
            completion(false)
            return
        }
        pendingCompletion = completion
        WCSession.default.transferUserInfo(["payload": payloadString])
    }

    func session(_ session: WCSession, didFinish userInfoTransfer: WCSessionUserInfoTransfer, error: Error?) {
        let ok = error == nil
        if let error = error {
            log.error("transferUserInfo failed: \(error.localizedDescription, privacy: .public)")
        }
        DispatchQueue.main.async { [weak self] in
            self?.pendingCompletion?(ok)
            self?.pendingCompletion = nil
        }
    }

    // A session that finished but never got a successful transferUserInfo handoff (app was
    // killed before didFinish fired, or the earlier attempt errored) stays persisted rather than
    // discarded (SessionView.finish()) — retry it whenever the session (re)activates, which
    // covers both "the Watch app relaunched" and "connectivity just came back".
    func resendIfNeeded() {
        guard let session = WatchSessionStore.shared.activeSession, session.end != nil else { return }
        sendCompletedSession(session) { success in
            if success { WatchSessionStore.shared.clearFinishedSession() }
        }
    }
}
