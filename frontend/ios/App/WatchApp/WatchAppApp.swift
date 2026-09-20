import SwiftUI

@main
struct OpenGymWatchApp: App {
    // Touching .shared here activates WCSession before any view needs it.
    private let connectivity = WatchConnectivitySession.shared

    var body: some Scene {
        WindowGroup {
            ContentView()
        }
    }
}
