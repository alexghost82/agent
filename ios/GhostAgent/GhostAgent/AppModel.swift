import Foundation
import Observation

@MainActor
@Observable
final class AppModel {
    var firebaseStatus: FirebaseStatus = .sdkUnavailable
    var lang: Lang = .en
    var theme: AppTheme = .dark
    var active: StepKey = .overview
    var session: Session?
    var stats: JSONObject?
    var topics: [JSONValue] = []
    var sources: [JSONValue] = []
    var skills: [JSONValue] = []
    var projects: [JSONValue] = []
    var plans: [JSONValue] = []
    var builds: [JSONValue] = []
    var memoryChunks: [JSONValue] = []
    var output: [String: JSONValue] = [:]
    var loading: Set<String> = []
    var selectedTopic = ""
    var selectedProject = ""
    var selectedSkillIds: [String] = []
    var providerStatus: ProviderStatus?
    var isLoading = false
    var errorMessage: String?

    private let keychain: SessionStoring
    private let api: APIClient
    private let firebaseAuth: FirebaseSignIn
    @ObservationIgnored private var ingestPollTask: Task<Void, Never>?

    /// Localized strings for the current language (EN/HE/RU), in parity with the web i18n.
    var t: Strings { Strings.resolve(lang) }

    /// True while any connected project is still queued for or actively being
    /// read/indexed by the agent (ingest is asynchronous: queued → ingesting → ready).
    var isIngesting: Bool {
        projects.contains { Self.isInProgressIngest($0.string("ingestStatus")) }
    }

    /// Whether an `ingestStatus` value represents work still in flight.
    static func isInProgressIngest(_ status: String?) -> Bool {
        status == "queued" || status == "ingesting"
    }

    /// The API base URL the client is talking to, surfaced read-only in the
    /// Settings diagnostics card (SPECS §D req 6).
    var apiBaseURLString: String { api.baseURL.absoluteString }

    /// Firebase project id when the SDK is configured (diagnostics card).
    var firebaseProjectID: String? {
        if case let .configured(projectID) = firebaseStatus { return projectID }
        return nil
    }

    /// Localized one-line label for the current Firebase configuration status,
    /// shown in the Settings diagnostics view (SPECS §D req 1).
    func firebaseStatusLabel() -> String {
        switch firebaseStatus {
        case .configured: return t("diagFbConfigured")
        case .missingConfig: return t("diagFbMissingConfig")
        case .sdkUnavailable: return t("diagFbUnavailable")
        }
    }

    /// Localized label for an async ingest status (queued → ingesting → ready).
    func ingestStatusLabel(_ status: String?) -> String {
        switch status ?? "none" {
        case "ready": return t("ingest_ready")
        case "ingesting": return t("ingest_ingesting")
        case "queued": return t("ingest_queued")
        case "error": return t("ingest_error")
        default: return t("ingest_none")
        }
    }

    init(
        keychain: SessionStoring = KeychainStore(),
        api: APIClient = APIClient(baseURL: AppConfig.apiBaseURL),
        firebaseAuth: FirebaseSignIn = LiveFirebaseSignIn()
    ) {
        self.keychain = keychain
        self.api = api
        self.firebaseAuth = firebaseAuth
    }

    func boot() async {
        firebaseStatus = FirebaseBootstrap.configure()

        session = keychain.loadSession(username: "Saved user")

        if session != nil {
            await refreshAll()
        }
    }

    func login(username: String, password: String) async {
        await runLoading {
            let response = try await api.login(username: username, password: password)
            try keychain.save(token: response.token)
            session = Session(token: response.token, username: response.user.username)
            await refreshAll()
        }
    }

    /// Core Firebase transport: exchange an already-obtained Firebase ID token
    /// for a GHOST session bearer via `POST /auth/firebase`, then persist the
    /// session token in the Keychain exactly like the password flow.
    func signInWithFirebase(idToken: String) async {
        await runLoading {
            let response = try await api.authFirebase(idToken: idToken)
            try keychain.save(token: response.token)
            session = Session(token: response.token, username: response.user.username)
            await refreshAll()
        }
    }

    /// Convenience sign-in: obtain a Firebase ID token from email/password via
    /// the Firebase SDK, then run the standard `/auth/firebase` exchange.
    func signInWithFirebaseEmail(email: String, password: String) async {
        await runLoading {
            let idToken = try await firebaseAuth.idToken(email: email, password: password)
            let response = try await api.authFirebase(idToken: idToken)
            try keychain.save(token: response.token)
            session = Session(token: response.token, username: response.user.username)
            await refreshAll()
        }
    }

    func logout() async {
        guard let token = session?.token else {
            clearLocalSession()
            return
        }

        await runLoading {
            try? await api.logout(token: token)
            clearLocalSession()
        }
    }

    private func clearLocalSession() {
        stopIngestPolling()
        keychain.clear()
        session = nil
        active = .overview
        stats = nil
        topics = []
        sources = []
        skills = []
        projects = []
        plans = []
        builds = []
        memoryChunks = []
        output = [:]
        loading = []
        selectedTopic = ""
        selectedProject = ""
        selectedSkillIds = []
        providerStatus = nil
    }

    private func runLoading(_ operation: () async throws -> Void) async {
        isLoading = true
        errorMessage = nil
        defer { isLoading = false }

        do {
            try await operation()
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    func setActive(_ step: StepKey) {
        active = step
        Task { await loadForActiveStep() }
    }

    func refreshAll() async {
        await withTaskGroup(of: Void.self) { group in
            group.addTask { await self.loadDashboard() }
            group.addTask { await self.loadTopics() }
            group.addTask { await self.loadSkills() }
            group.addTask { await self.loadProjects() }
        }
        await loadForActiveStep()
    }

    func loadForActiveStep() async {
        switch active {
        case .overview:
            await loadDashboard()
        case .sources:
            await loadTopics()
            if !selectedTopic.isEmpty { await loadSources(topicId: selectedTopic) }
        case .skills:
            await loadTopics()
            await loadSkills()
        case .projects:
            await loadProjects()
            await loadSkills()
        case .ask:
            break
        case .design, .plan:
            await loadProjects()
        case .build:
            await loadProjects()
            if !selectedProject.isEmpty {
                await loadPlans(projectId: selectedProject)
                await loadBuilds(projectId: selectedProject)
            }
        case .memory:
            await loadTopics()
            await loadMemory()
        case .settings:
            await loadKeys()
        }
    }

    func loadDashboard() async {
        do {
            stats = try await authed { token in try await api.getJSON(path: "/dashboard", token: token) }.objectValue
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    func loadTopics() async {
        do {
            topics = try await authed { token in try await api.getJSON(path: "/topics", token: token) }.array("topics")
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    func loadSources(topicId: String? = nil) async {
        let topicId = topicId ?? selectedTopic
        guard !topicId.isEmpty else {
            sources = []
            return
        }
        do {
            sources = try await authed { token in
                try await api.getJSON(path: "/sources?topicId=\(Self.escape(topicId))", token: token)
            }.array("sources")
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    func loadSkills() async {
        do {
            skills = try await authed { token in try await api.getJSON(path: "/skills", token: token) }.array("skills")
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    func loadProjects() async {
        do {
            projects = try await authed { token in try await api.getJSON(path: "/projects", token: token) }.array("projects")
            syncSelectedProjectSkills()
            startIngestPollingIfNeeded()
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    /// Mirrors the web client: while a repo is being ingested, poll projects and
    /// the dashboard every 2.5s so progress updates live. Stops automatically
    /// once nothing is ingesting.
    private func startIngestPollingIfNeeded() {
        guard session != nil, isIngesting else {
            stopIngestPolling()
            return
        }
        guard ingestPollTask == nil else { return }
        ingestPollTask = Task { [weak self] in
            while !Task.isCancelled {
                try? await Task.sleep(nanoseconds: 2_500_000_000)
                guard let self else { return }
                if Task.isCancelled || !self.isIngesting {
                    self.stopIngestPolling()
                    return
                }
                await self.loadProjects()
                await self.loadDashboard()
            }
        }
    }

    private func stopIngestPolling() {
        ingestPollTask?.cancel()
        ingestPollTask = nil
    }

    func loadPlans(projectId: String? = nil) async {
        let projectId = projectId ?? selectedProject
        guard !projectId.isEmpty else {
            plans = []
            return
        }
        do {
            plans = try await authed { token in
                try await api.getJSON(path: "/generated-plans?projectId=\(Self.escape(projectId))", token: token)
            }.array("plans")
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    func selectTopic(_ id: String) {
        selectedTopic = id
        Task { await loadSources(topicId: id) }
    }

    func selectProject(_ id: String) {
        selectedProject = id
        syncSelectedProjectSkills()
        Task {
            await loadPlans(projectId: id)
            await loadBuilds(projectId: id)
        }
    }

    func createTopic(name: String, description: String) async {
        guard name.trimmingCharacters(in: .whitespacesAndNewlines).count >= 2 else { return }
        await run("topicCreate") {
            try await authed { token in
                try await api.postJSON(path: "/topics", body: [
                    "name": .string(name.trimmingCharacters(in: .whitespacesAndNewlines)),
                    "description": description.isEmpty ? .null : .string(description)
                ], token: token)
            }
        }
        await loadTopics()
        if let id = output["topicCreate"]?.string("id") { selectTopic(id) }
        await loadDashboard()
    }

    func addSource(url: String, tags: String) async {
        guard !selectedTopic.isEmpty, !url.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return }
        let tagValues = tags.split(separator: ",").map { JSONValue.string($0.trimmingCharacters(in: .whitespacesAndNewlines)) }.filter { $0.stringValue?.isEmpty == false }
        await run("sources") {
            try await authed { token in
                try await api.postJSON(path: "/learn", body: [
                    "topicId": .string(selectedTopic),
                    "url": .string(url.trimmingCharacters(in: .whitespacesAndNewlines)),
                    "tags": tagValues.isEmpty ? .null : .array(tagValues)
                ], token: token)
            }
        }
        await loadSources()
        await loadDashboard()
    }

    /// Batch add: learn several resource URLs in one action by calling `/learn`
    /// per URL sequentially (to respect rate limits). A failing URL does not
    /// abort the rest; per-URL results are aggregated into a batch summary.
    func addSources(urls: [String], tags: String) async {
        guard !selectedTopic.isEmpty else { return }
        let cleanUrls = urls
            .map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
            .filter { !$0.isEmpty }
        guard !cleanUrls.isEmpty else { return }
        let tagValues = tags
            .split(separator: ",")
            .map { JSONValue.string($0.trimmingCharacters(in: .whitespacesAndNewlines)) }
            .filter { $0.stringValue?.isEmpty == false }

        loading.insert("sources")
        output["sources"] = nil
        defer { loading.remove("sources") }

        var results: [JSONValue] = []
        var saved = 0
        var failed = 0
        for url in cleanUrls {
            do {
                let response = try await authed { token in
                    try await api.postJSON(path: "/learn", body: [
                        "topicId": .string(selectedTopic),
                        "url": .string(url),
                        "tags": tagValues.isEmpty ? .null : .array(tagValues)
                    ], token: token)
                }
                saved += 1
                var entry: JSONObject = ["url": .string(url), "ok": .bool(true)]
                if let object = response.objectValue {
                    for (key, value) in object { entry[key] = value }
                }
                results.append(.object(entry))
            } catch let error as APIClientError {
                failed += 1
                let code: String
                if case let .server(serverCode, _, _) = error { code = serverCode } else { code = "internal" }
                results.append(.object(["url": .string(url), "ok": .bool(false), "error": .string(code)]))
            } catch {
                failed += 1
                results.append(.object(["url": .string(url), "ok": .bool(false), "error": .string(error.localizedDescription)]))
            }
        }
        output["sources"] = .object([
            "status": .string("batch"),
            "total": .number(Double(results.count)),
            "saved": .number(Double(saved)),
            "failed": .number(Double(failed)),
            "results": .array(results)
        ])
        errorMessage = nil
        await loadSources()
        await loadDashboard()
    }

    func reingestSource(_ source: JSONValue) async {
        guard let id = source.string("id") else { return }
        await run("reingest-\(id)") {
            try await authed { token in
                try await api.postJSON(path: "/sources/\(id)/reingest", body: [:], token: token)
            }
        }
        await loadSources()
        await loadDashboard()
    }

    func deleteSource(_ id: String) async {
        await run("del-source-\(id)") {
            try await authed { token in try await api.deleteJSON(path: "/sources/\(id)", token: token) }
        }
        await loadSources()
        await loadDashboard()
    }

    func extractSkills() async {
        guard !selectedTopic.isEmpty else { return }
        await run("skills") {
            try await authed { token in
                try await api.postJSON(path: "/extract-skills", body: ["topicId": .string(selectedTopic)], token: token)
            }
        }
        await loadSkills()
        await loadDashboard()
    }

    func updateSkill(id: String, name: String, description: String, example: String) async {
        await run("edit-skill-\(id)") {
            try await authed { token in
                try await api.patchJSON(path: "/skills/\(id)", body: [
                    "skillName": .string(name),
                    "description": .string(description),
                    "example": example.isEmpty ? .null : .string(example)
                ], token: token)
            }
        }
        await loadSkills()
    }

    func deleteSkill(_ id: String) async {
        await run("del-skill-\(id)") {
            try await authed { token in try await api.deleteJSON(path: "/skills/\(id)", token: token) }
        }
        await loadSkills()
        await loadDashboard()
    }

    func createProject(name: String, description: String, stack: String, repoUrl: String) async {
        await run("projectCreate") {
            try await authed { token in
                try await api.postJSON(path: "/projects", body: [
                    "name": .string(name),
                    "description": .string(description),
                    "stack": stack.isEmpty ? .null : .string(stack),
                    "repoUrl": repoUrl.isEmpty ? .null : .string(repoUrl)
                ], token: token)
            }
        }
        await loadProjects()
        await loadDashboard()
    }

    func updateProject(id: String, name: String, description: String, stack: String, repoUrl: String) async {
        await run("edit-project-\(id)") {
            try await authed { token in
                try await api.patchJSON(path: "/projects/\(id)", body: [
                    "name": .string(name),
                    "description": .string(description),
                    "stack": stack.isEmpty ? .null : .string(stack),
                    "repoUrl": repoUrl.isEmpty ? .null : .string(repoUrl)
                ], token: token)
            }
        }
        await loadProjects()
    }

    func deleteProject(_ id: String) async {
        await run("del-project-\(id)") {
            try await authed { token in try await api.deleteJSON(path: "/projects/\(id)", token: token) }
        }
        if selectedProject == id { selectedProject = "" }
        await loadProjects()
        await loadDashboard()
    }

    func saveGithubToken(_ tokenValue: String) async {
        await run("githubToken") {
            try await authed { token in
                try await api.postJSON(path: "/github-token", body: ["token": .string(tokenValue)], token: token)
            }
        }
    }

    func connectGithub(projectId: String, repoUrl: String) async {
        await run("gh-\(projectId)") {
            try await authed { token in
                try await api.postJSON(path: "/projects/\(projectId)/connect-github", body: ["repoUrl": .string(repoUrl)], token: token)
            }
        }
        await loadProjects()
        await loadDashboard()
    }

    func toggleSkill(_ id: String) {
        if selectedSkillIds.contains(id) {
            selectedSkillIds.removeAll { $0 == id }
        } else {
            selectedSkillIds.append(id)
        }
    }

    func saveProjectSkills() async {
        guard !selectedProject.isEmpty else { return }
        await run("saveSkills") {
            try await authed { token in
                try await api.patchJSON(path: "/projects/\(selectedProject)", body: [
                    "skillIds": .array(selectedSkillIds.map(JSONValue.string))
                ], token: token)
            }
        }
        await loadProjects()
    }

    func ask(_ question: String) async {
        guard question.trimmingCharacters(in: .whitespacesAndNewlines).count >= 3 else { return }
        await run("ask") {
            try await authed { token in
                try await api.postJSON(path: "/ask", body: [
                    "question": .string(question),
                    "lang": .string(lang.rawValue)
                ], token: token)
            }
        }
    }

    func design(section: String) async {
        guard !selectedProject.isEmpty else { return }
        await run("design") {
            try await authed { token in
                try await api.postJSON(path: "/design", body: [
                    "projectId": .string(selectedProject),
                    "section": section.isEmpty ? .null : .string(section),
                    "lang": .string(lang.rawValue)
                ], token: token)
            }
        }
    }

    func generatePlan(instructions: String) async {
        guard !selectedProject.isEmpty else { return }
        await run("plan") {
            try await authed { token in
                try await api.postJSON(path: "/generate-plan", body: [
                    "projectId": .string(selectedProject),
                    "instructions": instructions.isEmpty ? .null : .string(instructions),
                    "lang": .string(lang.rawValue)
                ], token: token)
            }
        }
        await loadPlans()
        await loadDashboard()
    }

    // MARK: - Build parity (CONTRACT v2.2 / v3.1)

    /// Load prior build runs for a project via `GET /builds?projectId=...`.
    func loadBuilds(projectId: String? = nil) async {
        let projectId = projectId ?? selectedProject
        guard !projectId.isEmpty else {
            builds = []
            return
        }
        do {
            builds = try await authed { token in
                try await api.getJSON(path: "/builds?projectId=\(Self.escape(projectId))", token: token)
            }.array("runs")
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    /// Trigger a real-development build via `POST /projects/{id}/build`. The
    /// response holds the generated files, summary and sandbox verification.
    func build(planId: String, instructions: String) async {
        guard !selectedProject.isEmpty else { return }
        await run("build") {
            try await authed { token in
                try await api.postJSON(path: "/projects/\(selectedProject)/build", body: [
                    "planId": planId.isEmpty ? .null : .string(planId),
                    "instructions": instructions.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
                        ? .null
                        : .string(instructions.trimmingCharacters(in: .whitespacesAndNewlines)),
                    "lang": .string(lang.rawValue)
                ], token: token)
            }
        }
        await loadBuilds()
        await loadDashboard()
    }

    /// Open a single owned build run together with its artifacts via
    /// `GET /builds/{id}`. Stored under `buildOpen` so the UI can render files.
    func openBuild(id: String) async {
        await run("buildOpen") {
            try await authed { token in
                try await api.getJSON(path: "/builds/\(Self.escape(id))", token: token)
            }
        }
    }

    // MARK: - Memory transparency (CONTRACT v3.6)

    /// List the user's stored knowledge chunks via `GET /memory`, optionally
    /// narrowed to a topic and/or project. The raw embedding is never returned.
    func loadMemory(topicId: String? = nil, projectId: String? = nil) async {
        var query: [String] = []
        let topic = topicId ?? (selectedTopic.isEmpty ? nil : selectedTopic)
        if let topic, !topic.isEmpty { query.append("topicId=\(Self.escape(topic))") }
        if let projectId, !projectId.isEmpty { query.append("projectId=\(Self.escape(projectId))") }
        let path = query.isEmpty ? "/memory" : "/memory?\(query.joined(separator: "&"))"
        do {
            memoryChunks = try await authed { token in
                try await api.getJSON(path: path, token: token)
            }.array("chunks")
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    /// Delete a single owned knowledge chunk via `DELETE /memory/{id}`.
    func deleteMemoryChunk(_ id: String) async {
        await run("del-memory-\(id)") {
            try await authed { token in try await api.deleteJSON(path: "/memory/\(Self.escape(id))", token: token) }
        }
        await loadMemory()
        await loadDashboard()
    }

    func loadKeys() async {
        do {
            providerStatus = try await authed { token in
                try await api.getJSON(path: "/me/api-keys", token: token)
            }.decode(ProviderStatus.self)
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    func setProvider(_ provider: String) async {
        await run("provider-\(provider)") {
            try await authed { token in
                try await api.putJSON(path: "/me/api-keys", body: ["provider": .string(provider)], token: token)
            }
        }
        await loadKeys()
    }

    func saveAPIKey(provider: String, value: String?) async {
        await run("save-key-\(provider)") {
            try await authed { token in
                try await api.putJSON(path: "/me/api-keys", body: [provider: value.map(JSONValue.string) ?? .null], token: token)
            }
        }
        await loadKeys()
    }

    func testAPIKey(provider: String) async {
        await run("test-key-\(provider)") {
            try await authed { token in
                try await api.postJSON(path: "/me/api-keys/test", body: ["provider": .string(provider)], token: token)
            }
        }
    }

    private func run(_ key: String, action: () async throws -> JSONValue) async {
        loading.insert(key)
        output[key] = nil
        defer { loading.remove(key) }
        do {
            output[key] = try await action()
            errorMessage = nil
        } catch let error as APIClientError {
            switch error {
            case let .server(code, requestId, _):
                var body: JSONObject = ["error": .string(code)]
                if let requestId { body["requestId"] = .string(requestId) }
                output[key] = .object(body)
                errorMessage = code
            case .invalidResponse:
                output[key] = .object(["error": .string("internal")])
                errorMessage = error.localizedDescription
            }
        } catch {
            output[key] = .object(["error": .string(error.localizedDescription)])
            errorMessage = error.localizedDescription
        }
    }

    private func authed<T>(_ action: (String) async throws -> T) async throws -> T {
        guard let token = session?.token else {
            throw APIClientError.server(code: "unauthorized", requestId: nil, status: 401)
        }
        return try await action(token)
    }

    private func syncSelectedProjectSkills() {
        guard !selectedProject.isEmpty,
              let project = projects.first(where: { $0.string("id") == selectedProject }) else {
            selectedSkillIds = []
            return
        }
        selectedSkillIds = project.array("skillIds").compactMap(\.stringValue)
    }

    private static func escape(_ value: String) -> String {
        value.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed) ?? value
    }
}

private extension JSONValue {
    func decode<T: Decodable>(_ type: T.Type) throws -> T {
        let data = try JSONEncoder().encode(self)
        return try JSONDecoder().decode(T.self, from: data)
    }
}
