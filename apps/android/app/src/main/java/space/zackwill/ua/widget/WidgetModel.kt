package space.zackwill.ua.widget

import space.zackwill.ua.Summary
import space.zackwill.ua.SummaryWindow
import space.zackwill.ua.UaError
import space.zackwill.ua.WindowMoney
import java.time.Instant
import java.time.ZoneId
import java.time.ZonedDateTime
import java.time.temporal.ChronoUnit
import kotlin.math.roundToInt

/**
 * 小部件要显示什么——纯函数，不碰 RemoteViews，方便在 JVM 上测。
 * 规则逐条对齐看板的额度卡（apps/web/src/components/WindowCards.tsx）：
 *   · 卡片色 ringTone：已用 ≥ 90 → danger；已用 ≥ 70 或预计 ≥ 95 → warn
 *   · 预计值单独取色：≥ 100 → danger；≥ 90 → warn
 *   · 耗尽提示：剩不到 45 分钟 → danger，否则 warn
 */
enum class Tone { OK, WARN, DANGER, MUTED }

/**
 * 底行的时刻。只写绝对钟点（「03:18 耗尽」），不写倒计时：
 * 小部件两次刷新之间隔着几十分钟，「还剩 54 分钟」挂在桌面上很快就是错的；
 * 而 Chronometer 在 HyperOS 桌面上不可用——它把 elapsedRealtime 基准直接当成剩余时长，
 * 实测显示成「199:58:07 后耗尽」（199 小时正好是手机开机时长）。
 */
sealed interface Countdown {
    data class Text(val text: String) : Countdown
    data object None : Countdown
}

data class WidgetRow(
    val label: String,
    /** 窄列表用：5h / 7d / Fable */
    val shortLabel: String,
    /** 只有数字；百分号由布局用小一号的同款字体画 */
    val pct: String,
    val tone: Tone,
    /** 重置时预计；null = 不值得写（与已用相同） */
    val projected: String?,
    val projectedTone: Tone,
    /** 0..100 */
    val used: Int,
    /** 0..100，额度条浅色那一段 */
    val projectedFill: Int,
    /** 0..100，窗口时间已过去的比例；null = 不知道窗口起点 */
    val pace: Int?,
    val eta: Countdown,
    val etaTone: Tone,
    /** 底行「已用 $32.34」；null = 没取到，显示「—」 */
    val spend: String? = null,
    /** 底行「满额约 $216」；null = 没取到或无从外推 */
    val full: String? = null,
)

data class WidgetModel(
    val rows: List<WidgetRow>,
    /** 右上角那一小行：新鲜时是额度更新钟点，出错时是原因 */
    val status: String,
    val statusTone: Tone,
    /** 数字不是最新的（拉取失败沿用旧值，或快照过期）——整体降一档显示 */
    val dim: Boolean,
    /** 点小部件该去哪：配置问题直接进设置 */
    val tapOpensSettings: Boolean,
)

object WidgetModels {
    private const val DANGER_MS = 45 * 60_000L
    private const val FIVE_HOURS_MS = 5 * 3600_000L
    private const val SEVEN_DAYS_MS = 7 * 24 * 3600_000L
    private val WEEKDAYS = arrayOf("周一", "周二", "周三", "周四", "周五", "周六", "周日")

    /** 与看板 WINDOW_LABEL 一致；认不出的用服务端给的短标签（如「7d Fable」） */
    private val LABELS = mapOf("five_hour" to "5h 窗口", "seven_day" to "7d 窗口")

    /**
     * 哪些窗口值得展示——与看板 isMeaningfulWindow、菜单栏 meaningful 同一判据。
     * 官方响应里有一批代号占位字段（nimbus_quill / amber_gauge…），服务端原样带出，
     * 没有重置时刻又零用量的就是它们。
     */
    fun meaningful(windows: List<SummaryWindow>): List<SummaryWindow> =
        windows.filter { it.resetsAt != null || it.pct > 0 }

    fun build(
        summary: Summary?,
        error: UaError?,
        now: Long,
        zone: ZoneId,
        money: Map<String, WindowMoney> = emptyMap(),
    ): WidgetModel {
        val rows = summary?.let { meaningful(it.windows) }?.map { w ->
            val m = money[w.kind]
            row(w, now, zone).copy(spend = m?.let(::spendText), full = m?.fullUsd?.let(::fullText))
        } ?: emptyList()
        val clock = summary?.capturedAt?.let { formatWhen(it, now, zone) }

        if (error != null) {
            return WidgetModel(
                rows = rows,
                status = error.text,
                statusTone = if (error.isAuth || error == UaError.CONFIG) Tone.DANGER else Tone.WARN,
                dim = rows.isNotEmpty(),
                tapOpensSettings = error == UaError.CONFIG,
            )
        }
        if (summary == null) return WidgetModel(emptyList(), "加载中", Tone.MUTED, dim = false, tapOpensSettings = false)
        return WidgetModel(
            rows = rows,
            status = clock ?: "时间未知",
            statusTone = if (summary.stale || clock == null) Tone.WARN else Tone.MUTED,
            dim = summary.stale,
            tapOpensSettings = false,
        )
    }

    /** 2×2 只放一个窗口：最先耗尽的；都不会耗尽就放用得最多的 */
    fun primary(summary: Summary?, model: WidgetModel): WidgetRow? {
        val windows = summary?.let { meaningful(it.windows) } ?: return null
        if (windows.size != model.rows.size) return model.rows.firstOrNull()
        val idx = windows.indices.minWithOrNull(
            compareBy<Int>({ windows[it].exhaustEta ?: Long.MAX_VALUE }, { -windows[it].pct }),
        ) ?: return null
        return model.rows[idx]
    }

    fun row(w: SummaryWindow, now: Long, zone: ZoneId): WidgetRow {
        val eta = w.exhaustEta
        val tone = when {
            w.pct >= 90 -> Tone.DANGER
            w.pct >= 70 || w.projectedPct >= 95 -> Tone.WARN
            else -> Tone.OK
        }
        val projectedTone = when {
            w.projectedPct >= 100 -> Tone.DANGER
            w.projectedPct >= 90 -> Tone.WARN
            else -> Tone.MUTED
        }
        val eta2: Countdown
        val etaTone: Tone
        when {
            eta != null && eta <= now -> {
                eta2 = Countdown.Text("已耗尽"); etaTone = Tone.DANGER
            }
            eta != null -> {
                eta2 = Countdown.Text("${formatWhen(eta, now, zone)} 耗尽")
                etaTone = if (eta - now < DANGER_MS) Tone.DANGER else Tone.WARN
            }
            w.resetsAt != null -> {
                eta2 = Countdown.Text("${formatWhen(w.resetsAt, now, zone)} 重置"); etaTone = Tone.MUTED
            }
            else -> {
                eta2 = Countdown.None; etaTone = Tone.MUTED
            }
        }
        val used = w.pct.roundToInt()
        val projected = w.projectedPct.roundToInt()
        return WidgetRow(
            label = LABELS[w.kind] ?: w.label,
            shortLabel = shortLabel(w),
            pct = used.toString(),
            tone = tone,
            projected = if (projected > used) projected.toString() else null,
            projectedTone = projectedTone,
            used = used.coerceIn(0, 100),
            projectedFill = projected.coerceIn(0, 100),
            pace = pace(w, now),
            eta = eta2,
            etaTone = etaTone,
        )
    }

    /** 与看板 Cost 一致：两位小数；有模型没报价时金额只是下界，写成「≥」 */
    fun spendText(m: WindowMoney): String? {
        val usd = m.spendUsd ?: return null
        return (if (m.unpricedEvents > 0) "≥" else "") + "$" + "%.2f".format(usd)
    }

    /** 满额约取整：外推出来的数，小数位是假精度 */
    fun fullText(usd: Double): String = "$" + "%.0f".format(usd)

    /** 「7d Fable」在窄列表里只写「Fable」：同一列里前两行已经是 5h / 7d，周窗口的身份不言自明 */
    fun shortLabel(w: SummaryWindow): String = when {
        w.kind == "five_hour" -> "5h"
        w.kind == "seven_day" -> "7d"
        w.kind.startsWith("seven_day_") && w.label.startsWith("7d ") -> w.label.removePrefix("7d ")
        else -> w.label
    }

    /**
     * 时间进度。summary 不带 starts_at，只能由重置时刻倒推：窗口长度按 kind 认，
     * 与服务端 inferWindowMs 同一套规则；认不出来的不画，宁缺勿错。
     */
    fun pace(w: SummaryWindow, now: Long): Int? {
        val reset = w.resetsAt ?: return null
        val len = when {
            w.kind == "five_hour" -> FIVE_HOURS_MS
            w.kind == "seven_day" || w.kind.startsWith("seven_day_") -> SEVEN_DAYS_MS
            else -> return null
        }
        val frac = (now - (reset - len)).toDouble() / len
        return (frac * 100).roundToInt().coerceIn(0, 100)
    }

    /** 今天只写钟点，其余写星期几 + 钟点（7d 窗口一周内必然落在不同的星期几上） */
    fun formatWhen(ms: Long, now: Long, zone: ZoneId): String {
        val t = ZonedDateTime.ofInstant(Instant.ofEpochMilli(ms), zone)
        val today = ZonedDateTime.ofInstant(Instant.ofEpochMilli(now), zone).truncatedTo(ChronoUnit.DAYS)
        val clock = "%02d:%02d".format(t.hour, t.minute)
        return if (t.truncatedTo(ChronoUnit.DAYS) == today) clock
        else "${WEEKDAYS[t.dayOfWeek.value - 1]} $clock"
    }
}
