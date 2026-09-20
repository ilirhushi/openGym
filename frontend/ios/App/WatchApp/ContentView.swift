import SwiftUI

struct ContentView: View {
    @ObservedObject var store = WatchSessionStore.shared
    @State private var startedSession: WatchActiveSession?

    var body: some View {
        NavigationStack {
            Group {
                if store.activeSession != nil {
                    // A session is already running locally (e.g. the app relaunched mid-workout)
                    // — go straight back into it rather than re-showing Start.
                    Color.clear.onAppear { startedSession = store.activeSession }
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
            .navigationDestination(item: $startedSession) { session in
                SessionView(session: session)
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
