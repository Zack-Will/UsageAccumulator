/**
 * Keychain —— 官方额度用的 sessionKey 只存这里。
 *
 * ★ 只存本机，**绝不上报服务端**，也绝不进日志（ARCHITECTURE §9）。
 * service / account 与 packages/ua-probe/src/config.ts 的默认值一致
 * （keychain_service = "ua-probe" / keychain_account = "claude-session-key"），
 * 这样 Linux 上那套 TS 探针的配置语义不用改。
 *
 * 注意：探针**不再**自己去读 keychain（`security` CLI 会撞 ACL 授权弹窗），
 * 值由本 app 读出来后经环境变量交给子进程，见 ProbeSupervisor.swift。
 */
import Foundation
import Security

enum Keychain {
    static let service = "ua-probe"
    static let account = "claude-session-key"

    private static func baseQuery() -> [String: Any] {
        [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
        ]
    }

    /// 读不到返回 nil，不抛。失败原因只记类型码，绝不记内容。
    static func readSessionKey() -> String? {
        var q = baseQuery()
        q[kSecReturnData as String] = true
        q[kSecMatchLimit as String] = kSecMatchLimitOne

        var item: CFTypeRef?
        let status = SecItemCopyMatching(q as CFDictionary, &item)
        guard status == errSecSuccess, let data = item as? Data else {
            if status != errSecItemNotFound { Log.warn("keychain read failed: OSStatus \(status)") }
            return nil
        }
        let v = String(data: data, encoding: .utf8)?.trimmingCharacters(in: .whitespacesAndNewlines)
        return (v?.isEmpty == false) ? v : nil
    }

    /// 覆盖写入。返回 false 表示没存进去，调用方要让用户知道。
    @discardableResult
    static func writeSessionKey(_ value: String) -> Bool {
        let data = Data(value.utf8)
        // 先试更新，没有再新建 —— 避免重复条目
        let update: [String: Any] = [kSecValueData as String: data]
        var status = SecItemUpdate(baseQuery() as CFDictionary, update as CFDictionary)
        if status == errSecItemNotFound {
            var add = baseQuery()
            add[kSecValueData as String] = data
            // 锁屏时探针可能要重启，用 AfterFirstUnlock 而不是 WhenUnlocked
            add[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlock
            add[kSecAttrLabel as String] = "UsageAccumulator · Claude sessionKey"
            status = SecItemAdd(add as CFDictionary, nil)
        }
        if status != errSecSuccess {
            Log.error("keychain write failed: OSStatus \(status)")
            return false
        }
        return true
    }

    @discardableResult
    static func deleteSessionKey() -> Bool {
        let status = SecItemDelete(baseQuery() as CFDictionary)
        return status == errSecSuccess || status == errSecItemNotFound
    }

    static var hasSessionKey: Bool { readSessionKey() != nil }
}
