import Foundation
import Combine

// Mirrors the phase-1 subset of watch-sync.js's buildWatchPlanPayload output.
struct WatchSet: Codable, Identifiable, Hashable {
    var id = UUID()
    var phase: String        // "warmup" | "work"
    var w: Double?
    var r: Int?
    var sec: Double?
    var min: Double?
    var speed: Double?
    var done: Bool
    enum CodingKeys: String, CodingKey { case phase, w, r, sec, min, speed, done }
}

struct WatchEntry: Codable, Identifiable, Hashable {
    var id: String            // exercise id, matches entry.id on the phone
    var label: String
    var sets: [WatchSet]
    // Opaque to the Watch — never read or shown here, only carried from the incoming plan
    // through to the outgoing completed session unchanged, so watch-import.js's
    // buildCompletedWorkout sees the same rid/noProg a phone-logged session would (which routine
    // entry came from; whether it's excluded from progression) instead of losing them.
    var rid: String?
    var noProg: Bool?
}

struct WatchPlan: Codable {
    var date: String
    var routineIds: [String]
    var name: String?
    var entries: [WatchEntry]
    var activeOnPhone: Bool
    // How the phone labels a weight, "kg" or "lb" (watch-sync.js's buildWatchPlanPayload). The
    // Watch has no other source for it and must not guess: labelling a pound lifter's sets "kg"
    // is worse than showing a bare number.
    //
    // Optional on purpose, and it must stay that way. Both of these decode from UserDefaults,
    // so a plan or an in-progress session persisted by a build that predates this field has no
    // "unit" key. A non-optional String would make that decode throw, load() would swallow it as
    // nil, and the Watch would drop back to "Not synced yet" (or lose a running session) on the
    // first launch after an update.
    var unit: String?
}

// The Watch's own copy of an in-progress or finished session — independent of `plan` once
// started (design doc §5.1: "independent from that point on").
struct WatchActiveSession: Codable, Identifiable, Hashable {
    var id: String { watchSessionId }
    var watchSessionId: String
    var date: String
    var start: Double
    var end: Double?
    var routineIds: [String]
    var name: String?
    var entries: [WatchEntry]
    var unit: String?   // carried from the plan at Start, see WatchPlan.unit
}

final class WatchSessionStore: ObservableObject {
    static let shared = WatchSessionStore()

    @Published var plan: WatchPlan?
    @Published var activeSession: WatchActiveSession?

    private let planKey = "opengym.watch.plan"
    private let sessionKey = "opengym.watch.activeSession"
    private let defaults = UserDefaults.standard

    private init() {
        plan = Self.load(planKey, as: WatchPlan.self, from: defaults)
        activeSession = Self.load(sessionKey, as: WatchActiveSession.self, from: defaults)
    }

    func applyIncomingPlan(_ plan: WatchPlan?) {
        self.plan = plan
        Self.save(plan, key: planKey, to: defaults)
    }

    // The Watch's own local-date reading, matching the phone's todayISO() (local calendar day,
    // not UTC) — never plan.date. plan.date is whatever day it was when the plan last synced,
    // which can be stale by the time Start is actually tapped (the whole point of running
    // offline); using it would file the workout under the wrong day and could manufacture a
    // same-day conflict against an unrelated real workout on that stale date.
    private func todayISO() -> String {
        let c = Calendar.current.dateComponents([.year, .month, .day], from: Date())
        return String(format: "%04d-%02d-%02d", c.year ?? 1970, c.month ?? 1, c.day ?? 1)
    }

    func startSession() {
        guard let plan = plan else { return }
        let session = WatchActiveSession(
            watchSessionId: UUID().uuidString,
            date: todayISO(), start: Date().timeIntervalSince1970 * 1000,
            routineIds: plan.routineIds, name: plan.name, entries: plan.entries,
            // Snapshotted with the rest of the plan at Start: a session already under way keeps
            // the unit it began with, the same way it keeps its entries (design doc §5.1).
            unit: plan.unit
        )
        activeSession = session
        Self.save(session, key: sessionKey, to: defaults)
    }

    // Called after every set edit (SessionView) so a killed Watch app loses nothing (design doc
    // §7: "Kill the Watch app mid-session ... is any completed set lost?").
    func persistActiveSession() {
        Self.save(activeSession, key: sessionKey, to: defaults)
    }

    func finishSession() -> WatchActiveSession? {
        guard var session = activeSession else { return nil }
        session.end = Date().timeIntervalSince1970 * 1000
        activeSession = session
        Self.save(session, key: sessionKey, to: defaults)
        return session
    }

    func clearFinishedSession() {
        activeSession = nil
        defaults.removeObject(forKey: sessionKey)
    }

    private static func load<T: Decodable>(_ key: String, as type: T.Type, from defaults: UserDefaults) -> T? {
        guard let data = defaults.data(forKey: key) else { return nil }
        return try? JSONDecoder().decode(T.self, from: data)
    }
    private static func save<T: Encodable>(_ value: T?, key: String, to defaults: UserDefaults) {
        guard let value = value, let data = try? JSONEncoder().encode(value) else {
            defaults.removeObject(forKey: key)
            return
        }
        defaults.set(data, forKey: key)
    }
}
