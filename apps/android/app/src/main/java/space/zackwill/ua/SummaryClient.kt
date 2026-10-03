package space.zackwill.ua

import java.io.IOException
import java.net.HttpURLConnection
import java.net.SocketTimeoutException
import java.net.URL

sealed interface FetchResult {
    /** raw 原样留着给小部件做缓存，下次拉取失败时沿用 */
    data class Ok(val summary: Summary, val raw: String) : FetchResult
    data class Err(val error: UaError) : FetchResult
}

/**
 * 同步请求，调用方自己放到后台线程。
 * 小部件的广播处理最多等 8.5 秒（UsageWidget.RECEIVE_WAIT_MS），连接 + 读取两段超时加起来要比它短。
 */
object SummaryClient {
    private const val CONNECT_TIMEOUT_MS = 4_000
    private const val READ_TIMEOUT_MS = 5_000

    fun fetchSummary(config: AppConfig): FetchResult {
        if (!config.isConfigured) return FetchResult.Err(UaError.CONFIG)
        return when (val r = get(config, "/v1/summary")) {
            is Response.Ok -> SummaryParser.parse(r.body)?.let { FetchResult.Ok(it, r.body) }
                ?: FetchResult.Err(UaError.BAD_RESPONSE)
            is Response.Fail -> FetchResult.Err(r.error)
        }
    }

    /**
     * 额度卡底行的折算费用（见 Money.kt）：一次 /v1/windows/current 拿起点和本地占比，
     * 再对每个窗口一次 /v1/distribution。只取 kinds 里的窗口；超过 budgetMs 就不再发新请求，
     * 取不到的窗口直接缺席——小部件显示「—」，不影响额度数字本身。
     */
    fun fetchMoney(config: AppConfig, profileId: String, kinds: List<String>, now: Long, budgetMs: Long): Map<String, WindowMoney> {
        val started = System.currentTimeMillis()
        val profile = if (profileId.isEmpty()) "" else "profile_id=${enc(profileId)}&"
        val cur = get(config, "/v1/windows/current?${profile}burn_points=2") as? Response.Ok ?: return emptyMap()
        val windows = MoneyParser.windows(cur.body).associateBy { it.kind }
        val to = java.time.Instant.ofEpochMilli(now).toString()
        val out = LinkedHashMap<String, WindowMoney>()
        for (kind in kinds) {
            if (System.currentTimeMillis() - started > budgetMs) break
            val w = windows[kind] ?: continue
            // 空闲窗口没有起点：照发会让服务端按缺省回看 7 天，5h 卡上就出现一周的花费
            val from = w.startsAt ?: continue
            val path = "/v1/distribution?${profile}from=${enc(from)}&to=${enc(to)}&by=model"
            val r = get(config, path) as? Response.Ok ?: continue
            MoneyParser.money(r.body, w)?.let { out[kind] = it }
        }
        return out
    }

    private fun enc(s: String): String = java.net.URLEncoder.encode(s, Charsets.UTF_8)

    /** 设置页保存前的连通性检查：`/healthz` 是公开端点，不需要凭证 */
    fun checkHealth(serverUrl: String): UaError? =
        when (val r = get(AppConfig(serverUrl = serverUrl), "/healthz")) {
            is Response.Ok -> null
            is Response.Fail -> r.error
        }

    private sealed interface Response {
        data class Ok(val body: String) : Response
        data class Fail(val error: UaError) : Response
    }

    private fun get(config: AppConfig, path: String): Response {
        val conn = try {
            URL(config.serverUrl + path).openConnection() as HttpURLConnection
        } catch (_: Exception) {
            return Response.Fail(UaError.CONFIG)
        }
        return try {
            conn.requestMethod = "GET"
            conn.connectTimeout = CONNECT_TIMEOUT_MS
            conn.readTimeout = READ_TIMEOUT_MS
            conn.useCaches = false
            // 重定向一律不跟：带着凭证跳到别处等于把凭证递出去
            conn.instanceFollowRedirects = false
            conn.setRequestProperty("Accept", "application/json")
            // Cookie 优先（与浏览器同一身份）；只有配了 token 才带 Bearer
            if (config.sessionCookie.isNotEmpty()) conn.setRequestProperty("Cookie", config.sessionCookie)
            if (config.token.isNotEmpty()) conn.setRequestProperty("Authorization", "Bearer ${config.token}")

            val status = conn.responseCode
            val stream = if (status in 200..299) conn.inputStream else conn.errorStream
            val body = stream?.use { it.readBytes().toString(Charsets.UTF_8) } ?: ""
            if (status in 200..299) Response.Ok(body)
            else Response.Fail(SummaryParser.classifyError(status, body))
        } catch (_: SocketTimeoutException) {
            Response.Fail(UaError.TIMEOUT)
        } catch (_: IOException) {
            Response.Fail(UaError.NETWORK)
        } finally {
            conn.disconnect()
        }
    }
}
