import XCTest
@testable import GhostAgent

final class GhostAgentTests: XCTestCase {
    func testErrorEnvelopeDecodesStableBackendShape() throws {
        let data = #"{"error":"unauthorized","requestId":"req_123"}"#.data(using: .utf8)!

        let envelope = try JSONDecoder().decode(ErrorEnvelope.self, from: data)

        XCTAssertEqual(envelope.error, "unauthorized")
        XCTAssertEqual(envelope.requestId, "req_123")
    }

    func testDefaultAPIBaseURLEndsWithAPIPath() {
        // The base URL is sourced from Info.plist (GHOST_API_BASE_URL) and must
        // point at the shared `/api` surface the web client also uses.
        XCTAssertTrue(AppConfig.apiBaseURL.absoluteString.hasSuffix("/api"))
    }

    func testFirebaseStatusTitlesAreUserVisible() {
        XCTAssertEqual(FirebaseStatus.missingConfig.title, "Missing GoogleService-Info.plist")
        XCTAssertEqual(FirebaseStatus.sdkUnavailable.title, "Firebase SDK unavailable")
    }
}

// MARK: - Async ingest status mapping (CONTRACT: queued → ingesting → ready)

@MainActor
final class IngestStatusTests: XCTestCase {
    func testInProgressIncludesQueuedAndIngesting() {
        XCTAssertTrue(AppModel.isInProgressIngest("queued"))
        XCTAssertTrue(AppModel.isInProgressIngest("ingesting"))
        XCTAssertFalse(AppModel.isInProgressIngest("ready"))
        XCTAssertFalse(AppModel.isInProgressIngest("error"))
        XCTAssertFalse(AppModel.isInProgressIngest(nil))
    }

    func testIsIngestingReflectsQueuedProjects() {
        let model = AppModel(keychain: InMemorySessionStore(), api: stubAPI(), firebaseAuth: StubFirebaseSignIn(token: "x"))
        model.projects = [.object(["id": .string("p1"), "ingestStatus": .string("queued")])]
        XCTAssertTrue(model.isIngesting)
        model.projects = [.object(["id": .string("p1"), "ingestStatus": .string("ready")])]
        XCTAssertFalse(model.isIngesting)
    }

    func testStatusLabelMappingIncludesQueuedAcrossLanguages() {
        let model = AppModel(keychain: InMemorySessionStore(), api: stubAPI(), firebaseAuth: StubFirebaseSignIn(token: "x"))

        model.lang = .en
        XCTAssertEqual(model.ingestStatusLabel("queued"), "queued…")
        XCTAssertEqual(model.ingestStatusLabel("ingesting"), "reading…")
        XCTAssertEqual(model.ingestStatusLabel("ready"), "understood")
        XCTAssertEqual(model.ingestStatusLabel("error"), "error")
        XCTAssertEqual(model.ingestStatusLabel(nil), "not connected")

        model.lang = .he
        XCTAssertEqual(model.ingestStatusLabel("queued"), "בתור…")
        model.lang = .ru
        XCTAssertEqual(model.ingestStatusLabel("queued"), "в очереди…")
    }
}

// MARK: - Settings diagnostics (SPECS §D req 1 & 6)

@MainActor
final class DiagnosticsTests: XCTestCase {
    private func model() -> AppModel {
        AppModel(keychain: InMemorySessionStore(), api: stubAPI(), firebaseAuth: StubFirebaseSignIn(token: "x"))
    }

    func testApiBaseURLStringReflectsConfiguredClient() {
        // The diagnostics card surfaces the exact base URL the client talks to.
        XCTAssertEqual(model().apiBaseURLString, "https://stub.test/api")
    }

    func testFirebaseStatusLabelIsLocalizedAndSecretFree() {
        let model = model()

        model.firebaseStatus = .sdkUnavailable
        model.lang = .en
        XCTAssertEqual(model.firebaseStatusLabel(), "SDK unavailable")
        model.lang = .ru
        XCTAssertEqual(model.firebaseStatusLabel(), "SDK недоступен")

        model.firebaseStatus = .missingConfig
        model.lang = .en
        XCTAssertEqual(model.firebaseStatusLabel(), "Missing GoogleService-Info.plist")

        model.firebaseStatus = .configured(projectID: "ghost-123")
        model.lang = .he
        XCTAssertEqual(model.firebaseStatusLabel(), "מוגדר")
        XCTAssertEqual(model.firebaseProjectID, "ghost-123")
    }

    func testFirebaseProjectIDNilWhenNotConfigured() {
        let model = model()
        model.firebaseStatus = .sdkUnavailable
        XCTAssertNil(model.firebaseProjectID)
    }
}

// MARK: - Build & memory response decoding (parity with backend shapes)

final class BuildMemoryDecodingTests: XCTestCase {
    func testBuildResponseExposesFilesSummaryAndVerification() throws {
        let json = #"""
        {
          "id": "run_1",
          "status": "ready",
          "fileCount": 2,
          "summary": "Generated a starter app.",
          "files": [
            {"path": "README.md", "content": "# Hello", "language": "markdown", "bytes": 7},
            {"path": "src/index.ts", "content": "export const x = 1;", "language": "ts", "bytes": 19}
          ],
          "verification": {
            "status": "passed",
            "summary": "Verified 2 file(s).",
            "durationMs": 12,
            "checks": [
              {"name": "sandbox_contained", "ok": true},
              {"name": "tsc", "ok": false, "detail": "exit 2"}
            ]
          }
        }
        """#.data(using: .utf8)!

        let value = try JSONDecoder().decode(JSONValue.self, from: json)

        XCTAssertEqual(value.string("status"), "ready")
        XCTAssertEqual(value.int("fileCount"), 2)
        XCTAssertEqual(value.string("summary"), "Generated a starter app.")

        let files = value.array("files")
        XCTAssertEqual(files.count, 2)
        XCTAssertEqual(files.first?.string("path"), "README.md")
        XCTAssertEqual(files.first?.string("content"), "# Hello")

        let verification = value.object("verification")
        XCTAssertEqual(verification?.string("status"), "passed")
        let checks = JSONValue.object(verification ?? [:]).array("checks")
        XCTAssertEqual(checks.count, 2)
        XCTAssertEqual(checks.first?.string("name"), "sandbox_contained")
        XCTAssertEqual(checks.first?.objectValue?["ok"], .bool(true))
        XCTAssertEqual(checks.last?.objectValue?["ok"], .bool(false))
        XCTAssertEqual(checks.last?.string("detail"), "exit 2")
    }

    func testBuildsListResponseDecodesRuns() throws {
        let json = #"{"runs":[{"id":"r1","status":"ready","fileCount":3,"summary":"S1"},{"id":"r2","status":"error","fileCount":0,"summary":"S2"}]}"#.data(using: .utf8)!
        let value = try JSONDecoder().decode(JSONValue.self, from: json)
        let runs = value.array("runs")
        XCTAssertEqual(runs.count, 2)
        XCTAssertEqual(runs.first?.string("id"), "r1")
        XCTAssertEqual(runs.first?.int("fileCount"), 3)
        XCTAssertEqual(runs.last?.string("status"), "error")
    }

    func testBuildOpenResponseDecodesRunAndArtifacts() throws {
        let json = #"{"run":{"id":"r1","projectName":"Demo"},"artifacts":[{"id":"a1","path":"a.ts","content":"x"}]}"#.data(using: .utf8)!
        let value = try JSONDecoder().decode(JSONValue.self, from: json)
        XCTAssertEqual(value.object("run")?.string("id"), "r1")
        let artifacts = value.array("artifacts")
        XCTAssertEqual(artifacts.count, 1)
        XCTAssertEqual(artifacts.first?.string("path"), "a.ts")
    }

    func testMemoryResponseDecodesChunks() throws {
        let json = #"""
        {"chunks":[
          {"id":"c1","title":"Auth","sourceUrl":"https://x/auth","preview":"how to auth","scope":"topic","chunkType":"doc"},
          {"id":"c2","title":null,"sourcePath":"src/a.ts","preview":"code","projectId":"p1"}
        ]}
        """#.data(using: .utf8)!
        let value = try JSONDecoder().decode(JSONValue.self, from: json)
        let chunks = value.array("chunks")
        XCTAssertEqual(chunks.count, 2)
        XCTAssertEqual(chunks.first?.string("title"), "Auth")
        XCTAssertEqual(chunks.first?.string("preview"), "how to auth")
        XCTAssertEqual(chunks.first?.string("scope"), "topic")
        // Null title falls back to sourcePath in the UI row.
        XCTAssertNil(chunks.last?.string("title"))
        XCTAssertEqual(chunks.last?.string("sourcePath"), "src/a.ts")
    }
}

// MARK: - Autonomous agent (Autorun) decoding & polling logic

@MainActor
final class AgentDecodingTests: XCTestCase {
    func testAgentRunResultDecodesFilesSummaryAndSteps() throws {
        let json = #"""
        {
          "runId": "run_42",
          "topicId": "t_1",
          "projectId": "p_1",
          "buildRunId": "b_1",
          "summary": "Built a TS CLI.",
          "files": [
            {"path": "README.md", "content": "# Hi", "language": "markdown", "bytes": 4},
            {"path": "src/index.ts", "content": "export const x = 1;"}
          ],
          "verification": {"status": "passed"},
          "steps": [
            {"name": "learning", "status": "done", "detail": "2/2 urls, 9 chunks"},
            {"name": "building", "status": "done", "detail": "passed"}
          ]
        }
        """#.data(using: .utf8)!

        let result = try JSONDecoder().decode(AgentRunResult.self, from: json)

        XCTAssertEqual(result.runId, "run_42")
        XCTAssertEqual(result.topicId, "t_1")
        XCTAssertEqual(result.projectId, "p_1")
        XCTAssertEqual(result.buildRunId, "b_1")
        XCTAssertEqual(result.summary, "Built a TS CLI.")
        XCTAssertEqual(result.files.count, 2)
        XCTAssertEqual(result.files.first?.path, "README.md")
        XCTAssertEqual(result.files.first?.content, "# Hi")
        XCTAssertEqual(result.files.first?.language, "markdown")
        XCTAssertEqual(result.files.first?.bytes, 4)
        // Optional file metadata may be absent.
        XCTAssertNil(result.files.last?.language)
        XCTAssertNil(result.files.last?.bytes)
        XCTAssertEqual(result.steps.count, 2)
        XCTAssertEqual(result.steps.first?.name, "learning")
        XCTAssertEqual(result.steps.first?.status, "done")
        XCTAssertEqual(result.steps.first?.detail, "2/2 urls, 9 chunks")
        XCTAssertEqual(result.steps.last?.name, "building")
        XCTAssertEqual(result.steps.last?.detail, "passed")
    }

    func testAgentRunStatusEnvelopeDecodes() throws {
        // Shape of `GET /agent/runs/:id` → `{ run: {...} }`.
        let json = #"""
        {"run":{
          "id": "run_7",
          "status": "building",
          "task": "Make an RSS summarizer",
          "topicId": "t",
          "projectId": "p",
          "buildRunId": null,
          "errorCode": null,
          "createdAt": {"_seconds": 1718000000, "_nanoseconds": 0},
          "steps": [
            {"name": "learning", "status": "done"},
            {"name": "skilling", "status": "done", "detail": "3 skills"}
          ]
        }}
        """#.data(using: .utf8)!

        let envelope = try JSONDecoder().decode(AgentRunEnvelope.self, from: json)
        let run = envelope.run

        XCTAssertEqual(run.id, "run_7")
        XCTAssertEqual(run.status, "building")
        XCTAssertEqual(run.task, "Make an RSS summarizer")
        // A Firestore Timestamp object on an unmapped key must not break decoding.
        XCTAssertNil(run.buildRunId)
        XCTAssertNil(run.errorCode)
        XCTAssertEqual(run.steps.count, 2)
        XCTAssertEqual(run.steps.last?.detail, "3 skills")
    }

    func testAgentRunsListEnvelopeDecodes() throws {
        let json = #"""
        {"runs":[
          {"id":"r1","status":"ready","task":"A","steps":[{"name":"building","status":"done"}]},
          {"id":"r2","status":"error","task":"B","errorCode":"no_api_key","steps":[]}
        ]}
        """#.data(using: .utf8)!

        let envelope = try JSONDecoder().decode(AgentRunsEnvelope.self, from: json)

        XCTAssertEqual(envelope.runs.count, 2)
        XCTAssertEqual(envelope.runs.first?.id, "r1")
        XCTAssertEqual(envelope.runs.first?.status, "ready")
        XCTAssertEqual(envelope.runs.last?.status, "error")
        XCTAssertEqual(envelope.runs.last?.errorCode, "no_api_key")
        XCTAssertTrue(envelope.runs.last?.steps.isEmpty ?? false)
    }

    func testTerminalStatusStopsPolling() {
        // Only ready/error are terminal; the in-flight phases keep polling.
        XCTAssertTrue(AppModel.isTerminalAgentStatus("ready"))
        XCTAssertTrue(AppModel.isTerminalAgentStatus("error"))
        XCTAssertFalse(AppModel.isTerminalAgentStatus("learning"))
        XCTAssertFalse(AppModel.isTerminalAgentStatus("skilling"))
        XCTAssertFalse(AppModel.isTerminalAgentStatus("designing"))
        XCTAssertFalse(AppModel.isTerminalAgentStatus("planning"))
        XCTAssertFalse(AppModel.isTerminalAgentStatus("building"))
        XCTAssertFalse(AppModel.isTerminalAgentStatus(nil))
    }
}

// MARK: - Autonomous agent request & error mapping

@MainActor
final class AgentRequestTests: XCTestCase {
    override func setUp() {
        super.setUp()
        StubURLProtocol.reset()
    }

    func testRunAgentSendsUrlsTaskDeepAndLang() async {
        StubURLProtocol.responder = { req in
            if (req.url?.path ?? "").hasSuffix("/agent/run") {
                return (200, Data(#"{"runId":"run_1","files":[],"summary":"ok","steps":[]}"#.utf8))
            }
            return (200, Data(#"{"runs":[]}"#.utf8))
        }
        let model = AppModel(keychain: InMemorySessionStore(), api: stubAPI(), firebaseAuth: StubFirebaseSignIn(token: "x"))
        model.session = Session(token: "tok", username: "u")
        model.lang = .ru

        await model.runAgent(urls: ["  https://a.dev/docs ", "", "https://b.dev"], task: "  build a thing  ", deep: true)

        let entry = StubURLProtocol.requestBodies.first { $0.key.hasSuffix("/agent/run") }
        XCTAssertNotNil(entry, "expected a POST to /agent/run")
        let obj = entry.flatMap { try? JSONSerialization.jsonObject(with: $0.value) as? [String: Any] }
        XCTAssertEqual(obj?["urls"] as? [String], ["https://a.dev/docs", "https://b.dev"])
        XCTAssertEqual(obj?["task"] as? String, "build a thing")
        XCTAssertEqual(obj?["deep"] as? Bool, true)
        XCTAssertEqual(obj?["lang"] as? String, "ru")
        XCTAssertEqual(model.agentResult?.runId, "run_1")
        XCTAssertNil(model.agentErrorCode)
    }

    func testRunAgentMapsErrorEnvelopeToCodeAndRequestId() async {
        StubURLProtocol.responder = { req in
            if (req.url?.path ?? "").hasSuffix("/agent/run") {
                return (429, Data(#"{"error":"rate_limited","requestId":"req_9"}"#.utf8))
            }
            return (200, Data(#"{"runs":[]}"#.utf8))
        }
        let model = AppModel(keychain: InMemorySessionStore(), api: stubAPI(), firebaseAuth: StubFirebaseSignIn(token: "x"))
        model.session = Session(token: "tok", username: "u")

        await model.runAgent(urls: ["https://a.dev"], task: "do the work", deep: false)

        XCTAssertNil(model.agentResult)
        XCTAssertEqual(model.agentErrorCode, "rate_limited")
        XCTAssertEqual(model.agentRequestId, "req_9")
    }

    func testRunAgentSkipsWhenNoUrlsOrShortTask() async {
        StubURLProtocol.responder = { _ in (200, Data("{}".utf8)) }
        let model = AppModel(keychain: InMemorySessionStore(), api: stubAPI(), firebaseAuth: StubFirebaseSignIn(token: "x"))
        model.session = Session(token: "tok", username: "u")

        await model.runAgent(urls: [], task: "valid task", deep: false)
        await model.runAgent(urls: ["https://a.dev"], task: "no", deep: false)

        XCTAssertTrue(StubURLProtocol.requestBodies.isEmpty, "no request should be sent for invalid input")
        XCTAssertNil(model.agentResult)
    }

    func testLoadAgentRunsDecodesList() async {
        StubURLProtocol.responder = { _ in
            (200, Data(#"{"runs":[{"id":"r1","status":"ready","task":"A","steps":[]}]}"#.utf8))
        }
        let model = AppModel(keychain: InMemorySessionStore(), api: stubAPI(), firebaseAuth: StubFirebaseSignIn(token: "x"))
        model.session = Session(token: "tok", username: "u")

        await model.loadAgentRuns()

        XCTAssertEqual(model.agentRuns.count, 1)
        XCTAssertEqual(model.agentRuns.first?.id, "r1")
        XCTAssertEqual(model.agentRuns.first?.status, "ready")
    }
}

// MARK: - Firebase ID-token sign-in path

@MainActor
final class FirebaseSignInTests: XCTestCase {
    override func setUp() {
        super.setUp()
        StubURLProtocol.reset()
    }

    func testSignInWithFirebaseStoresTokenAndLoadsSession() async {
        StubURLProtocol.responder = { req in
            if (req.url?.path ?? "").hasSuffix("/auth/firebase") {
                return (200, Data(#"{"ok":true,"token":"sess_fb_123","user":{"username":"Alex"}}"#.utf8))
            }
            return (200, Data("{}".utf8))
        }

        let store = InMemorySessionStore()
        let model = AppModel(keychain: store, api: stubAPI(), firebaseAuth: StubFirebaseSignIn(token: "unused"))

        await model.signInWithFirebase(idToken: "fake-id-token")

        XCTAssertEqual(store.savedToken, "sess_fb_123")
        XCTAssertEqual(model.session?.token, "sess_fb_123")
        XCTAssertEqual(model.session?.username, "Alex")
        XCTAssertNil(model.errorMessage)

        // The exchanged ID token was sent in the request body.
        let body = StubURLProtocol.requestBodies.first { $0.key.hasSuffix("/auth/firebase") }?.value
        let decoded = body.flatMap { try? JSONDecoder().decode([String: String].self, from: $0) }
        XCTAssertEqual(decoded?["idToken"], "fake-id-token")
    }

    func testSignInWithFirebaseEmailExchangesIdTokenFromSDK() async {
        StubURLProtocol.responder = { req in
            if (req.url?.path ?? "").hasSuffix("/auth/firebase") {
                return (200, Data(#"{"ok":true,"token":"sess_email","user":{"username":"you@example.com"}}"#.utf8))
            }
            return (200, Data("{}".utf8))
        }

        let store = InMemorySessionStore()
        let model = AppModel(keychain: store, api: stubAPI(), firebaseAuth: StubFirebaseSignIn(token: "sdk-id-token"))

        await model.signInWithFirebaseEmail(email: "you@example.com", password: "pw123456")

        XCTAssertEqual(store.savedToken, "sess_email")
        XCTAssertEqual(model.session?.username, "you@example.com")

        let body = StubURLProtocol.requestBodies.first { $0.key.hasSuffix("/auth/firebase") }?.value
        let decoded = body.flatMap { try? JSONDecoder().decode([String: String].self, from: $0) }
        XCTAssertEqual(decoded?["idToken"], "sdk-id-token")
    }

    func testFirebaseSignInFailureSurfacesErrorAndKeepsSessionNil() async {
        StubURLProtocol.responder = { _ in
            (401, Data(#"{"error":"unauthorized"}"#.utf8))
        }
        let store = InMemorySessionStore()
        let model = AppModel(keychain: store, api: stubAPI(), firebaseAuth: StubFirebaseSignIn(token: "x"))

        await model.signInWithFirebase(idToken: "bad")

        XCTAssertNil(model.session)
        XCTAssertNil(store.savedToken)
        XCTAssertNotNil(model.errorMessage)
    }
}

// MARK: - Build request body construction

@MainActor
final class BuildRequestTests: XCTestCase {
    override func setUp() {
        super.setUp()
        StubURLProtocol.reset()
    }

    func testBuildSendsNullPlanAndTrimmedInstructions() async {
        StubURLProtocol.responder = { req in
            if (req.url?.path ?? "").hasSuffix("/build") {
                return (200, Data(#"{"id":"r1","status":"ready","files":[],"summary":"ok"}"#.utf8))
            }
            return (200, Data("{}".utf8))
        }
        let model = AppModel(keychain: InMemorySessionStore(), api: stubAPI(), firebaseAuth: StubFirebaseSignIn(token: "x"))
        model.session = Session(token: "tok", username: "u")
        model.selectedProject = "proj1"

        await model.build(planId: "", instructions: "   ship it   ")

        let entry = StubURLProtocol.requestBodies.first { $0.key.hasSuffix("/projects/proj1/build") }
        XCTAssertNotNil(entry, "expected a POST to /projects/proj1/build")
        let obj = entry.flatMap { try? JSONSerialization.jsonObject(with: $0.value) as? [String: Any] }
        XCTAssertNotNil(obj)
        // Empty planId becomes JSON null; instructions are trimmed; lang propagated.
        XCTAssertTrue(obj?["planId"] is NSNull)
        XCTAssertEqual(obj?["instructions"] as? String, "ship it")
        XCTAssertEqual(obj?["lang"] as? String, "en")
    }
}

// MARK: - Test doubles (ios-only seams)

private func stubAPI() -> APIClient {
    let config = URLSessionConfiguration.ephemeral
    config.protocolClasses = [StubURLProtocol.self]
    let session = URLSession(configuration: config)
    return APIClient(baseURL: URL(string: "https://stub.test/api")!, session: session)
}

final class InMemorySessionStore: SessionStoring {
    var savedToken: String?
    var storedSession: Session?

    func loadSession(username: String) -> Session? { storedSession }
    func save(token: String) throws { savedToken = token }
    func clear() { savedToken = nil; storedSession = nil }
}

struct StubFirebaseSignIn: FirebaseSignIn {
    let token: String
    func idToken(email: String, password: String) async throws -> String { token }
}

/// Hermetic URLProtocol that answers requests from a closure and records bodies
/// (read from `httpBodyStream`, since URLSession moves JSON bodies there).
final class StubURLProtocol: URLProtocol {
    static var responder: ((URLRequest) -> (Int, Data))?
    static var requestBodies: [String: Data] = [:]

    static func reset() {
        responder = nil
        requestBodies = [:]
    }

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        if let path = request.url?.path, let body = Self.readBody(request) {
            Self.requestBodies[path] = body
        }
        let (status, data) = Self.responder?(request) ?? (200, Data("{}".utf8))
        let response = HTTPURLResponse(
            url: request.url!,
            statusCode: status,
            httpVersion: nil,
            headerFields: ["Content-Type": "application/json"]
        )!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: data)
        client?.urlProtocolDidFinishLoading(self)
    }

    override func stopLoading() {}

    private static func readBody(_ request: URLRequest) -> Data? {
        if let body = request.httpBody { return body }
        guard let stream = request.httpBodyStream else { return nil }
        stream.open()
        defer { stream.close() }
        var data = Data()
        let bufferSize = 4096
        var buffer = [UInt8](repeating: 0, count: bufferSize)
        while stream.hasBytesAvailable {
            let read = stream.read(&buffer, maxLength: bufferSize)
            if read <= 0 { break }
            data.append(buffer, count: read)
        }
        return data
    }
}
