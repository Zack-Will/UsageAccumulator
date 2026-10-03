package space.zackwill.ua

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.time.Instant

class SummaryParserTest {
    private val body = """
        {
          "profile_id": "claude-official",
          "tray_title_pct": "62%",
          "windows": [
            { "window_kind": "seven_day", "label": "7d", "pct": 41, "projected_pct": 70,
              "resets_at": "2026-09-24T01:00:00Z", "exhaust_eta": null },
            { "window_kind": "five_hour", "label": "5h", "pct": 62.4, "projected_pct": 87,
              "resets_at": "2026-09-21T10:30:00Z", "exhaust_eta": "2026-09-21T08:42:00Z" },
            { "window_kind": "seven_day_opus", "label": "", "pct": 12 },
            { "window_kind": "broken", "label": "x" }
          ],
          "soonest_exhaust": { "window_kind": "five_hour", "eta": "2026-09-21T08:42:00Z" },
          "captured_at": "2026-09-21T02:30:00Z",
          "stale": true,
          "rate_pct_per_min": 0.21,
          "dashboard_url": "https://ua.example.com"
        }
    """.trimIndent()

    @Test
    fun parsesAndOrdersWindows() {
        val s = SummaryParser.parse(body)!!
        assertEquals("claude-official", s.profileId)
        // 已知窗口固定次序：5h 在前，7d 其次，未知的按原顺序排后面
        assertEquals(listOf("five_hour", "seven_day", "seven_day_opus"), s.windows.map { it.kind })
        val five = s.windows[0]
        assertEquals(62.4, five.pct, 0.0)
        assertEquals(Instant.parse("2026-09-21T08:42:00Z").toEpochMilli(), five.exhaustEta)
        assertNull(s.windows[1].exhaustEta)
        assertTrue(s.stale)
        assertEquals(Instant.parse("2026-09-21T02:30:00Z").toEpochMilli(), s.capturedAt)
    }

    @Test
    fun missingFieldsDegradeInsteadOfFaking() {
        val s = SummaryParser.parse(body)!!
        val opus = s.windows[2]
        // label 缺失退回 window_kind；projected 缺失退回 pct；时间缺失是 null 而不是 0
        assertEquals("seven_day_opus", opus.label)
        assertEquals(12.0, opus.projectedPct, 0.0)
        assertNull(opus.resetsAt)
        // pct 缺失的一行直接丢掉，不能显示成 0%
        assertFalse(s.windows.any { it.kind == "broken" })
    }

    @Test
    fun rejectsNonObjects() {
        assertNull(SummaryParser.parse("not json"))
        assertNull(SummaryParser.parse("[1,2]"))
        assertNull(SummaryParser.parseInstant("yesterday"))
    }

    @Test
    fun classifiesByErrorCodeFirst() {
        assertEquals(UaError.MACHINE_REVOKED, SummaryParser.classifyError(403, """{"error":{"code":"machine_revoked","message":"x"}}"""))
        assertEquals(UaError.UPSTREAM, SummaryParser.classifyError(502, """{"error":{"code":"upstream"}}"""))
        assertEquals(UaError.UNAUTHORIZED, SummaryParser.classifyError(401, "<html>"))
        assertEquals(UaError.RATE_LIMITED, SummaryParser.classifyError(429, null))
        assertEquals(UaError.INTERNAL, SummaryParser.classifyError(503, ""))
        assertEquals(UaError.BAD_REQUEST, SummaryParser.classifyError(302, ""))
    }
}
