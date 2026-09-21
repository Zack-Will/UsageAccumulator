/**
 * 登录取 sessionKey。
 *
 * ★ 为什么需要一个真浏览器视图：claude.ai 在 Cloudflare 后面，登录页本身要执行
 *   JS 挑战。WKWebView 是系统自带的真引擎，用户在里面正常登录即可 ——
 *   **这里不做任何绕过**，也绝不代填任何凭证。
 *
 * ★ sessionKey 是 HttpOnly，页面脚本读不到；但 WKHTTPCookieStore 在原生侧读得到。
 *   取到之后立刻进 Keychain，不落盘、不进日志、不上报服务端（ARCHITECTURE §9）。
 */
import AppKit
import WebKit

final class LoginWindow: NSObject, WKNavigationDelegate {
    private static let loginURL = URL(string: "https://claude.ai/")!
    /// 登录完成后 cookie 不一定立刻可见，轮询一小段时间
    private static let pollInterval: TimeInterval = 1.5

    private var window: NSWindow?
    private var web: WKWebView?
    private var timer: Timer?
    private let onCaptured: (String) -> Void

    init(onCaptured: @escaping (String) -> Void) {
        self.onCaptured = onCaptured
    }

    func show() {
        if let window {
            window.makeKeyAndOrderFront(nil)
            NSApp.activate(ignoringOtherApps: true)
            return
        }

        let cfg = WKWebViewConfiguration()
        // 用持久化 store：Cloudflare 的设备 cookie 留下来，下次登录少一次挑战
        cfg.websiteDataStore = .default()
        let w = WKWebView(frame: NSRect(x: 0, y: 0, width: 520, height: 720), configuration: cfg)
        w.navigationDelegate = self
        web = w

        let win = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 520, height: 720),
            styleMask: [.titled, .closable, .resizable],
            backing: .buffered,
            defer: false
        )
        win.title = "登录 Claude"
        win.contentView = w
        win.center()
        win.isReleasedWhenClosed = false
        window = win

        w.load(URLRequest(url: Self.loginURL))
        win.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)

        timer = Timer.scheduledTimer(withTimeInterval: Self.pollInterval, repeats: true) { [weak self] _ in
            self?.checkCookies()
        }
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        checkCookies()
    }

    private func checkCookies() {
        web?.configuration.websiteDataStore.httpCookieStore.getAllCookies { [weak self] cookies in
            guard let self else { return }
            guard let c = cookies.first(where: { $0.name == "sessionKey" && $0.domain.contains("claude.ai") }),
                  !c.value.isEmpty
            else { return }
            self.finish(with: c.value)
        }
    }

    private func finish(with key: String) {
        timer?.invalidate()
        timer = nil
        guard Keychain.writeSessionKey(key) else {
            Log.error("sessionKey 写入 Keychain 失败")
            alert("写入 Keychain 失败", "登录成功，但凭证没能存进 Keychain。请检查钥匙串访问权限后重试。")
            return
        }
        // 日志里只记「拿到了」，绝不记值
        Log.info("已从登录窗口取得 sessionKey 并写入 Keychain")
        close()
        onCaptured(key)
        alert("登录完成", "额度采集已经可以开始了。")
    }

    private func alert(_ title: String, _ body: String) {
        let a = NSAlert()
        a.messageText = title
        a.informativeText = body
        a.alertStyle = .informational
        a.runModal()
    }

    func close() {
        timer?.invalidate()
        timer = nil
        window?.close()
        window = nil
        web = nil
    }
}
