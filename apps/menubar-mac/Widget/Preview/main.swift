/**
 * 设计预览：用假数据把各种状态（正常 / 会耗尽 / 快耗尽 / 拉取失败 / 菜单栏停了 / 没有数据）
 * 按三档尺寸、深浅两色画成 PNG，不用每次都往桌面上加小部件。
 * 由 scripts/preview-widget.sh 编译运行，与小部件共用同一份视图和规则。
 */
import AppKit
import SwiftUI

let now = Date()

func iso(_ offset: TimeInterval) -> String { ISO8601DateFormatter().string(from: now.addingTimeInterval(offset)) }

func window(_ kind: String, _ label: String, pct: Double, proj: Double, reset: TimeInterval?, eta: TimeInterval?) -> SummaryWindow {
    SummaryWindow(window_kind: kind, label: label, pct: pct, projected_pct: proj,
                  resets_at: reset.map(iso) ?? "", exhaust_eta: eta.map(iso))
}

func cost(_ usd: Double, events: Int, tokens: Int, models: [(String, Double)], partial: Int = 0) -> WidgetCost {
    WidgetCost(usd: usd, unpriced: 0, partial: partial, events: events, tokens: tokens,
               models: models.map { WidgetModelCost(key: $0.0, usd: $0.1, events: 10) })
}

func extra(start: TimeInterval, rate: Double, p25: Double, p75: Double, local: Double, other: Double,
           ref: Double? = nil, cost c: WidgetCost?) -> WidgetWindowExtra {
    WidgetWindowExtra(starts_at: iso(start), rate_pct_per_min: rate, p25: p25, p75: p75, local_pct: local,
                      other_pct: other, full_ref_usd: ref, full_ref_windows: ref == nil ? nil : 8, cost: c)
}

func snapshot(_ windows: [SummaryWindow], extras: [String: WidgetWindowExtra] = [:], error: UaErrorCode? = nil,
              stale: Bool = false, writtenAgo: TimeInterval = 20) -> WidgetSnapshot {
    WidgetSnapshot(
        written_at: now.addingTimeInterval(-writtenAgo), poll_seconds: 45,
        summary: Summary(profile_id: "claude-official", tray_title_pct: "", windows: windows, soonest_exhaust: nil,
                         captured_at: iso(-140), stale: stale, rate_pct_per_min: 0, dashboard_url: ""),
        error: error, extras: extras
    )
}

let fiveCost = cost(38.42, events: 1284, tokens: 41_200_000, models: [
    ("claude-fable-5-1", 30.10), ("claude-opus-5-5", 6.20), ("claude-sonnet-5-5", 1.90), ("claude-haiku-5-5", 0.22),
])
let weekCost = cost(412.7, events: 15_903, tokens: 512_000_000, models: [
    ("claude-fable-5-1", 288.4), ("claude-opus-5-5", 96.3), ("claude-sonnet-5-5", 25.2), ("claude-haiku-5-5", 2.8),
], partial: 3)
let fableCost = cost(288.4, events: 9_120, tokens: 300_000_000, models: [("claude-fable-5-1", 288.4)])

let normalWindows = [
    window("five_hour", "5h", pct: 42, proj: 71, reset: 2.3 * 3600, eta: nil),
    window("seven_day", "7d", pct: 36, proj: 64, reset: 3.4 * 86400, eta: nil),
    window("seven_day_fable", "7d Fable", pct: 51, proj: 88, reset: 3.4 * 86400, eta: nil),
]
let normalExtras = [
    "five_hour": extra(start: -2.7 * 3600, rate: 0.21, p25: 63, p75: 79, local: 38, other: 4, cost: fiveCost),
    "seven_day": extra(start: -3.6 * 86400, rate: 0.006, p25: 58, p75: 70, local: 33, other: 3, cost: weekCost),
    "seven_day_fable": extra(start: -3.6 * 86400, rate: 0.009, p25: 80, p75: 95, local: 50, other: 1, cost: fableCost),
]

let states: [(String, WidgetSnapshot?)] = [
    ("正常", snapshot(normalWindows, extras: normalExtras)),
    ("会耗尽", snapshot([
        window("five_hour", "5h", pct: 74, proj: 128, reset: 1.6 * 3600, eta: 52 * 60),
        window("seven_day", "7d", pct: 81, proj: 97, reset: 1.2 * 86400, eta: nil),
        window("seven_day_fable", "7d Fable", pct: 93, proj: 112, reset: 1.2 * 86400, eta: 20 * 3600),
    ], extras: [
        "five_hour": extra(start: -3.4 * 3600, rate: 0.36, p25: 118, p75: 139, local: 12, other: 2, ref: 104, cost: fiveCost),
        "seven_day": extra(start: -5.8 * 86400, rate: 0.01, p25: 94, p75: 100, local: 76, other: 5, cost: weekCost),
        "seven_day_fable": extra(start: -5.8 * 86400, rate: 0.012, p25: 106, p75: 118, local: 90, other: 0, cost: fableCost),
    ])),
    ("快耗尽", snapshot([
        window("five_hour", "5h", pct: 96, proj: 140, reset: 1.1 * 3600, eta: 12 * 60),
        window("seven_day", "7d", pct: 58, proj: 77, reset: 4 * 86400, eta: nil),
    ], extras: normalExtras)),
    ("拉取失败", snapshot(normalWindows, extras: normalExtras, error: .network)),
    ("菜单栏停了", snapshot(normalWindows, extras: normalExtras, writtenAgo: 1800)),
    ("5h 空闲", snapshot([
        window("five_hour", "5h", pct: 0, proj: 0, reset: nil, eta: nil),
        window("seven_day", "7d", pct: 36, proj: 64, reset: 3.4 * 86400, eta: nil),
    ], extras: ["seven_day": normalExtras["seven_day"]!])),
    ("未配置", WidgetSnapshot(written_at: now, poll_seconds: 45, summary: nil, error: .config, extras: [:])),
]

/**
 * macOS 桌面小部件的尺寸（pt）随屏幕而变。按偏小的一档出图（2026-10-17 实机：大档约 344×344），
 * 放得下小的，大屏上只会更宽松。
 */
let sizes: [(QuotaSize, String, CGSize)] = [
    (.small, "small", CGSize(width: 164, height: 164)),
    (.medium, "medium", CGSize(width: 344, height: 164)),
    (.large, "large", CGSize(width: 344, height: 344)),
]

struct Tile: View {
    let title: String
    let model: QuotaModel
    let size: QuotaSize
    let frame: CGSize
    let scheme: ColorScheme

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(title).font(.system(size: 11)).foregroundStyle(scheme == .dark ? Color.white.opacity(0.7) : Color.black.opacity(0.6))
            QuotaWidgetView(model: model, size: size)
                .frame(width: frame.width, height: frame.height)
                .background(Palette.of(scheme).surface)
                .clipShape(RoundedRectangle(cornerRadius: 22, style: .continuous))
                .environment(\.colorScheme, scheme)
        }
    }
}

let out = URL(fileURLWithPath: CommandLine.arguments.count > 1 ? CommandLine.arguments[1] : "widget-preview", isDirectory: true)
try FileManager.default.createDirectory(at: out, withIntermediateDirectories: true)

@MainActor
func render() throws {
    for (size, name, frame) in sizes {
        for scheme in [ColorScheme.light, .dark] {
            let perRow = size == .small ? 4 : 2
            let tiles = states.map { ($0.0, QuotaModels.build($0.1, now: now)) }
            let grid = VStack(alignment: .leading, spacing: 18) {
                ForEach(0..<((tiles.count + perRow - 1) / perRow), id: \.self) { r in
                    HStack(alignment: .top, spacing: 18) {
                        ForEach(tiles.indices.filter { $0 / perRow == r }, id: \.self) { i in
                            Tile(title: tiles[i].0, model: tiles[i].1, size: size, frame: frame, scheme: scheme)
                        }
                    }
                }
            }
            .padding(24)
            .background(scheme == .dark ? Color(hex: 0x1F1E1C) : Color(hex: 0xD9D6CC))

            let renderer = ImageRenderer(content: grid)
            renderer.scale = 2
            guard let img = renderer.nsImage, let tiff = img.tiffRepresentation,
                  let png = NSBitmapImageRep(data: tiff)?.representation(using: .png, properties: [:]) else {
                throw NSError(domain: "preview", code: 1)
            }
            let file = out.appendingPathComponent("\(name)-\(scheme == .dark ? "dark" : "light").png")
            try png.write(to: file)
            print("✓ \(file.path)")
        }
    }
}

try MainActor.assumeIsolated { try render() }
