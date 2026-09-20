import SwiftUI

struct SessionView: View {
    @State var session: WatchActiveSession
    var onFinished: () -> Void = {}
    @State private var exerciseIndex = 0
    @State private var showRest = false
    @State private var summary: WatchActiveSession?
    @State private var summarySaved = false

    var body: some View {
        TabView(selection: $exerciseIndex) {
            ForEach(session.entries.indices, id: \.self) { i in
                exerciseView(i).tag(i)
            }
        }
        .tabViewStyle(.page)
        .sheet(isPresented: $showRest) { RestTimerView(seconds: 90) { showRest = false } }
        .fullScreenCover(item: $summary) { finished in
            SummaryView(session: finished, saved: summarySaved) {
                summary = nil
                onFinished()
            }
        }
        .toolbar {
            ToolbarItem(placement: .confirmationAction) {
                Button("Finish") { finish() }
            }
        }
    }

    @ViewBuilder
    private func exerciseView(_ i: Int) -> some View {
        let entry = session.entries[i]
        List {
            Section(entry.label) {
                ForEach(entry.sets.indices, id: \.self) { j in
                    setRow(entryIndex: i, setIndex: j)
                }
            }
        }
    }

    @ViewBuilder
    private func setRow(entryIndex i: Int, setIndex j: Int) -> some View {
        let set = session.entries[i].sets[j]
        HStack {
            Text(set.phase == "warmup" ? "W" : "\(j + 1)").font(.caption2).foregroundStyle(.secondary)
            if set.sec != nil {
                Stepper("\(Int(set.sec ?? 0))s", value: Binding(
                    get: { session.entries[i].sets[j].sec ?? 0 },
                    set: { newValue in updateSet(entryIndex: i, setIndex: j) { $0.sec = newValue } }), in: 0...600, step: 5)
            } else if set.min != nil {
                Text("\(Int(set.min ?? 0)) min @ \(String(format: "%.1f", set.speed ?? 0))")
            } else {
                // Reps needs its own Stepper, not just weight — an unchecked adjustment here
                // (e.g. 6 of a planned 8) still logs as "done" with the planned rep count
                // otherwise, and progression.js's next-session decision reads the logged reps.
                VStack(alignment: .leading, spacing: 2) {
                    Stepper(value: Binding(
                        get: { session.entries[i].sets[j].w ?? 0 },
                        set: { newValue in updateSet(entryIndex: i, setIndex: j) { $0.w = newValue } }), in: 0...500, step: 2.5) {
                        Text("\(String(format: "%.1f", set.w ?? 0))")
                    }
                    Stepper(value: Binding(
                        get: { session.entries[i].sets[j].r ?? 0 },
                        set: { newValue in updateSet(entryIndex: i, setIndex: j) { $0.r = newValue } }), in: 0...50, step: 1) {
                        Text("\(set.r ?? 0) reps")
                    }
                }
            }
            Spacer()
            Button {
                toggleDone(entryIndex: i, setIndex: j)
            } label: {
                Image(systemName: set.done ? "checkmark.circle.fill" : "circle")
            }.buttonStyle(.plain)
        }
    }

    // The one path every set edit (weight/duration steppers, the done toggle) goes through, so
    // a crash or a back-swipe mid-session never loses an edit — design doc §7 asks this
    // explicitly ("is any completed set lost?").
    private func updateSet(entryIndex i: Int, setIndex j: Int, _ mutate: (inout WatchSet) -> Void) {
        mutate(&session.entries[i].sets[j])
        WatchSessionStore.shared.activeSession = session
        WatchSessionStore.shared.persistActiveSession()
    }

    private func toggleDone(entryIndex i: Int, setIndex j: Int) {
        updateSet(entryIndex: i, setIndex: j) { $0.done.toggle() }
        if session.entries[i].sets[j].done && session.entries[i].sets[j].phase == "work" {
            showRest = true
        }
    }

    private func finish() {
        WatchSessionStore.shared.activeSession = session
        guard let finished = WatchSessionStore.shared.finishSession() else { return }
        summary = finished
        summarySaved = false
        // sendCompletedSession's completion reports whether the workout was handed to
        // WCSession's durable outbox (not actual delivery to the phone — see that function's
        // comment). Only clear the local copy once that handoff succeeds, so a failure (not yet
        // activated, encode error) leaves the session persisted for
        // WatchConnectivitySession.resendIfNeeded to retry instead of losing it.
        WatchConnectivitySession.shared.sendCompletedSession(finished) { success in
            summarySaved = success
            if success { WatchSessionStore.shared.clearFinishedSession() }
        }
    }
}
