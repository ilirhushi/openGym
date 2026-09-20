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

    // Only reached for a plan synced by a phone build that predates WatchEntry.rest. Matches the
    // store's own default so an old plan rests the way it always did.
    private let fallbackRestSeconds = 90

    var body: some View {
        // The name is a sibling of the TabView, not a modifier on it. safeAreaInset(edge: .top)
        // did not reserve any height against a paged TabView on watchOS: it simply drew the name
        // over the top of the page, straight across the weight. A VStack is the only arrangement
        // here that actually gives the two their own space.
        VStack(spacing: 2) {
            Text(currentEntry?.label ?? "")
                .font(.caption2)
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

            // No TabView. A TabView(.page) on watchOS is not confined to its slot in a stack:
            // it takes the whole screen, runs under the navigation bar and past the bottom
            // edge, and anything laid out beside it draws over the top. That one behaviour
            // produced three separate bugs here, the exercise name painted across the weight, a
            // Done button sliced in half by the bottom edge, and a clipped rest countdown. A
            // plain stack plus a drag gesture does the same job with a layout that behaves.
            if let entry = currentEntry, !entry.sets.isEmpty {
                let j = min(setIndex, entry.sets.count - 1)
                pageView(entry: entry, setIndex: j)
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
                doneButton(entry: entry, setIndex: j)
                SetRail(sets: entry.sets, currentIndex: j) { k in
                    // Tapping the rail is the way back to a set you already logged. Marking one
                    // done advances the cursor, and without this there was no route back at all:
                    // the Undo button only ever acts on the set currently showing.
                    setIndex = k
                    resetCrownFocus(entryIndex: exerciseIndex, setIndex: k)
                }
            } else {
                Text("No sets").foregroundStyle(.secondary).frame(maxHeight: .infinity)
            }
        }
        .padding(.horizontal, 4)
        // Swipe left or right for the next or previous exercise, the gesture the pager used to
        // provide. A drag that starts at the very left edge is left alone: that belongs to
        // watchOS's own swipe-to-go-back, and stealing it would trap you in the session.
        .gesture(
            DragGesture(minimumDistance: 24)
                .onEnded { value in
                    guard value.startLocation.x > 28 else { return }
                    if value.translation.width < -24 { step(by: 1) }
                    else if value.translation.width > 24 { step(by: -1) }
                }
        )
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

    private func step(by delta: Int) {
        let next = exerciseIndex + delta
        guard session.entries.indices.contains(next) else { return }
        exerciseIndex = next
    }

    // The value, and whatever single line belongs under it.
    @ViewBuilder
    private func pageView(entry: WatchEntry, setIndex j: Int) -> some View {
        let set = entry.sets[j]
        let runner = restRunner
        VStack(spacing: 2) {
            Spacer(minLength: 0)
                // While a rest runs, the countdown is the thing you are actually watching and
                // the set becomes a reminder of what is coming, so the two swap sizes. It also
                // stops the timer being a detail you have to hunt for on a card whose largest
                // element is a weight you are not lifting yet.
            valueBlock(entryIndex: exerciseIndex, setIndex: j, set: set, compact: runner != nil)
            if let runner {
                RestHero(runner: runner)
            } else if set.phase == "warmup" {
                Text(positionLabel(entryIndex: exerciseIndex, setIndex: j))
                    .font(.caption2)
                    .foregroundStyle(WatchPalette.dim)
            }
            Spacer(minLength: 0)
        }
        .padding(.horizontal, 2)
    }

    private func doneButton(entry: WatchEntry, setIndex j: Int) -> some View {
        let set = entry.sets[j]
        return Button {
            toggleDone(entryIndex: exerciseIndex, setIndex: j)
        } label: {
            // The button names what tapping it does. On a set already logged, "Done" would
            // describe the state while actually performing the opposite, so it becomes "Undo".
            Text(set.done ? "Undo" : "Done")
                .font(.footnote.weight(.semibold))
                .foregroundStyle(set.done ? Color.white : Color.black)
                .frame(maxWidth: .infinity)
                .padding(.vertical, 5)
                // White for the action you take dozens of times a session, so it stays the
                // brightest thing under the numeral; a flat grey once logged, because an undo is
                // a correction and should not compete for the eye.
                .background(Capsule().fill(set.done ? WatchPalette.spent : Color.white))
                // The pill is drawn short but sits inside a taller tappable row. watchOS keeps a
                // 44pt minimum hit target and it is right to: this is tapped mid-set with
                // unsteady hands. Shrinking what is drawn while leaving what is touched alone is
                // how the button stops dominating the card without becoming harder to hit.
                .frame(height: 40)
                .contentShape(Rectangle())
        }
        // Drawn rather than styled with .borderedProminent, whose own vertical padding neither
        // .controlSize(.small) nor an outer .frame(height:) overrides.
        .buttonStyle(.plain)
    }

    @ViewBuilder
    // `compact` is the resting state: the set steps back to a reminder of what is coming while
    // the countdown takes the size.
    private func valueBlock(entryIndex i: Int, setIndex j: Int, set: WatchSet, compact: Bool) -> some View {
        // Same precedence as the file this replaces: sec first, then min, then reps. A set is
        // never more than one of these at once in practice, but if the payload ever did carry
        // more than one, time mode wins because it's the one the rest-timer flow cares about.
        if set.sec != nil {
            numeral("\(Int(set.sec ?? 0))", unit: "sec", focused: crownFocus == .seconds,
                    size: compact ? 20 : 42)
                .focusable()
                .focused($crownFocus, equals: .seconds)
                .digitalCrownRotation(
                    secBinding(entryIndex: i, setIndex: j),
                    from: 0, through: 600, by: Self.secondsStep,
                    sensitivity: .medium, isContinuous: false, isHapticFeedbackEnabled: true)
        } else if set.min != nil {
            // Cardio entries are read-only here too, same as the file this replaces: there's no
            // crown-adjustable field for them, just the logged duration and pace. The duration
            // still gets the full numeral treatment so the three modes read as one screen
            // rather than three, with the pace demoted to the context line it belongs on.
            VStack(spacing: 2) {
                numeral("\(Int(set.min ?? 0))", unit: "min", focused: false, size: compact ? 20 : 42)
                Text("pace \(String(format: "%.1f", set.speed ?? 0))")
                    .font(.footnote)
                    .monospacedDigit()
                    .foregroundStyle(WatchPalette.dim)
            }
        } else {
            // Weight and reps read as one statement, "57.5 kg x 9", because that is how a set is
            // said out loud and how it is written in a log. Stacked, the eye had to make two
            // stops to read one fact. The pair is sized down from the single-value modes to fit
            // the width, which is the trade: a shorter numeral, but one line instead of two.
            HStack(alignment: .firstTextBaseline, spacing: 7) {
                numeral(trimmedWeight(set.w ?? 0), unit: session.unit ?? "kg",
                        focused: crownFocus == .weight, size: compact ? 20 : 32)
                    .focusable()
                    .focused($crownFocus, equals: .weight)
                    .digitalCrownRotation(
                        weightBinding(entryIndex: i, setIndex: j),
                        from: 0, through: 500, by: weightStep,
                        sensitivity: .medium, isContinuous: false, isHapticFeedbackEnabled: true)
                    .onTapGesture { crownFocus = .weight }
                // No "reps" word: the multiplication sign already says what this number counts,
                // and on one line those characters are the width the weight needs.
                Text("\u{00D7}\(set.r ?? 0)")
                    .font(.system(size: compact ? 16 : 24, weight: .semibold))
                    .monospacedDigit()
                    .foregroundStyle(WatchPalette.dim)
                    .lineLimit(1)
                    .focusRule(crownFocus == .reps)
                    .focusable()
                    .focused($crownFocus, equals: .reps)
                    .digitalCrownRotation(
                        repsBinding(entryIndex: i, setIndex: j),
                        from: 0, through: 50, by: Self.repsStep,
                        sensitivity: .medium, isContinuous: false, isHapticFeedbackEnabled: true)
                    .onTapGesture { crownFocus = .reps }
            }
            .frame(maxWidth: .infinity)
        }
    }

    // A whole weight reads as "40", not "40.0". The tenth only means something on a plate-loaded
    // lift when it is actually there (72.5), and carrying it the rest of the time costs a
    // character of the largest text on the screen for no information.
    private func trimmedWeight(_ value: Double) -> String {
        value == value.rounded() ? String(Int(value)) : String(format: "%.1f", value)
    }

    // The number is the only thing worth reading at arm's length mid-set, so it takes the whole
    // visual budget in every mode. Monospaced digits matter more here than anywhere else on the
    // screen: without them the value reflows on every crown detent, and a number that shifts
    // while you turn it is harder to read than one half its size that stays put.
    // `size` drops for the reps mode, where the weight shares its line with the rep count; the
    // single-value modes keep the full height since they have the width to themselves.
    private func numeral(_ value: String, unit: String, focused: Bool, size: CGFloat = 42) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: 3) {
            Text(value)
                .font(.system(size: size, weight: .heavy))
                .monospacedDigit()
            Text(unit)
                .font(.system(size: max(11, size * 0.33), weight: .semibold))
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

    // digitalCrownRotation's `by:` is the detent stride it uses for haptics and nothing more: it
    // does NOT quantise what the binding is handed, which arrives as a continuous value. So the
    // crown was writing 60.13 and the card rendered "60.1", a weight nobody loads and nobody can
    // settle the crown on. Every setter below snaps to its own step, so the value written is
    // always one you could actually put on a bar.
    // Half a kilo, not the 2.5 the Stepper this replaced used and not the 2.5/5 that
    // progression.js's weightIncrement resolves. Those exist to decide next session's load; the
    // crown is doing a different job, correcting a weight you are already standing under because
    // the bar came out at 27.5 rather than 30. A correction wants fine granularity, and the
    // journey from 20 to 100 is one you essentially never make here, since the card opens on the
    // prescribed value.
    //
    // Pounds take 1.0: half a pound is finer than any plate anyone owns, and units.js is
    // explicit that an increment is a load and does not carry across units unchanged.
    private var weightStep: Double { (session.unit ?? "kg") == "lb" ? 1.0 : 0.5 }
    private static let repsStep = 1.0
    private static let secondsStep = 5.0

    private static func snap(_ value: Double, to step: Double) -> Double {
        (value / step).rounded() * step
    }

    private func weightBinding(entryIndex i: Int, setIndex j: Int) -> Binding<Double> {
        Binding(
            get: { session.entries[i].sets[j].w ?? 0 },
            set: { newValue in
                let snapped = Self.snap(newValue, to: weightStep)
                // Only write on a real change. The crown reports continuously, so without this
                // every fractional wobble inside one detent would run the whole persist path.
                guard snapped != session.entries[i].sets[j].w else { return }
                updateSet(entryIndex: i, setIndex: j) { $0.w = snapped }
            })
    }

    private func repsBinding(entryIndex i: Int, setIndex j: Int) -> Binding<Double> {
        Binding(
            get: { Double(session.entries[i].sets[j].r ?? 0) },
            set: { newValue in
                let snapped = Int(Self.snap(newValue, to: Self.repsStep))
                guard snapped != session.entries[i].sets[j].r else { return }
                updateSet(entryIndex: i, setIndex: j) { $0.r = snapped }
            })
    }

    private func secBinding(entryIndex i: Int, setIndex j: Int) -> Binding<Double> {
        Binding(
            get: { session.entries[i].sets[j].sec ?? 0 },
            set: { newValue in
                let snapped = Self.snap(newValue, to: Self.secondsStep)
                guard snapped != session.entries[i].sets[j].sec else { return }
                updateSet(entryIndex: i, setIndex: j) { $0.sec = snapped }
            })
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
        // Warm-up sets earn a rest too, the same as on the phone; they just tend to earn a
        // shorter one. Previously only work sets started a countdown here, which quietly
        // disagreed with warmupRestSecFor.
        let seconds = restSeconds(entryIndex: i, setIndex: j)
        if seconds > 0 { startRest(seconds: seconds) }
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

    // The phone's warmupRestSecFor rule, applied here because only the Watch knows which set was
    // just finished and what is left after it: a ramp set rests the exercise's warmupRest, but
    // the LAST ramp set, the one leading into the first work set, rests the full work rest.
    // Zero comes back when the rest timer is off, and the caller does not start a countdown.
    private func restSeconds(entryIndex i: Int, setIndex j: Int) -> Int {
        let entry = session.entries[i]
        let work = entry.rest ?? fallbackRestSeconds
        guard entry.sets[j].phase == "warmup", let warmup = entry.warmupRest else { return work }
        let next = entry.sets[(j + 1)...].first(where: { !$0.done })
        guard let next, next.phase == "warmup" else { return work }
        return warmup
    }

    private func startRest(seconds: Int) {
        // Starting a new rest while one is already running (e.g. the previous set's rest hadn't
        // finished when this one was marked done) must not leak the old Timer or extended
        // runtime session. cancel(), not skip(): this isn't the old countdown completing, so it
        // must not fire its success haptic or onDone a second time.
        restRunner?.cancel()
        let runner = RestTimerRunner(seconds: seconds)
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
private struct RestHero: View {
    @ObservedObject var runner: RestTimerRunner

    var body: some View {
        Button {
            // skip() (not cancel()) here: tapping is the user choosing to end the rest early,
            // which is the countdown finishing early, not this screen going away. It fires the
            // same success haptic and onDone as running out the clock would.
            runner.skip()
        } label: {
            VStack(spacing: -2) {
                // Named, not just a number. A lone countdown under a set could be elapsed time,
                // a target, anything; the word is what makes it a rest timer.
                Text("rest")
                    .font(.system(size: 12, weight: .semibold))
                Text(formatted)
                    .font(.system(size: 38, weight: .heavy))
                    .monospacedDigit()
            }
            .foregroundStyle(WatchPalette.signal)
            .lineLimit(1)
            .minimumScaleFactor(0.7)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
    }

    // Monospaced because this number changes every second in place. With proportional digits the
    // whole line shifts as the width of the glyphs changes, and a countdown that twitches is the
    // most distracting thing that can be on a watch face.
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
    var onSelect: (Int) -> Void = { _ in }

    var body: some View {
        HStack(spacing: 2) {
            ForEach(sets.indices, id: \.self) { k in
                Button { onSelect(k) } label: {
                    Capsule()
                        .fill(fill(k))
                        .frame(width: sets[k].phase == "warmup" ? 14 : nil)
                        .frame(maxWidth: sets[k].phase == "warmup" ? 14 : .infinity)
                        .frame(height: k == currentIndex ? 5 : 3)
                        // The touch area is far taller than the bar it draws. The rail doubles
                        // as the only way back to a set you have already logged, and a 3pt-high
                        // target is not one. Width is still one segment per set, so this is a
                        // deliberate aim rather than a thumb-sized button, which suits something
                        // you reach for to correct a mistake and not on every set.
                        .padding(.vertical, 8)
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
            }
        }
    }

    // Spelled out as Colors rather than a ternary over mixed styles: `.tertiary` is a
    // HierarchicalShapeStyle, not a Color, so a chain mixing the two has no single type it can
    // settle on and fails to compile.
    private func fill(_ k: Int) -> Color {
        if k == currentIndex { return WatchPalette.signal }
        return sets[k].done ? .white : WatchPalette.spent
    }
}


// The exercise photo on a list row. AsyncImage rather than a loader of our own: URLSession's
// shared cache already keeps the bytes across launches, and a cache we wrote would be a
// dependency too. The picture is an aid to recognition and nothing depends on it, so every
// failure (no media base in this build, no network yet, a 404) lands on the same quiet
// placeholder rather than an error the user has to think about.
private struct ExerciseThumb: View {
    let url: String?
    private let side: CGFloat = 26

    var body: some View {
        Group {
            if let url, let parsed = URL(string: url) {
                AsyncImage(url: parsed) { phase in
                    if case .success(let image) = phase {
                        image.resizable().scaledToFill()
                    } else {
                        placeholder
                    }
                }
            } else {
                placeholder
            }
        }
        .frame(width: side, height: side)
        .clipShape(RoundedRectangle(cornerRadius: 5, style: .continuous))
        // The dataset's art is black line drawing on white, so at full brightness the thumbnail
        // is the loudest thing in a row and outshouts the name, which is what you actually read.
        // Held back a little it identifies the lift without competing for the row.
        .opacity(0.82)
    }

    private var placeholder: some View { Color(white: 0.16) }
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
            // How long you have been training, and since when. A workout's length is the one
            // thing about the session that the exercises themselves cannot tell you, and it is
            // what you check when deciding whether to add a set or wrap up.
            VStack(alignment: .leading, spacing: 0) {
                // A TimelineView rather than a Timer: it only asks for a redraw while this
                // screen is actually on, so an elapsed clock does not keep the app awake in a
                // pocket between sets.
                TimelineView(.periodic(from: .now, by: 1)) { context in
                    Text(elapsedText(at: context.date))
                        .font(.system(size: 26, weight: .semibold))
                        .monospacedDigit()
                }
                Text("started \(startedText)")
                    .font(.caption2)
                    .foregroundStyle(WatchPalette.dim)
            }
            .listRowBackground(Color.clear)

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
        HStack(spacing: 7) {
            ExerciseThumb(url: entry.img)
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

    // WatchActiveSession.start is epoch milliseconds, matching the phone's own timestamps.
    private var startedDate: Date { Date(timeIntervalSince1970: live.start / 1000) }

    private var startedText: String {
        startedDate.formatted(date: .omitted, time: .shortened)
    }

    // m:ss for an ordinary session, h:mm:ss once past the hour. Clamped at zero because a
    // session started on the phone carries the phone's clock, and the two devices do not have
    // to agree to the second.
    private func elapsedText(at now: Date) -> String {
        let seconds = max(0, Int(now.timeIntervalSince(startedDate)))
        let h = seconds / 3600, m = (seconds % 3600) / 60, s = seconds % 60
        return h > 0
            ? String(format: "%d:%02d:%02d", h, m, s)
            : String(format: "%d:%02d", m, s)
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
