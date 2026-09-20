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
}

struct WatchPlan: Codable {
    var date: String
    var routineIds: [String]
    var name: String?
    var entries: [WatchEntry]
    var activeOnPhone: Bool
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

    func startSession() {
        guard let plan = plan else { return }
        let session = WatchActiveSession(
            watchSessionId: UUID().uuidString,
            date: plan.date, start: Date().timeIntervalSince1970 * 1000,
            routineIds: plan.routineIds, name: plan.name, entries: plan.entries
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
