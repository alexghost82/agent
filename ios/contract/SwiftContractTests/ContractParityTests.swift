import XCTest
@testable import GhostAgentContract

// Host-runnable API parity suite. It drives the REAL `APIClient` + `Models`
// (compiled straight from ios/GhostAgent/GhostAgent via Package.swift) so we get
// an executable proof — `swift test`, no Xcode/simulator/network — that the
// client's request building and response decoding match the backend contract
// captured in ../fixtures (mirrors functions/src responses + errors.ts envelope).

// MARK: - Hermetic transport stub

private struct Captured {
    var method: String
    var url: URL
    var authorization: String?
    var contentType: String?
    var accept: String?
    var body: Data?
}

private final class StubURLProtocol: URLProtocol {
    /// path -> (status, body). Matched by URL path suffix.
    static var responder: ((URLRequest) -> (Int, Data))?
    static var captured: [String: Captured] = [:]

    static func reset() {
        responder = nil
        captured = [:]
    }

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        if let url = request.url {
            Self.captured[url.path] = Captured(
                method: request.httpMethod ?? "",
                url: url,
                authorization: request.value(forHTTPHeaderField: "authorization"),
                contentType: request.value(forHTTPHeaderField: "content-type"),
                accept: request.value(forHTTPHeaderField: "accept"),
                body: Self.readBody(request)
            )
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
        var buffer = [UInt8](repeating: 0, count: 4096)
        while stream.hasBytesAvailable {
            let read = stream.read(&buffer, maxLength: buffer.count)
            if read <= 0 { break }
            data.append(buffer, count: read)
        }
        return data
    }
}

// MARK: - Fixtures + client wiring

private enum Fixtures {
    static let dir: URL = URL(fileURLWithPath: #filePath)
        .deletingLastPathComponent()   // SwiftContractTests
        .deletingLastPathComponent()   // contract
        .appendingPathComponent("fixtures")

    static func data(_ name: String) throws -> Data {
        try Data(contentsOf: dir.appendingPathComponent(name))
    }

    static func json(_ name: String) throws -> [String: Any] {
        try JSONSerialization.jsonObject(with: data(name)) as! [String: Any]
    }
}

private func makeClient() -> APIClient {
    let config = URLSessionConfiguration.ephemeral
    config.protocolClasses = [StubURLProtocol.self]
    return APIClient(baseURL: URL(string: "https://stub.test/api")!, session: URLSession(configuration: config))
}

/// Answer one fixture for the path that ends with `suffix`, `{}` otherwise.
private func respond(suffix: String, status: Int = 200, fixture: String) {
    StubURLProtocol.responder = { req in
        if (req.url?.path ?? "").hasSuffix(suffix), let data = try? Fixtures.data(fixture) {
            return (status, data)
        }
        return (200, Data("{}".utf8))
    }
}

private func bodyKeys(forPathSuffix suffix: String) -> Set<String> {
    guard let entry = StubURLProtocol.captured.first(where: { $0.key.hasSuffix(suffix) }),
          let body = entry.value.body,
          let obj = try? JSONSerialization.jsonObject(with: body) as? [String: Any] else { return [] }
    return Set(obj.keys)
}

private func captured(_ suffix: String) -> Captured? {
    StubURLProtocol.captured.first(where: { $0.key.hasSuffix(suffix) })?.value
}

// MARK: - Request building parity

final class RequestParityTests: XCTestCase {
    override func setUp() { super.setUp(); StubURLProtocol.reset() }

    func testLoginBuildsPublicPostWithCredentials() async throws {
        respond(suffix: "/login", fixture: "login.response.json")
        _ = try await makeClient().login(username: "Alex", password: "pw")
        let req = try XCTUnwrap(captured("/login"))
        XCTAssertEqual(req.method, "POST")
        XCTAssertTrue(req.url.path.hasSuffix("/api/login"))
        XCTAssertNil(req.authorization, "/login is public — no Bearer must be attached")
        XCTAssertEqual(req.contentType, "application/json")
        XCTAssertEqual(bodyKeys(forPathSuffix: "/login"), ["username", "password"])
    }

    func testAuthFirebaseBuildsPublicPostWithIdToken() async throws {
        respond(suffix: "/auth/firebase", fixture: "auth-firebase.response.json")
        _ = try await makeClient().authFirebase(idToken: "fake-id-token")
        let req = try XCTUnwrap(captured("/auth/firebase"))
        XCTAssertEqual(req.method, "POST")
        XCTAssertTrue(req.url.path.hasSuffix("/api/auth/firebase"))
        XCTAssertNil(req.authorization, "/auth/firebase is public — no Bearer must be attached")
        XCTAssertEqual(bodyKeys(forPathSuffix: "/auth/firebase"), ["idToken"])
    }

    func testLogoutBuildsAuthedPostWithoutBody() async throws {
        respond(suffix: "/logout", fixture: "logout.response.json")
        try await makeClient().logout(token: "tok123")
        let req = try XCTUnwrap(captured("/logout"))
        XCTAssertEqual(req.method, "POST")
        XCTAssertEqual(req.authorization, "Bearer tok123")
        XCTAssertNil(req.body, "logout sends no JSON body")
        XCTAssertNil(req.contentType, "no body => no content-type")
    }

    func testProtectedGetsAttachBearer() async throws {
        respond(suffix: "/projects", fixture: "projects.response.json")
        _ = try await makeClient().projects(token: "tokP")
        let req = try XCTUnwrap(captured("/projects"))
        XCTAssertEqual(req.method, "GET")
        XCTAssertEqual(req.authorization, "Bearer tokP")
        XCTAssertNil(req.body)
        XCTAssertEqual(req.accept, "application/json")
    }

    func testAgentRunBuildsAuthedPostWithFullBody() async throws {
        respond(suffix: "/agent/run", fixture: "agent-run.response.json")
        _ = try await makeClient().agentRun(urls: ["https://a.dev"], task: "do it", deep: true, lang: "ru", token: "tokA")
        let req = try XCTUnwrap(captured("/agent/run"))
        XCTAssertEqual(req.method, "POST")
        XCTAssertEqual(req.authorization, "Bearer tokA")
        XCTAssertTrue(req.url.path.hasSuffix("/api/agent/run"))
        XCTAssertEqual(bodyKeys(forPathSuffix: "/agent/run"), ["urls", "task", "deep", "lang"])
        // Body values are well-formed JSON of the expected types.
        let obj = try JSONSerialization.jsonObject(with: XCTUnwrap(req.body)) as? [String: Any]
        XCTAssertEqual(obj?["urls"] as? [String], ["https://a.dev"])
        XCTAssertEqual(obj?["task"] as? String, "do it")
        XCTAssertEqual(obj?["deep"] as? Bool, true)
        XCTAssertEqual(obj?["lang"] as? String, "ru")
    }

    func testAgentRunStatusEncodesRunIdInPath() async throws {
        respond(suffix: "/agent/runs/run_7", fixture: "agent-run-status.response.json")
        _ = try await makeClient().agentRunStatus(id: "run_7", token: "tokS")
        let req = try XCTUnwrap(captured("/agent/runs/run_7"))
        XCTAssertEqual(req.method, "GET")
        XCTAssertEqual(req.authorization, "Bearer tokS")
        XCTAssertTrue(req.url.path.hasSuffix("/api/agent/runs/run_7"))
    }
}

// MARK: - Response decoding parity (real models vs recorded fixtures)

final class ResponseParityTests: XCTestCase {
    override func setUp() { super.setUp(); StubURLProtocol.reset() }

    func testLoginResponseDecodesFromFixture() async throws {
        respond(suffix: "/login", fixture: "login.response.json")
        let res = try await makeClient().login(username: "Alex", password: "pw")
        XCTAssertTrue(res.ok)
        XCTAssertFalse(res.token.isEmpty)
        XCTAssertEqual(res.user.username, "Alex")
    }

    func testAuthFirebaseResponseDecodesFromFixture() async throws {
        respond(suffix: "/auth/firebase", fixture: "auth-firebase.response.json")
        let res = try await makeClient().authFirebase(idToken: "x")
        XCTAssertTrue(res.ok)
        XCTAssertEqual(res.user.username, "you@example.com")
    }

    func testLogoutToleratesOkEnvelopeIntoEmptyResponse() async throws {
        respond(suffix: "/logout", fixture: "logout.response.json")
        // Decodes `{ "ok": true }` into EmptyResponse without throwing.
        try await makeClient().logout(token: "tok")
    }

    func testProjectsResponseDecodesFromFixture() async throws {
        respond(suffix: "/projects", fixture: "projects.response.json")
        let res = try await makeClient().projects(token: "tok")
        XCTAssertEqual(res.projects.count, 2)
        XCTAssertEqual(res.projects.first?.id, "p_1")
        XCTAssertEqual(res.projects.first?.name, "Demo")
        XCTAssertEqual(res.projects.first?.stack, "swift")
        // Nullable fields on the greenfield project decode to nil, not a throw.
        XCTAssertNil(res.projects.last?.stack)
        XCTAssertNil(res.projects.last?.repoUrl)
    }

    func testAgentRunResultDecodesFromFixture() async throws {
        respond(suffix: "/agent/run", fixture: "agent-run.response.json")
        let res = try await makeClient().agentRun(urls: ["https://a.dev"], task: "t", deep: false, lang: "en", token: "tok")
        XCTAssertEqual(res.runId, "run_42")
        XCTAssertEqual(res.topicId, "t_1")
        XCTAssertEqual(res.files.count, 2)
        XCTAssertEqual(res.files.first?.path, "README.md")
        XCTAssertNil(res.files.last?.language, "optional file metadata may be absent")
        XCTAssertEqual(res.steps.count, 5)
        XCTAssertEqual(res.steps.first?.name, "learning")
    }

    func testAgentRunStatusEnvelopeDecodesFromFixture() async throws {
        respond(suffix: "/agent/runs/run_7", fixture: "agent-run-status.response.json")
        let run = try await makeClient().agentRunStatus(id: "run_7", token: "tok")
        XCTAssertEqual(run.id, "run_7")
        XCTAssertEqual(run.status, "building")
        XCTAssertNil(run.buildRunId, "Firestore null + timestamp objects must not break decoding")
        XCTAssertEqual(run.steps.count, 2)
    }

    func testAgentRunsListDecodesFromFixture() async throws {
        respond(suffix: "/agent/runs", fixture: "agent-runs.response.json")
        let runs = try await makeClient().agentRuns(token: "tok")
        XCTAssertEqual(runs.count, 2)
        XCTAssertEqual(runs.first?.id, "r1")
        XCTAssertEqual(runs.last?.errorCode, "no_api_key")
    }

    /// The app's supported dashboard path is the raw `JSONValue` tree (AppModel
    /// reads `stats.counts[<key>]`). Verify the backend's real counter keys are
    /// present and decodable that way.
    func testDashboardRawJSONExposesBackendCounterKeys() throws {
        let value = try JSONDecoder().decode(JSONValue.self, from: Fixtures.data("dashboard.response.json"))
        let counts = try XCTUnwrap(value.object("counts"))
        for key in ["topics", "sources", "knowledge_chunks", "agent_skills",
                    "projects", "project_decisions", "generated_plans", "agent_logs"] {
            XCTAssertNotNil(counts.int(key), "raw dashboard counts must expose \(key)")
        }
        XCTAssertEqual(counts.int("knowledge_chunks"), 240)
    }
}

// MARK: - Error envelope parity

final class ErrorParityTests: XCTestCase {
    override func setUp() { super.setUp(); StubURLProtocol.reset() }

    func testUnauthorizedMapsToServerError() async {
        respond(suffix: "/projects", status: 401, fixture: "error.unauthorized.json")
        do {
            _ = try await makeClient().projects(token: "tok")
            XCTFail("expected APIClientError.server")
        } catch let APIClientError.server(code, requestId, status) {
            XCTAssertEqual(code, "unauthorized")
            XCTAssertEqual(requestId, "req_abc123")
            XCTAssertEqual(status, 401)
        } catch {
            XCTFail("unexpected error: \(error)")
        }
    }

    func testRateLimitedMapsToServerErrorWithRequestId() async {
        respond(suffix: "/agent/run", status: 429, fixture: "error.rate_limited.json")
        do {
            _ = try await makeClient().agentRun(urls: ["https://a.dev"], task: "t", deep: false, lang: "en", token: "tok")
            XCTFail("expected APIClientError.server")
        } catch let APIClientError.server(code, requestId, status) {
            XCTAssertEqual(code, "rate_limited")
            XCTAssertEqual(requestId, "req_9")
            XCTAssertEqual(status, 429)
        } catch {
            XCTFail("unexpected error: \(error)")
        }
    }
}

// MARK: - Documented discrepancies (locked in as regression guards)

/// These assert the CURRENT behavior of typed models that DIVERGE from the
/// backend contract. They are intentional guards for the findings written up in
/// docs/notes/ios-api-parity.md — if someone fixes the model the assertion will
/// flip and prompt updating the doc.
final class DiscrepancyGuardTests: XCTestCase {
    func testTypedDashboardCountsDropRenamedBackendKeys() throws {
        // Backend returns knowledge_chunks/agent_skills/project_decisions/
        // generated_plans/agent_logs, but DashboardResponse.Counts is keyed
        // chunks/skills/decisions/plans/logs — so those silently decode to nil.
        let json = #"""
        {"counts":{"topics":3,"sources":12,"knowledge_chunks":240,"agent_skills":7,
        "projects":2,"project_decisions":4,"generated_plans":5,"agent_logs":38}}
        """#
        let decoded = try JSONDecoder().decode(DashboardResponse.self, from: Data(json.utf8))
        XCTAssertEqual(decoded.counts?.topics, 3, "matching key decodes")
        XCTAssertEqual(decoded.counts?.projects, 2, "matching key decodes")
        XCTAssertNil(decoded.counts?.chunks, "knowledge_chunks is dropped (key mismatch)")
        XCTAssertNil(decoded.counts?.skills, "agent_skills is dropped (key mismatch)")
        XCTAssertNil(decoded.counts?.decisions, "project_decisions is dropped (key mismatch)")
        XCTAssertNil(decoded.counts?.plans, "generated_plans is dropped (key mismatch)")
        XCTAssertNil(decoded.counts?.logs, "agent_logs is dropped (key mismatch)")
    }

    func testTypedDashboardThrowsOnFirestoreTimestampLogs() throws {
        // recentLogs[].createdAt is String? but the backend serializes a Firestore
        // Timestamp object ({_seconds,_nanoseconds}); decodeIfPresent throws on the
        // type mismatch, so APIClient.dashboard() cannot decode a real payload.
        let json = #"""
        {"counts":{"topics":0,"sources":0,"knowledge_chunks":0,"agent_skills":0,
        "projects":0,"project_decisions":0,"generated_plans":0,"agent_logs":0},
        "recentLogs":[{"id":"l1","type":"x","message":"m",
        "createdAt":{"_seconds":1718000000,"_nanoseconds":0}}]}
        """#
        XCTAssertThrowsError(try JSONDecoder().decode(DashboardResponse.self, from: Data(json.utf8)))
    }

    func testLoginResponseDropsUserRole() throws {
        // Backend /login returns user.role, but UserDTO only models `username`.
        let json = #"{"ok":true,"token":"t","user":{"username":"Alex","role":"admin"}}"#
        let res = try JSONDecoder().decode(LoginResponse.self, from: Data(json.utf8))
        XCTAssertEqual(res.user.username, "Alex")
        // (No `role` property exists to read — the admin/member distinction is lost.)
    }
}
