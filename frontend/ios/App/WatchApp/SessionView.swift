import SwiftUI

struct SessionView: View {
    @State var session: WatchActiveSession
    @State private var exerciseIndex = 0
    @State private var showRest = false

    var body: some View {
        TabView(selection: $exerciseIndex) {
            ForEach(session.entries.indices, id: \.self) { i in
                exerciseView(i).tag(i)
            }
        }
        .tabViewStyle(.page)
        .sheet(isPresented: $showRest) { RestTimerView(seconds: 90) { showRest = false } }
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
                    set: { session.entries[i].sets[j].sec = $0 }), in: 0...600, step: 5)
            } else if set.min != nil {
                Text("\(Int(set.min ?? 0)) min @ \(String(format: "%.1f", set.speed ?? 0))")
            } else {
                Stepper(value: Binding(
                    get: { session.entries[i].sets[j].w ?? 0 },
                    set: { session.entries[i].sets[j].w = $0 }), in: 0...500, step: 2.5) {
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

    private func toggleDone(entryIndex i: Int, setIndex j: Int) {
        session.entries[i].sets[j].done.toggle()
        WatchSessionStore.shared.activeSession = session
        WatchSessionStore.shared.persistActiveSession()
        if session.entries[i].sets[j].done && session.entries[i].sets[j].phase == "work" {
            showRest = true
        }
    }

    private func finish() {
        WatchSessionStore.shared.activeSession = session
        guard let finished = WatchSessionStore.shared.finishSession() else { return }
        WatchConnectivitySession.shared.sendCompletedSession(finished)
        WatchSessionStore.shared.clearFinishedSession()
    }
}
