import SwiftUI

// One-card-at-a-time workout screen. Previously a paged TabView of Lists (a Stepper per field,
// stacked in a row) which doesn't fit a 44mm face. This version keeps the TabView paging (one
// page per exercise, still swipeable) but each page renders a single "current set" card driven
// by a (exerciseIndex, setIndex) cursor instead of a scrollable list of every set at once.
struct SessionView: View {
    @State var session: WatchActiveSession

    // The cursor. exerciseIndex also drives which TabView page is showing (it's the page
    // selection binding), setIndex is which set within that exercise's card is on screen.
    // It starts wherever the exercise list sent us rather than always at the first exercise.
    @State private var exerciseIndex: Int
    @State private var setIndex = 0

    init(session: WatchActiveSession, startIndex: Int = 0) {
        _session = State(initialValue: session)
        _exerciseIndex = State(initialValue: min(max(startIndex, 0), max(session.entries.count - 1, 0)))
    }

    // Which value currently has Digital Crown focus. Only meaningful in reps mode (two
    // adjustable values); time mode has exactly one crown target and cardio mode has none.
    private enum CrownFocus: Hashable { case weight, reps, seconds }
    @FocusState private var crownFocus: CrownFocus?

    // The active rest countdown, if any. Owned here (not by a sheet) so it survives the card
    // changing under it as the cursor advances into the next set/exercise. RestLineView below
    // subscribes to its @Published remaining directly, so replacing this reference is the only
    // thing that needs to trigger a re-render of SessionView itself.
    @State private var restRunner: RestTimerRunner?

    // The synced plan carries no per-exercise rest interval yet (watch-sync.js's payload doesn't
    // have that field). 90s is a placeholder until that's added; tracked as a follow-up, not
    // something to invent here.
    private let restSeconds = 90

    var body: some View {
        TabView(selection: $exerciseIndex) {
            ForEach(session.entries.indices, id: \.self) { i in
                cardView(entryIndex: i).tag(i)
            }
        }
        // No page dots. They are drawn along the bottom edge, which is where the set rail lives,
        // and with a seven-exercise session the two overlap into noise. Which exercise you are
        // on is what the list behind the back button is for now.
        .tabViewStyle(.page(indexDisplayMode: .never))
        // The name lives in a top safe-area inset rather than inside the page. A TabView page's
        // content runs underneath the navigation bar, so on a real watch the name was drawn
        // behind the back chevron; an inset is laid out clear of the bar by definition.
        .safeAreaInset(edge: .top, spacing: 0) {
            Text(currentEntry?.label ?? "")
                .font(.caption)
                .foregroundStyle(WatchPalette.dim)
                .lineLimit(2)
                .minimumScaleFactor(0.75)
                // Truncate the middle, not the tail. The library's longest names are
                // distinguished by their endings, not their beginnings: "calf raise (tennis
                // ball between ankles)" and "... between knees)" differ only in the last word,
                // and tail truncation renders the two identical on screen.
                .truncationMode(.middle)
                .multilineTextAlignment(.center)
                .frame(maxWidth: .infinity)
                .padding(.horizontal, 6)
        }
        .onAppear {
            // Covers both a fresh Start and ContentView routing straight back into an
            // already-in-progress session after a relaunch: land on the first undone set rather
            // than always set 0, so a resumed session doesn't put you back at a set you already
            // logged.
            setIndex = firstIncompleteIndex(in: exerciseIndex)
            resetCrownFocus(entryIndex: exerciseIndex, setIndex: setIndex)
        }
        .onChange(of: exerciseIndex) { _, newValue in
            setIndex = firstIncompleteIndex(in: newValue)
            resetCrownFocus(entryIndex: newValue, setIndex: setIndex)
        }
        .onDisappear {
            // The runner used to live inside RestTimerView's own onDisappear. Now that it's
            // owned by this view directly, cancel (not skip) here: leaving the screen isn't the
            // countdown finishing, so it must not fire the success haptic or the onDone
            // advance-logic, just stop the Timer and the extended runtime session.
            restRunner?.cancel()
            restRunner = nil
        }
    }

    private var currentEntry: WatchEntry? {
        session.entries.indices.contains(exerciseIndex) ? session.entries[exerciseIndex] : nil
    }

    // MARK: - Card

    @ViewBuilder
    private func cardView(entryIndex i: Int) -> some View {
        let entry = session.entries[i]
        if entry.sets.isEmpty {
            Text("No sets").foregroundStyle(.secondary)
        } else {
            // TabView(.page) pre-renders the neighboring page or two for the swipe animation, so
            // every page's body runs even when it isn't the one on screen. setIndex is only
            // meaningful for the page that matches exerciseIndex; clamp it for any other page so
            // an exercise with fewer sets than the current cursor's index never indexes out of
            // bounds while it's momentarily rendered off-screen.
            let j = min(setIndex, entry.sets.count - 1)
            let set = entry.sets[j]
            VStack(spacing: 6) {
                Spacer(minLength: 0)
                valueBlock(entryIndex: i, setIndex: j, set: set)

                // Both of these are conditional, so this line costs nothing on an ordinary work
                // set. A running countdown wins the slot: mid-rest it is the only thing changing
                // and the thing you are actually waiting on.
                if i == exerciseIndex, let restRunner {
                    RestLine(runner: restRunner)
                } else if set.phase == "warmup" {
                    Text(positionLabel(entryIndex: i, setIndex: j))
                        .font(.caption2)
                        .foregroundStyle(WatchPalette.dim)
                }

                Spacer(minLength: 0)

                Button {
                    toggleDone(entryIndex: i, setIndex: j)
                } label: {
                    // The button names what tapping it does. On a set already logged, "Done"
                    // would describe the state while actually performing the opposite, so it
                    // becomes "Undo" instead.
                    Text(set.done ? "Undo" : "Done")
                        .font(.footnote.weight(.semibold))
                        .foregroundStyle(set.done ? Color.white : Color.black)
                        .frame(maxWidth: .infinity)
                }
                .buttonStyle(.borderedProminent)
                // Small, not because the target should be hard to hit (full width keeps it an
                // easy thumb target) but because at the default control size it was taller than
                // the numeral and pulled the eye away from the thing you are here to read.
                .controlSize(.small)
                // White for the action you take dozens of times a session, so it stays the
                // brightest thing under the numeral; a flat grey once logged, because an undo is
                // a correction and should not compete for the eye.
                .tint(set.done ? WatchPalette.spent : .white)

                SetRail(sets: entry.sets, currentIndex: j)
            }
            .padding(.horizontal, 6)
            .padding(.bottom, 2)
            // A TabView page's content area runs under the toolbar strip, and this VStack
            // centres itself in it, so a name that wraps to a second line grows upward and the
            // first line disappears behind the clock and Finish. Keeping the card inside the
            // safe area is what stops that.
            .padding(.top, 4)
            .frame(maxHeight: .infinity, alignment: .top)
        }
    }

    @ViewBuilder
    private func valueBlock(entryIndex i: Int, setIndex j: Int, set: WatchSet) -> some View {
        // Same precedence as the file this replaces: sec first, then min, then reps. A set is
        // never more than one of these at once in practice, but if the payload ever did carry
        // more than one, time mode wins because it's the one the rest-timer flow cares about.
        if set.sec != nil {
            numeral("\(Int(set.sec ?? 0))", unit: "sec", focused: crownFocus == .seconds)
                .focusable()
                .focused($crownFocus, equals: .seconds)
                .digitalCrownRotation(
                    secBinding(entryIndex: i, setIndex: j),
                    from: 0, through: 600, by: 5,
                    sensitivity: .medium, isContinuous: false, isHapticFeedbackEnabled: true)
        } else if set.min != nil {
            // Cardio entries are read-only here too, same as the file this replaces: there's no
            // crown-adjustable field for them, just the logged duration and pace. The duration
            // still gets the full numeral treatment so the three modes read as one screen
            // rather than three, with the pace demoted to the context line it belongs on.
            VStack(spacing: 2) {
                numeral("\(Int(set.min ?? 0))", unit: "min", focused: false)
                Text("pace \(String(format: "%.1f", set.speed ?? 0))")
                    .font(.footnote)
                    .monospacedDigit()
                    .foregroundStyle(WatchPalette.dim)
            }
        } else {
            VStack(spacing: 2) {
                numeral(String(format: "%.1f", set.w ?? 0), unit: session.unit ?? "kg",
                        focused: crownFocus == .weight)
                    .focusable()
                    .focused($crownFocus, equals: .weight)
                    .digitalCrownRotation(
                        weightBinding(entryIndex: i, setIndex: j),
                        from: 0, through: 500, by: 2.5,
                        sensitivity: .medium, isContinuous: false, isHapticFeedbackEnabled: true)
                    .onTapGesture { crownFocus = .weight }
                // No "reps" word: the multiplication sign already says what this number counts,
                // and the two characters it costs are two characters of numeral size.
                Text("\u{00D7} \(set.r ?? 0)")
                    .font(.system(size: 20, weight: .semibold))
                    .monospacedDigit()
                    .foregroundStyle(WatchPalette.dim)
                    .focusRule(crownFocus == .reps)
                    .focusable()
                    .focused($crownFocus, equals: .reps)
                    .digitalCrownRotation(
                        repsBinding(entryIndex: i, setIndex: j),
                        from: 0, through: 50, by: 1,
                        sensitivity: .medium, isContinuous: false, isHapticFeedbackEnabled: true)
                    .onTapGesture { crownFocus = .reps }
            }
        }
    }

    // The number is the only thing worth reading at arm's length mid-set, so it takes the whole
    // visual budget in every mode. Monospaced digits matter more here than anywhere else on the
    // screen: without them the value reflows on every crown detent, and a number that shifts
    // while you turn it is harder to read than one half its size that stays put.
    private func numeral(_ value: String, unit: String, focused: Bool) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: 3) {
            Text(value)
                .font(.system(size: 42, weight: .heavy))
                .monospacedDigit()
            Text(unit)
                .font(.system(size: 14, weight: .semibold))
                .foregroundStyle(WatchPalette.dim)
        }
        .lineLimit(1)
        .minimumScaleFactor(0.6)
        .focusRule(focused)
    }

    // Reps and weight both live on this card at once, so the crown needs to know which one it's
    // turning. Weight is the default because it's the value you're most likely to be adjusting
    // between sets (working weight changes far more often mid-session than the rep target does);
    // tapping either value moves focus explicitly. Time mode has only one target, so it always
    // gets the crown; cardio has none, so focus is cleared.
    private func resetCrownFocus(entryIndex i: Int, setIndex j: Int) {
        guard session.entries.indices.contains(i), session.entries[i].sets.indices.contains(j) else {
            crownFocus = nil
            return
        }
        let set = session.entries[i].sets[j]
        if set.sec != nil {
            crownFocus = .seconds
        } else if set.min != nil {
            crownFocus = nil
        } else {
            crownFocus = .weight
        }
    }

    // "2/4", or "warmup 1/2" when the set is a warmup. Numbered within the set's own phase, not
    // the raw array index, since warmup and work sets share one flat `sets` array on WatchEntry
    // and a warmup set sitting after two work sets (unusual, but the model doesn't forbid it)
    // shouldn't read as "warmup 3". The word only appears for warmups: on a work set it would be
    // chrome, since work is what every set is unless said otherwise.
    private func positionLabel(entryIndex i: Int, setIndex j: Int) -> String {
        let sets = session.entries[i].sets
        let phase = sets[j].phase
        let samePhase = sets.filter { $0.phase == phase }
        let indexInPhase = sets[0...j].filter { $0.phase == phase }.count
        let prefix = phase == "warmup" ? "warmup " : ""
        return "\(prefix)\(indexInPhase)/\(samePhase.count)"
    }

    private func firstIncompleteIndex(in exerciseIndex: Int) -> Int {
        guard session.entries.indices.contains(exerciseIndex) else { return 0 }
        let sets = session.entries[exerciseIndex].sets
        return sets.firstIndex(where: { !$0.done }) ?? max(sets.count - 1, 0)
    }

    // MARK: - Crown bindings

    private func weightBinding(entryIndex i: Int, setIndex j: Int) -> Binding<Double> {
        Binding(
            get: { session.entries[i].sets[j].w ?? 0 },
            set: { newValue in updateSet(entryIndex: i, setIndex: j) { $0.w = newValue } })
    }

    private func repsBinding(entryIndex i: Int, setIndex j: Int) -> Binding<Double> {
        Binding(
            get: { Double(session.entries[i].sets[j].r ?? 0) },
            set: { newValue in updateSet(entryIndex: i, setIndex: j) { $0.r = Int(newValue.rounded()) } })
    }

    private func secBinding(entryIndex i: Int, setIndex j: Int) -> Binding<Double> {
        Binding(
            get: { session.entries[i].sets[j].sec ?? 0 },
            set: { newValue in updateSet(entryIndex: i, setIndex: j) { $0.sec = newValue } })
    }

    // The one path every set edit (crown-driven weight/reps/seconds, the Done toggle) goes
    // through, so a crash or a back-swipe mid-session never loses an edit, design doc §7 asks
    // this explicitly ("is any completed set lost?").
    private func updateSet(entryIndex i: Int, setIndex j: Int, _ mutate: (inout WatchSet) -> Void) {
        mutate(&session.entries[i].sets[j])
        WatchSessionStore.shared.activeSession = session
        WatchSessionStore.shared.persistActiveSession()
    }

    private func toggleDone(entryIndex i: Int, setIndex j: Int) {
        let wasDone = session.entries[i].sets[j].done
        updateSet(entryIndex: i, setIndex: j) { $0.done.toggle() }
        // Undoing a set (was done, tapped again) is purely a correction: it must not start a
        // rest countdown or move the cursor forward, or undoing the set you're currently
        // reviewing would immediately fling you past it again.
        guard !wasDone else { return }
        if session.entries[i].sets[j].phase == "work" {
            startRest()
        }
        advanceCursor(entryIndex: i, setIndex: j)
    }

    private func advanceCursor(entryIndex i: Int, setIndex j: Int) {
        let entry = session.entries[i]
        if j + 1 < entry.sets.count {
            setIndex = j + 1
            resetCrownFocus(entryIndex: i, setIndex: setIndex)
        } else if i + 1 < session.entries.count {
            // Changing exerciseIndex both flips the TabView page and fires onChange(of:
            // exerciseIndex) above, which sets setIndex to that exercise's first incomplete set
            // (index 0, since nothing in it is done yet) and resets crown focus. No need to set
            // setIndex here too.
            exerciseIndex = i + 1
        }
        // Else: last set of the last exercise. Nothing to advance to, cursor stays put; Finish
        // is the only way forward from here.
    }

    private func startRest() {
        // Starting a new rest while one is already running (e.g. the previous set's rest hadn't
        // finished when this one was marked done) must not leak the old Timer or extended
        // runtime session. cancel(), not skip(): this isn't the old countdown completing, so it
        // must not fire its success haptic or onDone a second time.
        restRunner?.cancel()
        let runner = RestTimerRunner(seconds: restSeconds)
        runner.onDone = { restRunner = nil }
        runner.start()
        restRunner = runner
    }

}

// Black, white, one grey, one signal. The signal is reserved for "this is live or this is where
// you are" (crown focus, a running countdown, the current set) and is used for nothing else, so
// colour anywhere on the card carries meaning instead of decorating. The screen this replaces
// had green on the button, green on the dots and orange on the timer, three accents that each
// meant something different and competed at 44mm.
private enum WatchPalette {
    // A gym-equipment yellow rather than a fitness-app green: it holds up in direct sun, which
    // is where half of these glances happen, and it does not read as "success" on a control
    // that is only reporting where you are.
    static let signal = Color(red: 1.0, green: 0.83, blue: 0.0)
    static let dim = Color(white: 0.62)
    static let spent = Color(white: 0.24)
}

// Crown focus is shown with a rule under the value, never by dimming the value that is not
// focused. Dimming spends legibility on the one screen that can least afford it (a sub-second
// glance, often in bad light), and a value at reduced opacity reads as disabled, which is the
// opposite of what focus means.
private struct FocusRule: ViewModifier {
    let focused: Bool

    func body(content: Content) -> some View {
        VStack(spacing: 3) {
            content
            Capsule()
                .fill(focused ? WatchPalette.signal : Color.clear)
                .frame(width: 28, height: 2)
        }
    }
}

private extension View {
    func focusRule(_ focused: Bool) -> some View { modifier(FocusRule(focused: focused)) }
}

// Small subview so only this piece re-renders on the countdown's per-second tick, via its own
// @ObservedObject subscription to RestTimerRunner.remaining, instead of the whole card.
private struct RestLine: View {
    @ObservedObject var runner: RestTimerRunner

    var body: some View {
        Button {
            // skip() (not cancel()) here: tapping the rest line is the user choosing to end the
            // rest early, which is the countdown finishing early, not this screen going away. It
            // fires the same success haptic and onDone as running out the clock would.
            runner.skip()
        } label: {
            // Monospaced because this number changes every second in place. With proportional
            // digits the whole line shifts as the width of the glyphs changes, and a countdown
            // that twitches is the most distracting thing that can be on a watch face.
            Text(formatted).monospacedDigit()
        }
        .buttonStyle(.plain)
        .foregroundStyle(WatchPalette.signal)
    }

    private var formatted: String {
        String(format: "%d:%02d", runner.remaining / 60, runner.remaining % 60)
    }
}

// A rail rather than a row of dots. The sets of an exercise are a sequence you move along, so a
// segmented bar shows position and how much is left in one shape, and it degrades gracefully:
// ten sets shrink the segments instead of overflowing the width the way ten circles at a fixed
// 10pt would. Warmup segments are drawn short and work segments fill the remaining width, so the
// shape of the exercise (two warmups, then four work sets) is readable without a legend.
private struct SetRail: View {
    let sets: [WatchSet]
    let currentIndex: Int

    var body: some View {
        HStack(spacing: 2) {
            ForEach(sets.indices, id: \.self) { k in
                Capsule()
                    .fill(fill(k))
                    .frame(width: sets[k].phase == "warmup" ? 14 : nil)
                    .frame(maxWidth: sets[k].phase == "warmup" ? 14 : .infinity)
                    .frame(height: k == currentIndex ? 5 : 3)
            }
        }
        .frame(height: 5)
    }

    // Spelled out as Colors rather than a ternary over mixed styles: `.tertiary` is a
    // HierarchicalShapeStyle, not a Color, so a chain mixing the two has no single type it can
    // settle on and fails to compile.
    private func fill(_ k: Int) -> Color {
        if k == currentIndex { return WatchPalette.signal }
        return sets[k].done ? .white : WatchPalette.spent
    }
}


// A pushed destination needs an Identifiable, and a bare Int is not one.
private struct ExercisePick: Identifiable, Hashable { let id: Int }

// The day's exercises in order, with how far each one has got. This is what the back button from
// a set card returns to: mid-workout, "how many are left and what is next" should not require
// swiping through every card to count. It also owns finishing, which is why the set card's
// toolbar is now empty except for the back chevron, and why the exercise name finally has the
// top of the screen to itself.
struct SessionListView: View {
    let session: WatchActiveSession
    var onFinished: () -> Void = {}

    @ObservedObject private var store = WatchSessionStore.shared
    @State private var open: ExercisePick?
    @State private var confirmingFinish = false
    @State private var summary: WatchActiveSession?
    @State private var summarySaved = false

    // Progress is read back out of the store rather than from the value this view was built
    // with. SessionView writes every set edit straight through, so returning from a card shows
    // what was just logged instead of the snapshot taken when this list was first pushed.
    private var live: WatchActiveSession { store.activeSession ?? session }

    var body: some View {
        List {
            ForEach(live.entries.indices, id: \.self) { i in
                Button { open = ExercisePick(id: i) } label: { row(i) }
                    .buttonStyle(.plain)
            }
            // Finishing lives at the end of the list, past the exercises, so it is somewhere you
            // arrive deliberately rather than something parked next to the controls you tap
            // dozens of times a session.
            Button("Finish workout") { confirmingFinish = true }
                .font(.footnote.weight(.semibold))
                .foregroundStyle(WatchPalette.signal)
        }
        .navigationTitle("Today")
        .navigationDestination(item: $open) { pick in
            SessionView(session: live, startIndex: pick.id)
        }
        // Finishing cannot be undone from the wrist: it stamps the session ended and hands it to
        // WCSession's outbox. The count in the message is the point of the confirmation, since
        // stopping early with sets still unlogged is the mistake worth catching.
        .confirmationDialog("Finish workout?", isPresented: $confirmingFinish, titleVisibility: .visible) {
            Button("Save workout") { finish() }
            Button("Keep going", role: .cancel) { }
        } message: {
            Text(progressLine)
        }
        .fullScreenCover(item: $summary) { finished in
            SummaryView(session: finished, saved: summarySaved) {
                summary = nil
                onFinished()
            }
        }
    }

    @ViewBuilder
    private func row(_ i: Int) -> some View {
        let entry = live.entries[i]
        let done = entry.sets.filter { $0.done }.count
        HStack(spacing: 6) {
            VStack(alignment: .leading, spacing: 1) {
                Text(entry.label)
                    .font(.caption)
                    .lineLimit(2)
                    .minimumScaleFactor(0.8)
                    .truncationMode(.middle)
                Text("\(done)/\(entry.sets.count) sets")
                    .font(.caption2)
                    .foregroundStyle(WatchPalette.dim)
            }
            Spacer(minLength: 0)
            if !entry.sets.isEmpty, done == entry.sets.count {
                Image(systemName: "checkmark")
                    .font(.caption2)
                    .foregroundStyle(WatchPalette.signal)
            }
        }
    }

    private var progressLine: String {
        let total = live.entries.reduce(0) { $0 + $1.sets.count }
        let done = live.entries.reduce(0) { $0 + $1.sets.filter { $0.done }.count }
        return done == total ? "All \(total) sets logged." : "\(done) of \(total) sets logged."
    }

    private func finish() {
        // finishSession() works off the store's own copy and returns nil if there isn't one. If
        // the store has been cleared out from under this view, fall back to the session it was
        // built with, so Finish saves the workout rather than silently doing nothing.
        if WatchSessionStore.shared.activeSession == nil {
            WatchSessionStore.shared.activeSession = session
        }
        guard let finished = WatchSessionStore.shared.finishSession() else { return }
        summary = finished
        summarySaved = false
        // sendCompletedSession's completion reports whether the workout was handed to WCSession's
        // durable outbox (not actual delivery to the phone, see that function's comment). Only
        // clear the local copy once that handoff succeeds, so a failure (not yet activated,
        // encode error) leaves the session persisted for
        // WatchConnectivitySession.resendIfNeeded to retry instead of losing it.
        WatchConnectivitySession.shared.sendCompletedSession(finished) { success in
            summarySaved = success
            if success { WatchSessionStore.shared.clearFinishedSession() }
        }
    }
}
