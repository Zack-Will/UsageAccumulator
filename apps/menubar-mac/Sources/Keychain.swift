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
    /**
     * 读 sessionKey。
     *
     * ★ 必须 `kSecUseAuthenticationUISkip`：条目的 ACL 绑定应用的代码签名，
     * 而本地 ad-hoc 构建**每次重新签名都会变身份**，于是系统要求重新授权。
     * 不加这个标志时 `SecItemCopyMatching` 会**同步阻塞直到有人点掉弹窗**，
     * 而这个 App 是 LSUIElement，弹窗未必浮得到用户面前 —— 2026-09-22 就是这样
     * 把启动流程整个卡死，托盘只剩初始态的「—」，排查了四轮才定位到。
     *
     * 现在改为拿不到就立刻返回 nil，由调用方去提示重新登录。
     */
    static func readSessionKey() -> String? {
        var q = baseQuery()
        q[kSecReturnData as String] = true
        q[kSecMatchLimit as String] = kSecMatchLimitOne
        /*
         * ★ 这里**不能**只靠 kSecUseAuthenticationUISkip。
         * 该条目落在**旧版文件钥匙串**上（调用栈是 SecItemCopyMatching_osx →
         * SecKeychainItemCopyContent），那个标志只对现代 data-protection 钥匙串有效，
         * 管不住旧版的 ACL 授权弹窗 —— 实测加了依然同步阻塞。
         * 旧版要用 SecKeychainSetUserInteractionAllowed(false)：拿不到就返回
         * errSecInteractionNotAllowed，而不是干等。
         */
        q[kSecUseAuthenticationUI as String] = kSecUseAuthenticationUISkip
        SecKeychainSetUserInteractionAllowed(false)
        defer { SecKeychainSetUserInteractionAllowed(true) }

        var item: CFTypeRef?
        let status = SecItemCopyMatching(q as CFDictionary, &item)
        guard status == errSecSuccess, let data = item as? Data else {
            if status == errSecInteractionNotAllowed {
                Log.warn("keychain 条目需要重新授权（本地构建重新签名后 ACL 失效）；请从菜单重新登录")
            } else if status != errSecItemNotFound {
                Log.warn("keychain read failed: OSStatus \(status)")
            }
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
