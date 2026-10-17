/**
 * 三档小部件的视图。小档、中档照搬安卓小部件（= 看板额度卡的桌面版）：
 * 标题 · 衬线大数字 + 重置时预计 · 额度条（已用 / 预计 / 时间刻度）· 耗尽或重置时刻。
 * 大档是 Mac 独有的：两张完整的额度卡（含看板同款金额栏）+ 其余窗口列表 + 按模型的花费。
 *
 * 不依赖 WidgetKit 的环境值，预览工具（scripts/preview-widget.sh）用同一份视图出图。
 */
import SwiftUI

enum QuotaSize { case small, medium, large }

/// 四周的安全边距。系统默认边距下内容贴着上下边，挤（2026-10-17 实机反馈），统一自己留
let quotaMargin: CGFloat = 18

struct QuotaWidgetView: View {
    let model: QuotaModel
    let size: QuotaSize
    @Environment(\.colorScheme) private var scheme

    var body: some View {
        let p = Palette.of(scheme)
        Group {
            switch size {
            case .small: SmallLayout(model: model)
            case .medium: MediumLayout(model: model)
            case .large: LargeLayout(model: model)
            }
        }
        .environment(\.palette, p)
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        .padding(quotaMargin)
    }
}

// ── 三档 ─────────────────────────────────────────────────────────────
//
// 小部件的实际尺寸随屏幕而变（同一个大档，有的 Mac 上 364×382，有的只有 344×344），
// 写死一种版式迟早溢出：内容比格子高时系统会上下一起裁，顶部贴边、底部被切。
// 所以每一档都按 ViewThatFits 从信息最全的版本往下试，放得下哪个用哪个。

/// 一张卡：最先耗尽的窗口，都不会耗尽时取用量最高的
private struct SmallLayout: View {
    let model: QuotaModel

    var body: some View {
        if let row = model.primary {
            ViewThatFits(in: .vertical) {
                CardSlot(row: row, dim: model.dim, status: model, money: .line)
                CardSlot(row: row, dim: model.dim, status: model, money: .none)
            }
        } else {
            EmptyCard(model: model)
        }
    }
}

/// 5h / 7d 两张卡并排
private struct MediumLayout: View {
    let model: QuotaModel

    var body: some View {
        let rows = Array(model.rows.prefix(2))
        if rows.isEmpty {
            EmptyCard(model: model)
        } else {
            ViewThatFits(in: .vertical) {
                cards(rows, money: .line)
                cards(rows, money: .none)
            }
        }
    }

    private func cards(_ rows: [QuotaRow], money: MoneyStyle) -> some View {
        HStack(alignment: .top, spacing: 20) {
            ForEach(rows.indices, id: \.self) { i in
                // 状态放在最右一张卡的标题行尾，与看板顶栏右侧的「额度更新时刻」同一个位置
                CardSlot(row: rows[i], dim: model.dim, status: i == rows.count - 1 ? model : nil, money: money)
            }
        }
    }
}

/**
 * 大档：尽量把看板首屏的信息搬上桌面。
 *   顶部两张完整额度卡（耗尽 · 倒计时 · 速度 · 重置 · 已用 / 满额约 · 调用次数 / 非 Code 占比）
 *   中间其余窗口（7d Fable 等）一行一个
 *   底部两栏按模型的花费，与上面两张卡对齐
 * 放不下时依次少画模型行、去掉模型栏、去掉倒计时与速度、去掉其余窗口。
 */
private struct LargeLayout: View {
    let model: QuotaModel

    var body: some View {
        let cards = Array(model.rows.prefix(2))
        let rest = Array(model.rows.dropFirst(2).prefix(2))
        if cards.isEmpty {
            EmptyCard(model: model)
        } else {
            ViewThatFits(in: .vertical) {
                // 倒计时与速度比模型明细要紧：先减模型行，最后才去掉它们
                variant(cards, rest, models: 3, detail: true)
                variant(cards, rest, models: 2, detail: true)
                variant(cards, rest, models: 1, detail: true)
                variant(cards, rest, models: 0, detail: true)
                variant(cards, rest, models: 0, detail: false)
                variant(cards, [], models: 0, detail: false)
            }
        }
    }

    private func variant(_ cards: [QuotaRow], _ rest: [QuotaRow], models: Int, detail: Bool) -> some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack(alignment: .top, spacing: 20) {
                ForEach(cards.indices, id: \.self) { i in
                    CardSlot(row: cards[i], dim: model.dim, status: i == cards.count - 1 ? model : nil,
                             money: .full, detail: detail)
                }
            }
            if !rest.isEmpty {
                Rule().padding(.vertical, 8)
                VStack(spacing: 8) {
                    ForEach(rest.indices, id: \.self) { i in ListRow(row: rest[i], dim: model.dim) }
                }
            }
            if models > 0 {
                Rule().padding(.vertical, 8)
                HStack(alignment: .top, spacing: 20) {
                    ForEach(cards.indices, id: \.self) { i in
                        ModelColumn(row: cards[i], limit: models, dim: model.dim)
                    }
                }
            }
        }
    }
}

// ── 部件 ─────────────────────────────────────────────────────────────

private enum MoneyStyle { case none, line, full }

private struct CardSlot: View {
    let row: QuotaRow
    let dim: Bool
    /// 非 nil：在标题行尾写状态
    var status: QuotaModel?
    var money: MoneyStyle
    /// 大档：倒计时、速度、重置另起一行
    var detail = false
    @Environment(\.palette) private var p
    private let t = TypeScale.card

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack(alignment: .firstTextBaseline, spacing: 4) {
                Text(row.label).font(UAFont.serif(t.title, weight: 600)).foregroundStyle(p.text2)
                Spacer(minLength: 4)
                if let status {
                    Text(status.status).font(UAFont.serif(t.status)).foregroundStyle(p.text(status.statusTone))
                }
            }
            .lineLimit(1)

            HStack(alignment: .lastTextBaseline, spacing: 6) {
                Pct(value: row.pct, size: t.num, tone: dim || row.idle ? .muted : row.tone)
                if let proj = row.projected {
                    ViewThatFits(in: .horizontal) {
                        projected(proj, band: row.band)
                        projected(proj, band: nil)
                        Color.clear.frame(width: 0, height: 0)
                    }
                }
            }
            .padding(.top, 1)

            QuotaBar(row: row, dim: dim, height: t.bar, tick: t.tick).padding(.top, 4)

            EtaLine(row: row, dim: dim, size: t.eta, until: detail).padding(.top, 6)

            if detail {
                let meta = [row.rate, row.reset].compactMap { $0 }
                Text(meta.isEmpty ? " " : meta.joined(separator: " · "))
                    .font(UAFont.serif(t.moneyLabel)).foregroundStyle(p.text3).lineLimit(1)
                    .fixedSize()
                    .padding(.top, 2)
            }

            switch money {
            case .none: EmptyView()
            case .line: MoneyLine(row: row).padding(.top, 6)
            case .full: MoneyBlock(row: row).padding(.top, 8)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private func projected(_ proj: Int, band: Int?) -> some View {
        HStack(alignment: .lastTextBaseline, spacing: 3) {
            Text("预计").font(UAFont.serif(t.projLabel)).foregroundStyle(p.text3)
            Text("\(proj)%").font(UAFont.serif(t.proj, weight: 600))
                .foregroundStyle(dim || row.projectedTone == .muted ? p.text2 : p.text(row.projectedTone))
            if let band {
                Text("±\(band)").font(UAFont.serif(t.projLabel)).foregroundStyle(p.text3)
            }
        }
        .lineLimit(1)
        .fixedSize()
    }
}

/// 没有任何窗口可画：标题 + 「--」+ 状态（加载中 / 未配置 / 无法连接）
private struct EmptyCard: View {
    let model: QuotaModel
    @Environment(\.palette) private var p

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text("额度").font(UAFont.serif(13, weight: 600)).foregroundStyle(p.text2)
            Text("--").font(UAFont.serif(40, weight: 440)).foregroundStyle(p.text3)
            Text(model.status).font(UAFont.serif(13)).foregroundStyle(p.text(model.statusTone))
        }
        .lineLimit(1)
    }
}

/// 衬线大数字 + 小一号的百分号。看板：ok 时是正文色，warn / danger 才上色
private struct Pct: View {
    let value: Int
    let size: CGFloat
    let tone: Tone
    @Environment(\.palette) private var p

    var body: some View {
        (Text("\(value)").font(UAFont.serif(size, weight: 440))
            + Text("%").font(UAFont.serif(size * 0.5, weight: 440)))
            .foregroundStyle(p.text(tone))
            .lineLimit(1)
            .fixedSize()
    }
}

/// 额度条：已用实心、预计半透明、时间进度一根竖线（看板 QuotaBar）
private struct QuotaBar: View {
    let row: QuotaRow
    let dim: Bool
    let height: CGFloat
    let tick: CGFloat
    @Environment(\.palette) private var p

    var body: some View {
        GeometryReader { geo in
            let w = geo.size.width
            let tone: Tone = dim ? .muted : row.tone
            ZStack(alignment: .leading) {
                Capsule().fill(p.track).frame(width: w, height: height)
                Capsule().fill(p.bar(tone).opacity(0.32)).frame(width: len(row.projectedFill, w), height: height)
                Capsule().fill(p.bar(tone)).frame(width: len(row.used, w), height: height)
                if let pace = row.pace {
                    let x = min(w - 1, max(1, w * pace))
                    RoundedRectangle(cornerRadius: 1).fill(p.pace)
                        .frame(width: 2, height: tick)
                        .offset(x: x - 1)
                }
            }
            .frame(height: tick)
        }
        .frame(height: tick)
    }

    /// 太短的段至少画成一个圆点，否则 1% 会细成看不见的一条缝
    private func len(_ v: Int, _ w: CGFloat) -> CGFloat { v <= 0 ? 0 : max(height, w * CGFloat(min(100, v)) / 100) }
}

private struct EtaLine: View {
    let row: QuotaRow
    let dim: Bool
    let size: CGFloat
    /// 写上「· 2 小时 5 分后」：小部件的时间线每分钟一帧，倒计时不会挂着过期
    var until: Bool
    @Environment(\.palette) private var p

    var body: some View {
        let tone: Tone = dim ? .muted : row.etaTone
        let loud = tone == .warn || tone == .danger
        HStack(spacing: 5) {
            if loud { Circle().fill(p.bar(tone)).frame(width: 6, height: 6) }
            ViewThatFits(in: .horizontal) {
                if until, let u = row.etaUntil { text(row.eta ?? "", u, tone) }
                text(row.eta ?? " ", nil, tone)
            }
        }
    }

    private func text(_ eta: String, _ until: String?, _ tone: Tone) -> some View {
        HStack(spacing: 0) {
            Text(eta).foregroundStyle(tone == .muted ? p.text3 : p.text(tone))
            if let until { Text(" · \(until)").foregroundStyle(p.text3) }
        }
        .font(UAFont.serif(size))
        .lineLimit(1)
        .fixedSize()
    }
}

/// 窄卡的金额：一行「已用 $32.34 · 满额约 $216」，放不下时只留满额约
private struct MoneyLine: View {
    let row: QuotaRow
    @Environment(\.palette) private var p
    private let t = TypeScale.card

    var body: some View {
        ViewThatFits(in: .horizontal) {
            HStack(spacing: 0) {
                pair("已用", row.spend ?? "—", strong: false)
                Text(" · ").foregroundStyle(p.text3)
                pair("满额约", row.full ?? "—", strong: true)
            }
            pair("满额约", row.full ?? "—", strong: true)
        }
        .font(UAFont.serif(12))
        .lineLimit(1)
    }

    private func pair(_ k: String, _ v: String, strong: Bool) -> some View {
        HStack(spacing: 3) {
            Text(k).foregroundStyle(p.text3)
            Text(v).font(UAFont.serif(12, weight: 600))
                .foregroundStyle(strong && row.fullIsRef ? p.text3 : p.text)
        }
        .fixedSize()
    }
}

/// 看板的 .quota__money：一条细线 + 左右两栏，每栏上标签、中数字、下注脚
private struct MoneyBlock: View {
    let row: QuotaRow
    @Environment(\.palette) private var p
    private let t = TypeScale.card

    var body: some View {
        VStack(spacing: 6) {
            Rule()
            HStack(alignment: .top) {
                column("已用", row.spend ?? "—", row.calls, align: .leading, muted: false)
                Spacer(minLength: 6)
                column("满额约", row.full ?? "—", row.otherShare, align: .trailing, muted: row.fullIsRef)
            }
        }
    }

    private func column(_ k: String, _ v: String, _ note: String?, align: HorizontalAlignment, muted: Bool) -> some View {
        VStack(alignment: align, spacing: 1) {
            Text(k).font(UAFont.serif(t.moneyLabel)).foregroundStyle(p.text3)
            Text(v).font(UAFont.serif(t.money, weight: 600)).foregroundStyle(muted ? p.text3 : p.text)
            // 「1,284 次调用 · 41.2M」半张卡放不下时去掉 token 数
            ViewThatFits(in: .horizontal) {
                Text(note ?? " ").fixedSize()
                Text(note?.components(separatedBy: " · ").first ?? " ").fixedSize()
            }
            .font(UAFont.serif(10)).foregroundStyle(p.text3)
        }
        .lineLimit(1)
    }
}

/// 一个窗口一行：短标签 · 数字 · 条 · 时刻
private struct ListRow: View {
    let row: QuotaRow
    let dim: Bool
    @Environment(\.palette) private var p
    private let t = TypeScale.list

    var body: some View {
        HStack(spacing: 8) {
            Text(row.shortLabel).font(UAFont.serif(t.title, weight: 600)).foregroundStyle(p.text2)
                .frame(width: 44, alignment: .leading)
            Pct(value: row.pct, size: t.num, tone: dim || row.idle ? .muted : row.tone)
                .frame(width: 46, alignment: .leading)
            QuotaBar(row: row, dim: dim, height: t.bar, tick: t.tick)
            EtaLine(row: row, dim: dim, size: t.eta, until: false)
                .frame(width: 104, alignment: .trailing)
        }
        .lineLimit(1)
    }
}

/// 本窗口按模型的花费：名字 · 金额，下面一根占比细条
private struct ModelColumn: View {
    let row: QuotaRow
    let limit: Int
    let dim: Bool
    @Environment(\.palette) private var p

    var body: some View {
        VStack(alignment: .leading, spacing: 5) {
            Text("\(row.shortLabel) 按模型").font(UAFont.serif(11)).foregroundStyle(p.text3)
            if row.models.isEmpty {
                Text(row.idle ? "空闲" : "—").font(UAFont.serif(12)).foregroundStyle(p.text3)
            }
            ForEach(Array(row.models.prefix(limit).enumerated()), id: \.offset) { _, m in
                VStack(spacing: 2) {
                    HStack(spacing: 4) {
                        Text(m.name).foregroundStyle(p.text2)
                        Spacer(minLength: 4)
                        Text(m.usd).font(UAFont.serif(12, weight: 600)).foregroundStyle(p.text)
                    }
                    .font(UAFont.serif(12))
                    .lineLimit(1)
                    GeometryReader { geo in
                        ZStack(alignment: .leading) {
                            Capsule().fill(p.track)
                            Capsule().fill(dim ? p.mutedG : p.text3.opacity(0.7))
                                .frame(width: m.fraction > 0 ? max(3, geo.size.width * m.fraction) : 0)
                        }
                    }
                    .frame(height: 3)
                }
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

private struct Rule: View {
    @Environment(\.palette) private var p
    var body: some View { Rectangle().fill(p.border).frame(height: 1) }
}

// ── 环境 ─────────────────────────────────────────────────────────────

private struct PaletteKey: EnvironmentKey {
    static let defaultValue = Palette.light
}

extension EnvironmentValues {
    var palette: Palette {
        get { self[PaletteKey.self] }
        set { self[PaletteKey.self] = newValue }
    }
}
