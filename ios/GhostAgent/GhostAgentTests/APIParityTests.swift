import XCTest
@testable import GhostAgent

// API contract-parity suite for Xcode Cloud / local `xcodebuild test`.
//
// Mirrors ios/contract/SwiftContractTests (which runs the same assertions on the
// host with `swift test`) but lives in the app's unit-test target so it runs on
// a simulator against the real `APIClient`/`Models`. Fixtures are inlined to keep
// the bundle hermetic; they are byte-for-byte mirrors of ios/contract/fixtures
// and of the backend responses in functions/src (+ errors.ts envelope). No live
// network: a URLProtocol stub captures the outgoing request and returns fixtures.

// MARK: - Header/body capturing transport

private struct CapturedRequest {
    var method: String
    var url: URL
    var authorization: String?
    var contentType: String?
    var body: Data?
}

private final class CapturingURLProtocol: URLProtocol {
    static var responder: ((URLRequest) -> (Int, Data))?
    static var captured: [String: CapturedRequest] = [:]

    static func reset() {
        responder = nil
        captured = [:]
    }

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        if let url = request.url {
            Self.captured[url.path] = CapturedRequest(
                method: request.httpMethod ?? "",
                url: url,
                authorization: request.value(forHTTPHeaderField: "authorization"),
                contentType: request.value(forHTTPHeaderField: "content-type"),
                body: Self.readBody(request)
            )
        }
        let (status, data) = Self.responder?(request) ?? (200, Data("{}".utf8))
        let response = HTTPURLResponse(url: request.url!, statusCode: status, httpVersion: nil,
                                       headerFields: ["Content-Type": "application/json"])!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: data)
        client?.urlProtocolDidFinishLoading(self)
    }

    override func stopLoading() {}

    private static func readBody(_ request: URLRequest) -> Data? {
        if let body = request.httpBody { return body }
        guard let stream = request.httpBodyStream else { return nil }
        stream.open(); defer { stream.close() }
        var data = Data()
        var buffer = [UInt8](repeating: 0, count: 4096)
        while stream.hasBytesAvailable {
            let read = stream.read(&buffer, maxLength: buffer.count)
            if read <= 0 { break }
            data.append(buffer, count: read)
        }
        return data
    }
}

private func parityClient() -> APIClient {
    let config = URLSessionConfiguration.ephemeral
    config.protocolClasses = [CapturingURLProtocol.self]
    return APIClient(baseURL: URL(string: "https://stub.test/api")!, session: URLSession(configuration: config))
}

private func answer(suffix: String, status: Int = 200, _ json: String) {
    CapturingURLProtocol.responder = { req in
        (req.url?.path ?? "").hasSuffix(suffix) ? (status, Data(json.utf8)) : (200, Data("{}".utf8))
    }
}

private func cap(_ suffix: String) -> CapturedRequest? {
    CapturingURLProtocol.captured.first { $0.key.hasSuffix(suffix) }?.value
}

private func bodyKeys(_ suffix: String) -> Set<String> {
    guard let body = cap(suffix)?.body,
          let obj = try? JSONSerialization.jsonObject(with: body) as? [String: Any] else { return [] }
    return Set(obj.keys)
}

// MARK: - Inlined fixtures (mirror ios/contract/fixtures)

private enum Fx {
    static let login = #"{"ok":true,"token":"tok_abc","user":{"username":"Alex","role":"admin"}}"#
    static let authFirebase = #"{"ok":true,"token":"sess_fb","user":{"username":"you@example.com"}}"#
    static let logout = #"{"ok":true}"#
    static let projects = #"""
    {"projects":[
      {"id":"p_1","name":"Demo","description":"d","stack":"swift","repoUrl":"https://x/r",
       "skillIds":["s1"],"summary":null,"ingestStatus":"ready","createdAt":{"_seconds":1,"_nanoseconds":0}},
      {"id":"p_2","name":"Greenfield","description":"d2","stack":null,"repoUrl":null,
       "skillIds":[],"summary":null,"ingestStatus":"none","createdAt":{"_seconds":2,"_nanoseconds":0}}
    ]}
    """#
    static let agentRun = #"""
    {"runId":"run_42","topicId":"t_1","projectId":"p_1","buildRunId":"b_1","summary":"ok",
     "files":[{"path":"README.md","content":"# Hi","language":"markdown","bytes":4},
              {"path":"src/index.ts","content":"export const x = 1;"}],
     "verification":{"status":"passed"},
     "steps":[{"name":"learning","status":"done","detail":"2/2"},{"name":"building","status":"done"}]}
    """#
    static let agentRunStatus = #"""
    {"run":{"id":"run_7","status":"building","task":"t","topicId":"t","projectId":"p",
     "buildRunId":null,"errorCode":null,"summary":null,
     "createdAt":{"_seconds":1718000000,"_nanoseconds":0},
     "steps":[{"name":"learning","status":"done"},{"name":"skilling","status":"done","detail":"3 skills"}]}}
    """#
    static let agentRuns = #"""
    {"runs":[{"id":"r1","status":"ready","task":"A","steps":[{"name":"building","status":"done"}]},
             {"id":"r2","status":"error","task":"B","errorCode":"no_api_key","steps":[]}]}
    """#
    static let errorUnauthorized = #"{"error":"unauthorized","requestId":"req_abc123"}"#
    static let errorRateLimited = #"{"error":"rate_limited","requestId":"req_9"}"#
}

// MARK: - Request building parity

final class APIParityRequestTests: XCTestCase {
    override func setUp() { super.setUp(); CapturingURLProtocol.reset() }

    func testLoginIsPublicPostWithCredentials() async throws {
        answer(suffix: "/login", Fx.login)
        _ = try await parityClient().login(username: "Alex", password: "pw")
        let req = try XCTUnwrap(cap("/login"))
        XCTAssertEqual(req.method, "POST")
        XCTAssertTrue(req.url.path.hasSuffix("/api/login"))
        XCTAssertNil(req.authorization)
        XCTAssertEqual(bodyKeys("/login"), ["username", "password"])
    }

    func testAuthFirebaseIsPublicPostWithIdToken() async throws {
        answer(suffix: "/auth/firebase", Fx.authFirebase)
        _ = try await parityClient().authFirebase(idToken: "x")
        let req = try XCTUnwrap(cap("/auth/firebase"))
        XCTAssertEqual(req.method, "POST")
        XCTAssertNil(req.authorization)
        XCTAssertEqual(bodyKeys("/auth/firebase"), ["idToken"])
    }

    func testLogoutIsAuthedPostWithoutBody() async throws {
        answer(suffix: "/logout", Fx.logout)
        try await parityClient().logout(token: "tok123")
        let req = try XCTUnwrap(cap("/logout"))
        XCTAssertEqual(req.method, "POST")
        XCTAssertEqual(req.authorization, "Bearer tok123")
        XCTAssertNil(req.body)
    }

    func testProtectedGetAttachesBearer() async throws {
        answer(suffix: "/projects", Fx.projects)
        _ = try await parityClient().projects(token: "tokP")
        let req = try XCTUnwrap(cap("/projects"))
        XCTAssertEqual(req.method, "GET")
        XCTAssertEqual(req.authorization, "Bearer tokP")
        XCTAssertNil(req.body)
    }

    func testAgentRunPostsFullBodyWithBearer() async throws {
        answer(suffix: "/agent/run", Fx.agentRun)
        _ = try await parityClient().agentRun(urls: ["https://a.dev"], task: "t", deep: true, lang: "ru", token: "tokA")
        let req = try XCTUnwrap(cap("/agent/run"))
        XCTAssertEqual(req.method, "POST")
        XCTAssertEqual(req.authorization, "Bearer tokA")
        XCTAssertEqual(bodyKeys("/agent/run"), ["urls", "task", "deep", "lang"])
    }

    func testAgentRunStatusEncodesIdInPath() async throws {
        answer(suffix: "/agent/runs/run_7", Fx.agentRunStatus)
        _ = try await parityClient().agentRunStatus(id: "run_7", token: "tokS")
        let req = try XCTUnwrap(cap("/agent/runs/run_7"))
        XCTAssertEqual(req.method, "GET")
        XCTAssertTrue(req.url.path.hasSuffix("/api/agent/runs/run_7"))
    }
}

// MARK: - Response decoding parity

final class APIParityResponseTests: XCTestCase {
    override func setUp() { super.setUp(); CapturingURLProtocol.reset() }

    func testLoginDecodes() async throws {
        answer(suffix: "/login", Fx.login)
        let res = try await parityClient().login(username: "Alex", password: "pw")
        XCTAssertTrue(res.ok)
        XCTAssertEqual(res.user.username, "Alex")
    }

    func testAuthFirebaseDecodes() async throws {
        answer(suffix: "/auth/firebase", Fx.authFirebase)
        let res = try await parityClient().authFirebase(idToken: "x")
        XCTAssertEqual(res.user.username, "you@example.com")
    }

    func testLogoutDecodesEmptyResponse() async throws {
        answer(suffix: "/logout", Fx.logout)
        try await parityClient().logout(token: "tok")
    }

    func testProjectsDecodeIncludingNullableFields() async throws {
        answer(suffix: "/projects", Fx.projects)
        let res = try await parityClient().projects(token: "tok")
        XCTAssertEqual(res.projects.count, 2)
        XCTAssertEqual(res.projects.first?.id, "p_1")
        XCTAssertNil(res.projects.last?.stack)
    }

    func testAgentRunResultDecodes() async throws {
        answer(suffix: "/agent/run", Fx.agentRun)
        let res = try await parityClient().agentRun(urls: ["https://a.dev"], task: "t", deep: false, lang: "en", token: "tok")
        XCTAssertEqual(res.runId, "run_42")
        XCTAssertEqual(res.files.count, 2)
        XCTAssertNil(res.files.last?.language)
        XCTAssertEqual(res.steps.count, 2)
    }

    func testAgentRunStatusEnvelopeDecodes() async throws {
        answer(suffix: "/agent/runs/run_7", Fx.agentRunStatus)
        let run = try await parityClient().agentRunStatus(id: "run_7", token: "tok")
        XCTAssertEqual(run.id, "run_7")
        XCTAssertEqual(run.status, "building")
        XCTAssertNil(run.buildRunId)
    }

    func testAgentRunsListDecodes() async throws {
        answer(suffix: "/agent/runs", Fx.agentRuns)
        let runs = try await parityClient().agentRuns(token: "tok")
        XCTAssertEqual(runs.count, 2)
        XCTAssertEqual(runs.last?.errorCode, "no_api_key")
    }
}

// MARK: - Error envelope parity

final class APIParityErrorTests: XCTestCase {
    override func setUp() { super.setUp(); CapturingURLProtocol.reset() }

    func testUnauthorizedMapsToServerError() async {
        answer(suffix: "/projects", status: 401, Fx.errorUnauthorized)
        do {
            _ = try await parityClient().projects(token: "tok")
            XCTFail("expected APIClientError.server")
        } catch let APIClientError.server(code, requestId, status) {
            XCTAssertEqual(code, "unauthorized")
            XCTAssertEqual(requestId, "req_abc123")
            XCTAssertEqual(status, 401)
        } catch { XCTFail("unexpected error: \(error)") }
    }

    func testRateLimitedMapsToServerError() async {
        answer(suffix: "/agent/run", status: 429, Fx.errorRateLimited)
        do {
            _ = try await parityClient().agentRun(urls: ["https://a.dev"], task: "t", deep: false, lang: "en", token: "tok")
            XCTFail("expected APIClientError.server")
        } catch let APIClientError.server(code, requestId, status) {
            XCTAssertEqual(code, "rate_limited")
            XCTAssertEqual(requestId, "req_9")
            XCTAssertEqual(status, 429)
        } catch { XCTFail("unexpected error: \(error)") }
    }
}

// MARK: - Documented discrepancies (regression guards)

final class APIParityDiscrepancyTests: XCTestCase {
    func testTypedDashboardCountsDropRenamedKeys() throws {
        let json = #"{"counts":{"topics":3,"sources":12,"knowledge_chunks":240,"agent_skills":7,"projects":2,"project_decisions":4,"generated_plans":5,"agent_logs":38}}"#
        let decoded = try JSONDecoder().decode(DashboardResponse.self, from: Data(json.utf8))
        XCTAssertEqual(decoded.counts?.topics, 3)
        XCTAssertNil(decoded.counts?.chunks, "knowledge_chunks dropped by key mismatch")
        XCTAssertNil(decoded.counts?.skills, "agent_skills dropped by key mismatch")
        XCTAssertNil(decoded.counts?.plans, "generated_plans dropped by key mismatch")
    }

    func testTypedDashboardThrowsOnFirestoreTimestampLogs() {
        let json = #"{"counts":{"topics":0,"sources":0,"knowledge_chunks":0,"agent_skills":0,"projects":0,"project_decisions":0,"generated_plans":0,"agent_logs":0},"recentLogs":[{"id":"l1","createdAt":{"_seconds":1,"_nanoseconds":0}}]}"#
        XCTAssertThrowsError(try JSONDecoder().decode(DashboardResponse.self, from: Data(json.utf8)))
    }
}
