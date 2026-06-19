import Foundation
import Security

/// Seam over the secure session store so `AppModel` can be exercised in tests
/// with an in-memory stub instead of touching the real Keychain.
protocol SessionStoring {
    func loadSession(username: String) -> Session?
    func save(token: String) throws
    func clear()
}

struct KeychainStore: SessionStoring {
    private let service = "com.ghostagnt.ghost.session"
    private let account = "backend-bearer"

    func loadSession(username: String = "Saved user") -> Session? {
        var query = baseQuery
        query[kSecReturnData as String] = true
        query[kSecMatchLimit as String] = kSecMatchLimitOne

        var result: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &result)
        guard status == errSecSuccess,
              let data = result as? Data,
              let token = String(data: data, encoding: .utf8),
              !token.isEmpty else {
            return nil
        }

        return Session(token: token, username: username)
    }

    func save(token: String) throws {
        let data = Data(token.utf8)
        var query = baseQuery
        let attributes: [String: Any] = [kSecValueData as String: data]

        let updateStatus = SecItemUpdate(query as CFDictionary, attributes as CFDictionary)
        if updateStatus == errSecSuccess {
            return
        }

        query[kSecValueData as String] = data
        query[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly

        let addStatus = SecItemAdd(query as CFDictionary, nil)
        guard addStatus == errSecSuccess else {
            throw KeychainError.status(addStatus)
        }
    }

    func clear() {
        SecItemDelete(baseQuery as CFDictionary)
    }

    private var baseQuery: [String: Any] {
        [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account
        ]
    }
}

enum KeychainError: Error, Equatable {
    case status(OSStatus)
}
