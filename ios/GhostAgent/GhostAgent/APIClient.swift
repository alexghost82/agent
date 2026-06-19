import Foundation

enum APIClientError: LocalizedError, Equatable {
    case server(code: String, requestId: String?, status: Int)
    case invalidResponse

    var errorDescription: String? {
        switch self {
        case let .server(code, requestId, _):
            if let requestId {
                return "\(code) (requestId: \(requestId))"
            }
            return code
        case .invalidResponse:
            return "Invalid response from server"
        }
    }
}

struct APIClient {
    var baseURL: URL
    var session: URLSession = .shared

    func login(username: String, password: String) async throws -> LoginResponse {
        let body = ["username": username, "password": password]
        return try await request("POST", path: "/login", body: body, token: nil)
    }

    func logout(token: String) async throws {
        let _: EmptyResponse = try await request("POST", path: "/logout", body: Optional<String>.none, token: token)
    }

    /// Exchange a verified Firebase Auth ID token for a GHOST session bearer
    /// (`POST /auth/firebase`). Public endpoint — no bearer is attached.
    func authFirebase(idToken: String) async throws -> LoginResponse {
        let body = ["idToken": idToken]
        return try await request("POST", path: "/auth/firebase", body: body, token: nil)
    }

    func dashboard(token: String) async throws -> DashboardResponse {
        try await request("GET", path: "/dashboard", body: Optional<String>.none, token: token)
    }

    func projects(token: String) async throws -> ProjectsResponse {
        try await request("GET", path: "/projects", body: Optional<String>.none, token: token)
    }

    func getJSON(path: String, token: String) async throws -> JSONValue {
        try await request("GET", path: path, body: Optional<String>.none, token: token)
    }

    func postJSON(path: String, body: JSONObject, token: String) async throws -> JSONValue {
        try await request("POST", path: path, body: body, token: token)
    }

    func patchJSON(path: String, body: JSONObject, token: String) async throws -> JSONValue {
        try await request("PATCH", path: path, body: body, token: token)
    }

    func putJSON(path: String, body: JSONObject, token: String) async throws -> JSONValue {
        try await request("PUT", path: path, body: body, token: token)
    }

    func deleteJSON(path: String, token: String) async throws -> JSONValue {
        try await request("DELETE", path: path, body: Optional<String>.none, token: token)
    }

    private func request<Response: Decodable, Body: Encodable>(
        _ method: String,
        path: String,
        body: Body?,
        token: String?
    ) async throws -> Response {
        var request = URLRequest(url: url(for: path))
        request.httpMethod = method
        request.setValue("application/json", forHTTPHeaderField: "accept")

        if let token {
            request.setValue("Bearer \(token)", forHTTPHeaderField: "authorization")
        }

        if let body {
            request.setValue("application/json", forHTTPHeaderField: "content-type")
            request.httpBody = try JSONEncoder().encode(body)
        }

        let (data, response) = try await session.data(for: request)
        guard let http = response as? HTTPURLResponse else {
            throw APIClientError.invalidResponse
        }

        if (200..<300).contains(http.statusCode) {
            if Response.self == EmptyResponse.self, data.isEmpty {
                return EmptyResponse() as! Response
            }
            return try JSONDecoder().decode(Response.self, from: data)
        }

        if let envelope = try? JSONDecoder().decode(ErrorEnvelope.self, from: data) {
            throw APIClientError.server(code: envelope.error, requestId: envelope.requestId, status: http.statusCode)
        }

        throw APIClientError.server(code: "internal", requestId: nil, status: http.statusCode)
    }

    private func url(for path: String) -> URL {
        let trimmed = path.trimmingCharacters(in: CharacterSet(charactersIn: "/"))
        let parts = trimmed.split(separator: "?", maxSplits: 1).map(String.init)
        var url = baseURL
        for component in parts[0].split(separator: "/").map(String.init) {
            url.appendPathComponent(component)
        }
        if parts.count > 1 {
            var components = URLComponents(url: url, resolvingAgainstBaseURL: false)
            components?.percentEncodedQuery = parts[1]
            return components?.url ?? url
        }
        return url
    }
}

struct EmptyResponse: Decodable, Equatable {}
