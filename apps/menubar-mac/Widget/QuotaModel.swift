/**
 * 小部件要显示什么 —— 纯函数，不碰 SwiftUI，预览工具和小部件共用。
 * 规则逐条对齐看板额度卡（apps/web/src/components/WindowCards.tsx）与安卓小部件
 * （apps/android/.../widget/WidgetModel.kt）：
 *   · 卡片色：已用 ≥ 90 → danger；已用 ≥ 70 或预计 ≥ 95 → warn
 *   · 预计值单独取色：≥ 100 → danger；≥ 90 → warn
 *   · 耗尽提示：剩不到 45 分钟 → danger，否则 warn
 *   · 满额约：本地占比 < 20% 时不外推，改用历史参考（弱化色）
 */
import Foundation

enum Tone { case ok, warn, danger, muted }

struct ModelShare {
    var name: String
    /// 「$12.34」；没报价时「—」
    var usd: String
    /// 占本窗口已用金额的比例，0..1；没报价时 0
    var fraction: Double
}

struct QuotaRow {
    var kind: String
    /// 「5h 窗口」「7d Fable」
    var label: String
    /// 列表用：5h / 7d / Fable
    var shortLabel: String
    var pct: Int
    var tone: Tone
    /// 重置时预计；nil = 不值得写（不比已用多，或窗口空闲）
    var projected: Int?
    var projectedTone: Tone
    /// 预计区间的半宽；不足 1 个百分点不写（「±0」是假精度）
    var band: Int?
    /// 0..100
    var used: Int
    /// 0..100，额度条浅色那一段
    var projectedFill: Int
    /// 0..1，窗口时间已过去的比例；nil = 不知道窗口起点
    var pace: Double?
    /// 上一个窗口已到期、下一条消息还没来
    var idle: Bool
    /// 「03:18 耗尽」「周三 10:30 重置」「空闲」
    var eta: String?
    /// 「2 小时 5 分后」；空闲或无从计算时 nil
    var etaUntil: String?
    var etaTone: Tone
    /// 耗尽时才有：重置时刻（大档另起一行写）
    var reset: String?
    /// 「12.6%/时」；速率为 0 或没取到时 nil
    var rate: String?
    /// 「$32.34」「≥$32.34」；nil = 没取到，显示「—」
    var spend: String?
    /// 「$216」；nil = 没取到或无从外推
    var full: String?
    /// 满额约来自历史参考而不是外推：弱化显示
    var fullIsRef: Bool
    /// 「1,234 次调用 · 3.4M」
    var calls: String?
    /// 「12% 非 Code」；测到 0 就是 nil
    var otherShare: String?
    var models: [ModelShare]
}

struct QuotaModel {
    var rows: [QuotaRow]
    /// 状态行：新鲜时是额度采集钟点，出错时是原因
    var status: String
    var statusTone: Tone
    /// 数字不是最新的（拉取失败沿用旧值、快照过期、菜单栏停了）——整体降一档显示
    var dim: Bool
    /// 窄卡只放一个窗口：最先耗尽的；都不会耗尽就放用得最多的
    var primary: QuotaRow?
}

enum QuotaModels {
    private static let dangerSeconds: TimeInterval = 45 * 60
    /// 本地占比低于它时「满额约」不外推（与看板 FULL_COST_MIN_LOCAL_PCT 一致）
    private static let fullCostMinLocalPct = 20.0
    private static let weekdays = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"]

    /// 与看板 WINDOW_LABEL 一致；认不出的用服务端给的短标签
    private static let labels = [
        "five_hour": "5h 窗口", "seven_day": "7d 窗口",
        "seven_day_opus": "7d Fable", "seven_day_fable": "7d Fable",
    ]
    /// 核心窗口永远占一个位置，空闲时显示空闲态（看板 CORE_WINDOW_KINDS）
    private static let core = ["five_hour", "seven_day", "seven_day_fable", "seven_day_opus"]

    /// 看板 displayWindows：核心窗口 + 有意义的其余窗口（代号占位字段没有重置时刻又零用量）
    static func display(_ windows: [SummaryWindow]) -> [SummaryWindow] {
        func rank(_ k: String) -> Int { core.firstIndex(of: k) ?? core.count }
        return windows
            .filter { rank($0.window_kind) < core.count || !$0.resets_at.isEmpty || $0.pct > 0 }
            .enumerated()
            .sorted { a, b in
                let ra = rank(a.element.window_kind), rb = rank(b.element.window_kind)
                return ra == rb ? a.offset < b.offset : ra < rb
            }
            .map(\.element)
    }

    /**
     * 菜单栏多久没写快照算「停了」：三个轮询周期，至少 5 分钟。
     * 退出菜单栏 App 后小部件的时间线还会继续走，靠这条把旧数字降成灰色。
     */
    static func feedStale(_ snap: WidgetSnapshot, now: Date) -> Bool {
        now.timeIntervalSince(snap.written_at) > max(300, 3 * Double(snap.poll_seconds))
    }

    static func build(_ snap: WidgetSnapshot?, now: Date, calendar: Calendar = .current) -> QuotaModel {
        guard let snap else {
            return QuotaModel(rows: [], status: "无数据", statusTone: .muted, dim: false, primary: nil)
        }
        let windows = snap.summary.map { display($0.windows) } ?? []
        let rows = windows.map { row($0, extra: snap.extras[$0.window_kind], now: now, calendar: calendar) }
        let primary = primaryRow(windows, rows)

        if let err = snap.error {
            return QuotaModel(
                rows: rows, status: err.text,
                statusTone: err.isAuth || err == .config ? .danger : .warn,
                dim: !rows.isEmpty, primary: primary
            )
        }
        if feedStale(snap, now: now) {
            return QuotaModel(rows: rows, status: "已停止更新", statusTone: .warn, dim: !rows.isEmpty, primary: primary)
        }
        guard let summary = snap.summary else {
            return QuotaModel(rows: [], status: "加载中", statusTone: .muted, dim: false, primary: nil)
        }
        let clock = RFC3339.parse(summary.captured_at).map { formatWhen($0, now: now, calendar: calendar) }
        return QuotaModel(
            rows: rows,
            status: clock ?? "时间未知",
            statusTone: summary.stale || clock == nil ? .warn : .muted,
            dim: summary.stale,
            primary: primary
        )
    }

    private static func primaryRow(_ windows: [SummaryWindow], _ rows: [QuotaRow]) -> QuotaRow? {
        guard !rows.isEmpty else { return nil }
        let idx = windows.indices.min { a, b in
            let ea = RFC3339.parse(windows[a].exhaust_eta) ?? .distantFuture
            let eb = RFC3339.parse(windows[b].exhaust_eta) ?? .distantFuture
            return ea == eb ? windows[a].pct > windows[b].pct : ea < eb
        }
        return idx.map { rows[$0] }
    }

    static func row(_ w: SummaryWindow, extra: WidgetWindowExtra?, now: Date, calendar: Calendar) -> QuotaRow {
        let resetsAt = RFC3339.parse(w.resets_at)
        let idle = resetsAt == nil
        let tone: Tone = w.pct >= 90 ? .danger : (w.pct >= 70 || w.projected_pct >= 95) ? .warn : .ok
        let projectedTone: Tone = w.projected_pct >= 100 ? .danger : w.projected_pct >= 90 ? .warn : .muted
        let used = Int(w.pct.rounded())
        let projected = Int(w.projected_pct.rounded())

        var eta: String?
        var etaUntil: String?
        var etaTone = Tone.muted
        var reset: String?
        if idle {
            eta = "空闲"
        } else if let at = RFC3339.parse(w.exhaust_eta) {
            let remain = at.timeIntervalSince(now)
            if remain <= 0 {
                eta = "已耗尽"
                etaTone = .danger
            } else {
                eta = "\(formatWhen(at, now: now, calendar: calendar)) 耗尽"
                etaUntil = fmtUntil(remain)
                etaTone = remain < dangerSeconds ? .danger : .warn
            }
            reset = resetsAt.map { "\(formatWhen($0, now: now, calendar: calendar)) 重置" }
        } else if let resetsAt {
            eta = "\(formatWhen(resetsAt, now: now, calendar: calendar)) 重置"
            etaUntil = fmtUntil(resetsAt.timeIntervalSince(now))
        }

        var band: Int?
        if !idle, let p25 = extra?.p25, let p75 = extra?.p75 {
            let b = Int(((p75 - p25) / 2).rounded())
            if b >= 1 { band = b }
        }

        let money = moneyOf(w, extra: extra, idle: idle)
        return QuotaRow(
            kind: w.window_kind,
            label: labels[w.window_kind] ?? w.label,
            shortLabel: shortLabel(w),
            pct: used,
            tone: tone,
            projected: !idle && projected > used ? projected : nil,
            projectedTone: projectedTone,
            band: band,
            used: min(100, max(0, idle ? 0 : used)),
            projectedFill: min(100, max(0, idle ? 0 : projected)),
            pace: idle ? nil : pace(w, startsAt: RFC3339.parse(extra?.starts_at), resetsAt: resetsAt, now: now),
            idle: idle,
            eta: eta,
            etaUntil: etaUntil,
            etaTone: etaTone,
            reset: reset,
            rate: (extra?.rate_pct_per_min).flatMap { r in r > 0 && !idle ? String(format: "%.1f%%/时", r * 60) : nil },
            spend: money.spend,
            full: money.full,
            fullIsRef: money.fullIsRef,
            calls: money.calls,
            otherShare: money.otherShare,
            models: money.models
        )
    }

    private struct Money {
        var spend: String?
        var full: String?
        var fullIsRef = false
        var calls: String?
        var otherShare: String?
        var models: [ModelShare] = []
    }

    private static func moneyOf(_ w: SummaryWindow, extra: WidgetWindowExtra?, idle: Bool) -> Money {
        var m = Money()
        guard let extra else { return m }
        // 空闲窗口里确实什么都没发生：已用是 $0，满额约照样可以给历史参考
        let cost = idle ? WidgetCost(usd: 0, unpriced: 0, partial: 0, events: 0, tokens: 0, models: []) : extra.cost
        if let cost {
            if let usd = cost.usd {
                // 有模型没报价、或有事件的输出量只是下界：金额是下界，写成「≥」
                m.spend = (cost.unpriced > 0 || cost.partial > 0 ? "≥" : "") + String(format: "$%.2f", usd)
            }
            if !idle { m.calls = "\(grouped(cost.events)) 次调用 · \(fmtTokens(cost.tokens))" }
            let total = cost.models.compactMap(\.usd).reduce(0, +)
            m.models = cost.models.map { mc in
                ModelShare(
                    name: prettyModel(mc.key),
                    usd: mc.usd.map { String(format: "$%.2f", $0) } ?? "—",
                    fraction: total > 0 ? (mc.usd ?? 0) / total : 0
                )
            }
        }
        let localPct = extra.local_pct ?? w.pct
        let usd = cost?.usd ?? 0
        let extrapolated = usd > 0 && localPct > 0 ? usd / (localPct / 100) : nil
        if let ref = extra.full_ref_usd, localPct < fullCostMinLocalPct {
            m.full = String(format: "$%.0f", ref)
            m.fullIsRef = true
        } else if let extrapolated {
            m.full = String(format: "$%.0f", extrapolated)
        }
        // 「占本窗口已用量的份额」，不是占限额的百分点（看板 2026-10 改过一次口径）
        let other = idle ? 0 : (extra.other_pct ?? 0)
        if w.pct > 0 {
            let share = min(100, other / w.pct * 100)
            if share >= 0.05 { m.otherShare = String(format: share < 1 ? "%.1f%% 非 Code" : "%.0f%% 非 Code", share) }
        }
        return m
    }

    /// 「7d Fable」在窄列表里只写「Fable」：同一列前两行已经是 5h / 7d
    static func shortLabel(_ w: SummaryWindow) -> String {
        if w.window_kind == "five_hour" { return "5h" }
        if w.window_kind == "seven_day" { return "7d" }
        let label = labels[w.window_kind] ?? w.label
        return label.hasPrefix("7d ") ? String(label.dropFirst(3)) : label
    }

    /**
     * 时间进度。有窗口起点就用起点；没有时由重置时刻倒推，窗口长度按 kind 认，
     * 与服务端 inferWindowMs 同一套规则；认不出来的不画，宁缺勿错。
     */
    static func pace(_ w: SummaryWindow, startsAt: Date?, resetsAt: Date?, now: Date) -> Double? {
        guard let resetsAt else { return nil }
        let start: Date
        if let startsAt, startsAt < resetsAt {
            start = startsAt
        } else if w.window_kind == "five_hour" {
            start = resetsAt.addingTimeInterval(-5 * 3600)
        } else if w.window_kind.hasPrefix("seven_day") {
            start = resetsAt.addingTimeInterval(-7 * 86400)
        } else {
            return nil
        }
        return min(1, max(0, now.timeIntervalSince(start) / resetsAt.timeIntervalSince(start)))
    }

    /// 今天只写钟点，其余写星期几 + 钟点（7d 窗口一周内必然落在不同的星期几上）
    static func formatWhen(_ date: Date, now: Date, calendar: Calendar) -> String {
        let c = calendar.dateComponents([.hour, .minute, .weekday], from: date)
        let clock = String(format: "%02d:%02d", c.hour ?? 0, c.minute ?? 0)
        if calendar.isDate(date, inSameDayAs: now) { return clock }
        return "\(weekdays[(c.weekday ?? 1) - 1]) \(clock)"
    }

    /// 与看板 fmtUntil 一致
    static func fmtUntil(_ seconds: TimeInterval) -> String {
        guard seconds.isFinite else { return "—" }
        if seconds <= 60 { return "即将" }
        let total = Int((seconds / 60).rounded())
        if total < 60 { return "\(total) 分钟后" }
        let d = total / 1440, h = (total % 1440) / 60, m = total % 60
        if d >= 1 { return h > 0 ? "\(d) 天 \(h) 小时后" : "\(d) 天后" }
        return m > 0 ? "\(h) 小时 \(m) 分后" : "\(h) 小时后"
    }

    static func fmtTokens(_ n: Int) -> String {
        let v = Double(n)
        if v >= 1e9 { return String(format: "%.1fB", v / 1e9) }
        if v >= 1e6 { return String(format: "%.1fM", v / 1e6) }
        if v >= 1e3 { return String(format: "%.0fk", v / 1e3) }
        return "\(n)"
    }

    private static func grouped(_ n: Int) -> String {
        let f = NumberFormatter()
        f.numberStyle = .decimal
        f.locale = Locale(identifier: "en_US")
        return f.string(from: NSNumber(value: n)) ?? "\(n)"
    }

    /// claude-opus-4-1-20250805 → Opus 4.1；claude-3-5-haiku-20241022 → Haiku 3.5；认不出的原样
    static func prettyModel(_ key: String) -> String {
        var parts = key.lowercased().split(separator: "-").map(String.init)
        if parts.first == "claude" { parts.removeFirst() }
        if let last = parts.last, last.count == 8, last.allSatisfy(\.isNumber) { parts.removeLast() }
        let words = parts.filter { !$0.allSatisfy(\.isNumber) }
        let digits = parts.filter { $0.allSatisfy(\.isNumber) }
        guard words.count == 1, let name = words.first, !name.isEmpty else { return key }
        let title = name.prefix(1).uppercased() + name.dropFirst()
        return digits.isEmpty ? title : "\(title) \(digits.joined(separator: "."))"
    }
}
