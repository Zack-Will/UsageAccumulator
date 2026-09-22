/**
 * 探针子进程的监管。
 *
 * 数据逻辑一行都不在 Swift 里：探针仍然是 `@ua/probe` 那份 TS（Linux 上跑的是同一套），
 * 这里只负责拉起来、喂凭证、挂了再拉起来。
 *
 * ★ 凭证交接走环境变量 `UA_PROBE_CLAUDE_SESSION_KEY`（探针侧的 EnvCredentialStore
 *   已经认这个名字）。**绝不走 argv** —— argv 会出现在 `ps` 的输出里。
 *
 * 启动命令不写死在代码里，由 Resources/probe-launch.json 给出（构建时按仓库路径生成），
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

    var text: String {
        switch self {
        case .stopped: return "探针：未监管"
        case .running: return "探针：运行中"
        case .backoff: return "探针：重启中"
        case .missing: return "探针：未配置"
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
     * ★ 拉起动作必须离开主线程。
     *
     * spawn() 里要读 Keychain 取 sessionKey，而 `SecItemCopyMatching` 在需要
     * 用户授权时会**同步阻塞直到有人点掉弹窗**。App 是 LSUIElement（不进 Dock），
     * 弹窗未必浮得到用户面前，于是主线程就一直卡在
     * applicationDidFinishLaunching 里 —— 托盘画不出内容，只剩初始态的一根短横线。
     * 2026-09-22 排查了四轮才定位到这里：每次 ad-hoc 重新签名都会让钥匙串条目的
     * 授权失效，所以现象时有时无。
     */
    func start() {
        wantRunning = true
        failures = 0
        Self.work.async { [weak self] in self?.spawn() }
    }

    /// 监管相关的阻塞调用（读钥匙串、起进程）都放这条队列
    private static let work = DispatchQueue(label: "space.zackwill.ua.probe-supervisor")

    /// 凭证变了（刚登录完）要让子进程带着新 env 重来一次。
    func restartForNewCredential() {
        guard wantRunning else { return }
        Log.info("restarting probe with refreshed credential")
        failures = 0
        killCurrent()
        Self.work.async { [weak self] in self?.spawn() }
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

    private func spawn() {
        guard wantRunning else { return }
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
        // ★ 凭证只在这里出现一次：父进程内存 → 子进程 environ。不落盘、不进 argv、不进日志。
        if let key = Keychain.readSessionKey() {
            env["UA_PROBE_CLAUDE_SESSION_KEY"] = key
        } else {
            env.removeValue(forKey: "UA_PROBE_CLAUDE_SESSION_KEY")
        }
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

    private func scheduleRestart() {
        let delay = ProbeSupervisor.backoffSteps[min(failures, ProbeSupervisor.backoffSteps.count - 1)]
        failures += 1
        state = .backoff
        restartTimer?.invalidate()
        restartTimer = Timer.scheduledTimer(withTimeInterval: delay, repeats: false) { [weak self] _ in
            Self.work.async { [weak self] in self?.spawn() }
        }
        Log.info("probe restart in \(Int(delay))s")
    }
}
