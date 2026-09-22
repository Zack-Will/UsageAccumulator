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
 *
 * ─────────────────────────────────────────────────────────────────────────
 * 这个条目落在**旧版文件钥匙串**上（调用栈 SecItemCopyMatching_osx →
 * SecKeychainSearchCopyNext），而 ACL 绑定应用的代码签名。本地 ad-hoc 构建
 * 每次重新签名都换身份，于是系统要重新授权 —— 而本 App 是 LSUIElement，
 * 弹窗浮不到用户面前，`SecItemCopyMatching` 就**同步阻塞到天荒地老**。
 *
 * 2026-09-22 的故障形态：14:33 监管队列调 readSessionKey 卡住，两个半小时没动，
 * 探针再没被拉起来，额度快照从 14:11 起断供。第一次修只把调用挪离主线程
 * （托盘因此能画出来了），阻塞本身没解决，于是换个线程接着卡。
 *
 * 现在三层保护：
 *   1. 全进程只在启动时关一次用户交互（见 disableInteractivePrompts），
 *      不再每次调用 set(false)/defer set(true) —— 那是个进程级全局开关，
 *      两个线程并发时 A 的 defer 会把 B 的保护撤掉，正是这次卡死的成因。
 *   2. 所有钥匙串访问串行化到一条队列，杜绝并发。
 *   3. 实际的 Sec 调用放到一次性线程上跑，**带硬超时**。超时就认定钥匙串
 *      卡死，之后一律走缓存/返回 nil，绝不再让任何有用的队列陪葬。
 */
import Foundation
import Security

enum Keychain {
    static let service = "ua-probe"
    static let account = "claude-session-key"

    /// 单次钥匙串调用的耐心上限。正常读取是毫秒级；到秒就说明撞上授权等待了。
    static let timeout: TimeInterval = 3

    /// 串行化所有访问：旧版钥匙串的进程级状态经不起并发。
    private static let queue = DispatchQueue(label: "space.zackwill.ua.keychain")

    private static let stateLock = NSLock()
    /// 双层可选：外层 nil = 还没读过；内层 nil = 读过，确实没有。
    private static var cached: String??
    /// 卡死过一次就别再碰它 —— 每次重试都会再泄漏一条永久阻塞的线程。
    private static var wedged = false

    /**
     * 启动时调一次。旧版钥匙串拿不到授权时立刻返回 errSecInteractionNotAllowed，
     * 而不是等用户点一个他根本看不见的弹窗。
     *
     * 刻意**不**还原成 true：本 App 全程没有能承载钥匙串弹窗的窗口，
     * 允许交互在任何时刻都只会变成一次静默的挂起。
     */
    static func disableInteractivePrompts() {
        SecKeychainSetUserInteractionAllowed(false)
    }

    private static func baseQuery() -> [String: Any] {
        [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
        ]
    }

    /// 给超时线程放结果的盒子：超时后主调用方不再读它，线程晚到的写入无人关心。
    private final class Box: @unchecked Sendable {
        let lock = NSLock()
        var status: OSStatus = errSecInteractionNotAllowed
        var data: Data?
    }

    /**
     * 带硬超时地跑一段钥匙串调用。
     *
     * 超时返回 nil。那条线程可能永远卡在 Security 框架里 —— 我们接受这一次泄漏：
     * 之后 `wedged` 会挡住所有后续调用，泄漏不会累积，而换来的是任何调用方
     * 都不会被钥匙串拖死。
     */
    private static func runWithTimeout(_ body: @escaping (Box) -> Void) -> Box? {
        let box = Box()
        let sem = DispatchSemaphore(value: 0)
        Thread.detachNewThread {
            body(box)
            sem.signal()
        }
        if sem.wait(timeout: .now() + timeout) == .timedOut { return nil }
        return box
    }

    /// 读不到返回 nil，不抛。失败原因只记类型码，绝不记内容。
    static func readSessionKey() -> String? {
        stateLock.lock()
        if let c = cached { stateLock.unlock(); return c }
        if wedged { stateLock.unlock(); return nil }
        stateLock.unlock()

        return queue.sync {
            // 队列里再确认一次：排队期间别的调用可能已经把值取回来了
            stateLock.lock()
            if let c = cached { stateLock.unlock(); return c }
            if wedged { stateLock.unlock(); return nil }
            stateLock.unlock()

            let box = runWithTimeout { box in
                var q = baseQuery()
                q[kSecReturnData as String] = true
                q[kSecMatchLimit as String] = kSecMatchLimitOne
                q[kSecUseAuthenticationUI as String] = kSecUseAuthenticationUISkip
                var item: CFTypeRef?
                let st = SecItemCopyMatching(q as CFDictionary, &item)
                box.lock.lock()
                box.status = st
                box.data = item as? Data
                box.lock.unlock()
            }

            guard let box else {
                stateLock.lock(); wedged = true; stateLock.unlock()
                Log.error("keychain 读取超时（\(Int(timeout))s）——旧版钥匙串在等一个看不见的授权弹窗；"
                    + "本次起不再访问钥匙串，请从菜单重新登录 Claude 以重建条目")
                return nil
            }

            box.lock.lock()
            let status = box.status
            let data = box.data
            box.lock.unlock()

            guard status == errSecSuccess, let data else {
                if status == errSecInteractionNotAllowed {
                    Log.warn("keychain 条目需要重新授权（本地构建重新签名后 ACL 失效）；请从菜单重新登录")
                } else if status != errSecItemNotFound {
                    Log.warn("keychain read failed: OSStatus \(status)")
                }
                // 记成「读过且没有」：省掉每次轮询都去撞一次旧版钥匙串。
                // 重新登录会 invalidate 缓存，用户没有别的路径能让它凭空出现。
                stateLock.lock(); cached = .some(nil); stateLock.unlock()
                return nil
            }

            let v = String(data: data, encoding: .utf8)?.trimmingCharacters(in: .whitespacesAndNewlines)
            let value = (v?.isEmpty == false) ? v : nil
            stateLock.lock(); cached = .some(value); stateLock.unlock()
            return value
        }
    }

    /// 覆盖写入。返回 false 表示没存进去，调用方要让用户知道。
    @discardableResult
    static func writeSessionKey(_ value: String) -> Bool {
        let data = Data(value.utf8)
        let ok = queue.sync { () -> Bool in
            let box = runWithTimeout { box in
                // 先试更新，没有再新建 —— 避免重复条目
                let update: [String: Any] = [kSecValueData as String: data]
                var st = SecItemUpdate(baseQuery() as CFDictionary, update as CFDictionary)
                if st == errSecItemNotFound {
                    var add = baseQuery()
                    add[kSecValueData as String] = data
                    // 锁屏时探针可能要重启，用 AfterFirstUnlock 而不是 WhenUnlocked
                    add[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlock
                    add[kSecAttrLabel as String] = "UsageAccumulator · Claude sessionKey"
                    st = SecItemAdd(add as CFDictionary, nil)
                }
                box.lock.lock(); box.status = st; box.lock.unlock()
            }
            guard let box else {
                Log.error("keychain 写入超时（\(Int(timeout))s）")
                return false
            }
            box.lock.lock(); let status = box.status; box.lock.unlock()
            if status != errSecSuccess {
                Log.error("keychain write failed: OSStatus \(status)")
                return false
            }
            return true
        }
        if ok {
            // 刚写进去的值自己最清楚，顺手把缓存填上；同时解除 wedged ——
            // 重新登录重建了条目，ACL 按当前二进制的身份重新授权过了。
            stateLock.lock(); cached = .some(value); wedged = false; stateLock.unlock()
        }
        return ok
    }

    @discardableResult
    static func deleteSessionKey() -> Bool {
        let ok = queue.sync { () -> Bool in
            let box = runWithTimeout { box in
                let st = SecItemDelete(baseQuery() as CFDictionary)
                box.lock.lock(); box.status = st; box.lock.unlock()
            }
            guard let box else { return false }
            box.lock.lock(); let status = box.status; box.lock.unlock()
            return status == errSecSuccess || status == errSecItemNotFound
        }
        stateLock.lock(); cached = .some(nil); stateLock.unlock()
        return ok
    }

    /// 钥匙串是不是已经被判定为卡死（菜单用它解释「为什么没有额度」）。
    static var isWedged: Bool {
        stateLock.lock(); defer { stateLock.unlock() }
        return wedged
    }

    static var hasSessionKey: Bool { readSessionKey() != nil }
}
