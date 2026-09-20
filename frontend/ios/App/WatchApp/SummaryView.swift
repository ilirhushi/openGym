import SwiftUI

// Post-finish confirmation (design doc §4.4): "synced" once the OS has durably queued the
// completed session for the phone, "will sync when phone is nearby" while that's still pending
// or failed — never silence, so the wearer always knows the workout was actually recorded.
struct SummaryView: View {
    let session: WatchActiveSession
    let synced: Bool
    var onDone: () -> Void

    var body: some View {
        VStack(spacing: 10) {
            Image(systemName: "checkmark.circle.fill")
                .font(.system(size: 36))
                .foregroundStyle(.green)
            Text(session.name ?? "Workout").font(.headline)
            Text(synced ? "Synced" : "Will sync when the phone is nearby")
                .font(.caption)
                .foregroundStyle(synced ? Color.secondary : Color.orange)
            Button("Done", action: onDone)
                .buttonStyle(.borderedProminent)
        }
        .padding()
    }
}
