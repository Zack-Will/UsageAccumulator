/**
 * 菜单栏项 + 弹出面板。
 *
 * 面板本体是 WKWebView 加载 apps/menubar/src/renderer 的那套 HTML ——
 * 与 Electron 版**同一份文件**，配色走 @ua/tokens，改一次两边都生效。
 * Swift 这层只提供外壳与 window.ua 桥接，不参与任何渲染决策。
 */
import AppKit
import WebKit

final class PanelController: NSObject, WKScriptMessageHandlerWithReply, WKNavigationDelegate {
    /// 面板宽度固定，高度按内容算（窗口数是变的，2 个和 4 个差很多）
    private static let width: CGFloat = 300
    private static let minHeight: CGFloat = 160
    private static let maxHeight: CGFloat = 620

    private let statusItem: NSStatusItem
    private let popover = NSPopover()
    private var web: WKWebView!
    /// 压在材质之上的一层色调：材质单独用太透，压一层才够"厚"
    private let tint = NSView()
    /// 菜单栏里的迷你条，自绘 —— 不走 NSImage（见 TrayBarsView 的注释）
    private let bars = TrayBarsView()
    private var ready = false
    /// 页面就绪前推来的状态先存着，就绪后补发 —— 否则首帧是空的
    private var pending: PanelState?

    var onRefresh: (() -> Void)?
    var onSaveSettings: ((SettingsPatch) -> Void)?
    var onClearToken: (() -> Void)?
    var onQuit: (() -> Void)?
    var stateProvider: (() -> PanelState)?

    init(statusItem: NSStatusItem) {
        self.statusItem = statusItem
        super.init()
        buildWeb()
        popover.behavior = .transient
        popover.contentSize = NSSize(width: Self.width, height: 320)

        // 背景交给系统材质：WKWebView 自己不画底色（CSS 里 body 是 transparent）。
        // 材质与色调覆盖的组合复刻自 Claude-Usage-Tracker 的 VisualEffectBackground
        // （MIT）—— 单用 .popover 太透，读数会被桌面花色干扰。
        let glass = NSVisualEffectView(frame: NSRect(x: 0, y: 0, width: Self.width, height: 320))
        glass.material = .hudWindow
        glass.blendingMode = .behindWindow
        glass.state = .active
        glass.isEmphasized = true
        glass.autoresizingMask = [.width, .height]

        tint.frame = glass.bounds
        tint.autoresizingMask = [.width, .height]
        tint.wantsLayer = true
        glass.addSubview(tint)

        web.frame = glass.bounds
        web.autoresizingMask = [.width, .height]
        glass.addSubview(web)
        applyTint()

        let vc = NSViewController()
        vc.view = glass
        popover.contentViewController = vc

        // 系统在浅/深之间切换时立刻重绘，不等下一次轮询
        DistributedNotificationCenter.default.addObserver(
            self, selector: #selector(appearanceChanged),
            name: NSNotification.Name("AppleInterfaceThemeChangedNotification"), object: nil)

        statusItem.button?.target = self
        statusItem.button?.action = #selector(togglePopover)
        statusItem.button?.sendAction(on: [.leftMouseUp, .rightMouseUp])

        if let button = statusItem.button {
            bars.translatesAutoresizingMaskIntoConstraints = false
            button.addSubview(bars)
            NSLayoutConstraint.activate([
                bars.leadingAnchor.constraint(equalTo: button.leadingAnchor),
                bars.trailingAnchor.constraint(equalTo: button.trailingAnchor),
                bars.topAnchor.constraint(equalTo: button.topAnchor),
                bars.bottomAnchor.constraint(equalTo: button.bottomAnchor),
            ])
            bars.showsBars = false
        }
    }

    // ---- WKWebView ---------------------------------------------------------

    /**
     * 注入 window.ua。渲染层只认这个接口（见 apps/menubar/src/preload.cts），
     * 所以键名必须逐字对齐，否则面板会静默空白。
     */
    private static let bridgeJS = """
    (function () {
      var subs = [];
      function call(m, a) {
        return window.webkit.messageHandlers.ua.postMessage({ m: m, a: a === undefined ? null : a });
      }
      window.ua = {
        getState: function () { return call("getState"); },
        subscribe: function (fn) { if (typeof fn === "function") subs.push(fn); },
        refresh: function () { call("refresh"); },
        hide: function () { call("hide"); },
        quit: function () { call("quit"); },
        openDashboard: function () { call("openDashboard"); },
        saveSettings: function (p) { return call("saveSettings", p); },
        clearToken: function () { return call("clearToken"); },
        resize: function () { call("resize"); },
      };
      // Swift 侧推状态用
      window.__uaPush = function (s) {
        for (var i = 0; i < subs.length; i++) { try { subs[i](s); } catch (e) {} }
      };
      // 内容高度变了就告诉外壳，让 popover 跟着收放。
      // ★ 只能量内容元素本身。documentElement.scrollHeight 最小等于视口高度，
      // 而视口高度就是 popover 当前高度 —— 一旦把它算进来就成了只增不减的棘轮，
      // 表现为面板底部留一块空白（2026-09-21 踩过）。
      window.__uaContentHeight = function () {
        var s = document.getElementById("settings");
        var el = (s && !s.hidden) ? s : document.getElementById("main");
        return el ? Math.ceil(el.getBoundingClientRect().height) : 0;
      };

      // 每次弹出都回到用量页：设置页是"进去办件事"，不是可停留的状态。
      // 渲染层常驻不重载，不显式复位就会停在上次离开的地方。
      // panel.js 会覆盖它（还没配置时改为停在设置页），这里是它加载前的兜底。
      window.__uaShowUsage = function () {
        var s = document.getElementById("settings");
        var m = document.getElementById("main");
        if (s) s.hidden = true;
        if (m) m.hidden = false;
      };
    })();
    """

    private func buildWeb() {
        let cfg = WKWebViewConfiguration()
        let ucc = WKUserContentController()
        ucc.addUserScript(WKUserScript(source: Self.bridgeJS, injectionTime: .atDocumentStart, forMainFrameOnly: true))
        ucc.addScriptMessageHandler(self, contentWorld: .page, name: "ua")
        cfg.userContentController = ucc
        // 面板不联网（渲染层的 CSP 也写死了 connect-src 'none'），这里不需要任何持久化
        cfg.websiteDataStore = .nonPersistent()

        web = WKWebView(frame: NSRect(x: 0, y: 0, width: Self.width, height: 320), configuration: cfg)
        web.navigationDelegate = self
        web.setValue(false, forKey: "drawsBackground")  // 用页面自己的背景，避免白底闪一下
        if #available(macOS 13.3, *) { web.isInspectable = true }

        guard let index = Bundle.main.url(forResource: "index", withExtension: "html", subdirectory: "renderer") else {
            Log.error("找不到 renderer/index.html —— 构建脚本没把渲染层拷进 bundle")
            return
        }
        web.loadFileURL(index, allowingReadAccessTo: index.deletingLastPathComponent())
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        ready = true
        if let p = pending { push(p); pending = nil }
    }

    // ---- 状态推送 -----------------------------------------------------------

    /// 面板用浅色还是深色由系统外观决定，不再是配置项 —— 背景是系统材质，
    /// 文字色必须跟它走，否则会在玻璃上读不清。
    private static func systemTheme() -> String {
        let match = NSApp.effectiveAppearance.bestMatch(from: [.aqua, .darkAqua])
        return match == .darkAqua ? "dark" : "light"
    }

    private func applyTint() {
        let dark = NSApp.effectiveAppearance.bestMatch(from: [.aqua, .darkAqua]) == .darkAqua
        tint.layer?.backgroundColor = dark
            ? NSColor.black.withAlphaComponent(0.25).cgColor
            : NSColor.white.withAlphaComponent(0.40).cgColor
    }

    @objc private func appearanceChanged() {
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.2) { [weak self] in
            guard let self else { return }
            self.applyTint()
            if let s = self.stateProvider?() { self.push(s) }
        }
    }

    func push(_ incoming: PanelState) {
        var state = incoming
        state.theme = Self.systemTheme()
        let tray = TrayTitle.compose(state)
        statusItem.button?.toolTip = tray.tooltip
        // 正常有数据时画迷你条；异常态（未配置 / 凭证失效 / 还没拉到）回落成文字，
        // 因为那几种情况要传达的是「出事了」，不是某个百分比。
        let windows = state.summary?.windows ?? []
        let drawable = (state.status == .ok || state.status == .stale)
            && !TrayIcon.meaningful(windows).isEmpty
        statusItem.button?.image = nil
        // 一行说清「现在菜单栏上是什么」：条 还是 文字，文字的话是哪一句。
        // 面板的错误占位符与这里的兜底文案都是「—」，光看外观分不出是哪一种。
        Log.info(
            "托盘：\(drawable ? "条" : "文字[\(tray.title)]")"
            + " · status=\(state.status.rawValue)"
            + " · windows=\(windows.count) 有效=\(TrayIcon.meaningful(windows).count)"
        )
        if drawable {
            bars.windows = windows
            bars.showsBars = true
            statusItem.button?.title = ""
            statusItem.length = TrayBarsView.preferredWidth
        } else {
            // 异常态要传达的是「出事了」，不是某个百分比；画几根空条会让人以为用量为 0
            bars.showsBars = false
            statusItem.button?.title = tray.title
            statusItem.length = NSStatusItem.variableLength
        }
        guard ready else { pending = state; return }
        let json = state.jsonString()
        web.evaluateJavaScript("window.__uaPush(\(json))") { [weak self] _, err in
            if let err { Log.warn("推状态失败: \(Log.text(err))") }
            self?.resizeToContent()
        }
    }

    /// 让 popover 高度贴合内容：窗口数量是动态的，写死高度要么留白要么出滚动条。
    private func resizeToContent() {
        web.evaluateJavaScript("window.__uaContentHeight()") { [weak self] value, _ in
            guard let self, let h = value as? CGFloat ?? (value as? NSNumber).map({ CGFloat($0.doubleValue) }),
                  h > 0 else { return }
            let clamped = min(max(h, Self.minHeight), Self.maxHeight)
            guard abs(self.popover.contentSize.height - clamped) > 1 else { return }
            self.popover.contentSize = NSSize(width: Self.width, height: clamped)
        }
    }

    // ---- 桥接消息 -----------------------------------------------------------

    func userContentController(
        _ userContentController: WKUserContentController,
        didReceive message: WKScriptMessage,
        replyHandler: @escaping (Any?, String?) -> Void
    ) {
        guard let body = message.body as? [String: Any], let m = body["m"] as? String else {
            return replyHandler(nil, "bad message")
        }
        let arg = body["a"]
        switch m {
        case "getState":
            replyHandler(stateProvider?().jsonObject() ?? [:], nil)
        case "refresh":
            onRefresh?(); replyHandler(nil, nil)
        case "hide":
            popover.performClose(nil); replyHandler(nil, nil)
        case "quit":
            onQuit?(); replyHandler(nil, nil)
        case "openDashboard":
            openDashboard(); replyHandler(nil, nil)
        case "saveSettings":
            // 渲染层来的是外部数据，交给 SettingsPatch.sanitize 逐字段挑
            onSaveSettings?(SettingsPatch.sanitize(arg)); replyHandler(nil, nil)
        case "clearToken":
            onClearToken?(); replyHandler(nil, nil)
        case "resize":
            // 渲染层内容尺寸变了（切到设置页、行数变化），跟着收放
            resizeToContent(); replyHandler(nil, nil)
        default:
            replyHandler(nil, "unknown method: \(m)")
        }
    }

    /// dashboard_url 来自服务端响应，属于外部数据：协议必须先验，只放行 http(s)。
    private func openDashboard() {
        guard let raw = stateProvider?().summary?.dashboard_url,
              let url = URL(string: raw),
              let scheme = url.scheme?.lowercased(),
              scheme == "http" || scheme == "https"
        else {
            Log.warn("dashboard_url 不是 http(s)，已忽略")
            return
        }
        NSWorkspace.shared.open(url)
    }

    // ---- 交互 ---------------------------------------------------------------

    @objc private func togglePopover() {
        // 右键给菜单（刷新、退出这些低频动作），左键才是面板
        if NSApp.currentEvent?.type == .rightMouseUp {
            return showMenu()
        }
        if popover.isShown { return popover.performClose(nil) }
        guard let button = statusItem.button else { return }
        web.evaluateJavaScript("window.__uaShowUsage()") { [weak self] _, _ in
            self?.resizeToContent()
        }
        popover.show(relativeTo: button.bounds, of: button, preferredEdge: .minY)
        popover.contentViewController?.view.window?.makeKey()
        onRefresh?()
    }

    private func showMenu() {
        let menu = NSMenu()
        let refresh = NSMenuItem(title: "立即刷新", action: #selector(refreshClicked), keyEquivalent: "")
        refresh.target = self
        menu.addItem(refresh)
        menu.addItem(.separator())
        let quit = NSMenuItem(title: "退出", action: #selector(quitClicked), keyEquivalent: "q")
        quit.target = self
        menu.addItem(quit)

        statusItem.menu = menu
        statusItem.button?.performClick(nil)
        statusItem.menu = nil  // 用完即摘，否则左键也会弹菜单
    }

    @objc private func refreshClicked() { onRefresh?() }
    @objc private func quitClicked() { onQuit?() }
}
