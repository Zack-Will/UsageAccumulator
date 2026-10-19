/**
 * 菜单栏 → 桌面小部件的唯一数据通道：一份 JSON 快照。
 *
 * 为什么不用 App Group：那要开发者证书，ad-hoc 签名下系统直接拒绝写入
 * （2026-10-17 实测 `Operation not permitted`）。小部件扩展必须开沙箱，
 * 改用沙箱的临时例外只读这一个子目录（见 Widget/Widget.entitlements）。
 * 例外只开到 `Widget/`，读不到隔壁存着 token 的 mac.json —— 快照里也绝不放凭证。
 *
 * 两边编进同一份文件，键名不会漂。
 */
import Foundation

enum WidgetFeedFile {
    /// 小部件的 kind；菜单栏刷新时按它点名
    static let kind = "space.zackwill.ua.quota"

    /**
     * 必须用真实的家目录：沙箱里 homeDirectoryForCurrentUser 指向
     * ~/Library/Containers/<id>/Data，拼出来的路径根本不是菜单栏写的那个。
     */
    static var directory: URL {
        let home = getpwuid(getuid()).flatMap { $0.pointee.pw_dir.map { String(cString: $0) } } ?? NSHomeDirectory()
        return URL(fileURLWithPath: home, isDirectory: true)
            .appendingPathComponent("Library/Application Support/UsageAccumulator/Widget", isDirectory: true)
    }

    static var url: URL { directory.appendingPathComponent("snapshot.json") }

    static func load() -> WidgetSnapshot? {
        guard let data = try? Data(contentsOf: url) else { return nil }
        return try? decoder.decode(WidgetSnapshot.self, from: data)
    }

    static let encoder: JSONEncoder = {
        let e = JSONEncoder()
        e.dateEncodingStrategy = .iso8601
        e.outputFormatting = [.sortedKeys]
        return e
    }()

    static let decoder: JSONDecoder = {
        let d = JSONDecoder()
        d.dateDecodingStrategy = .iso8601
        return d
    }()
}

/// 某个模型在本窗口里的折算费用（`/v1/distribution?by=model` 的一个桶）
struct WidgetModelCost: Codable {
    var key: String
    /// nil = 这个模型没有报价，不是 $0
    var usd: Double?
    var events: Int
}

/// 本窗口起点 → 现在的折算费用，按窗口的模型家族过滤过（7d Fable 只算 Fable）
struct WidgetCost: Codable {
    /// nil = 没有任何有报价的桶
    var usd: Double?
    var unpriced: Int
    /// > 0 = 有事件的最终输出量没写进 JSONL，金额只是下界
    var partial: Int
    var events: Int
    var tokens: Int
    /// 按金额从高到低
    var models: [WidgetModelCost]

    /// 额度当量：各模型费用 × 所属家族的倍率（没列出的按 1）。「满额约」用它，「已用」仍是原价
    func quotaUsd(_ weights: [String: Double]?) -> Double? {
        guard let weights, !weights.isEmpty else { return usd }
        var out: Double?
        for mc in models {
            guard let c = mc.usd else { continue }
            let k = weights.first { modelInFamily(mc.key, $0.key) }?.value ?? 1
            out = (out ?? 0) + c * k
        }
        return out
    }
}

/// 与看板 modelInFamily 一致：先剥 `claude-` 前缀，再比家族名
func modelInFamily(_ model: String, _ family: String) -> Bool {
    var m = model.trimmingCharacters(in: .whitespaces).lowercased()
    if m.hasPrefix("claude-") || m.hasPrefix("claude.") { m.removeFirst(7) }
    return m == family || m.hasPrefix("\(family)-") || m.hasPrefix("\(family).")
}

/// `/v1/windows/current` 里 summary 没有的那部分（大档小部件和底行金额要用）
struct WidgetWindowExtra: Codable {
    var starts_at: String?
    var rate_pct_per_min: Double?
    var p25: Double?
    var p75: Double?
    /// 本地 Claude Code 吃掉的百分比（attribution.local_utilization_pct），满额约的分母
    var local_pct: Double?
    /// 别处（网页聊天、手机、没装探针的机器）吃掉的百分点
    var other_pct: Double?
    /// 历史参考：最近几个已结束窗口「已花 ÷ 本地占比」的中位数
    var full_ref_usd: Double?
    var full_ref_windows: Int?
    /// nil = 没取到（不是 $0）
    var cost: WidgetCost?
    /// 额度当量倍率（家族 → 倍率）：7d 上 Fable ×2。旧快照没有这个字段 → nil，全按 1
    var quota_weights: [String: Double]? = nil
}

struct WidgetSnapshot: Codable {
    static let version = 1

    var v: Int = WidgetSnapshot.version
    /// 菜单栏最后一次写快照的时刻。小部件靠它判断菜单栏是不是还在更新
    var written_at: Date
    /// 菜单栏的轮询间隔，秒；判断「停止更新」的尺子
    var poll_seconds: Int
    /// 最后一次成功拿到的摘要；拉取失败时仍保留，由 error 表达新鲜度
    var summary: Summary?
    var error: UaErrorCode?
    /// 按 window_kind
    var extras: [String: WidgetWindowExtra]
}
