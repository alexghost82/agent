import Foundation

#if canImport(FirebaseCore)
import FirebaseCore
#endif

#if canImport(FirebaseAuth)
import FirebaseAuth
#endif

enum FirebaseStatus: Equatable {
    case configured(projectID: String?)
    case missingConfig
    case sdkUnavailable

    var title: String {
        switch self {
        case .configured:
            return "Configured"
        case .missingConfig:
            return "Missing GoogleService-Info.plist"
        case .sdkUnavailable:
            return "Firebase SDK unavailable"
        }
    }
}

enum FirebaseBootstrap {
    @MainActor
    static func configure() -> FirebaseStatus {
        #if canImport(FirebaseCore)
        guard Bundle.main.path(forResource: "GoogleService-Info", ofType: "plist") != nil else {
            return .missingConfig
        }

        if FirebaseApp.app() == nil {
            FirebaseApp.configure()
        }

        let projectID = FirebaseApp.app()?.options.projectID

        #if canImport(FirebaseAuth)
        _ = Auth.auth()
        #endif

        return .configured(projectID: projectID)
        #else
        return .sdkUnavailable
        #endif
    }
}
