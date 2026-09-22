/**
 * 菜单栏里的迷你条，**直接用 NSView 画**，不走 NSImage。
 *
 * 为什么不用图片：2026-09-22 实测，把 24x15 的 NSImage 设进 statusItem.button
 * （thickness=22、bounds=32x22、scaleNone、非模板图，条件全都满足）之后，
 * 系统只渲染出一根横线。落盘的位图是正确的三根条，所以问题出在
 * 「状态栏怎么画这张图」这一层。换成自绘的 NSView 就没有这一层。
 */
import AppKit

final class TrayBarsView: NSView {
    private static let barWidth: CGFloat = 24
    private static let barHeight: CGFloat = 3
    private static let gap: CGFloat = 3
    private static let maxBars = 3
    static let preferredWidth: CGFloat = barWidth + 8

    var windows: [SummaryWindow] = [] {
        didSet { needsDisplay = true }
    }

    /// 异常态（未配置 / 凭证失效 / 还没拉到）交给按钮的文字标题，这里整块隐藏。
    var showsBars = false {
        didSet { isHidden = !showsBars; needsDisplay = true }
    }

    override var isFlipped: Bool { false }

    override func draw(_ dirtyRect: NSRect) {
        let rows = Array(TrayIcon.meaningful(windows).prefix(Self.maxBars))
        guard !rows.isEmpty else { return }

        let totalH = CGFloat(rows.count) * Self.barHeight + CGFloat(rows.count - 1) * Self.gap
        let originX = ((bounds.width - Self.barWidth) / 2).rounded()
        let topY = ((bounds.height + totalH) / 2).rounded()
        let r = Self.barHeight / 2

        for (i, w) in rows.enumerated() {
            let y = topY - CGFloat(i + 1) * Self.barHeight - CGFloat(i) * Self.gap

            NSColor.labelColor.withAlphaComponent(0.32).setFill()
            NSBezierPath(roundedRect: NSRect(x: originX, y: y, width: Self.barWidth, height: Self.barHeight),
                         xRadius: r, yRadius: r).fill()

            let pct = min(100, max(0, w.pct))
            if pct > 0 {
                // 至少给 barHeight 宽，否则 1% 会画成看不见的一条缝，等同于「没有数据」
                let fillW = max(Self.barHeight, Self.barWidth * CGFloat(pct) / 100)
                TrayIcon.statusColor(w).setFill()
                NSBezierPath(roundedRect: NSRect(x: originX, y: y, width: fillW, height: Self.barHeight),
                             xRadius: r, yRadius: r).fill()
            }

            // 配速刻度：按时间匀速消耗此刻应该在的位置
            if let t = TrayIcon.elapsed(w), t > 0, t < 1 {
                let tickW: CGFloat = 1.5
                let x = originX + min(Self.barWidth - tickW, max(0, (Self.barWidth * CGFloat(t)).rounded() - tickW / 2))
                TrayIcon.paceTint(w, t).setFill()
                NSBezierPath(roundedRect: NSRect(x: x, y: y - 1, width: tickW, height: Self.barHeight + 2),
                             xRadius: 0.75, yRadius: 0.75).fill()
            }
        }
    }
}
