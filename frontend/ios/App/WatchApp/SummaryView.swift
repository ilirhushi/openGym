import SwiftUI

// Post-finish confirmation (design doc §4.4): "saved" once the workout has been handed to
// WCSession's own durable outbox (not yet actual delivery to the phone — the Watch has no
// reliable way to observe that, and waiting for it would mean this screen — and the "workout
// recorded" reassurance it gives — never resolves while the phone is out of range), "will sync
// when the phone is nearby" while that handoff itself hasn't happened yet or failed.
struct SummaryView: View {
    let session: WatchActiveSession
    let saved: Bool
    var onDone: () -> Void

    var body: some View {
        VStack(spacing: 10) {
            Image(systemName: "checkmark.circle.fill")
                .font(.system(size: 36))
                .foregroundStyle(.green)
            Text(session.name ?? "Workout").font(.headline)
            Text(saved ? "Saved" : "Will sync when the phone is nearby")
                .font(.caption)
                .foregroundStyle(saved ? Color.secondary : Color.orange)
            Button("Done", action: onDone)
                .buttonStyle(.borderedProminent)
        }
        .padding()
    }
}
