import SwiftUI
import WatchKit

struct RestTimerView: View {
    let seconds: Int
    var onDone: () -> Void
    @State private var remaining: Int
    @State private var timer: Timer?

    init(seconds: Int, onDone: @escaping () -> Void) {
        self.seconds = seconds
        self.onDone = onDone
        _remaining = State(initialValue: seconds)
    }

    var body: some View {
        VStack(spacing: 10) {
            Text("\(remaining)s").font(.system(size: 40, weight: .bold, design: .rounded))
            Button("Skip") { finish() }
        }
        .onAppear { start() }
        .onDisappear { timer?.invalidate() }
    }

    private func start() {
        timer = Timer.scheduledTimer(withTimeInterval: 1, repeats: true) { _ in
            remaining -= 1
            if remaining <= 0 { finish() }
        }
    }

    private func finish() {
        timer?.invalidate()
        WKInterfaceDevice.current().play(.success)
        onDone()
    }
}
