/**
 * 菜单栏标题的组织逻辑。纯函数，不碰 AppKit，语义照搬
 * apps/menubar/src/lib/tray-title.cts —— 两个壳显示的字必须一模一样。
 *
 * 标题 = 服务端给的 `tray_title_pct` + **本地算出的**倒计时。
 * 倒计时必须本地算（契约 §2.2）：服务端渲染的那个在两次轮询之间就过期了，
 * 所以另开一条 30s 的心跳只重排标题，不发请求。
 *
 * 结构固定为 `[前缀字形] [数字]`，前缀互斥：
 *   - 正常：无前缀
 *   - 预计打满：`▲`（菜单栏不能上色，只能用字形做区分）
 *   - 陈旧 / profile 不一致 / 拉取失败但快照还在保鲜期：`⚠`，数字保留但已被明确标记
 *   - 快照超出保鲜期：只显示 `⚠ 离线`，**不展示过期数字**
 *   - 凭证失效：`⚠ 凭证失效`，数字也不展示 —— 用户必须动手，重试没用
 */
import Foundation

struct TrayView {
    var title: String
    var tooltip: String
}

enum TrayTitle {
    /// 与契约 §2.2 的 stale 定义对齐：15 分钟。
    static let staleAfter: TimeInterval = 15 * 60

    /// 菜单栏标题的自刷新间隔。倒计时只到分钟，30s 心跳足够跟上。
    static let tickInterval: TimeInterval = 30

    /// 额度紧张 = 有窗口会耗尽，或任一窗口预计打满。
    static func isTight(_ summary: Summary?) -> Bool {
        guard let summary else { return false }
        if summary.soonest_exhaust != nil { return true }
        return summary.windows.contains { $0.projected_pct >= 100 }
    }

    /// 秒 → "1:48"；≥24h 走 "2d3h"；≤0 走 "0:00"。
    static func formatCountdown(_ seconds: TimeInterval) -> String {
        guard seconds.isFinite, seconds > 0 else { return "0:00" }
        let totalMin = Int(seconds / 60)
        if totalMin >= 24 * 60 {
            let d = totalMin / (24 * 60)
            let h = (totalMin % (24 * 60)) / 60
            return h > 0 ? "\(d)d\(h)h" : "\(d)d"
        }
        return "\(totalMin / 60):\(String(format: "%02d", totalMin % 60))"
    }

    /// 百分比部分：优先用服务端渲染的，缺失时取最吃紧窗口兜底。
    static func pctPart(_ summary: Summary) -> String {
        let given = summary.tray_title_pct.trimmingCharacters(in: .whitespaces)
        if !given.isEmpty { return given }
        let pct = summary.windows.reduce(0.0) { max($0, $1.pct) }
        return "\(Int(pct.rounded()))%"
    }

    /// 本地拼出完整数字段：`62% · 1:48`；没有耗尽预期时只留百分比。
    static func composeNumbers(_ summary: Summary, now: Date) -> String {
        let head = pctPart(summary)
        guard let eta = summary.soonest_exhaust, let at = RFC3339.parse(eta.eta) else { return head }
        return "\(head) · \(formatCountdown(at.timeIntervalSince(now)))"
    }

    static func ageText(_ ageSeconds: Int?) -> String {
        guard let ageSeconds else { return "无数据" }
        if ageSeconds < 90 { return "刚刚" }
        let min = Int((Double(ageSeconds) / 60).rounded())
        if min < 60 { return "\(min) 分钟前" }
        return "\(Int((Double(min) / 60).rounded())) 小时前"
    }

    static func compose(_ state: PanelState, now: Date = Date()) -> TrayView {
        if state.status == .unconfigured {
            return TrayView(title: "未配置", tooltip: "UsageAccumulator · 点击填写服务器地址")
        }
        if state.status == .auth {
            // 凭证类错误重试无用，数字一并收起，逼用户去动手；两种码的补救动作不同
            let revoked = state.errorCode == .machine_revoked
            return revoked
                ? TrayView(title: "⚠ 已吊销", tooltip: "\(state.error ?? "机器已吊销") · 需重新 enroll")
                : TrayView(title: "⚠ 凭证失效", tooltip: "\(state.error ?? "凭证失效") · 到设置里更新 Token")
        }
        guard state.status != .loading, let summary = state.summary else {
            return TrayView(title: "—", tooltip: "UsageAccumulator · 正在获取")
        }

        let numbers = composeNumbers(summary, now: now)
        // 快照是否还在保鲜期，由 captured_at 决定（额度新鲜度，不是网络新鲜度）
        let fresh = state.snapshotAgeSeconds.map { Double($0) < staleAfter } ?? false

        if state.status == .offline {
            return TrayView(
                title: fresh ? "⚠ \(numbers)" : "⚠ 离线",
                tooltip: "\(state.error ?? "拉取失败") · 快照 \(ageText(state.snapshotAgeSeconds))"
            )
        }

        if state.profileMismatch {
            // 数字是别的 profile 的，绝不能不声不响地显示
            return TrayView(
                title: "⚠ \(numbers)",
                tooltip: "profile 与本地配置不一致 · 服务端用的是 \(summary.profile_id)"
            )
        }

        if state.status == .stale {
            return TrayView(title: "⚠ \(numbers)", tooltip: "额度快照陈旧 · \(ageText(state.snapshotAgeSeconds))")
        }

        let tight = isTight(summary)
        return TrayView(
            title: tight ? "▲ \(numbers)" : numbers,
            tooltip: tight ? "预计打满 · \(numbers)" : numbers
        )
    }
}
