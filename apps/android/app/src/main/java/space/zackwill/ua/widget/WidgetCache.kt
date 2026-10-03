package space.zackwill.ua.widget

import android.content.Context
import android.util.AtomicFile
import org.json.JSONObject
import space.zackwill.ua.MoneyParser
import space.zackwill.ua.Summary
import space.zackwill.ua.SummaryParser
import space.zackwill.ua.UaError
import space.zackwill.ua.WindowMoney
import java.io.File

/**
 * 小部件最近一次的拉取结果。拉取失败时沿用上次成功的数字（并标明「不是最新」），
 * 而不是把整块清空——空白和 0% 都会被误读成真值。
 */
data class WidgetState(
    /** 最近一次**成功**拿到的摘要原文 */
    val raw: String?,
    /** 最近一次拉取（无论成败）的本地时刻 */
    val fetchedAt: Long,
    /** 最近一次拉取的错误；null = 成功 */
    val error: UaError?,
    /** 额度卡底行的折算费用（MoneyParser.toJson）；拉不到时沿用上一次的 */
    val moneyRaw: String? = null,
) {
    val summary: Summary? get() = raw?.let(SummaryParser::parse)
    val money: Map<String, WindowMoney> get() = MoneyParser.fromJson(moneyRaw)
}

object WidgetCache {
    private const val FILE = "widget_state.json"

    private fun file(context: Context) = AtomicFile(File(context.filesDir, FILE))

    fun load(context: Context): WidgetState? = try {
        val o = JSONObject(file(context).readFully().toString(Charsets.UTF_8))
        WidgetState(
            raw = o.optString("raw").ifEmpty { null },
            fetchedAt = o.optLong("fetched_at", 0),
            error = o.optString("error").ifEmpty { null }?.let { name ->
                UaError.entries.firstOrNull { it.name == name }
            },
            moneyRaw = o.optString("money").ifEmpty { null },
        )
    } catch (_: Exception) {
        null
    }

    @Synchronized
    fun save(context: Context, state: WidgetState) {
        val body = JSONObject()
            .put("raw", state.raw ?: "")
            .put("fetched_at", state.fetchedAt)
            .put("error", state.error?.name ?: "")
            .put("money", state.moneyRaw ?: "")
            .toString()
            .toByteArray(Charsets.UTF_8)
        val f = file(context)
        val out = f.startWrite()
        try {
            out.write(body)
            f.finishWrite(out)
        } catch (e: Exception) {
            f.failWrite(out)
        }
    }

    fun clear(context: Context) {
        file(context).delete()
    }
}
