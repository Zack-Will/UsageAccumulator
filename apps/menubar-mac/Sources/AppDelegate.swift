/**
 * 把各块接起来：轮询 summary → 组装 PanelState → 推给面板与托盘，
 * 同时监管 Node 探针子进程。
 *
 * 退出 App = 采集也停 —— 这是刻意的语义：探针靠游标续传，下次打开会把
 * 期间产生的记录整批补上，不会丢数据。
 */
import AppKit

final class AppDelegate: NSObject, NSApplicationDelegate {
    private var statusItem: NSStatusItem!
    private var panel: PanelController!
    private let config = ConfigStore()
    private let client = SummaryClient()
    private let probe = ProbeSupervisor()

    private var pollTimer: Timer?
    private var tickTimer: Timer?
    private var state = PanelState(
        status: .loading, summary: nil, snapshotAgeSeconds: nil, profileMismatch: false,
        error: nil, errorCode: nil, theme: "dark",
        settings: SettingsView(serverUrl: "", profileId: "", pollSeconds: 45, launchAtLogin: false, hasToken: false)
    )

    func applicationDidFinishLaunching(_ notification: Notification) {
        statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
        panel = PanelController(statusItem: statusItem)
        panel.stateProvider = { [weak self] in self?.state ?? PanelState(
            status: .loading, summary: nil, snapshotAgeSeconds: nil, profileMismatch: false,
            error: nil, errorCode: nil, theme: "dark",
            settings: SettingsView(serverUrl: "", profileId: "", pollSeconds: 45, launchAtLogin: false, hasToken: false)) }
        panel.onRefresh = { [weak self] in self?.poll() }
        panel.onQuit = { NSApp.terminate(nil) }
        panel.onClearToken = { [weak self] in
            guard let self else { return }
            var p = SettingsPatch(); p.token = ""
            _ = self.config.patch(p)
            self.refreshSettingsView()
            self.poll()
        }
        panel.onSaveSettings = { [weak self] patch in
            guard let self else { return }
            let changed = self.config.patch(patch)
            self.refreshSettingsView()
            if changed { self.poll() }
        }

        probe.onStateChange = { st in Log.info("探针状态: \(st.text)") }
        if config.data.superviseProbe { probe.start() }

        refreshSettingsView()
        poll()
        schedule()
    }

    func applicationWillTerminate(_ notification: Notification) {
        probe.stop()
        pollTimer?.invalidate()
        tickTimer?.invalidate()
    }

    // ---- 轮询 ---------------------------------------------------------------

    private func schedule() {
        pollTimer?.invalidate()
        pollTimer = Timer.scheduledTimer(withTimeInterval: Double(config.data.pollSeconds), repeats: true) { [weak self] _ in
            self?.poll()
        }
        // 倒计时与「多久之前」是本地算的，不必等下一次网络请求
        tickTimer?.invalidate()
        tickTimer = Timer.scheduledTimer(withTimeInterval: TrayTitle.tickInterval, repeats: true) { [weak self] _ in
            guard let self else { return }
            self.state.snapshotAgeSeconds = Self.age(of: self.state.summary)
            self.panel.push(self.state)
        }
    }

    private static func age(of summary: Summary?) -> Int? {
        guard let at = RFC3339.parse(summary?.captured_at) else { return nil }
        return max(0, Int(Date().timeIntervalSince(at)))
    }

    private func refreshSettingsView() {
        state.settings = config.view(launchAtLogin: config.data.launchAtLogin)
        if config.data.serverUrl.isEmpty { state.status = .unconfigured }
        panel.push(state)
    }

    private func poll() {
        guard !config.data.serverUrl.isEmpty else {
            state.status = .unconfigured
            return panel.push(state)
        }
        client.fetch(
            serverUrl: config.data.serverUrl,
            token: config.data.token,
            profileId: config.data.profileId
        ) { [weak self] result in
            guard let self else { return }
            switch result {
            case .success(let summary):
                self.state.summary = summary
                self.state.snapshotAgeSeconds = Self.age(of: summary)
                // 服务端回显的 profile 与本地配置不一致时必须显式提示，
                // 否则会盯着别的 profile 的数字做判断
                self.state.profileMismatch =
                    !self.config.data.profileId.isEmpty && summary.profile_id != self.config.data.profileId
                self.state.error = nil
                self.state.errorCode = nil
                self.state.status = summary.stale ? .stale : .ok
                // 只记结构化事实，不记响应正文；排障时第一眼要看的就是这行
                Log.info("summary ok · windows=\(summary.windows.count) · stale=\(summary.stale) · age=\(TrayTitle.ageText(self.state.snapshotAgeSeconds))")
            case .failure(let err):
                self.state.errorCode = err.code
                self.state.error = err.message
                // 拿不到新数据不代表旧数据要清空，保留并由 status 表达新鲜度
                self.state.status = err.code.isAuth ? .auth : (err.code == .config ? .unconfigured : .offline)
                Log.warn("summary 失败 · code=\(err.code.rawValue) · \(err.message)")
            }
            self.panel.push(self.state)
        }
    }
}
