import XCTest
@testable import GhostAgent

final class GhostAgentTests: XCTestCase {
    func testErrorEnvelopeDecodesStableBackendShape() throws {
        let data = #"{"error":"unauthorized","requestId":"req_123"}"#.data(using: .utf8)!

        let envelope = try JSONDecoder().decode(ErrorEnvelope.self, from: data)

        XCTAssertEqual(envelope.error, "unauthorized")
        XCTAssertEqual(envelope.requestId, "req_123")
    }

    func testDefaultAPIBaseURLTargetsFunctionsAPI() {
        XCTAssertTrue(AppConfig.apiBaseURL.absoluteString.contains("/us-central1/api"))
    }

    func testFirebaseStatusTitlesAreUserVisible() {
        XCTAssertEqual(FirebaseStatus.missingConfig.title, "Missing GoogleService-Info.plist")
        XCTAssertEqual(FirebaseStatus.sdkUnavailable.title, "Firebase SDK unavailable")
    }
}
