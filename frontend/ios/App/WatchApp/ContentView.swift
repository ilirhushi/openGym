import SwiftUI

struct ContentView: View {
    @ObservedObject private var store = WatchSessionStore.shared
    @State private var startedSession: WatchActiveSession?

    var body: some View {
        NavigationStack {
            Group {
                if let active = store.activeSession, active.end == nil {
                    // A session is genuinely still in progress (e.g. the app relaunched
                    // mid-workout) — go straight back into it rather than re-showing Start. A
                    // *finished* session (end != nil) that just hasn't been handed to WCSession
                    // yet is deliberately excluded here: showing it again would trap the user
                    // back inside a workout they already finished, on every relaunch, until
                    // WatchConnectivitySession.resendIfNeeded() clears it in the background.
                    Color.clear.onAppear { startedSession = active }
                } else if let plan = store.plan {
                    planView(plan)
                } else {
                    VStack(spacing: 8) {
                        Text("Not synced yet").font(.headline)
                        Text("Open the iPhone app once to sync today's plan.")
                            .font(.caption).multilineTextAlignment(.center).foregroundStyle(.secondary)
                    }.padding()
                }
            }
            // Into the day's exercise list, not straight onto a set card: the list is the spine
            // of the session (order, progress, finishing) and a card's back button has to have
            // somewhere useful to land.
            .navigationDestination(item: $startedSession) { session in
                SessionListView(session: session, onFinished: { startedSession = nil })
            }
        }
    }

    @ViewBuilder
    private func planView(_ plan: WatchPlan) -> some View {
        VStack(spacing: 10) {
            Text(plan.name ?? "Workout").font(.headline)
            Text("\(plan.entries.count) exercises").font(.caption).foregroundStyle(.secondary)
            if plan.activeOnPhone {
                Text("Already started on iPhone").font(.caption2).foregroundStyle(.orange)
            }
            Button("Start") {
                store.startSession()
                startedSession = store.activeSession
            }
            .buttonStyle(.borderedProminent)
        }.padding()
    }
}
