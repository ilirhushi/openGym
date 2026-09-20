import SwiftUI
import WatchKit

// A plain Timer only runs while the app is frontmost, and watchOS suspends the app within
// seconds of the wrist dropping — the normal posture during a rest interval — so the haptic
// would silently never fire. WKExtendedRuntimeSession's base (non-entitled) mode buys roughly an
// extra minute of background runtime, which is what lets the countdown and haptic survive that.
// A rest longer than that still needs the wrist raised near the end — a known phase-1 limit, not
// solvable without requesting a background-mode entitlement this sideloaded (non-App-Store) app
// doesn't otherwise need.
final class RestTimerRunner: NSObject, ObservableObject, WKExtendedRuntimeSessionDelegate {
    @Published var remaining: Int
    private let total: Int
    private var session: WKExtendedRuntimeSession?
    private var timer: Timer?
    var onDone: (() -> Void)?

    init(seconds: Int) {
        self.total = max(1, seconds)
        self.remaining = self.total
    }

    func start() {
        guard session == nil else { return }
        let s = WKExtendedRuntimeSession()
        s.delegate = self
        s.start()
        session = s
    }

    func skip() { finish() }

    func extendedRuntimeSessionDidStart(_ extendedRuntimeSession: WKExtendedRuntimeSession) {
        DispatchQueue.main.async { [weak self] in self?.beginCountdown() }
    }

    func extendedRuntimeSession(_ extendedRuntimeSession: WKExtendedRuntimeSession, didInvalidateWith reason: WKExtendedRuntimeSessionInvalidationReason, error: Error?) {
        DispatchQueue.main.async { [weak self] in self?.timer?.invalidate() }
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
        guard timer != nil || session != nil else { return }
        timer?.invalidate()
        timer = nil
        WKInterfaceDevice.current().play(.success)
        session?.invalidate()
        session = nil
        onDone?()
    }
}

struct RestTimerView: View {
    @StateObject private var runner: RestTimerRunner
    var onDone: () -> Void

    init(seconds: Int, onDone: @escaping () -> Void) {
        self.onDone = onDone
        _runner = StateObject(wrappedValue: RestTimerRunner(seconds: seconds))
    }

    var body: some View {
        VStack(spacing: 10) {
            Text("\(runner.remaining)s").font(.system(size: 40, weight: .bold, design: .rounded))
            Button("Skip") { runner.skip() }
        }
        .onAppear {
            runner.onDone = onDone
            runner.start()
        }
    }
}
