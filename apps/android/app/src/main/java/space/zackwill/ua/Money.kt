package space.zackwill.ua

import org.json.JSONArray
import org.json.JSONObject

/**
 * 额度卡底行的折算费用：「已用 $32.34 · 满额约 $216」。
 * 算法逐条照搬看板（apps/web/src/components/WindowCards.tsx 的 spend / fullWindowCost）：
 *
 *   · 已用 = 本窗口起点 → 现在，按模型分桶的 cost_usd 之和；7d Fable 这类窗口只算自己那一族模型
 *   · 满额约 = 已用 ÷（本地 Claude Code 吃掉的百分比 / 100）——这个窗口打满值多少钱。
 *     分母必须是 attribution.local_utilization_pct 而不是官方总百分比：官方计的是整个账号，
 *     分子却只有本地事件，混进别处的消耗会把结果系统性压低。
 *   · 花费为 0 时满额约给「—」：那不是误差大，是根本没有可外推的东西。
 *
 * 金额是按公开价目表折算的等价 API 费用，不是实际扣费。
 */
data class WindowMoney(
    /** null = 没取到（不是 $0） */
    val spendUsd: Double?,
    /** null = 无从外推 */
    val fullUsd: Double?,
    /** > 0 = 有模型没报价，已用金额是下界 */
    val unpricedEvents: Int,
)

object MoneyParser {
    /** 与看板 windowModelFamily 一致：seven_day_<family> 只算这一族；scoped 不是模型族 */
    fun family(kind: String): String? {
        if (!kind.startsWith("seven_day_")) return null
        val fam = kind.removePrefix("seven_day_").lowercase()
        return if (fam.isEmpty() || fam == "scoped") null else fam
    }

    /** 与看板 modelInFamily 一致：先剥 `claude-` 前缀，再比家族名 */
    fun modelInFamily(model: String, family: String): Boolean {
        val m = model.trim().lowercase().replace(Regex("^claude[-.]"), "")
        return m == family || m.startsWith("$family-") || m.startsWith("$family.")
    }

    data class WindowInfo(val kind: String, val startsAt: String?, val localPct: Double)

    /** `/v1/windows/current` → 每个窗口的起点与本地占比（attribution 缺失时退回官方百分比） */
    fun windows(body: String): List<WindowInfo> {
        val arr = try {
            JSONObject(body).optJSONArray("windows")
        } catch (_: Exception) {
            null
        } ?: return emptyList()
        return (0 until arr.length()).mapNotNull { i ->
            val w = arr.optJSONObject(i) ?: return@mapNotNull null
            val kind = w.optString("window_kind", "")
            if (kind.isEmpty()) return@mapNotNull null
            val util = w.optDouble("utilization_pct", Double.NaN)
            val local = w.optJSONObject("attribution")?.optDouble("local_utilization_pct", Double.NaN) ?: Double.NaN
            val starts = w.optString("starts_at", "").ifEmpty { null }?.takeIf { it != "null" }
            WindowInfo(kind, starts, if (local.isFinite()) local else util)
        }
    }

    /** `/v1/distribution?by=model` 的桶 + 窗口 → 金额 */
    fun money(distributionBody: String, window: WindowInfo): WindowMoney? {
        val buckets: JSONArray = try {
            JSONObject(distributionBody).optJSONArray("buckets")
        } catch (_: Exception) {
            null
        } ?: return null
        val fam = family(window.kind)
        var usd: Double? = null
        var unpriced = 0
        for (i in 0 until buckets.length()) {
            val b = buckets.optJSONObject(i) ?: continue
            if (fam != null && !modelInFamily(b.optString("key", ""), fam)) continue
            if (!b.isNull("cost_usd")) {
                val c = b.optDouble("cost_usd", Double.NaN)
                if (c.isFinite()) usd = (usd ?: 0.0) + c
            }
            unpriced += b.optInt("unpriced_events", 0)
        }
        // 过滤后一个桶都不剩 = 这个家族本窗口确实没用过，是 $0 而不是「未知」
        val spend = usd ?: 0.0
        val full = if (spend > 0 && window.localPct > 0) spend / (window.localPct / 100) else null
        return WindowMoney(spend, full, unpriced)
    }

    fun toJson(money: Map<String, WindowMoney>): String {
        val o = JSONObject()
        for ((kind, m) in money) {
            o.put(kind, JSONObject()
                .put("spend", m.spendUsd ?: JSONObject.NULL)
                .put("full", m.fullUsd ?: JSONObject.NULL)
                .put("unpriced", m.unpricedEvents))
        }
        return o.toString()
    }

    fun fromJson(raw: String?): Map<String, WindowMoney> {
        if (raw.isNullOrEmpty()) return emptyMap()
        return try {
            val o = JSONObject(raw)
            o.keys().asSequence().associateWith { k ->
                val m = o.getJSONObject(k)
                WindowMoney(
                    spendUsd = if (m.isNull("spend")) null else m.getDouble("spend"),
                    fullUsd = if (m.isNull("full")) null else m.getDouble("full"),
                    unpricedEvents = m.optInt("unpriced", 0),
                )
            }
        } catch (_: Exception) {
            emptyMap()
        }
    }
}
