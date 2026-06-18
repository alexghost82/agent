import Foundation

enum AppConfig {
    static var apiBaseURL: URL {
        if let raw = Bundle.main.object(forInfoDictionaryKey: "GHOST_API_BASE_URL") as? String,
           let url = URL(string: raw) {
            return url
        }

        // Same endpoint the web client uses (Firebase Hosting rewrites /api/** to the `api` function).
        return URL(string: "https://agent-9d7c2.web.app/api")!
    }
}
