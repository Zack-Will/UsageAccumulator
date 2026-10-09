/**
 * 探针子进程的监管。
 *
 * 数据逻辑一行都不在 Swift 里：探针仍然是 `@ua/probe` 那份 TS（Linux 上跑的是同一套），
 * 这里只负责拉起来、挂了再拉起来。
 *
 * 不给探针传任何 claude.ai 凭证：额度由服务端直接抓（ARCHITECTURE §5.3），
 * 菜单栏只从服务端拿汇总好的数字。
 *
 * 启动命令不写死在代码里，由 Resources/probe-launch.json 给出（本机构建时按仓库路径生成；Release 包不带，改找全局安装的 ua-probe），
 * 用户可以用 ~/Library/Application Support/UsageAccumulator/probe-launch.json 覆盖。
 */
import Foundation

struct ProbeLaunchSpec: Codable {
    /// argv[0] 必须是可执行文件的绝对路径
    var command: [String]
    var cwd: String?
    /// 额外环境变量（PATH 之类）；凭证**不**放在这里，由代码单独注入
    var env: [String: String]?
}

enum ProbeState: String {
    case stopped        // 用户关掉了监管
    case running
    case backoff        // 挂了，等退避窗口
    case missing        // 找不到启动配置或可执行文件
    case external       // 已经由 launchd 托管，这里不插手

    var text: String {
        switch self {
        case .stopped: return "探针：未监管"
        case .running: return "探针：运行中"
        case .backoff: return "探针：重启中"
        case .missing: return "探针：未配置"
        case .external: return "探针：由 launchd 托管"
        }
    }
}

final class ProbeSupervisor {
    /// 退避阶梯：连续崩溃时不要把 CPU 和服务端一起打爆。
    private static let backoffSteps: [TimeInterval] = [2, 4, 8, 16, 32, 64, 128, 300]
    /// 活过这个时长就认为「起来了」，退避重新归零。
    private static let healthyUptime: TimeInterval = 60

    private var process: Process?
    private var wantRunning = false
    private var failures = 0
    private var startedAt: Date?
    private var restartTimer: Timer?
    private var logHandle: FileHandle?

    private(set) var state: ProbeState = .stopped {
        didSet { if state != oldValue { onStateChange?(state) } }
    }

    /// 状态一变就让菜单跟着变。
    var onStateChange: ((ProbeState) -> Void)?

    // ---- 启动配置 ----------------------------------------------------------

    private func loadSpec() -> ProbeLaunchSpec? {
        let override = ConfigStore.supportDir.appendingPathComponent("probe-launch.json")
        let bundled = Bundle.main.url(forResource: "probe-launch", withExtension: "json")
        for url in [override, bundled].compactMap({ $0 }) {
            guard let raw = try? Data(contentsOf: url),
                  let spec = try? JSONDecoder().decode(ProbeLaunchSpec.self, from: raw),
                  let exe = spec.command.first, !exe.isEmpty else { continue }
            guard FileManager.default.isExecutableFile(atPath: exe) else {
                Log.warn("probe launch spec points at a non-executable: \(exe)")
                continue
            }
            return spec
        }
        return Self.globalInstallSpec()
    }

    /**
     * Release 包里没有 probe-launch.json（构建机的仓库路径到了别人机器上不存在），
     * 就去找 `npm i -g @zack-will/ua-probe` 装好的 `ua-probe`。
     * 它的 shebang 是 `/usr/bin/env node`，LaunchAgent 下 PATH 是最小集，
     * 所以把它所在目录（node 通常就在旁边）放到 PATH 最前面。
     */
    private static func globalInstallSpec() -> ProbeLaunchSpec? {
        let fm = FileManager.default
        let home = fm.homeDirectoryForCurrentUser.path
        var dirs = ["/opt/homebrew/bin", "/usr/local/bin", "\(home)/.npm-global/bin",
                    "\(home)/.local/bin", "\(home)/.volta/bin"]
        // nvm：版本号大的优先
        let nvm = "\(home)/.nvm/versions/node"
        if let versions = try? fm.contentsOfDirectory(atPath: nvm) {
            dirs += versions.sorted { $0.compare($1, options: .numeric) == .orderedDescending }
                .map { "\(nvm)/\($0)/bin" }
        }
        for dir in dirs {
            let exe = "\(dir)/ua-probe"
            guard fm.isExecutableFile(atPath: exe) else { continue }
            return ProbeLaunchSpec(
                command: [exe, "run"],
                cwd: nil,
                env: ["PATH": "\(dir):/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"]
            )
        }
        return nil
    }

    private func openLog() -> FileHandle? {
        if let logHandle { return logHandle }
        let dir = FileManager.default.homeDirectoryForCurrentUser
            .appendingPathComponent("Library/Logs/UsageAccumulator", isDirectory: true)
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        let file = dir.appendingPathComponent("probe-mac.log")
        if !FileManager.default.fileExists(atPath: file.path) {
            FileManager.default.createFile(atPath: file.path, contents: nil, attributes: [.posixPermissions: 0o600])
        }
        logHandle = try? FileHandle(forWritingTo: file)
        _ = try? logHandle?.seekToEnd()
        return logHandle
    }

    // ---- 生命周期 ----------------------------------------------------------

    /**
     * 线程约定：**所有状态只在主线程上读写**（wantRunning / failures / process /
     * startedAt / state / restartTimer）。
     *
     *   · `Timer.scheduledTimer` 挂在**调用线程的 run loop** 上，别的队列排的
     *     重启定时器永远不会触发，监管就此静默。
     *   · `state` 的 didSet 会回调 UI，必须在主线程。
     */
    func start() {
        wantRunning = true
        failures = 0
        spawn()
    }

    func stop() {
        wantRunning = false
        restartTimer?.invalidate()
        restartTimer = nil
        killCurrent()
        state = .stopped
    }

    private func killCurrent() {
        guard let p = process, p.isRunning else { process = nil; return }
        p.terminationHandler = nil
        p.terminate()  // SIGTERM：探针自己会冲刷队列
        // 给它一点时间收尾，超时就硬杀，不能把退出流程卡住
        let deadline = Date().addingTimeInterval(3)
        while p.isRunning && Date() < deadline { usleep(50_000) }
        if p.isRunning { kill(p.processIdentifier, SIGKILL) }
        process = nil
    }

    /**
     * `ua-probe install` 装过 launchd 服务就让给它。两边都拉起的话，两个探针会轮流
     * 「接管」同一个状态库、每隔几分钟互相 SIGTERM（2026-10-09 K4F 上实测）。
     * 只看 plist 在不在：`ua-probe install` 写它，卸载时删它，判断不用起子进程。
     */
    static let launchdLabels = ["com.ua.probe", "com.zackwill.ua-probe"]

    static func launchdManaged() -> Bool {
        let dir = FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("Library/LaunchAgents")
        return launchdLabels.contains {
            FileManager.default.fileExists(atPath: dir.appendingPathComponent("\($0).plist").path)
        }
    }

    /// 主线程。
    private func spawn() {
        guard wantRunning, process == nil else { return }
        if Self.launchdManaged() {
            Log.info("launchd 已托管探针，菜单栏不再拉起")
            state = .external
            return
        }
        guard let spec = loadSpec() else {
            Log.warn("no usable probe-launch.json; probe supervision is off")
            state = .missing
            return
        }

        let p = Process()
        p.executableURL = URL(fileURLWithPath: spec.command[0])
        p.arguments = Array(spec.command.dropFirst())
        if let cwd = spec.cwd, !cwd.isEmpty {
            p.currentDirectoryURL = URL(fileURLWithPath: cwd)
        }

        var env = ProcessInfo.processInfo.environment
        for (k, v) in spec.env ?? [:] { env[k] = v }
        p.environment = env

        if let handle = openLog() {
            p.standardOutput = handle
            p.standardError = handle
        }

        p.terminationHandler = { [weak self] proc in
            DispatchQueue.main.async { self?.handleExit(proc) }
        }

        do {
            try p.run()
            process = p
            startedAt = Date()
            state = .running
            Log.info("probe started pid \(p.processIdentifier)")
        } catch {
            Log.error("probe spawn failed: \(Log.text(error))")
            scheduleRestart()
        }
    }

    private func handleExit(_ proc: Process) {
        guard wantRunning, proc === process else { return }
        process = nil
        let uptime = startedAt.map { Date().timeIntervalSince($0) } ?? 0
        // 活够久就当它是被外力干掉的，退避从头算；否则算一次连续失败
        if uptime >= ProbeSupervisor.healthyUptime { failures = 0 }
        Log.warn("probe exited status \(proc.terminationStatus) after \(Int(uptime))s")
        scheduleRestart()
    }

    /// 主线程。定时器必须挂在主 run loop 上，别的队列排的定时器不会触发。
    private func scheduleRestart() {
        let delay = ProbeSupervisor.backoffSteps[min(failures, ProbeSupervisor.backoffSteps.count - 1)]
        failures += 1
        state = .backoff
        restartTimer?.invalidate()
        restartTimer = Timer.scheduledTimer(withTimeInterval: delay, repeats: false) { [weak self] _ in
            self?.spawn()
        }
        Log.info("probe restart in \(Int(delay))s")
    }
}
