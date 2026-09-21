/**
 * 本地配置：`~/Library/Application Support/UsageAccumulator/mac.json`，0600。
 *
 * 为什么不直接复用 Electron 版的 config.json：那边 patch 时整文件重写，
 * 会把这里多出来的键（superviseProbe）抹掉。所以只在首次启动时**读一次**
 * 它来做迁移，之后两个壳各写各的文件。
 *
 * machine_token 只在本进程内存与这个文件里出现，**不进日志、不发给渲染层**。
 */
import Foundation

struct Config: Codable {
    var serverUrl: String = ""
    var token: String = ""
    var profileId: String = "claude-official"
    /// 轮询间隔，秒。默认 45，钳在 [30, 600]
    var pollSeconds: Int = 45
    var launchAtLogin: Bool = false
    /// 是否由本 app 拉起并监管探针子进程。关掉 = 只当看板，探针交给 launchd。
    var superviseProbe: Bool = true
}

final class ConfigStore {
    static let pollMin = 30
    static let pollMax = 600

    /// 与 Electron 版 app.getPath("userData") 同一个目录，方便迁移。
    static var supportDir: URL {
        FileManager.default.homeDirectoryForCurrentUser
            .appendingPathComponent("Library/Application Support/UsageAccumulator", isDirectory: true)
    }

    private let file: URL
    private(set) var data: Config

    init() {
        file = ConfigStore.supportDir.appendingPathComponent("mac.json")
        data = ConfigStore.read(file) ?? ConfigStore.migrateFromElectron() ?? Config()
        data.pollSeconds = ConfigStore.clampPoll(data.pollSeconds)
    }

    private static func clampPoll(_ v: Int) -> Int { min(pollMax, max(pollMin, v)) }

    private static func read(_ url: URL) -> Config? {
        guard let raw = try? Data(contentsOf: url) else { return nil }
        guard let cfg = try? JSONDecoder().decode(Config.self, from: raw) else {
            // 注意：这里只说读不出来，绝不打印文件内容
            Log.warn("mac.json unreadable, falling back to defaults")
            return nil
        }
        return cfg
    }

    /// 迁移：Electron 版的 config.json 字段是这里的子集，能读就照搬一次。
    private static func migrateFromElectron() -> Config? {
        let legacy = supportDir.appendingPathComponent("config.json")
        guard let raw = try? Data(contentsOf: legacy),
              let obj = try? JSONSerialization.jsonObject(with: raw) as? [String: Any] else { return nil }
        var cfg = Config()
        cfg.serverUrl = SummaryClient.normalizeServerUrl(obj["serverUrl"] as? String ?? "")
        cfg.token = obj["token"] as? String ?? ""
        cfg.profileId = (obj["profileId"] as? String).flatMap { $0.isEmpty ? nil : $0 } ?? cfg.profileId
        cfg.pollSeconds = clampPoll((obj["pollSeconds"] as? NSNumber)?.intValue ?? cfg.pollSeconds)
        Log.info("migrated settings from Electron config.json")
        return cfg
    }

    /// 给渲染层看的版本：token 只留 hasToken 布尔。
    func view(launchAtLogin: Bool) -> SettingsView {
        SettingsView(
            serverUrl: data.serverUrl,
            profileId: data.profileId,
            pollSeconds: data.pollSeconds,
            launchAtLogin: launchAtLogin,
            hasToken: !data.token.isEmpty
        )
    }

    /// 返回 true 表示有字段真的变了（调用方据此决定是否立刻重拉）。
    @discardableResult
    func patch(_ p: SettingsPatch) -> Bool {
        var next = data
        if let v = p.serverUrl { next.serverUrl = SummaryClient.normalizeServerUrl(v) }
        if let v = p.profileId {
            let t = v.trimmingCharacters(in: .whitespaces)
            next.profileId = t.isEmpty ? "claude-official" : t
        }
        if let v = p.pollSeconds { next.pollSeconds = ConfigStore.clampPoll(v) }
        if let v = p.launchAtLogin { next.launchAtLogin = v }
        // token 为 nil = 不改动；空串 = 清除
        if let v = p.token { next.token = v.trimmingCharacters(in: .whitespaces) }

        let changed = next.serverUrl != data.serverUrl
            || next.profileId != data.profileId
            || next.pollSeconds != data.pollSeconds
            || next.launchAtLogin != data.launchAtLogin
            || next.token != data.token
        guard changed else { return false }
        data = next
        write()
        return true
    }

    func setSuperviseProbe(_ on: Bool) {
        guard data.superviseProbe != on else { return }
        data.superviseProbe = on
        write()
    }

    private func write() {
        let fm = FileManager.default
        do {
            try fm.createDirectory(at: ConfigStore.supportDir, withIntermediateDirectories: true)
            let enc = JSONEncoder()
            enc.outputFormatting = [.prettyPrinted, .sortedKeys]
            try enc.encode(data).write(to: file, options: [.atomic])
            try fm.setAttributes([.posixPermissions: 0o600], ofItemAtPath: file.path)
        } catch {
            Log.error("config write failed: \(Log.text(error))")
        }
    }
}
