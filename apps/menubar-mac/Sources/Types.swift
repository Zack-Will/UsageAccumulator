/**
 * 契约类型：字段名以 docs/CONTRACT.md §2.2 `GET /v1/summary` 为准，
 * 与 apps/menubar/src/lib/types.cts 逐字段对齐（renderer 是同一份，键名不能漂）。
 * 菜单栏只消费这一个端点，不调用任何重端点。
 */
import Foundation

/// CONTRACT.md §2.2 windows[]
struct SummaryWindow: Codable {
    /// 稳定 key（five_hour / seven_day / ...），用于排序，不做枚举约束
    var window_kind: String
    /// "5h" | "7d" | "7d Fable" —— 仅供展示
    var label: String
    /// 已用百分比，0..100（契约 §4：不是 0..1）
    var pct: Double
    /// 窗口结束时的预计百分比，可能 > 100
    var projected_pct: Double
    /// RFC3339 UTC
    var resets_at: String
    /// 本窗口的耗尽时刻；null = 本窗口打不满
    var exhaust_eta: String?
}

/// CONTRACT.md §2.2 soonest_exhaust
struct SoonestExhaust: Codable {
    var window_kind: String
    /// RFC3339 UTC
    var eta: String
}

/// CONTRACT.md §2.2 响应体
struct Summary: Codable {
    /// 服务端回显的 profile，用来发现「配错 id 拿到别的 profile 数字」
    var profile_id: String
    /// ★ 只含百分比部分，如 "62%"。倒计时由客户端本地算，见 TrayTitle.swift
    var tray_title_pct: String
    var windows: [SummaryWindow]
    /// 最先耗尽的窗口；null = 没有窗口会打满
    var soonest_exhaust: SoonestExhaust?
    /// 额度快照的采集时刻（不是本次请求时刻）；陈旧时长必须由它算
    var captured_at: String?
    /// true = 超过 15 分钟没有新快照
    var stale: Bool
    var rate_pct_per_min: Double
    var dashboard_url: String
}

/**
 * 错误码。前 5 个来自契约 §2 的 `error.code`，后面几个是本地才会发生的情况。
 * UI 据此区分「凭证失效」与「服务端挂了」，不看 HTTP 状态码。
 */
enum UaErrorCode: String, Codable {
    case bad_request, unauthorized, machine_revoked, rate_limited, internalError = "internal"
    case config, network, timeout, bad_response, unknown

    /// 凭证类错误要单独成一态：用户必须去设置里动手，重试没用。
    var isAuth: Bool { self == .unauthorized || self == .machine_revoked }

    /// 每个 code 对应一句克制的中文，UI 直接用；不回显服务端自由文本。
    var text: String {
        switch self {
        case .bad_request: return "请求被拒绝"
        case .unauthorized: return "凭证失效"
        case .machine_revoked: return "机器已吊销"
        case .rate_limited: return "被限流"
        case .internalError: return "服务端故障"
        case .config: return "未配置"
        case .network: return "无法连接"
        case .timeout: return "请求超时"
        case .bad_response: return "响应无法解析"
        case .unknown: return "未知错误"
        }
    }
}

/**
 * 托盘/面板的显示状态。
 * loading = 还没拿到过任何一次成功响应；
 * stale   = 服务端自报 stale:true（快照过期）；
 * auth    = 凭证失效 / 机器被吊销，重试无用；
 * offline = 其余拉取失败（网络、限流、服务端故障）；
 * unconfigured = 还没填 server url。
 */
enum PanelStatus: String, Codable {
    case loading, ok, stale, auth, offline, unconfigured
}

/// 暴露给渲染层的设置快照 —— 注意这里**没有** token 字段，只有 hasToken。
struct SettingsView: Codable {
    var serverUrl: String
    var profileId: String
    var pollSeconds: Int
    var launchAtLogin: Bool
    var hasToken: Bool
}

/// Swift 壳 → 渲染层的唯一一份状态（键名与 panel.js 读的完全一致）。
struct PanelState: Codable {
    var status: PanelStatus
    /// 最后一次成功拿到的摘要；offline 时仍然保留，由 status/snapshotAgeSeconds 表达其新鲜度
    var summary: Summary?
    /// 额度快照采集至今的秒数，由 captured_at 算出；null = 服务端没给或无数据。
    /// 注意这衡量的是额度新鲜度，不是网络新鲜度，两者不能混。
    var snapshotAgeSeconds: Int?
    /// 服务端回显的 profile_id 与本地配置不一致 —— 必须显式提示，不能静默
    var profileMismatch: Bool
    /// 简短失败原因（已脱敏，绝不含 token）
    var error: String?
    var errorCode: UaErrorCode?
    var theme: String
    var settings: SettingsView

    /// 交给 WKWebView 的 reply handler：必须是 JSON 基元，所以先编码再反解。
    func jsonObject() -> [String: Any] {
        guard let data = try? JSONEncoder().encode(self),
              let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
        else { return [:] }
        return obj
    }

    func jsonString() -> String {
        guard let data = try? JSONEncoder().encode(self) else { return "null" }
        return String(data: data, encoding: .utf8) ?? "null"
    }
}

/// 渲染层 → Swift 壳的设置提交体。token 为 nil 表示「不改动」。
struct SettingsPatch {
    var serverUrl: String?
    var profileId: String?
    var pollSeconds: Int?
    var launchAtLogin: Bool?
    var token: String?

    /// 渲染层来的是外部数据：逐字段挑类型，长度也钳住。
    static func sanitize(_ raw: Any?) -> SettingsPatch {
        var out = SettingsPatch()
        guard let r = raw as? [String: Any] else { return out }
        if let v = r["serverUrl"] as? String { out.serverUrl = String(v.prefix(2048)) }
        if let v = r["profileId"] as? String { out.profileId = String(v.prefix(256)) }
        if let v = r["pollSeconds"] as? NSNumber { out.pollSeconds = v.intValue }
        if let v = r["launchAtLogin"] as? Bool { out.launchAtLogin = v }
        if let v = r["token"] as? String { out.token = String(v.prefix(4096)) }
        return out
    }
}

/// RFC3339 → Date。服务端带不带小数秒都要吃得下。
enum RFC3339 {
    private static let withFraction: ISO8601DateFormatter = {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return f
    }()

    private static let plain: ISO8601DateFormatter = {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime]
        return f
    }()

    static func parse(_ s: String?) -> Date? {
        guard let s, !s.isEmpty else { return nil }
        return withFraction.date(from: s) ?? plain.date(from: s)
    }
}
