package space.zackwill.ua

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class MoneyParserTest {
    private val current = """
        {"profile_id":"p","windows":[
          {"window_kind":"five_hour","utilization_pct":30,"starts_at":"2026-09-26T00:00:00Z",
           "attribution":{"local_utilization_pct":20}},
          {"window_kind":"seven_day_fable","utilization_pct":12,"starts_at":"2026-09-22T07:00:00Z"},
          {"window_kind":"five_hour_idle","utilization_pct":0,"starts_at":null}
        ]}
    """.trimIndent()

    private val dist = """
        {"buckets":[
          {"key":"claude-opus-5","cost_usd":20.0,"unpriced_events":0},
          {"key":"claude-fable-5-1","cost_usd":10.0,"unpriced_events":2},
          {"key":"mystery-model","cost_usd":null,"unpriced_events":5}
        ]}
    """.trimIndent()

    @Test
    fun familyMatchesDashboard() {
        assertEquals("fable", MoneyParser.family("seven_day_fable"))
        assertNull(MoneyParser.family("seven_day"))
        assertNull(MoneyParser.family("seven_day_scoped"))
        assertNull(MoneyParser.family("five_hour"))
        assertTrue(MoneyParser.modelInFamily("claude-fable-5-1", "fable"))
        assertTrue(MoneyParser.modelInFamily("Fable.5", "fable"))
        assertFalse(MoneyParser.modelInFamily("claude-fablet", "fable"))
    }

    @Test
    fun windowsUseLocalPctWhenPresent() {
        val w = MoneyParser.windows(current)
        assertEquals(20.0, w[0].localPct, 0.0)
        // attribution 缺失时退回官方百分比
        assertEquals(12.0, w[1].localPct, 0.0)
        assertNull(w[2].startsAt)
    }

    @Test
    fun fullWindowCostDividesByLocalPct() {
        val w = MoneyParser.windows(current)
        val all = MoneyParser.money(dist, w[0])!!
        assertEquals(30.0, all.spendUsd!!, 1e-9)
        // $30 ÷ 20% = $150
        assertEquals(150.0, all.fullUsd!!, 1e-9)
        assertEquals(7, all.unpricedEvents)

        // 7d Fable 只算 Fable 那一族
        val fable = MoneyParser.money(dist, w[1])!!
        assertEquals(10.0, fable.spendUsd!!, 1e-9)
        assertEquals(2, fable.unpricedEvents)
    }

    @Test
    fun zeroSpendHasNoFullEstimate() {
        val w = MoneyParser.WindowInfo("seven_day_fable", "x", 5.0)
        val m = MoneyParser.money("""{"buckets":[{"key":"claude-opus-5","cost_usd":9}]}""", w)!!
        assertEquals(0.0, m.spendUsd!!, 0.0)
        assertNull(m.fullUsd)
    }

    @Test
    fun jsonRoundTrip() {
        val m = mapOf("five_hour" to WindowMoney(1.5, null, 2))
        assertEquals(m, MoneyParser.fromJson(MoneyParser.toJson(m)))
        assertTrue(MoneyParser.fromJson("garbage").isEmpty())
    }
}
