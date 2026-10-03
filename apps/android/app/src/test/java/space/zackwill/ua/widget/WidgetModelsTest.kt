package space.zackwill.ua.widget

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import space.zackwill.ua.Summary
import space.zackwill.ua.SummaryWindow
import space.zackwill.ua.UaError
import space.zackwill.ua.WindowMoney
import java.time.Instant
import java.time.ZoneId

class WidgetModelsTest {
    private val zone = ZoneId.of("Asia/Shanghai")
    /** 2026-09-21 周一 10:00 北京时间 */
    private val now = Instant.parse("2026-09-21T02:00:00Z").toEpochMilli()
    private val min = 60_000L
    private val hour = 60 * min

    private fun window(
        kind: String,
        pct: Double,
        projected: Double = pct,
        eta: Long? = null,
        resets: Long? = now + 2 * hour,
        label: String = kind,
    ) = SummaryWindow(kind, label, pct, projected, resets, eta)

    private fun summary(vararg w: SummaryWindow, stale: Boolean = false, captured: Long? = now - 2 * min) =
        Summary("p", w.toList(), captured, stale)

    @Test
    fun placeholderWindowsAreDropped() {
        // 官方响应里的代号占位字段：没有重置时刻、零用量。就是它们在小部件上显示成「不明数据源」
        val s = summary(
            window("five_hour", 16.0),
            window("nimbus_quill", 0.0, resets = null),
            window("seven_day", 0.0),
        )
        val m = WidgetModels.build(s, null, now, zone)
        assertEquals(listOf("5h 窗口", "7d 窗口"), m.rows.map { it.label })
    }

    @Test
    fun unknownKindsKeepServerLabel() {
        val r = WidgetModels.row(window("seven_day_fable", 12.0, label = "7d Fable"), now, zone)
        assertEquals("7d Fable", r.label)
    }

    @Test
    fun shortLabelsForNarrowList() {
        assertEquals("5h", WidgetModels.row(window("five_hour", 1.0), now, zone).shortLabel)
        assertEquals("7d", WidgetModels.row(window("seven_day", 1.0), now, zone).shortLabel)
        assertEquals("Fable", WidgetModels.row(window("seven_day_fable", 1.0, label = "7d Fable"), now, zone).shortLabel)
        assertEquals("mystery", WidgetModels.row(window("mystery", 1.0), now, zone).shortLabel)
    }

    @Test
    fun toneFollowsDashboardRingTone() {
        assertEquals(Tone.DANGER, WidgetModels.row(window("a", 91.0), now, zone).tone)
        assertEquals(Tone.WARN, WidgetModels.row(window("a", 72.0), now, zone).tone)
        assertEquals(Tone.WARN, WidgetModels.row(window("a", 40.0, projected = 96.0), now, zone).tone)
        assertEquals(Tone.OK, WidgetModels.row(window("a", 40.0, projected = 80.0), now, zone).tone)
    }

    @Test
    fun projectedHasItsOwnTone() {
        val r = WidgetModels.row(window("a", 40.0, projected = 128.4), now, zone)
        assertEquals("128", r.projected)
        assertEquals(Tone.DANGER, r.projectedTone)
        assertEquals(100, r.projectedFill)
        assertEquals(Tone.WARN, WidgetModels.row(window("a", 40.0, projected = 92.0), now, zone).projectedTone)
        // 预计与已用相同：不写，免得多出一个没信息量的数字
        assertNull(WidgetModels.row(window("a", 40.0, projected = 40.2), now, zone).projected)
    }

    @Test
    fun etaIsAlwaysAnAbsoluteClock() {
        // 不走秒：HyperOS 桌面上的 Chronometer 把 elapsedRealtime 当成剩余时长，实测显示「199:58:07」
        val soon = WidgetModels.row(window("a", 95.0, eta = now + 25 * min), now, zone)
        assertEquals(Countdown.Text("10:25 耗尽"), soon.eta)
        assertEquals(Tone.DANGER, soon.etaTone)

        val later = WidgetModels.row(window("a", 80.0, eta = now + 3 * hour), now, zone)
        assertEquals(Countdown.Text("13:00 耗尽"), later.eta)
        assertEquals(Tone.WARN, later.etaTone)

        val far = WidgetModels.row(window("a", 30.0, eta = now + 50 * hour), now, zone)
        assertEquals(Countdown.Text("周三 12:00 耗尽"), far.eta)

        val past = WidgetModels.row(window("a", 100.0, eta = now - min), now, zone)
        assertEquals(Countdown.Text("已耗尽"), past.eta)

        val calm = WidgetModels.row(window("a", 10.0), now, zone)
        assertEquals(Countdown.Text("12:00 重置"), calm.eta)
        assertEquals(Tone.MUTED, calm.etaTone)
    }

    @Test
    fun moneyIsAttachedByWindowKind() {
        val s = summary(window("five_hour", 30.0), window("seven_day", 24.0))
        val m = WidgetModels.build(s, null, now, zone, mapOf(
            "five_hour" to WindowMoney(32.344, 216.4, 0),
            "seven_day" to WindowMoney(118.5, null, 3),
        ))
        assertEquals("$32.34", m.rows[0].spend)
        assertEquals("$216", m.rows[0].full)
        // 有模型没报价：已用只是下界
        assertEquals("≥$118.50", m.rows[1].spend)
        assertNull(m.rows[1].full)
        // 没取到金额：null，界面上写「—」而不是 $0
        assertNull(WidgetModels.build(s, null, now, zone).rows[0].spend)
    }

    @Test
    fun paceIsDerivedFromResetAndWindowLength() {
        // 5h 窗口 2 小时后重置 → 已过 3/5
        assertEquals(60, WidgetModels.pace(window("five_hour", 1.0, resets = now + 2 * hour), now))
        // 7d 窗口 3.5 天后重置 → 已过一半
        assertEquals(50, WidgetModels.pace(window("seven_day_fable", 1.0, resets = now + 84 * hour), now))
        // 认不出窗口长度就不画
        assertNull(WidgetModels.pace(window("mystery", 1.0), now))
        assertNull(WidgetModels.pace(window("five_hour", 1.0, resets = null), now))
    }

    @Test
    fun pctIsRoundedAndBarClamped() {
        val r = WidgetModels.row(window("a", 104.6), now, zone)
        assertEquals("105", r.pct)
        assertEquals(100, r.used)
    }

    @Test
    fun errorKeepsLastNumbersButDimsThem() {
        val m = WidgetModels.build(summary(window("five_hour", 62.0)), UaError.NETWORK, now, zone)
        assertEquals(1, m.rows.size)
        assertTrue(m.dim)
        assertEquals("无法连接", m.status)
        assertEquals(Tone.WARN, m.statusTone)
    }

    @Test
    fun freshStatusIsCaptureClock() {
        val m = WidgetModels.build(summary(window("five_hour", 62.0)), null, now, zone)
        assertEquals("09:58", m.status)
        assertEquals(Tone.MUTED, m.statusTone)
        assertFalse(m.dim)
    }

    @Test
    fun authErrorWithoutDataShowsNoNumbers() {
        val m = WidgetModels.build(null, UaError.UNAUTHORIZED, now, zone)
        assertTrue(m.rows.isEmpty())
        assertFalse(m.dim)
        assertEquals("需要登录", m.status)
        assertEquals(Tone.DANGER, m.statusTone)
    }

    @Test
    fun unconfiguredTapGoesToSettings() {
        assertTrue(WidgetModels.build(null, UaError.CONFIG, now, zone).tapOpensSettings)
    }

    @Test
    fun staleSnapshotIsFlagged() {
        val m = WidgetModels.build(summary(window("five_hour", 62.0), stale = true), null, now, zone)
        assertTrue(m.dim)
        assertEquals(Tone.WARN, m.statusTone)

        val unknown = WidgetModels.build(summary(window("five_hour", 62.0), captured = null), null, now, zone)
        assertEquals("时间未知", unknown.status)
    }

    @Test
    fun primaryPicksSoonestExhaustThenHighestPct() {
        val s = summary(window("five_hour", 40.0), window("seven_day", 70.0, eta = now + 5 * hour))
        assertEquals("7d 窗口", WidgetModels.primary(s, WidgetModels.build(s, null, now, zone))!!.label)

        val calm = summary(window("five_hour", 40.0), window("seven_day", 70.0))
        assertEquals("7d 窗口", WidgetModels.primary(calm, WidgetModels.build(calm, null, now, zone))!!.label)

        // 占位窗口被滤掉后，下标仍要对得上
        val junk = summary(window("nimbus", 0.0, resets = null), window("five_hour", 40.0, eta = now + 2 * hour))
        assertEquals("5h 窗口", WidgetModels.primary(junk, WidgetModels.build(junk, null, now, zone))!!.label)
    }
}
