package space.zackwill.ua

import org.json.JSONArray
import org.json.JSONObject
import java.time.Instant
import java.time.format.DateTimeParseException

/**
 * `GET /v1/summary` 的响应（docs/CONTRACT.md §2.2），字段与 apps/menubar-mac/Sources/Types.swift 对齐。
 * 时间一律解析成毫秒时间戳；解析不了的当作没给，而不是 0。
 */
data class SummaryWindow(
    /** 稳定 key（five_hour / seven_day / ...），用于排序 */
    val kind: String,
    /** 仅供展示："5h" | "7d" | "7d Fable" */
    val label: String,
    /** 已用百分比 0..100 */
    val pct: Double,
    /** 窗口结束时的预计百分比，可能 > 100 */
    val projectedPct: Double,
    val resetsAt: Long?,
    /** 本窗口的耗尽时刻；null = 本窗口打不满 */
    val exhaustEta: Long?,
)

data class Summary(
    val profileId: String,
    val windows: List<SummaryWindow>,
    /** 额度快照的采集时刻，不是请求时刻 */
    val capturedAt: Long?,
    /** 超过 15 分钟没有新快照 */
    val stale: Boolean,
)

/** 契约 §2 的 error.code，加上几个只在本地发生的情况。UI 只按它分态，不回显服务端自由文本。 */
enum class UaError(val text: String) {
    BAD_REQUEST("请求被拒绝"),
    UNAUTHORIZED("需要登录"),
    MACHINE_REVOKED("凭证已吊销"),
    RATE_LIMITED("被限流"),
    UPSTREAM("上游故障"),
    INTERNAL("服务端故障"),
    CONFIG("未配置"),
    NETWORK("无法连接"),
    TIMEOUT("请求超时"),
    BAD_RESPONSE("响应无法解析");

    /** 凭证类错误要单独成一态：必须去 App 里动手，重试没用 */
    val isAuth: Boolean get() = this == UNAUTHORIZED || this == MACHINE_REVOKED
}

object SummaryParser {
    /** 已知窗口的固定次序：服务端换了顺序也不让小部件里的行跳来跳去 */
    private val KIND_RANK = mapOf("five_hour" to 0, "seven_day" to 1)

    fun parseInstant(v: Any?): Long? {
        val s = v as? String ?: return null
        if (s.isEmpty()) return null
        return try {
            Instant.parse(s).toEpochMilli()
        } catch (_: DateTimeParseException) {
            null
        }
    }

    private fun num(v: Any?): Double? {
        val n = (v as? Number)?.toDouble() ?: return null
        return if (n.isFinite()) n else null
    }

    private fun parseWindow(o: JSONObject): SummaryWindow? {
        val kind = o.optString("window_kind", "")
        val label = o.optString("label", "")
        if (kind.isEmpty() && label.isEmpty()) return null
        // pct 缺失就丢掉这一行：显示 0% 等于冒充真值
        val pct = num(o.opt("pct")) ?: return null
        return SummaryWindow(
            kind = kind,
            label = label.ifEmpty { kind },
            pct = pct,
            projectedPct = num(o.opt("projected_pct")) ?: pct,
            resetsAt = parseInstant(o.opt("resets_at")),
            exhaustEta = parseInstant(o.opt("exhaust_eta")),
        )
    }

    fun parse(body: String): Summary? {
        val root = try {
            JSONObject(body)
        } catch (_: Exception) {
            return null
        }
        val arr = root.optJSONArray("windows") ?: JSONArray()
        val windows = (0 until arr.length())
            .mapNotNull { arr.optJSONObject(it)?.let(::parseWindow) }
            .withIndex()
            .sortedWith(compareBy({ KIND_RANK[it.value.kind] ?: 2 }, { it.index }))
            .map { it.value }
        return Summary(
            profileId = root.optString("profile_id", ""),
            windows = windows,
            capturedAt = parseInstant(root.opt("captured_at")),
            stale = root.optBoolean("stale", false),
        )
    }

    /** 优先看 `{"error":{"code"}}`，取不到再按状态码兜底（契约 §2 的表） */
    fun classifyError(status: Int, body: String?): UaError {
        val code = try {
            body?.let { JSONObject(it).optJSONObject("error")?.optString("code") }
        } catch (_: Exception) {
            null
        }
        when (code) {
            "bad_request" -> return UaError.BAD_REQUEST
            "unauthorized", "forbidden" -> return UaError.UNAUTHORIZED
            "machine_revoked" -> return UaError.MACHINE_REVOKED
            "rate_limited" -> return UaError.RATE_LIMITED
            "upstream" -> return UaError.UPSTREAM
            "internal" -> return UaError.INTERNAL
        }
        return when {
            status == 401 || status == 403 -> UaError.UNAUTHORIZED
            status == 429 -> UaError.RATE_LIMITED
            status >= 500 -> UaError.INTERNAL
            else -> UaError.BAD_REQUEST
        }
    }
}
