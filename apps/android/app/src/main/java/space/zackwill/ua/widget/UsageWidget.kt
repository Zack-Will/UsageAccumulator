package space.zackwill.ua.widget

import android.app.PendingIntent
import android.appwidget.AppWidgetManager
import android.appwidget.AppWidgetProvider
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.content.res.ColorStateList
import android.content.res.Configuration
import android.os.Bundle
import android.util.Log
import android.view.View
import android.widget.RemoteViews
import space.zackwill.ua.AppConfig
import space.zackwill.ua.FetchResult
import space.zackwill.ua.MainActivity
import space.zackwill.ua.MoneyParser
import space.zackwill.ua.R
import space.zackwill.ua.SettingsActivity
import space.zackwill.ua.SummaryClient
import space.zackwill.ua.UaError
import java.time.ZoneId
import kotlin.concurrent.thread

/**
 * 桌面给的格子大小（dp）。小部件可以拖动改大小，布局按它现选：
 *   · 高 ≥ 150dp → 宽松档（字号照看板原尺寸）；否则紧凑档（按小米最小尺寸 110dp 高排）
 *   · 宽 ≥ 250dp → 放得下两张卡 / 列表的右侧时刻列
 * 实测 HyperOS 4 桌面：2 行高 184dp，4 列宽 351dp。
 */
data class WidgetSize(val widthDp: Int, val heightDp: Int) {
    val roomy: Boolean get() = heightDp >= ROOMY_MIN_HEIGHT_DP
    val wide: Boolean get() = widthDp >= WIDE_MIN_WIDTH_DP

    companion object {
        const val ROOMY_MIN_HEIGHT_DP = 150
        const val WIDE_MIN_WIDTH_DP = 250

        /** 竖屏时格子是 MIN_WIDTH × MAX_HEIGHT（横屏才是 MAX_WIDTH × MIN_HEIGHT） */
        fun of(options: Bundle, fallback: WidgetSize): WidgetSize {
            val w = options.getInt(AppWidgetManager.OPTION_APPWIDGET_MIN_WIDTH)
            val h = options.getInt(AppWidgetManager.OPTION_APPWIDGET_MAX_HEIGHT)
            return if (w > 0 && h > 0) WidgetSize(w, h) else fallback
        }
    }
}

/**
 * 所有小部件共用的刷新逻辑。刷新来源：
 *   · 系统定时（updatePeriodMillis，最短 30 分钟）
 *   · 小米曝光刷新：看到桌面时系统发 miui.appwidget.action.APPWIDGET_UPDATE（要过审，见 README）
 *   · App 自己：页面加载完、离开前台、改设置、App 升级后（WidgetUpdater.requestAll）
 *   · 拖动改大小后按新尺寸重画（用缓存，不重新拉取）
 */
abstract class UsageWidget : AppWidgetProvider() {
    /** 桌面没报尺寸时按这个画（= 小部件声明的默认尺寸） */
    protected abstract val defaultSize: WidgetSize

    /** 预览页（src/debug）也要调，所以不是 protected */
    abstract fun render(context: Context, model: WidgetModel, state: WidgetState?, size: WidgetSize): RemoteViews

    override fun onReceive(context: Context, intent: Intent) {
        when (intent.action) {
            ACTION_MIUI_UPDATE, AppWidgetManager.ACTION_APPWIDGET_UPDATE -> {
                val ids = intent.getIntArrayExtra(AppWidgetManager.EXTRA_APPWIDGET_IDS) ?: allIds(context)
                if (ids.isNotEmpty()) refresh(context, ids, force = intent.getBooleanExtra(EXTRA_FORCE, false))
            }
            else -> super.onReceive(context, intent)
        }
    }

    override fun onAppWidgetOptionsChanged(context: Context, manager: AppWidgetManager, id: Int, newOptions: Bundle) {
        val app = context.applicationContext
        push(app, manager, intArrayOf(id), WidgetCache.load(app))
    }

    private fun allIds(context: Context): IntArray =
        AppWidgetManager.getInstance(context).getAppWidgetIds(ComponentName(context, javaClass))

    private fun refresh(context: Context, ids: IntArray, force: Boolean) {
        val app = context.applicationContext
        val manager = AppWidgetManager.getInstance(app)
        val cached = WidgetCache.load(app)
        // 先把缓存画上去：网络再慢，桌面上也不会是一块空白
        push(app, manager, ids, cached)

        val now = System.currentTimeMillis()
        // 几个小部件同时收到刷新时，别各发一次请求
        if (!force && cached != null && cached.error == null && now - cached.fetchedAt < THROTTLE_MS) return

        // 不用 goAsync：HyperOS 的进程冻结（GreezeManager）不认它——onReceive 一返回，
        // 小部件进程就被冻住，网络请求停在半路，直到用户打开 App 才解冻，拿到的是 TIMEOUT。
        // 所以主线程**等**后台线程拉完再返回：正在处理广播的进程不会被冻结。
        // 网络仍在后台线程里发（主线程联网会被 StrictMode 拦下），主线程只是等。
        val worker = thread(name = "ua-widget") {
            try {
                val config = AppConfig.load(app)
                var result = SummaryClient.fetchSummary(config)
                // 失败得这么快不可能是真超时，是系统还没放开网络（刚升级、刚解冻）：等一下再试一次
                if (result is FetchResult.Err && result.error == UaError.NETWORK &&
                    System.currentTimeMillis() - now < RETRY_IF_FAILED_WITHIN_MS
                ) {
                    Thread.sleep(RETRY_DELAY_MS)
                    result = SummaryClient.fetchSummary(config)
                }
                val next = when (val r = result) {
                    is FetchResult.Ok -> {
                        // 底行金额只给卡片的前两个窗口用；剩下的时间不够就不取
                        val kinds = WidgetModels.meaningful(r.summary.windows).take(2).map { it.kind }
                        val budget = MONEY_BUDGET_MS - (System.currentTimeMillis() - now)
                        val money = if (budget > 0) SummaryClient.fetchMoney(config, r.summary.profileId, kinds, now, budget) else emptyMap()
                        val merged = (cached?.money ?: emptyMap()) + money
                        WidgetState(r.raw, now, null, MoneyParser.toJson(merged))
                    }
                    is FetchResult.Err -> WidgetState(cached?.raw, now, r.error, cached?.moneyRaw)
                }
                WidgetCache.save(app, next)
                push(app, manager, ids, next)
            } catch (e: Exception) {
                Log.w(TAG, "widget refresh failed: ${e.javaClass.simpleName}")
            }
        }
        // 广播处理的上限是 10 秒，留出余量；超时就先返回，线程若被冻结，解冻后照样会画完
        worker.join(RECEIVE_WAIT_MS)
    }

    private fun push(context: Context, manager: AppWidgetManager, ids: IntArray, state: WidgetState?) {
        val model = WidgetModels.build(
            state?.summary, state?.error, System.currentTimeMillis(), ZoneId.systemDefault(), state?.money ?: emptyMap(),
        )
        val tap = tapIntent(context, model)
        for (id in ids) {
            val size = WidgetSize.of(manager.getAppWidgetOptions(id), defaultSize)
            val views = render(context, model, state, size)
            views.setOnClickPendingIntent(android.R.id.background, tap)
            manager.updateAppWidget(id, views)
            Log.i(TAG, "${javaClass.simpleName}#$id size=${size.widthDp}x${size.heightDp} " +
                "rows=${model.rows.size} status=${state?.error?.name ?: "ok"}")
        }
    }

    private fun tapIntent(context: Context, model: WidgetModel): PendingIntent {
        val target = if (model.tapOpensSettings) SettingsActivity::class.java else MainActivity::class.java
        val intent = Intent(context, target).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        return PendingIntent.getActivity(
            context,
            if (model.tapOpensSettings) 1 else 0,
            intent,
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
        )
    }

    companion object {
        private const val TAG = "UaWidget"
        const val ACTION_MIUI_UPDATE = "miui.appwidget.action.APPWIDGET_UPDATE"
        const val EXTRA_FORCE = "space.zackwill.ua.FORCE"
        private const val THROTTLE_MS = 20_000L
        /** 主线程最多等这么久（广播处理上限 10 秒） */
        private const val RECEIVE_WAIT_MS = 8_500L
        /** summary 之后留给金额请求的时间（从本次刷新开始算），整体要落在 RECEIVE_WAIT_MS 以内 */
        private const val MONEY_BUDGET_MS = 7_000L
        private const val RETRY_IF_FAILED_WITHIN_MS = 1_000L
        private const val RETRY_DELAY_MS = 1_500L
    }
}

// ── 绑定：卡片和列表共用 ────────────────────────────────────────────
//
// 所有文字都是 TextArt 画的白色衬线位图（小米会把 TextView 的字体强制换成 MiSans），颜色靠着色。
//
// 着色**不能给资源 id** 让桌面去解析：小米桌面在调整大小后重建界面时，按资源 id 读颜色的指令会失效，
// 字形停在白色、画在白卡片上，实测整块小部件的文字全部「消失」（进度条这类写在布局里的颜色不受影响）。
// 所以浅色、深色两套颜色值由我们在自己的进程里算好，直接放进指令（API 31 的日/夜双值写法），
// 桌面只按自己当前的深浅色挑一个——系统切换深色模式时仍然不用等下一次刷新。

/** 字号（sp）。与看板 claude.css 对应：.card__title 13 · .num--xl 46（桌面上收到 40）· .quota__eta 13 */
data class Type(
    val title: Float,
    val status: Float,
    val num: Float,
    val projLabel: Float = 0f,
    val proj: Float = 0f,
    val eta: Float = 0f,
    val moneyLabel: Float = 0f,
    val money: Float = 0f,
) {
    companion object {
        val CARD_COMPACT = Type(title = 12f, status = 11f, num = 26f, projLabel = 11f, proj = 13f, eta = 12f)
        val CARD_ROOMY = Type(title = 13f, status = 12f, num = 40f, projLabel = 12f, proj = 15f, eta = 13f, moneyLabel = 11f, money = 14f)
        val LIST_COMPACT = Type(title = 11f, status = 11f, num = 17f, eta = 11f)
        val LIST_ROOMY = Type(title = 12f, status = 12f, num = 22f, eta = 12f)
        val NARROW_COMPACT = Type(title = 11f, status = 11f, num = 14f)
        val NARROW_ROOMY = Type(title = 12f, status = 12f, num = 18f)
    }
}

/** 一个窗口在布局里用到的 view id。卡片和列表的额度条、时刻部分结构相同 */
data class SlotIds(
    val root: Int,
    val label: Int,
    val pct: Int,
    /** 四种状态色各一根条，按 OK / WARN / DANGER / MUTED 的顺序 */
    val bars: List<Int>,
    val pace: Int,
    val dot: Int,
    val eta: Int,
    /** 卡片才有：重置时预计 */
    val proj: Int? = null,
    val projLabel: Int? = null,
    val projValue: Int? = null,
    /** 卡片才有：标题行尾的状态 */
    val status: Int? = null,
    /** 列表才有：右侧时刻列（窄列表整列隐藏） */
    val etaBox: Int? = null,
    /** 宽松档卡片才有：底行「已用 · 满额约」 */
    val spendLabel: Int? = null,
    val spend: Int? = null,
    val fullLabel: Int? = null,
    val full: Int? = null,
)

internal object Bind {
    /**
     * 实验开关：true = 按当前深浅色把颜色直接画进位图，不下着色指令。
     * 用来判断 HyperOS 桌面调整大小后文字消失，是丢了着色还是丢了位图。
     */
    private const val BAKE_COLORS = true

    private val BAR_TONES = listOf(Tone.OK, Tone.WARN, Tone.DANGER, Tone.MUTED)

    /** 颜色资源 → (浅色值, 深色值)。按 uiMode 各建一个配置上下文去读，不经过桌面 */
    private val tints = HashMap<Int, Pair<ColorStateList, ColorStateList>>()

    @Synchronized
    private fun tintPair(context: Context, colorRes: Int): Pair<ColorStateList, ColorStateList> =
        tints.getOrPut(colorRes) {
            fun read(night: Boolean): ColorStateList {
                val cfg = Configuration(context.resources.configuration)
                cfg.uiMode = (cfg.uiMode and Configuration.UI_MODE_NIGHT_MASK.inv()) or
                    (if (night) Configuration.UI_MODE_NIGHT_YES else Configuration.UI_MODE_NIGHT_NO)
                return ColorStateList.valueOf(context.createConfigurationContext(cfg).getColor(colorRes))
            }
            read(night = false) to read(night = true)
        }

    /** 给一段文字位图着色（日/夜两个值都带上，见文件开头的说明） */
    fun tint(views: RemoteViews, context: Context, id: Int, colorRes: Int) {
        val (day, night) = tintPair(context, colorRes)
        views.setColorStateList(id, "setImageTintList", day, night)
    }

    fun textColor(tone: Tone?): Int = when (tone) {
        Tone.OK, null -> R.color.ua_text
        Tone.WARN -> R.color.ua_warn
        Tone.DANGER -> R.color.ua_danger
        Tone.MUTED -> R.color.ua_text_3
    }

    private fun dot(tone: Tone): Int = when (tone) {
        Tone.OK -> R.drawable.dot_ok
        Tone.WARN -> R.drawable.dot_warn
        Tone.DANGER -> R.drawable.dot_danger
        Tone.MUTED -> R.drawable.dot_muted
    }

    /** 一段衬线小字 */
    fun text(
        views: RemoteViews,
        context: Context,
        id: Int,
        text: String,
        sizeSp: Float,
        color: Int,
        face: TextArt.Face = TextArt.Face.REGULAR,
    ) {
        if (BAKE_COLORS) {
            views.setImageViewBitmap(id, TextArt.text(context, text, sizeSp, face, context.getColor(color)))
        } else {
            views.setImageViewBitmap(id, TextArt.text(context, text, sizeSp, face))
            tint(views, context, id, color)
        }
        views.setContentDescription(id, text)
    }

    /** 衬线大数字。看板：ok 时是正文色，warn/danger 才上色。bottomPadPx 见 TextArt.number */
    fun number(views: RemoteViews, context: Context, id: Int, text: String, sizeSp: Float, tone: Tone?, bottomPadPx: Float) {
        if (BAKE_COLORS) {
            views.setImageViewBitmap(id, TextArt.number(context, text, sizeSp, bottomPadPx, color = context.getColor(textColor(tone))))
        } else {
            views.setImageViewBitmap(id, TextArt.number(context, text, sizeSp, bottomPadPx))
            tint(views, context, id, textColor(tone))
        }
        views.setContentDescription(id, "$text%")
    }

    fun empty(views: RemoteViews, context: Context, s: SlotIds, type: Type) {
        text(views, context, s.label, "额度", type.title, R.color.ua_text_2, TextArt.Face.SEMIBOLD)
        number(views, context, s.pct, "--", type.num, Tone.MUTED, TextArt.descentPx(context, type.proj))
        s.proj?.let { views.setViewVisibility(it, View.GONE) }
        for (id in s.bars + listOf(s.pace, s.dot, s.eta)) views.setViewVisibility(id, View.GONE)
    }

    fun slot(
        views: RemoteViews,
        context: Context,
        s: SlotIds,
        row: WidgetRow,
        dim: Boolean,
        type: Type,
        label: String = row.label,
        /** 布局里有没有金额行（只有宽松档卡片有）；对不存在的 view 下指令会让整个小部件加载失败 */
        withMoney: Boolean = false,
        withProjected: Boolean = s.proj != null,
    ) {
        views.setViewVisibility(s.root, View.VISIBLE)
        text(views, context, s.label, label, type.title, R.color.ua_text_2, TextArt.Face.SEMIBOLD)
        // 数据不是最新时一律降成次要色：沿用的旧值不能和新鲜数字长得一样。
        // 卡片里大数字要和旁边的「预计」按基线对齐，列表里要和标题居中对齐——都给小字的下留白
        val pad = TextArt.descentPx(context, if (type.proj > 0) type.proj else type.title)
        number(views, context, s.pct, row.pct, type.num, if (dim) Tone.MUTED else row.tone.takeIf { it != Tone.OK }, pad)

        if (s.proj != null && s.projLabel != null && s.projValue != null) {
            if (withProjected && row.projected != null) {
                views.setViewVisibility(s.proj, View.VISIBLE)
                text(views, context, s.projLabel, "预计", type.projLabel, R.color.ua_text_3)
                val t = if (dim) Tone.MUTED else row.projectedTone
                val color = if (t == Tone.MUTED) R.color.ua_text_2 else textColor(t)
                text(views, context, s.projValue, "${row.projected}%", type.proj, color, TextArt.Face.SEMIBOLD)
            } else {
                views.setViewVisibility(s.proj, View.GONE)
            }
        }

        // 每种状态色一根条，只显示一根——不在运行时染色，深浅色由资源自动切换
        val barTone = if (dim) Tone.MUTED else row.tone
        BAR_TONES.forEachIndexed { i, tone ->
            val id = s.bars[i]
            if (tone == barTone) {
                views.setViewVisibility(id, View.VISIBLE)
                views.setInt(id, "setSecondaryProgress", row.projectedFill)
                views.setInt(id, "setProgress", row.used)
            } else {
                views.setViewVisibility(id, View.GONE)
            }
        }
        if (row.pace != null) {
            views.setViewVisibility(s.pace, View.VISIBLE)
            views.setInt(s.pace, "setProgress", row.pace)
        } else {
            views.setViewVisibility(s.pace, View.GONE)
        }

        val etaTone = if (dim) Tone.MUTED else row.etaTone
        val loud = etaTone == Tone.WARN || etaTone == Tone.DANGER
        when (val e = row.eta) {
            is Countdown.Text -> {
                views.setViewVisibility(s.eta, View.VISIBLE)
                text(views, context, s.eta, e.text, type.eta, textColor(etaTone))
                views.setViewVisibility(s.dot, if (loud) View.VISIBLE else View.GONE)
                if (loud) views.setImageViewResource(s.dot, dot(etaTone))
            }
            Countdown.None -> {
                views.setViewVisibility(s.eta, View.GONE)
                views.setViewVisibility(s.dot, View.GONE)
            }
        }

        if (withMoney && s.spend != null && s.full != null && s.spendLabel != null && s.fullLabel != null) {
            text(views, context, s.spendLabel, "已用", type.moneyLabel, R.color.ua_text_3)
            text(views, context, s.fullLabel, "满额约", type.moneyLabel, R.color.ua_text_3)
            // 取不到就写「—」，不写 $0：没取到和没花钱是两回事
            text(views, context, s.spend, row.spend ?: "—", type.money, R.color.ua_text, TextArt.Face.SEMIBOLD)
            text(views, context, s.full, row.full ?: "—", type.money, R.color.ua_text, TextArt.Face.SEMIBOLD)
        }
    }

    /** 右上角的更新时刻 / 出错原因；model 为 null 时隐藏（别的卡片在显示） */
    fun status(views: RemoteViews, context: Context, id: Int, model: WidgetModel?, sizeSp: Float) {
        if (model == null) {
            views.setViewVisibility(id, View.GONE)
            return
        }
        views.setViewVisibility(id, View.VISIBLE)
        text(views, context, id, model.status, sizeSp, textColor(model.statusTone))
    }
}

// ── 卡片：看板额度卡的桌面版 ──────────────────────────────────────

/**
 * 卡片样式。窄（2 列）放一张最吃紧的卡，宽（4 列）放 5h / 7d 两张。
 * 两个 provider 只是默认尺寸不同，拖动改大小后画法完全一样。
 */
abstract class CardWidget : UsageWidget() {
    override fun render(context: Context, model: WidgetModel, state: WidgetState?, size: WidgetSize): RemoteViews {
        val two = size.wide
        val layout = when {
            two && size.roomy -> R.layout.widget_card2_roomy
            two -> R.layout.widget_card2
            size.roomy -> R.layout.widget_card1_roomy
            else -> R.layout.widget_card1
        }
        val views = RemoteViews(context.packageName, layout)
        val type = if (size.roomy) Type.CARD_ROOMY else Type.CARD_COMPACT

        if (!two) {
            val row = WidgetModels.primary(state?.summary, model)
            if (row == null) {
                Bind.empty(views, context, C0, type)
                Bind.status(views, context, R.id.c0_status, model, type.status)
                return views
            }
            // 紧凑档 110dp 宽放不下「预计 128%」：浅色那段额度条已经表达了预计
            Bind.slot(views, context, C0, row, model.dim, type, withMoney = size.roomy, withProjected = size.roomy)
            if (state?.error != null) {
                // 窄卡的标题行放不下「7d 窗口」+「无法连接」：原因挪到底行，替掉已经不新鲜的时刻
                Bind.status(views, context, R.id.c0_status, null, type.status)
                views.setViewVisibility(C0.dot, View.GONE)
                views.setViewVisibility(C0.eta, View.VISIBLE)
                Bind.text(views, context, C0.eta, model.status, type.eta, Bind.textColor(model.statusTone))
            } else {
                Bind.status(views, context, R.id.c0_status, model, type.status)
            }
            return views
        }

        val rows = model.rows.take(2)
        if (rows.isEmpty()) {
            Bind.empty(views, context, C0, type)
            views.setViewVisibility(C1.root, View.GONE)
            Bind.status(views, context, R.id.c0_status, model, type.status)
            return views
        }
        Bind.slot(views, context, C0, rows[0], model.dim, type, withMoney = size.roomy)
        if (rows.size >= 2) Bind.slot(views, context, C1, rows[1], model.dim, type, withMoney = size.roomy)
        else views.setViewVisibility(C1.root, View.GONE)
        // 状态放在最右一张卡的标题行尾，与看板顶栏右侧的「额度更新时刻」同一个位置
        Bind.status(views, context, R.id.c0_status, if (rows.size >= 2) null else model, type.status)
        if (rows.size >= 2) Bind.status(views, context, R.id.c1_status, model, type.status)
        return views
    }

    companion object {
        private val C0 = SlotIds(
            R.id.c0, R.id.c0_label, R.id.c0_pct,
            listOf(R.id.c0_bar_ok, R.id.c0_bar_warn, R.id.c0_bar_danger, R.id.c0_bar_muted),
            R.id.c0_pace, R.id.c0_dot, R.id.c0_eta,
            proj = R.id.c0_proj, projLabel = R.id.c0_proj_label, projValue = R.id.c0_proj_val, status = R.id.c0_status,
            spendLabel = R.id.c0_spend_label, spend = R.id.c0_spend, fullLabel = R.id.c0_full_label, full = R.id.c0_full,
        )
        private val C1 = SlotIds(
            R.id.c1, R.id.c1_label, R.id.c1_pct,
            listOf(R.id.c1_bar_ok, R.id.c1_bar_warn, R.id.c1_bar_danger, R.id.c1_bar_muted),
            R.id.c1_pace, R.id.c1_dot, R.id.c1_eta,
            proj = R.id.c1_proj, projLabel = R.id.c1_proj_label, projValue = R.id.c1_proj_val, status = R.id.c1_status,
            spendLabel = R.id.c1_spend_label, spend = R.id.c1_spend, fullLabel = R.id.c1_full_label, full = R.id.c1_full,
        )
    }
}

/** 默认 2×2 */
class SmallWidget : CardWidget() {
    override val defaultSize = WidgetSize(110, 110)
}

/** 默认 4×2 */
class WideWidget : CardWidget() {
    override val defaultSize = WidgetSize(300, 110)
}

// ── 列表：信息密度更高，一个窗口一行 ─────────────────────────────────

/**
 * 列表样式：所有有意义的窗口（5h / 7d / 7d Fable…）各占一行，
 * 行 = 标题 · 大数字 · 额度条（已用 / 预计 / 时间刻度）· 耗尽或重置时刻。
 * 窄（2 列）时每行拆成两层，标题换短写，不放时刻。
 */
class ListWidget : UsageWidget() {
    override val defaultSize = WidgetSize(300, 110)

    override fun render(context: Context, model: WidgetModel, state: WidgetState?, size: WidgetSize): RemoteViews {
        val layout = when {
            size.wide && size.roomy -> R.layout.widget_list_roomy
            size.wide -> R.layout.widget_list
            size.roomy -> R.layout.widget_list_narrow_roomy
            else -> R.layout.widget_list_narrow
        }
        val views = RemoteViews(context.packageName, layout)
        val type = when {
            size.wide -> if (size.roomy) Type.LIST_ROOMY else Type.LIST_COMPACT
            else -> if (size.roomy) Type.NARROW_ROOMY else Type.NARROW_COMPACT
        }
        // 110dp 高的格子：宽列表排得下三行，窄列表每行两层只排得下两行
        val maxRows = when {
            size.roomy -> ROWS.size
            size.wide -> 3
            else -> 2
        }
        val rows = model.rows.take(maxRows)

        Bind.text(views, context, R.id.list_title, "额度", type.title, R.color.ua_text_2, TextArt.Face.SEMIBOLD)
        Bind.status(views, context, R.id.list_status, model, type.status)
        if (rows.isEmpty()) {
            views.setViewVisibility(R.id.list_empty, View.VISIBLE)
            Bind.text(views, context, R.id.list_empty_text, "--", type.num, R.color.ua_text_3)
        } else {
            views.setViewVisibility(R.id.list_empty, View.GONE)
        }
        ROWS.forEachIndexed { i, s ->
            val row = rows.getOrNull(i)
            if (row == null) {
                views.setViewVisibility(s.root, View.GONE)
            } else {
                Bind.slot(views, context, s, row, model.dim, type, label = if (size.wide) row.label else row.shortLabel)
                views.setViewVisibility(s.etaBox!!, if (size.wide) View.VISIBLE else View.GONE)
            }
        }
        return views
    }

    companion object {
        private val ROWS = listOf(
            SlotIds(R.id.r0, R.id.r0_label, R.id.r0_pct,
                listOf(R.id.r0_bar_ok, R.id.r0_bar_warn, R.id.r0_bar_danger, R.id.r0_bar_muted),
                R.id.r0_pace, R.id.r0_dot, R.id.r0_eta, etaBox = R.id.r0_eta_box),
            SlotIds(R.id.r1, R.id.r1_label, R.id.r1_pct,
                listOf(R.id.r1_bar_ok, R.id.r1_bar_warn, R.id.r1_bar_danger, R.id.r1_bar_muted),
                R.id.r1_pace, R.id.r1_dot, R.id.r1_eta, etaBox = R.id.r1_eta_box),
            SlotIds(R.id.r2, R.id.r2_label, R.id.r2_pct,
                listOf(R.id.r2_bar_ok, R.id.r2_bar_warn, R.id.r2_bar_danger, R.id.r2_bar_muted),
                R.id.r2_pace, R.id.r2_dot, R.id.r2_eta, etaBox = R.id.r2_eta_box),
            SlotIds(R.id.r3, R.id.r3_label, R.id.r3_pct,
                listOf(R.id.r3_bar_ok, R.id.r3_bar_warn, R.id.r3_bar_danger, R.id.r3_bar_muted),
                R.id.r3_pace, R.id.r3_dot, R.id.r3_eta, etaBox = R.id.r3_eta_box),
        )
    }
}

/** App 进程这一侧：通知所有小部件立即刷新（绕过节流） */
object WidgetUpdater {
    val PROVIDERS = listOf(SmallWidget::class.java, WideWidget::class.java, ListWidget::class.java)

    fun requestAll(context: Context) {
        val manager = AppWidgetManager.getInstance(context)
        for (cls in PROVIDERS) {
            val ids = manager.getAppWidgetIds(ComponentName(context, cls))
            if (ids.isEmpty()) continue
            val intent = Intent(context, cls)
                .setAction(AppWidgetManager.ACTION_APPWIDGET_UPDATE)
                .putExtra(AppWidgetManager.EXTRA_APPWIDGET_IDS, ids)
                .putExtra(UsageWidget.EXTRA_FORCE, true)
            context.sendBroadcast(intent)
        }
    }
}
