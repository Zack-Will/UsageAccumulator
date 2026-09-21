/**
 * `GET /v1/summary` 客户端。菜单栏只打这一个端点（CONTRACT.md §2.2）。
 * 响应是外部数据：全字段逐个校验，坏字段降级而不是抛到上层崩掉。
 * 错误按契约 §2 的 `error.code` 分类，不只看 HTTP 状态码。
 */
import Foundation

struct SummaryError: Error {
    let code: UaErrorCode
    let message: String
    init(_ code: UaErrorCode, _ message: String? = nil) {
        self.code = code
        self.message = message ?? code.text
    }
}

/// 契约 §2 定义的 5 个 code
private let contractCodes: Set<String> = [
    "bad_request", "unauthorized", "machine_revoked", "rate_limited", "internal",
]

/// 已知窗口的固定次序：服务端换了顺序也不让面板里的行跳来跳去。
private let kindRank: [String: Int] = ["five_hour": 0, "seven_day": 1]

final class SummaryClient: NSObject, URLSessionTaskDelegate {
    static let requestTimeout: TimeInterval = 10

    private lazy var session: URLSession = {
        let cfg = URLSessionConfiguration.ephemeral
        cfg.timeoutIntervalForRequest = SummaryClient.requestTimeout
        cfg.httpCookieAcceptPolicy = .never
        cfg.httpShouldSetCookies = false
        return URLSession(configuration: cfg, delegate: self, delegateQueue: nil)
    }()

    /// 重定向一律拒绝：带着 Bearer 跟着跳到别处等于把 token 递出去。
    func urlSession(
        _ session: URLSession,
        task: URLSessionTask,
        willPerformHTTPRedirection response: HTTPURLResponse,
        newRequest request: URLRequest,
        completionHandler: @escaping (URLRequest?) -> Void
    ) {
        completionHandler(nil)
    }

    private static func isHttpUrl(_ raw: String) -> Bool {
        guard let u = URL(string: raw), let scheme = u.scheme?.lowercased() else { return false }
        return scheme == "http" || scheme == "https"
    }

    /// 规范化 server url：去掉尾部 `/` 和误粘上的 `/v1`。
    static func normalizeServerUrl(_ raw: String) -> String {
        var s = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        while s.hasSuffix("/") { s.removeLast() }
        if s.hasSuffix("/v1") { s.removeLast(3) }
        return s
    }

    func fetch(
        serverUrl: String,
        token: String,
        profileId: String,
        completion: @escaping (Result<Summary, SummaryError>) -> Void
    ) {
        let base = SummaryClient.normalizeServerUrl(serverUrl)
        guard !base.isEmpty else { return completion(.failure(SummaryError(.config, "未配置服务器地址"))) }
        guard SummaryClient.isHttpUrl(base), var comps = URLComponents(string: "\(base)/v1/summary") else {
            return completion(.failure(SummaryError(.config, "服务器地址无效")))
        }
        if !profileId.isEmpty { comps.queryItems = [URLQueryItem(name: "profile_id", value: profileId)] }
        guard let url = comps.url else {
            return completion(.failure(SummaryError(.config, "服务器地址无效")))
        }

        var req = URLRequest(url: url)
        req.httpMethod = "GET"
        req.setValue("application/json", forHTTPHeaderField: "accept")
        if !token.isEmpty { req.setValue("Bearer \(token)", forHTTPHeaderField: "authorization") }

        session.dataTask(with: req) { data, response, err in
            if let err {
                let ns = err as NSError
                let code: UaErrorCode = ns.code == NSURLErrorTimedOut ? .timeout : .network
                return completion(.failure(SummaryError(code, Log.redact(ns.localizedDescription))))
            }
            guard let http = response as? HTTPURLResponse, let data else {
                return completion(.failure(SummaryError(.bad_response, "无响应")))
            }
            let body = try? JSONSerialization.jsonObject(with: data)
            guard (200..<300).contains(http.statusCode) else {
                let code = SummaryClient.classifyError(status: http.statusCode, body: body)
                // 服务端的自由文本只进日志（Log.redact 会脱敏），不进 UI
                Log.warn("summary \(http.statusCode) \(code.rawValue): \(SummaryClient.serverMessage(body))")
                return completion(.failure(SummaryError(code)))
            }
            guard let body else {
                return completion(.failure(SummaryError(.bad_response, "响应不是 JSON")))
            }
            guard let parsed = SummaryClient.parse(body) else {
                return completion(.failure(SummaryError(.bad_response, "响应不是对象")))
            }
            completion(.success(parsed))
        }.resume()
    }

    /// 从 `{"error":{"code","message"}}` 里取码；取不到就按状态码兜底（契约 §2 的表）。
    static func classifyError(status: Int, body: Any?) -> UaErrorCode {
        if let dict = body as? [String: Any],
           let err = dict["error"] as? [String: Any],
           let code = err["code"] as? String,
           contractCodes.contains(code),
           let mapped = UaErrorCode(rawValue: code) {
            return mapped
        }
        if status == 400 { return .bad_request }
        if status == 401 || status == 403 { return .unauthorized }
        if status == 429 { return .rate_limited }
        if status >= 500 { return .internalError }
        // 其余 4xx 按契约一律当「永不接受」处理
        return status >= 400 ? .bad_request : .internalError
    }

    private static func serverMessage(_ body: Any?) -> String {
        guard let dict = body as? [String: Any],
              let err = dict["error"] as? [String: Any],
              let msg = err["message"] as? String else { return "" }
        return String(msg.prefix(200))
    }

    // ---- 解析 --------------------------------------------------------------

    private static func num(_ v: Any?, _ fallback: Double) -> Double {
        guard let n = v as? NSNumber, n.doubleValue.isFinite else { return fallback }
        return n.doubleValue
    }

    /// 能解析成时间的字符串才算数，否则当没给。
    private static func isoOrNil(_ v: Any?) -> String? {
        guard let s = v as? String, !s.isEmpty, RFC3339.parse(s) != nil else { return nil }
        return s
    }

    private static func parseWindow(_ raw: Any) -> SummaryWindow? {
        guard let r = raw as? [String: Any] else { return nil }
        let label = r["label"] as? String ?? ""
        let kind = r["window_kind"] as? String ?? ""
        // label 缺失时退回 window_kind，两个都没有才丢弃
        if label.isEmpty && kind.isEmpty { return nil }
        let pct = num(r["pct"], 0)
        return SummaryWindow(
            window_kind: kind,
            label: label.isEmpty ? kind : label,
            pct: pct,
            // projected 缺失时退化为 pct（宁可低估也不要 NaN 进渲染层）
            projected_pct: num(r["projected_pct"], pct),
            resets_at: r["resets_at"] as? String ?? "",
            exhaust_eta: isoOrNil(r["exhaust_eta"])
        )
    }

    static func parse(_ raw: Any) -> Summary? {
        guard let r = raw as? [String: Any] else { return nil }
        let windows = (r["windows"] as? [Any] ?? [])
            .compactMap(parseWindow)
            .enumerated()
            .sorted { a, b in
                let ra = kindRank[a.element.window_kind] ?? 2
                let rb = kindRank[b.element.window_kind] ?? 2
                return ra == rb ? a.offset < b.offset : ra < rb
            }
            .map(\.element)

        var soonest: SoonestExhaust?
        if let s = r["soonest_exhaust"] as? [String: Any], let eta = isoOrNil(s["eta"]) {
            soonest = SoonestExhaust(window_kind: s["window_kind"] as? String ?? "", eta: eta)
        }

        let dashboard = r["dashboard_url"] as? String ?? ""
        return Summary(
            profile_id: r["profile_id"] as? String ?? "",
            tray_title_pct: r["tray_title_pct"] as? String ?? "",
            windows: windows,
            soonest_exhaust: soonest,
            captured_at: isoOrNil(r["captured_at"]),
            stale: (r["stale"] as? Bool) == true,
            rate_pct_per_min: num(r["rate_pct_per_min"], 0),
            // 这个 URL 会被丢给系统浏览器，协议必须先验；非 http(s) 一律丢弃
            dashboard_url: isHttpUrl(dashboard) ? dashboard : ""
        )
    }
}
