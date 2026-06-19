import Foundation

typealias JSONObject = [String: JSONValue]

enum JSONValue: Codable, Equatable, Identifiable {
    case string(String)
    case number(Double)
    case bool(Bool)
    case object(JSONObject)
    case array([JSONValue])
    case null

    var id: String { string("id") ?? string("path") ?? string("title") ?? UUID().uuidString }

    init(from decoder: Decoder) throws {
        let container = try decoder.singleValueContainer()
        if container.decodeNil() {
            self = .null
        } else if let value = try? container.decode(Bool.self) {
            self = .bool(value)
        } else if let value = try? container.decode(Double.self) {
            self = .number(value)
        } else if let value = try? container.decode(String.self) {
            self = .string(value)
        } else if let value = try? container.decode([JSONValue].self) {
            self = .array(value)
        } else {
            self = .object(try container.decode(JSONObject.self))
        }
    }

    func encode(to encoder: Encoder) throws {
        var container = encoder.singleValueContainer()
        switch self {
        case let .string(value):
            try container.encode(value)
        case let .number(value):
            try container.encode(value)
        case let .bool(value):
            try container.encode(value)
        case let .object(value):
            try container.encode(value)
        case let .array(value):
            try container.encode(value)
        case .null:
            try container.encodeNil()
        }
    }
}

extension JSONValue {
    var objectValue: JSONObject? {
        if case let .object(value) = self { return value }
        return nil
    }

    var arrayValue: [JSONValue]? {
        if case let .array(value) = self { return value }
        return nil
    }

    func string(_ key: String) -> String? {
        guard case let .object(object) = self else { return nil }
        return object[key]?.stringValue
    }

    func number(_ key: String) -> Double? {
        guard case let .object(object) = self else { return nil }
        return object[key]?.numberValue
    }

    func int(_ key: String) -> Int? {
        guard let value = number(key) else { return nil }
        return Int(value)
    }

    func array(_ key: String) -> [JSONValue] {
        guard case let .object(object) = self else { return [] }
        return object[key]?.arrayValue ?? []
    }

    func object(_ key: String) -> JSONObject? {
        guard case let .object(object) = self else { return nil }
        return object[key]?.objectValue
    }

    var stringValue: String? {
        switch self {
        case let .string(value):
            return value
        case let .number(value):
            return value.truncatingRemainder(dividingBy: 1) == 0 ? String(Int(value)) : String(value)
        case let .bool(value):
            return String(value)
        default:
            return nil
        }
    }

    var numberValue: Double? {
        switch self {
        case let .number(value):
            return value
        case let .string(value):
            return Double(value)
        default:
            return nil
        }
    }
}

extension JSONObject {
    func string(_ key: String) -> String? { self[key]?.stringValue }
    func int(_ key: String) -> Int? { self[key]?.numberValue.map(Int.init) }
    func array(_ key: String) -> [JSONValue] { self[key]?.arrayValue ?? [] }
    func object(_ key: String) -> JSONObject? { self[key]?.objectValue }
}

struct UserDTO: Codable, Equatable {
    let username: String
}

struct LoginResponse: Decodable, Equatable {
    let ok: Bool
    let token: String
    let user: UserDTO
}

struct ErrorEnvelope: Decodable, Error, Equatable {
    let error: String
    let requestId: String?
}

struct DashboardResponse: Decodable, Equatable {
    let counts: Counts?
    let recentLogs: [AgentLog]?

    struct Counts: Decodable, Equatable {
        let topics: Int?
        let sources: Int?
        let chunks: Int?
        let skills: Int?
        let projects: Int?
        let decisions: Int?
        let plans: Int?
        let logs: Int?
    }
}

struct ProjectsResponse: Decodable, Equatable {
    let projects: [ProjectSummary]
}

struct ProjectSummary: Decodable, Identifiable, Equatable {
    let id: String
    let name: String
    let description: String?
    let stack: String?
    let repoUrl: String?
}

struct AgentLog: Decodable, Identifiable, Equatable {
    let id: String
    let action: String?
    let type: String?
    let message: String?
    let createdAt: String?
}

struct Session: Equatable {
    let token: String
    let username: String
}

enum StepKey: String, CaseIterable, Identifiable {
    case overview
    case sources
    case skills
    case projects
    case ask
    case design
    case plan
    case build
    case autorun
    case memory
    case settings

    var id: String { rawValue }

    var number: String {
        switch self {
        case .overview, .autorun, .memory, .settings: return "•"
        case .sources: return "1"
        case .skills: return "2"
        case .projects: return "3"
        case .ask: return "4"
        case .design: return "5"
        case .plan: return "6"
        case .build: return "7"
        }
    }

    var icon: String {
        switch self {
        case .overview: return "rectangle.grid.2x2"
        case .sources: return "book.pages"
        case .skills: return "bolt.badge.automatic"
        case .projects: return "folder"
        case .ask: return "bubble.left.and.text.bubble.right"
        case .design: return "chart.line.uptrend.xyaxis"
        case .plan: return "chevron.left.forwardslash.chevron.right"
        case .build: return "hammer"
        case .autorun: return "wand.and.stars"
        case .memory: return "memorychip"
        case .settings: return "key"
        }
    }
}

enum Lang: String, CaseIterable, Identifiable {
    case en
    case he
    case ru
    var id: String { rawValue }

    /// Short label shown in the language switcher (parity with the web toggle).
    var shortLabel: String {
        switch self {
        case .en: return "EN"
        case .he: return "HEB"
        case .ru: return "RU"
        }
    }
}

enum AppTheme: String, CaseIterable, Identifiable {
    case dark
    case light
    var id: String { rawValue }
}

struct ProviderStatus: Decodable, Equatable {
    let provider: String
    let keys: [String: KeyInfo]
}

struct KeyInfo: Decodable, Equatable {
    let configured: Bool
    let last4: String?
    let updatedAt: String?
}

// MARK: - Autonomous agent (Autorun, Epic 3)

/// One generated build file, in parity with the backend `build.files[]` shape
/// (`{ path, content, language?, bytes? }`). Shared by `AgentRunResult` and the
/// regular build flow.
struct BuildFileDTO: Decodable, Identifiable, Equatable {
    let path: String
    let content: String
    let language: String?
    let bytes: Int?

    var id: String { path }
}

/// A single orchestration step of an agent run (learn → skill → design → plan →
/// build). `detail` is an optional human-readable note (e.g. "2/3 urls").
struct AgentStep: Decodable, Identifiable, Equatable {
    let name: String
    let status: String
    let detail: String?

    var id: String { "\(name)-\(status)" }
}

/// Synchronous result of `POST /agent/run`: the final verified build files plus
/// the orchestration steps and the ids of the entities the run created.
struct AgentRunResult: Decodable, Equatable {
    let runId: String
    let topicId: String?
    let projectId: String?
    let buildRunId: String?
    let files: [BuildFileDTO]
    let summary: String
    let steps: [AgentStep]

    enum CodingKeys: String, CodingKey {
        case runId, topicId, projectId, buildRunId, files, summary, steps
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        runId = try c.decode(String.self, forKey: .runId)
        topicId = (try? c.decodeIfPresent(String.self, forKey: .topicId)) ?? nil
        projectId = (try? c.decodeIfPresent(String.self, forKey: .projectId)) ?? nil
        buildRunId = (try? c.decodeIfPresent(String.self, forKey: .buildRunId)) ?? nil
        files = (try? c.decode([BuildFileDTO].self, forKey: .files)) ?? []
        summary = (try? c.decode(String.self, forKey: .summary)) ?? ""
        steps = (try? c.decode([AgentStep].self, forKey: .steps)) ?? []
    }
}

/// An owned agent run as stored server-side, returned by `GET /agent/runs/:id`
/// (wrapped in `{ run }`) and `GET /agent/runs` (a `{ runs }` list). `summary`
/// is optional because the run document only carries it once the build is ready.
struct AgentRun: Decodable, Identifiable, Equatable {
    let id: String
    let status: String
    let steps: [AgentStep]
    let summary: String?
    let task: String?
    let buildRunId: String?
    let projectId: String?
    let topicId: String?
    let errorCode: String?

    enum CodingKeys: String, CodingKey {
        case id, status, steps, summary, task, buildRunId, projectId, topicId, errorCode
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        status = (try? c.decode(String.self, forKey: .status)) ?? ""
        steps = (try? c.decode([AgentStep].self, forKey: .steps)) ?? []
        summary = (try? c.decodeIfPresent(String.self, forKey: .summary)) ?? nil
        task = (try? c.decodeIfPresent(String.self, forKey: .task)) ?? nil
        buildRunId = (try? c.decodeIfPresent(String.self, forKey: .buildRunId)) ?? nil
        projectId = (try? c.decodeIfPresent(String.self, forKey: .projectId)) ?? nil
        topicId = (try? c.decodeIfPresent(String.self, forKey: .topicId)) ?? nil
        errorCode = (try? c.decodeIfPresent(String.self, forKey: .errorCode)) ?? nil
    }
}

/// Response envelopes for the agent-run read endpoints.
struct AgentRunEnvelope: Decodable, Equatable { let run: AgentRun }
struct AgentRunsEnvelope: Decodable, Equatable { let runs: [AgentRun] }
