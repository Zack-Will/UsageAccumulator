package space.zackwill.ua.widget

import android.content.Context
import android.content.res.Configuration
import android.graphics.Bitmap
import android.graphics.Canvas
import android.view.View
import android.widget.FrameLayout
import android.widget.RemoteViews
import space.zackwill.ua.R
import kotlin.math.roundToInt

/**
 * 把设计好的小部件界面在**我们自己的进程里**渲染、截成整图，再只把整图交给桌面。
 *
 * 为什么：HyperOS 桌面（Flutter + Rust 重写的 RemoteViews 渲染器）拼复杂布局时总出问题——
 * 调整大小后丢着色指令、几根 ProgressBar 的进度串值、几十张小位图里成片丢掉左边那张卡的元素。
 * 交给它的东西缩到一张图之后，它能出错的地方只剩「换不换这张图」。
 *
 * 浅色、深色各截一张（分别按 layout/ 与 layout-night/ 渲染），桌面按自己的深浅色显示其中一张，
 * 系统切换深色模式不用等下一次刷新。
 * 只截内边距以内的内容区：四角的圆角交给 widget_canvas 布局的底板。
 * 必须用 ARGB_8888：RGB_565 会把深色卡片底色 #262624 量化成另一个颜色，内容区四周出现一圈色差。
 * 4×2 一张约 2.7MB，浅深两张约 5.5MB，在系统给小部件位图的上限（屏幕像素 × 4 × 1.5 ≈ 27MB）以内。
 */
internal object Snapshot {
    private const val PAD_COMPACT_DP = 10
    private const val PAD_ROOMY_DP = 16

    fun wrap(context: Context, design: RemoteViews, size: WidgetSize, description: String): RemoteViews {
        val padDp = if (size.roomy) PAD_ROOMY_DP else PAD_COMPACT_DP
        val views = RemoteViews(context.packageName, if (size.roomy) R.layout.widget_canvas_roomy else R.layout.widget_canvas)
        views.setImageViewBitmap(R.id.canvas_d, draw(context, design, size, padDp, night = false))
        views.setImageViewBitmap(R.id.canvas_n, draw(context, design, size, padDp, night = true))
        views.setContentDescription(android.R.id.background, description)
        return views
    }

    private fun draw(context: Context, design: RemoteViews, size: WidgetSize, padDp: Int, night: Boolean): Bitmap {
        val cfg = Configuration(context.resources.configuration)
        cfg.uiMode = (cfg.uiMode and Configuration.UI_MODE_NIGHT_MASK.inv()) or
            (if (night) Configuration.UI_MODE_NIGHT_YES else Configuration.UI_MODE_NIGHT_NO)
        val themed = context.createConfigurationContext(cfg)

        val density = context.resources.displayMetrics.density
        val w = (size.widthDp * density).roundToInt().coerceAtLeast(1)
        val h = (size.heightDp * density).roundToInt().coerceAtLeast(1)
        val pad = (padDp * density).roundToInt()

        val view = design.apply(themed, FrameLayout(themed))
        view.measure(
            View.MeasureSpec.makeMeasureSpec(w, View.MeasureSpec.EXACTLY),
            View.MeasureSpec.makeMeasureSpec(h, View.MeasureSpec.EXACTLY),
        )
        view.layout(0, 0, w, h)

        val bmp = Bitmap.createBitmap((w - 2 * pad).coerceAtLeast(1), (h - 2 * pad).coerceAtLeast(1), Bitmap.Config.ARGB_8888)
        val canvas = Canvas(bmp)
        canvas.translate(-pad.toFloat(), -pad.toFloat())
        view.draw(canvas)
        return bmp
    }

    /** 读屏用：整图里的文字读不到，给一段完整的文字描述 */
    fun describe(model: WidgetModel): String {
        if (model.rows.isEmpty()) return "额度，${model.status}"
        val rows = model.rows.joinToString("；") { r ->
            buildString {
                append("${r.label} ${r.pct}%")
                r.projected?.let { append("，预计 $it%") }
                (r.eta as? Countdown.Text)?.let { append("，${it.text}") }
            }
        }
        return "$rows。${model.status}"
    }
}
