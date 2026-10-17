/**
 * 小部件入口：读菜单栏写的快照，排一小时的时间线，每分钟一帧。
 *
 * 每分钟一帧是为了让倒计时、时间刻度、「已停止更新」自己走起来 —— 菜单栏只在数字或状态
 * 真的变了时才点名重画（WidgetFeed），系统给的重画次数有日预算，不能拿来走钟。
 * 帧里只放快照，显示什么由 QuotaModels.build 按帧的时刻现算。
 */
import SwiftUI
import WidgetKit

struct QuotaEntry: TimelineEntry {
    let date: Date
    let snapshot: WidgetSnapshot?
}

struct QuotaProvider: TimelineProvider {
    func placeholder(in context: Context) -> QuotaEntry {
        QuotaEntry(date: Date(), snapshot: nil)
    }

    func getSnapshot(in context: Context, completion: @escaping (QuotaEntry) -> Void) {
        completion(QuotaEntry(date: Date(), snapshot: WidgetFeedFile.load()))
    }

    func getTimeline(in context: Context, completion: @escaping (Timeline<QuotaEntry>) -> Void) {
        let snap = WidgetFeedFile.load()
        // 对齐到整分，倒计时与钟点一起跳
        let start = Calendar.current.dateInterval(of: .minute, for: Date())?.start ?? Date()
        let entries = (0..<60).map { QuotaEntry(date: start.addingTimeInterval(Double($0) * 60), snapshot: snap) }
        completion(Timeline(entries: entries, policy: .atEnd))
    }
}

struct QuotaEntryView: View {
    let entry: QuotaEntry
    @Environment(\.widgetFamily) private var family
    @Environment(\.colorScheme) private var scheme

    var body: some View {
        let model = QuotaModels.build(entry.snapshot, now: entry.date)
        QuotaWidgetView(model: model, size: family == .systemLarge ? .large : family == .systemMedium ? .medium : .small)
            .containerBackground(Palette.of(scheme).surface, for: .widget)
            .widgetURL(URL(string: "usageaccumulator://panel"))
    }
}

struct QuotaWidget: Widget {
    var body: some WidgetConfiguration {
        StaticConfiguration(kind: WidgetFeedFile.kind, provider: QuotaProvider()) { entry in
            QuotaEntryView(entry: entry)
        }
        .configurationDisplayName("额度")
        // 边距由 QuotaWidgetView 自己留（quotaMargin），系统那份去掉，免得叠成两层
        .contentMarginsDisabled()
        .supportedFamilies([.systemSmall, .systemMedium, .systemLarge])
    }
}

@main
struct QuotaWidgetBundle: WidgetBundle {
    var body: some Widget { QuotaWidget() }
}
