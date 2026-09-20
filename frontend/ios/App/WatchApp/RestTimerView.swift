import SwiftUI
import WatchKit

// The countdown itself is a plain Timer, started immediately and unconditionally — it must never
// depend on WKExtendedRuntimeSession succeeding, or a denied/invalidated session would mean the
// rest timer silently never runs at all (worse than not extending background time). The extended
// runtime session is layered on purely as a best-effort way to keep the app (and so the timer)
// alive a little longer once the wrist drops — watchOS suspends a foregrounded-only app within
// seconds of that, the normal posture during a rest interval — never as something the countdown
// waits on or is torn down by if it invalidates first.
final class RestTimerRunner: NSObject, ObservableObject, WKExtendedRuntimeSessionDelegate {
    @Published var remaining: Int
    private var session: WKExtendedRuntimeSession?
    private var timer: Timer?
    var onDone: (() -> Void)?

    init(seconds: Int) {
        remaining = max(1, seconds)
    }

    func start() {
        // SwiftUI can re-fire onAppear on a still-live view; gating on the timer (never on the
        // extended session, which start() always attempts regardless of the countdown's state)
        // stops a second call installing a second Timer — that would double the tick rate and
        // orphan the first extended runtime session's reference.
        guard timer == nil else { return }
        beginCountdown()
        let s = WKExtendedRuntimeSession()
        s.delegate = self
        s.start()
        session = s
    }

    func skip() { finish() }

    // Called when the view disappears without the countdown reaching zero (a sheet swipe-dismiss
    // — watchOS sheets are dismissable that way). Tears down the timer and the runtime session
    // without firing the haptic or onDone, which finish() would do.
    func cancel() {
        timer?.invalidate()
        timer = nil
        session?.invalidate()
        session = nil
    }

    func extendedRuntimeSessionDidStart(_ extendedRuntimeSession: WKExtendedRuntimeSession) {}

    func extendedRuntimeSession(_ extendedRuntimeSession: WKExtendedRuntimeSession, didInvalidateWith reason: WKExtendedRuntimeSessionInvalidationReason, error: Error?) {
        // Only drop the reference — the countdown Timer is independent and keeps running
        // (foregrounded) or gets suspended by the OS along with the rest of the app either way;
        // it must not be invalidated here, or the rest of the intended runtime this session
        // bought would go to waste.
        DispatchQueue.main.async { [weak self] in self?.session = nil }
    }

    func extendedRuntimeSessionWillExpire(_ extendedRuntimeSession: WKExtendedRuntimeSession) {}

    private func beginCountdown() {
        let t = Timer(timeInterval: 1, repeats: true) { [weak self] _ in
            guard let self else { return }
            self.remaining -= 1
            if self.remaining <= 0 { self.finish() }
        }
        // .common keeps the countdown running while the Digital Crown is being scrolled —
        // .default (a bare scheduledTimer's mode) stalls during UI tracking.
        RunLoop.main.add(t, forMode: .common)
        timer = t
    }

    private func finish() {
        guard timer != nil else { return }
        timer?.invalidate()
        timer = nil
        WKInterfaceDevice.current().play(.success)
        session?.invalidate()
        session = nil
        onDone?()
    }
}
