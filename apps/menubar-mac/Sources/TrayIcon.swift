/**
 * 菜单栏图标：每个窗口一根迷你条，竖向堆叠。
 *
 * 不用文字：菜单栏空间按像素算，一串 "98% · 3:14" 又长又要读；
 * 几根带颜色的条能在余光里直接判断「有没有快满的」。
 *
 * 判定规则与面板严格一致（见 panel.js 的 statusColorVar）——
 * 两处若用不同阈值，就会出现「菜单栏是橙的、点开是红的」这种自相矛盾。
 * 规则本身复刻自 Claude-Usage-Tracker 的 UsageStatusCalculator（MIT）。
 */
import AppKit

enum TrayIcon {
    private static let barWidth: CGFloat = 24
    private static let barHeight: CGFloat = 3.5
    private static let gap: CGFloat = 3
    private static let maxBars = 3

    /// 窗口长度，与渲染层的 WINDOW_META 对应。未知 kind 返回 nil = 算不出配速。
    private static func periodSeconds(_ kind: String) -> Double? {
        if kind == "five_hour" { return 5 * 3600 }
        if kind == "seven_day" || kind.hasPrefix("seven_day_") { return 7 * 86400 }
        return nil
    }

    /// 已经走过的时间比例 0..1；算不出返回 nil。
    private static func elapsedFraction(_ w: SummaryWindow) -> Double? {
        guard let period = periodSeconds(w.window_kind),
              let reset = RFC3339.parse(w.resets_at) else { return nil }
        let remaining = reset.timeIntervalSinceNow
        if remaining <= 0 { return 1 }
        if remaining > period { return nil }
        return min(1, max(0, (period - remaining) / period))
    }

    /**
     * 颜色。★ 关键是**配速感知**：时间过了 15% 之后看的不是「已经用了多少」，
     * 而是「按这个速度到期末会用到多少」。
     */
    private static func color(_ w: SummaryWindow) -> NSColor {
        let u = w.pct / 100
        if let t = elapsedFraction(w), t >= 0.15, t < 1, u > 0 {
            let projected = u / t
            if projected < 0.70 { return .adaptiveGreen }
            if projected < 0.90 { return .systemOrange }
            return .systemRed
        }
        if w.pct < 70 { return .adaptiveGreen }
        if w.pct < 90 { return .systemOrange }
        return .systemRed
    }

    /**
     * 配速刻度自身的颜色。与面板的 paceColorVar 同一套六档
     * （复刻自 Claude-Usage-Tracker 的 PaceStatus，MIT）。
     */
    private static func paceColor(_ w: SummaryWindow, _ t: Double) -> NSColor {
        guard t >= 0.03, t < 1 else { return .labelColor }
        guard w.pct > 0 else { return .systemGreen }
        let projected = (w.pct / 100) / t
        if projected < 0.50 { return .systemGreen }
        if projected < 0.75 { return .systemTeal }
        if projected < 0.90 { return .systemYellow }
        if projected < 1.00 { return .systemOrange }
        if projected < 1.20 { return .systemRed }
        return .systemPurple
    }

    /// 只画有意义的窗口，规则与渲染层的 isMeaningful 一致。
    static func meaningful(_ windows: [SummaryWindow]) -> [SummaryWindow] {
        windows.filter { !$0.resets_at.isEmpty || $0.pct > 0 }
    }

    /**
     * windows 为空（还没数据 / 拉取失败）时返回 nil，调用方改用文字标题 ——
     * 画几根空条会让人以为「用量为 0」，那是假数据。
     */
    static func image(for windows: [SummaryWindow]) -> NSImage? {
        let rows = Array(meaningful(windows).prefix(maxBars))
        guard !rows.isEmpty else { return nil }

        let h = CGFloat(rows.count) * barHeight + CGFloat(rows.count - 1) * gap
        let size = NSSize(width: barWidth, height: h)
        let r = barHeight / 2

        let image = NSImage(size: size, flipped: false) { _ in
            for (i, w) in rows.enumerated() {
                let y = h - CGFloat(i + 1) * barHeight - CGFloat(i) * gap
                // 轨道要够明显：菜单栏是半透明的，太淡的灰会直接消失，
                // 用量为 0 的那根就只剩"什么都没有"
                NSColor.labelColor.withAlphaComponent(0.32).setFill()
                NSBezierPath(roundedRect: NSRect(x: 0, y: y, width: barWidth, height: barHeight),
                             xRadius: r, yRadius: r).fill()

                let pct = min(100, max(0, w.pct))
                if pct > 0 {
                    // 至少给 barHeight 宽，否则 1% 会画成看不见的一条缝，等同于「没有数据」
                    let fillW = max(barHeight, barWidth * CGFloat(pct) / 100)
                    color(w).setFill()
                    NSBezierPath(roundedRect: NSRect(x: 0, y: y, width: fillW, height: barHeight),
                                 xRadius: r, yRadius: r).fill()
                }

                // 配速刻度：按时间匀速消耗此刻应该在的位置。
                // 填充越过它 = 烧得比时间快。与面板上那根竖线是同一个含义。
                if let t = elapsedFraction(w), t > 0, t < 1 {
                    let tickW: CGFloat = 1.5
                    let x = min(barWidth - tickW, max(0, round(barWidth * CGFloat(t)) - tickW / 2))
                    paceColor(w, t).setFill()
                    NSBezierPath(roundedRect: NSRect(x: x, y: y - 1, width: tickW, height: barHeight + 2),
                                 xRadius: 0.75, yRadius: 0.75).fill()
                }
            }
            return true
        }
        // 带颜色，不能让系统按模板图重新着色
        image.isTemplate = false
        return image
    }
}

extension NSColor {
    /// 复刻自 Claude-Usage-Tracker 的 adaptiveGreen（MIT）：
    /// 浅色下用更深的森林绿，否则在半透明浅底上读不清。
    static let adaptiveGreen = NSColor(name: nil) { appearance in
        appearance.bestMatch(from: [.darkAqua, .aqua]) == .darkAqua
            ? NSColor(srgbRed: 60 / 255, green: 199 / 255, blue: 95 / 255, alpha: 1)
            : NSColor(srgbRed: 27 / 255, green: 107 / 255, blue: 52 / 255, alpha: 1)
    }
}
