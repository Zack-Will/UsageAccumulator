package space.zackwill.ua

import android.app.Activity
import android.content.Context
import android.content.res.Configuration
import android.os.Bundle
import android.util.TypedValue
import android.view.ViewGroup
import android.widget.FrameLayout
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView
import org.json.JSONArray
import org.json.JSONObject
import space.zackwill.ua.widget.ListWidget
import space.zackwill.ua.widget.SmallWidget
import space.zackwill.ua.widget.UsageWidget
import space.zackwill.ua.widget.WideWidget
import space.zackwill.ua.widget.WidgetModels
import space.zackwill.ua.widget.WidgetSize
import space.zackwill.ua.widget.WidgetState
import java.time.Instant
import java.time.ZoneId

/**
 * 小部件设计预览（只在 debug 包里）：
 *   adb shell am start -n space.zackwill.ua/.WidgetPreviewActivity --es theme dark --es size spec
 * theme = light | dark；size = spec（小米规范 110 / 300×110dp）| real（实测 HyperOS 4 桌面：4×2 = 351×184dp）
 */
class WidgetPreviewActivity : Activity() {
    private data class Scenario(val name: String, val state: WidgetState)

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val dark = intent.getStringExtra("theme") == "dark"
        val real = intent.getStringExtra("size") == "real"
        val ctx = themed(dark)

        val list = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(dp(16), dp(40), dp(16), dp(40))
            setBackgroundColor(if (dark) 0xFF0E0E0D.toInt() else 0xFFD9D6CC.toInt())
        }
        val now = System.currentTimeMillis()
        for (s in scenarios(now)) {
            list.addView(TextView(this).apply {
                text = s.name
                setTextColor(if (dark) 0xFFA6A399.toInt() else 0xFF3D3D3A.toInt())
                setTextSize(TypedValue.COMPLEX_UNIT_SP, 11f)
                setPadding(0, dp(12), 0, dp(6))
            })
            val h = if (real) 184 else 110
            val row = LinearLayout(this).apply { orientation = LinearLayout.HORIZONTAL }
            row.addView(frame(ctx, SmallWidget(), s.state, if (real) 170 else 110, h))
            row.addView(frame(ctx, ListWidget(), s.state, if (real) 170 else 110, h).also {
                (it.layoutParams as ViewGroup.MarginLayoutParams).marginStart = dp(8)
            })
            list.addView(row)
            for (w in listOf<UsageWidget>(WideWidget(), ListWidget())) {
                list.addView(frame(ctx, w, s.state, if (real) 351 else 300, h).also {
                    (it.layoutParams as ViewGroup.MarginLayoutParams).topMargin = dp(8)
                })
            }
        }
        setContentView(ScrollView(this).apply { addView(list) })
    }

    private fun frame(ctx: Context, widget: UsageWidget, state: WidgetState, w: Int, h: Int): FrameLayout {
        val model = WidgetModels.build(state.summary, state.error, System.currentTimeMillis(), ZoneId.systemDefault(), state.money)
        val views = widget.render(ctx, model, state, WidgetSize(w, h))
        val host = FrameLayout(ctx)
        host.addView(views.apply(ctx, host))
        host.layoutParams = LinearLayout.LayoutParams(dp(w), dp(h))
        return host
    }

    private fun themed(dark: Boolean): Context {
        val cfg = Configuration(resources.configuration)
        cfg.uiMode = (cfg.uiMode and Configuration.UI_MODE_NIGHT_MASK.inv()) or
            (if (dark) Configuration.UI_MODE_NIGHT_YES else Configuration.UI_MODE_NIGHT_NO)
        return createConfigurationContext(cfg)
    }

    private fun dp(v: Int) = (v * resources.displayMetrics.density).toInt()

    private fun iso(ms: Long) = Instant.ofEpochMilli(ms).toString()

    private fun summary(captured: Long, stale: Boolean, vararg windows: JSONObject): String =
        JSONObject()
            .put("profile_id", "claude-official")
            .put("windows", JSONArray(windows.toList()))
            .put("captured_at", iso(captured))
            .put("stale", stale)
            .toString()

    private fun w(kind: String, label: String, pct: Double, proj: Double, reset: Long?, eta: Long?) =
        JSONObject()
            .put("window_kind", kind).put("label", label).put("pct", pct).put("projected_pct", proj)
            .put("resets_at", reset?.let(::iso) ?: JSONObject.NULL)
            .put("exhaust_eta", eta?.let(::iso) ?: JSONObject.NULL)

    private val money = MoneyParser.toJson(mapOf(
        "five_hour" to WindowMoney(32.34, 216.0, 0),
        "seven_day" to WindowMoney(118.5, 482.0, 3),
    ))

    private fun scenarios(now: Long): List<Scenario> {
        val min = 60_000L
        val hour = 60 * min
        val day = 24 * hour
        // 代号占位窗口：必须被过滤掉，不能出现在小部件上
        val junk = w("nimbus_quill", "nimbus_quill", 0.0, 0.0, null, null)
        return listOf(
            Scenario("正常", WidgetState(summary(now - 2 * min, false,
                w("five_hour", "5h", 16.0, 35.0, now + 2 * hour, null),
                w("seven_day", "7d", 41.0, 70.0, now + 3 * day, null),
                w("seven_day_fable", "7d Fable", 12.0, 30.0, now + 3 * day, null), junk), now, null, money)),
            Scenario("会耗尽（warn）", WidgetState(summary(now - 2 * min, false,
                w("five_hour", "5h", 74.0, 128.0, now + 3 * hour, now + 95 * min),
                w("seven_day", "7d", 63.0, 96.0, now + 2 * day, null), junk), now, null, money)),
            Scenario("快耗尽（danger）", WidgetState(summary(now - 2 * min, false,
                w("five_hour", "5h", 94.0, 140.0, now + 2 * hour, now + 25 * min),
                w("seven_day", "7d", 88.0, 112.0, now + 2 * day, now + 30 * hour)), now, null)),
            Scenario("拉取失败，沿用旧值", WidgetState(summary(now - 40 * min, true,
                w("five_hour", "5h", 16.0, 35.0, now + 2 * hour, null),
                w("seven_day", "7d", 41.0, 70.0, now + 3 * day, null)), now, UaError.NETWORK, money)),
            Scenario("没有数据", WidgetState(null, now, UaError.UNAUTHORIZED)),
        )
    }
}
