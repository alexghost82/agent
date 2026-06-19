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

/// Errors surfaced by the Firebase sign-in path before the GHOST session
/// exchange (`POST /auth/firebase`) is reached.
enum FirebaseSignInError: LocalizedError, Equatable {
    case sdkUnavailable
    case missingToken

    var errorDescription: String? {
        switch self {
        case .sdkUnavailable:
            return "Firebase Auth is unavailable in this build."
        case .missingToken:
            return "Could not obtain a Firebase ID token."
        }
    }
}

/// Seam over Firebase Auth so the sign-in flow can be stubbed in tests without
/// a live Firebase project. Live implementation signs in with email/password
/// and returns the user's ID token, which is then exchanged for a GHOST session.
protocol FirebaseSignIn {
    func idToken(email: String, password: String) async throws -> String
}

struct LiveFirebaseSignIn: FirebaseSignIn {
    func idToken(email: String, password: String) async throws -> String {
        #if canImport(FirebaseAuth)
        let result = try await Auth.auth().signIn(withEmail: email, password: password)
        return try await result.user.getIDToken()
        #else
        throw FirebaseSignInError.sdkUnavailable
        #endif
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
