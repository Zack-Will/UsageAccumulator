package space.zackwill.ua.widget

import android.content.Context
import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.graphics.Rect
import android.graphics.Typeface
import android.graphics.fonts.Font
import android.graphics.fonts.FontFamily
import android.util.TypedValue
import space.zackwill.ua.R
import kotlin.math.ceil

/**
 * 小部件上的所有文字都由这里画成位图。
 *
 * 为什么不用 TextView：小米会把系统主题字体（MiSans）强制套到小部件的所有文字上
 * （ro.miui.ui.font.theme_apply=true），fontFamily 声明的字体在真机上被换成黑体，模拟器上却看不出来。
 * 位图不经过文字排版，替换不了。
 *
 * 整套是衬线：拉丁字母与数字用 Source Serif 4，中文回退到思源宋体（它的拉丁字形本就源自
 * Source Serif），再不够就回退系统衬线字体——服务端下发的新文案里有子集外的字也不会变成方框。
 * 字体子集由 scripts/gen-widget-fonts.py 生成。
 *
 * 画出来的是**白色**字形，颜色由 ImageView 的着色（setImageTintList，给颜色资源 id）决定——
 * 桌面按自己的深浅色去解析，系统切深色模式时不用等下一次刷新。
 */
object TextArt {
    enum class Face { REGULAR, SEMIBOLD }

    /**
     * 所有小字用同一个行框：基线以上 0.92em（汉字顶端与大写字母都在其内）、以下 0.22em。
     * 行框一致，同一行里不同文字按中线或底边对齐时，基线自然就对齐了。
     */
    private const val ASCENT_EM = 0.92f
    private const val DESCENT_EM = 0.22f

    /** 看板 .num__suffix：百分号与数字同一字体、0.56 倍、紧贴数字 */
    private const val SUFFIX_RATIO = 0.56f
    private const val SUFFIX_GAP_EM = 0.04f
    /** 看板 .num--xl 的 letter-spacing: -0.025em */
    private const val DISPLAY_TRACKING = -0.025f

    private val faces = HashMap<Face, Typeface>()
    private var display: Typeface? = null

    @Synchronized
    private fun typeface(context: Context, face: Face): Typeface = faces.getOrPut(face) {
        val res = context.resources
        val (latin, cjk) = when (face) {
            Face.REGULAR -> R.font.ua_serif_latin_regular to R.font.ua_serif_cjk_regular
            Face.SEMIBOLD -> R.font.ua_serif_latin_semibold to R.font.ua_serif_cjk_semibold
        }
        Typeface.CustomFallbackBuilder(FontFamily.Builder(Font.Builder(res, latin).build()).build())
            .addCustomFallback(FontFamily.Builder(Font.Builder(res, cjk).build()).build())
            .setSystemFallback("serif")
            .build()
    }

    @Synchronized
    private fun displayFace(context: Context): Typeface =
        display ?: context.resources.getFont(R.font.ua_display).also { display = it }

    private fun px(context: Context, sp: Float): Float =
        TypedValue.applyDimension(TypedValue.COMPLEX_UNIT_SP, sp, context.resources.displayMetrics)

    /** 与 [text] 同一行框里的「基线以下」高度——大数字要和旁边的小字底边对齐时，给它同样的下留白 */
    fun descentPx(context: Context, sizeSp: Float): Float = px(context, sizeSp) * DESCENT_EM

    fun text(context: Context, text: String, sizeSp: Float, face: Face = Face.REGULAR, color: Int = Color.WHITE): Bitmap {
        val size = px(context, sizeSp)
        val paint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
            typeface = typeface(context, face)
            textSize = size
            this.color = color
            fontFeatureSettings = "'tnum', 'lnum'"
        }
        val ascent = size * ASCENT_EM
        val descent = size * DESCENT_EM
        val w = ceil(paint.measureText(text)).toInt().coerceAtLeast(1)
        val h = ceil(ascent + descent).toInt().coerceAtLeast(1)
        val bmp = Bitmap.createBitmap(w, h, Bitmap.Config.ARGB_8888)
        Canvas(bmp).drawText(text, 0f, ascent, paint)
        return bmp
    }

    /**
     * 衬线大数字 + 小一号的百分号。高度按数字的真实字形取（到基线为止），
     * 再在基线下留 [bottomPadPx]：传同一行小字的 [descentPx]，两者底边对齐即基线对齐。
     */
    fun number(
        context: Context,
        number: String,
        sizeSp: Float,
        bottomPadPx: Float,
        suffix: String = "%",
        color: Int = Color.WHITE,
    ): Bitmap {
        val size = px(context, sizeSp)
        val big = Paint(Paint.ANTI_ALIAS_FLAG).apply {
            typeface = displayFace(context)
            textSize = size
            letterSpacing = DISPLAY_TRACKING
            this.color = color
            fontFeatureSettings = "'tnum', 'lnum'"
        }
        val small = Paint(big).apply {
            textSize = size * SUFFIX_RATIO
            letterSpacing = 0f
        }
        val bounds = Rect().also { big.getTextBounds(number, 0, number.length, it) }
        val bigWidth = big.measureText(number)
        val gap = size * SUFFIX_GAP_EM
        val smallWidth = if (suffix.isEmpty()) 0f else small.measureText(suffix)
        val top = 1f // 抗锯齿的边缘
        val ascent = -bounds.top.toFloat()
        val w = ceil(bigWidth + gap + smallWidth + 2).toInt().coerceAtLeast(1)
        val h = ceil(top + ascent + bottomPadPx).toInt().coerceAtLeast(1)
        val bmp = Bitmap.createBitmap(w, h, Bitmap.Config.ARGB_8888)
        val canvas = Canvas(bmp)
        val baseline = top + ascent
        canvas.drawText(number, 1f, baseline, big)
        if (suffix.isNotEmpty()) canvas.drawText(suffix, 1f + bigWidth + gap, baseline, small)
        return bmp
    }
}
