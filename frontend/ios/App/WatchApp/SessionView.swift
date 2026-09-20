import SwiftUI

struct SessionView: View {
    @State var session: WatchActiveSession
    var onFinished: () -> Void = {}
    @State private var exerciseIndex = 0
    @State private var showRest = false
    @State private var summary: WatchActiveSession?
    @State private var summarySynced = false

    var body: some View {
        TabView(selection: $exerciseIndex) {
            ForEach(session.entries.indices, id: \.self) { i in
                exerciseView(i).tag(i)
            }
        }
        .tabViewStyle(.page)
        .sheet(isPresented: $showRest) { RestTimerView(seconds: 90) { showRest = false } }
        .fullScreenCover(item: $summary) { finished in
            SummaryView(session: finished, synced: summarySynced) {
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
                Stepper(value: Binding(
                    get: { session.entries[i].sets[j].w ?? 0 },
                    set: { newValue in updateSet(entryIndex: i, setIndex: j) { $0.w = newValue } }), in: 0...500, step: 2.5) {
                    Text("\(String(format: "%.1f", set.w ?? 0)) x \(set.r ?? 0)")
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
        // Show the summary immediately (optimistic — the transfer is already durably queued
        // with the OS once sendCompletedSession's completion fires); only clear the local copy
        // once that's confirmed, so a failure leaves the session persisted for retry
        // (WatchConnectivitySession.resendIfNeeded) instead of losing it.
        summary = finished
        summarySynced = false
        WatchConnectivitySession.shared.sendCompletedSession(finished) { success in
            summarySynced = success
            if success { WatchSessionStore.shared.clearFinishedSession() }
        }
    }
}
