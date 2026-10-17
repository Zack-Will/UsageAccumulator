/**
 * 给桌面小部件喂数据：每次轮询后写一份快照（Shared/WidgetSnapshot.swift），
 * 必要时点名小部件重画。小部件自己不联网、不碰凭证。
 *
 * 金额与窗口细节要多打两种端点（`/v1/windows/current` 和每个窗口一次 `/v1/distribution`），
 * 算法照搬看板额度卡（apps/web/src/components/WindowCards.tsx）。它们变得慢、又比 summary 重，
 * 所以 5 分钟取一次；窗口换代（重置时刻变了）时立刻重取，免得新窗口挂着上一个窗口的花费。
 */
import Foundation
import WidgetKit

final class WidgetFeed {
    /// 金额的刷新间隔
    static let extrasInterval: TimeInterval = 300
    /**
     * 两次普通重画之间至少隔这么久。WidgetKit 给后台 App 的刷新次数有日预算，
     * 用完之后的 reload 会被静默丢弃 —— 每次轮询都点名，下午就没得用了。
     * 状态类变化（出错 / 恢复 / 换色）不受这个限制，见 publish。
     */
    static let reloadInterval: TimeInterval = 600

    private let client: SummaryClient
    private var extras: [String: WidgetWindowExtra] = [:]
    private var extrasAt: Date?
    /// 取金额时各窗口的重置时刻；变了说明窗口换代
    private var extrasResets: [String: String] = [:]
    private var extrasInFlight = false

    private var lastLoud = ""
    private var lastQuiet = ""
    private var lastReload = Date.distantPast

    init(client: SummaryClient) {
        self.client = client
    }

    /// 主线程调用：每次轮询（成功或失败）之后
    func publish(state: PanelState, config: Config) {
        write(state: state, config: config)
        guard let summary = state.summary, state.errorCode == nil else { return }

        let resets = Dictionary(summary.windows.map { ($0.window_kind, $0.resets_at) }, uniquingKeysWith: { a, _ in a })
        let due = extrasAt.map { Date().timeIntervalSince($0) >= Self.extrasInterval } ?? true
        if !extrasInFlight && (due || resets != extrasResets) {
            fetchExtras(summary: summary, config: config, resets: resets) { [weak self] in
                // 这期间 state 可能已经又变了：按最近一次 publish 的状态重写
                guard let self, let (s, c) = self.latest else { return }
                self.write(state: s, config: c)
            }
        }
    }

    // ---- 快照 ---------------------------------------------------------------

    private var latest: (PanelState, Config)?

    private func write(state: PanelState, config: Config) {
        latest = (state, config)
        let snap = WidgetSnapshot(
            written_at: Date(),
            poll_seconds: config.pollSeconds,
            summary: state.summary,
            error: state.status == .unconfigured ? .config : state.errorCode,
            extras: extras
        )
        do {
            try FileManager.default.createDirectory(at: WidgetFeedFile.directory, withIntermediateDirectories: true)
            try WidgetFeedFile.encoder.encode(snap).write(to: WidgetFeedFile.url, options: .atomic)
        } catch {
            Log.warn("小部件快照写入失败: \(error.localizedDescription)")
            return
        }
        reloadIfNeeded(snap)
    }

    /**
     * 两档签名：loud 变了（出错、恢复、某个窗口换色、会不会耗尽）立刻重画；
     * quiet 变了（百分比、金额这类数字）按 reloadInterval 节流。
     * 倒计时、时间刻度、陈旧判断不在签名里：小部件的时间线每分钟一帧，自己会走。
     */
    private func reloadIfNeeded(_ snap: WidgetSnapshot) {
        let windows = snap.summary?.windows ?? []
        let loud = ([snap.error?.rawValue ?? "ok", snap.summary?.stale == true ? "stale" : ""] +
            windows.map { w in
                "\(w.window_kind):\(Self.tone(w)):\(w.exhaust_eta == nil ? "-" : "eta"):\(w.resets_at)"
            }).joined(separator: "|")
        let quiet = windows.map { w in
            let usd = snap.extras[w.window_kind]?.cost?.usd.map { String(Int($0)) } ?? "-"
            return "\(w.window_kind):\(Int(w.pct.rounded())):\(Int(w.projected_pct.rounded())):\(w.exhaust_eta ?? ""):\(usd)"
        }.joined(separator: "|")

        let now = Date()
        let loudChanged = loud != lastLoud
        guard loudChanged || (quiet != lastQuiet && now.timeIntervalSince(lastReload) >= Self.reloadInterval) else { return }
        lastLoud = loud
        lastQuiet = quiet
        lastReload = now
        WidgetCenter.shared.reloadTimelines(ofKind: WidgetFeedFile.kind)
        Log.info("小部件重画 · \(loudChanged ? "状态变化" : "数字变化")")
    }

    /// 与看板 ringTone 同一套阈值，只用来判断「换色了没有」
    private static func tone(_ w: SummaryWindow) -> String {
        if w.pct >= 90 { return "danger" }
        if w.pct >= 70 || w.projected_pct >= 95 { return "warn" }
        return "ok"
    }

    // ---- 金额与窗口细节 -------------------------------------------------------

    private func fetchExtras(summary: Summary, config: Config, resets: [String: String], done: @escaping () -> Void) {
        extrasInFlight = true
        let profile = summary.profile_id.isEmpty ? config.profileId : summary.profile_id
        let profileQuery = profile.isEmpty ? [] : [URLQueryItem(name: "profile_id", value: profile)]
        let kinds = Set(summary.windows.map(\.window_kind))

        client.getJSON(
            serverUrl: config.serverUrl, token: config.token, path: "/v1/windows/current",
            query: profileQuery + [URLQueryItem(name: "burn_points", value: "2")]
        ) { [weak self] result in
            guard let self else { return }
            guard case .success(let body) = result else {
                // 取不到就沿用上次的；下次轮询再试
                return DispatchQueue.main.async { self.extrasInFlight = false }
            }
            var next = Self.parseWindows(body).filter { kinds.contains($0.key) }
            let to = ISO8601DateFormatter().string(from: Date())
            let group = DispatchGroup()
            let lock = NSLock()
            for (kind, extra) in next {
                // 空闲窗口没有起点：照发会让服务端按缺省回看 7 天，5h 卡上就出现一周的花费
                guard let from = extra.starts_at else { continue }
                group.enter()
                self.client.getJSON(
                    serverUrl: config.serverUrl, token: config.token, path: "/v1/distribution",
                    query: profileQuery + [
                        URLQueryItem(name: "from", value: from),
                        URLQueryItem(name: "to", value: to),
                        URLQueryItem(name: "by", value: "model"),
                    ]
                ) { r in
                    if case .success(let body) = r, let cost = Self.parseCost(body, kind: kind) {
                        lock.lock(); next[kind]?.cost = cost; lock.unlock()
                    }
                    group.leave()
                }
            }
            group.notify(queue: .main) {
                // 某个窗口的金额这次没取到：沿用上次的值，别让它闪成「—」
                for (kind, extra) in next where extra.cost == nil && extra.starts_at != nil {
                    next[kind]?.cost = self.extras[kind]?.cost
                }
                self.extras = next
                self.extrasAt = Date()
                self.extrasResets = resets
                self.extrasInFlight = false
                Log.info("小部件金额 · \(next.values.filter { $0.cost != nil }.count)/\(next.count) 个窗口")
                done()
            }
        }
    }

    private static func num(_ v: Any?) -> Double? {
        guard let n = v as? NSNumber, n.doubleValue.isFinite else { return nil }
        return n.doubleValue
    }

    /// `/v1/windows/current` → 每个窗口 summary 里没有的字段（CONTRACT.md §2.1）
    static func parseWindows(_ body: Any) -> [String: WidgetWindowExtra] {
        guard let arr = (body as? [String: Any])?["windows"] as? [Any] else { return [:] }
        var out: [String: WidgetWindowExtra] = [:]
        for raw in arr {
            guard let w = raw as? [String: Any], let kind = w["window_kind"] as? String, !kind.isEmpty else { continue }
            let proj = w["projected_pct"] as? [String: Any]
            let attr = w["attribution"] as? [String: Any]
            let ref = w["full_cost_reference"] as? [String: Any]
            let starts = (w["starts_at"] as? String).flatMap { RFC3339.parse($0) != nil ? $0 : nil }
            out[kind] = WidgetWindowExtra(
                starts_at: starts,
                rate_pct_per_min: num(w["rate_pct_per_min"]),
                p25: num(proj?["p25"]),
                p75: num(proj?["p75"]),
                // attribution 缺失时退回官方百分比，与看板一致
                local_pct: num(attr?["local_utilization_pct"]) ?? num(w["utilization_pct"]),
                other_pct: num(attr?["other_pct"]) ?? num(attr?["other_pct_lower_bound"]),
                full_ref_usd: num(ref?["usd"]),
                full_ref_windows: num(ref?["windows"]).map { Int($0) },
                cost: nil
            )
        }
        return out
    }

    /// 与看板 windowModelFamily 一致：seven_day_<family> 只算这一族；scoped 不是模型族
    static func family(_ kind: String) -> String? {
        guard kind.hasPrefix("seven_day_") else { return nil }
        let fam = kind.dropFirst("seven_day_".count).lowercased()
        return fam.isEmpty || fam == "scoped" ? nil : fam
    }

    /// 与看板 modelInFamily 一致：先剥 `claude-` 前缀，再比家族名
    static func modelInFamily(_ model: String, _ family: String) -> Bool {
        var m = model.trimmingCharacters(in: .whitespaces).lowercased()
        if m.hasPrefix("claude-") || m.hasPrefix("claude.") { m.removeFirst(7) }
        return m == family || m.hasPrefix("\(family)-") || m.hasPrefix("\(family).")
    }

    /// `/v1/distribution?by=model` → 本窗口的金额（按家族过滤）
    static func parseCost(_ body: Any, kind: String) -> WidgetCost? {
        guard let buckets = (body as? [String: Any])?["buckets"] as? [Any] else { return nil }
        let fam = family(kind)
        var usd: Double?
        var unpriced = 0, partial = 0, events = 0, tokens = 0
        var models: [WidgetModelCost] = []
        for raw in buckets {
            guard let b = raw as? [String: Any] else { continue }
            let key = b["key"] as? String ?? ""
            if let fam, !modelInFamily(key, fam) { continue }
            let c = num(b["cost_usd"])
            if let c { usd = (usd ?? 0) + c }
            let n = Int(num(b["events"]) ?? 0)
            unpriced += Int(num(b["unpriced_events"]) ?? 0)
            partial += Int(num(b["partial_output_events"]) ?? 0)
            events += n
            tokens += Int(num(b["total_tokens"]) ?? 0)
            models.append(WidgetModelCost(key: key, usd: c, events: n))
        }
        models.sort { ($0.usd ?? -1) > ($1.usd ?? -1) }
        // 过滤后一个桶都不剩 = 这个家族本窗口确实没用过，是 $0 而不是「未知」
        return WidgetCost(
            usd: buckets.isEmpty || models.isEmpty ? 0 : usd,
            unpriced: unpriced, partial: partial, events: events, tokens: tokens,
            models: models
        )
    }
}
