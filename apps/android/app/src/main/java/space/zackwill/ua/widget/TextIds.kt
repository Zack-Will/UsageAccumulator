// 由 apps/android/scripts/gen-widget-layouts.py 生成，不要手改。
package space.zackwill.ua.widget

import space.zackwill.ua.R

/** 位图容器 id → (浅色位图 id, 深色位图 id)。文字和额度条都是一个容器 + 两张位图，见生成脚本 img() / bars() */
internal object TextIds {
    val PAIRS: Map<Int, Pair<Int, Int>> = mapOf(
        R.id.c0_bar to (R.id.c0_bar_d to R.id.c0_bar_n),
        R.id.c0_eta to (R.id.c0_eta_d to R.id.c0_eta_n),
        R.id.c0_full to (R.id.c0_full_d to R.id.c0_full_n),
        R.id.c0_full_label to (R.id.c0_full_label_d to R.id.c0_full_label_n),
        R.id.c0_label to (R.id.c0_label_d to R.id.c0_label_n),
        R.id.c0_pct to (R.id.c0_pct_d to R.id.c0_pct_n),
        R.id.c0_proj_label to (R.id.c0_proj_label_d to R.id.c0_proj_label_n),
        R.id.c0_proj_val to (R.id.c0_proj_val_d to R.id.c0_proj_val_n),
        R.id.c0_spend to (R.id.c0_spend_d to R.id.c0_spend_n),
        R.id.c0_spend_label to (R.id.c0_spend_label_d to R.id.c0_spend_label_n),
        R.id.c0_status to (R.id.c0_status_d to R.id.c0_status_n),
        R.id.c1_bar to (R.id.c1_bar_d to R.id.c1_bar_n),
        R.id.c1_eta to (R.id.c1_eta_d to R.id.c1_eta_n),
        R.id.c1_full to (R.id.c1_full_d to R.id.c1_full_n),
        R.id.c1_full_label to (R.id.c1_full_label_d to R.id.c1_full_label_n),
        R.id.c1_label to (R.id.c1_label_d to R.id.c1_label_n),
        R.id.c1_pct to (R.id.c1_pct_d to R.id.c1_pct_n),
        R.id.c1_proj_label to (R.id.c1_proj_label_d to R.id.c1_proj_label_n),
        R.id.c1_proj_val to (R.id.c1_proj_val_d to R.id.c1_proj_val_n),
        R.id.c1_spend to (R.id.c1_spend_d to R.id.c1_spend_n),
        R.id.c1_spend_label to (R.id.c1_spend_label_d to R.id.c1_spend_label_n),
        R.id.c1_status to (R.id.c1_status_d to R.id.c1_status_n),
        R.id.list_empty_text to (R.id.list_empty_text_d to R.id.list_empty_text_n),
        R.id.list_status to (R.id.list_status_d to R.id.list_status_n),
        R.id.list_title to (R.id.list_title_d to R.id.list_title_n),
        R.id.r0_bar to (R.id.r0_bar_d to R.id.r0_bar_n),
        R.id.r0_eta to (R.id.r0_eta_d to R.id.r0_eta_n),
        R.id.r0_label to (R.id.r0_label_d to R.id.r0_label_n),
        R.id.r0_pct to (R.id.r0_pct_d to R.id.r0_pct_n),
        R.id.r1_bar to (R.id.r1_bar_d to R.id.r1_bar_n),
        R.id.r1_eta to (R.id.r1_eta_d to R.id.r1_eta_n),
        R.id.r1_label to (R.id.r1_label_d to R.id.r1_label_n),
        R.id.r1_pct to (R.id.r1_pct_d to R.id.r1_pct_n),
        R.id.r2_bar to (R.id.r2_bar_d to R.id.r2_bar_n),
        R.id.r2_eta to (R.id.r2_eta_d to R.id.r2_eta_n),
        R.id.r2_label to (R.id.r2_label_d to R.id.r2_label_n),
        R.id.r2_pct to (R.id.r2_pct_d to R.id.r2_pct_n),
        R.id.r3_bar to (R.id.r3_bar_d to R.id.r3_bar_n),
        R.id.r3_eta to (R.id.r3_eta_d to R.id.r3_eta_n),
        R.id.r3_label to (R.id.r3_label_d to R.id.r3_label_n),
        R.id.r3_pct to (R.id.r3_pct_d to R.id.r3_pct_n),
    )
}

/**
 * 额度条的几何尺寸，与布局同源（生成脚本里的 CARD / LIST / NARROW）。
 * 条宽 =（格子宽 − 两侧内边距 − 同一行里别的列 − 卡片间距）÷ 卡片数
 */
internal data class BarDims(
    val padDp: Int,
    val reserveDp: Int,
    val columns: Int,
    val gapDp: Int,
    val barDp: Int,
    val tickDp: Int,
) {
    fun widthDp(widgetWidthDp: Int): Int =
        ((widgetWidthDp - 2 * padDp - reserveDp - gapDp * (columns - 1)) / columns).coerceAtLeast(24)
}

internal object Dims {
    val CARD1_COMPACT = BarDims(padDp = 10, reserveDp = 0, columns = 1, gapDp = 0, barDp = 8, tickDp = 12)
    val CARD1_ROOMY = BarDims(padDp = 16, reserveDp = 0, columns = 1, gapDp = 0, barDp = 10, tickDp = 16)
    val CARD2_COMPACT = BarDims(padDp = 10, reserveDp = 0, columns = 2, gapDp = 20, barDp = 8, tickDp = 12)
    val CARD2_ROOMY = BarDims(padDp = 16, reserveDp = 0, columns = 2, gapDp = 24, barDp = 10, tickDp = 16)
    val LIST_COMPACT = BarDims(padDp = 10, reserveDp = 180, columns = 1, gapDp = 0, barDp = 6, tickDp = 10)
    val LIST_ROOMY = BarDims(padDp = 16, reserveDp = 210, columns = 1, gapDp = 0, barDp = 8, tickDp = 14)
    val NARROW_COMPACT = BarDims(padDp = 10, reserveDp = 0, columns = 1, gapDp = 0, barDp = 6, tickDp = 10)
    val NARROW_ROOMY = BarDims(padDp = 16, reserveDp = 0, columns = 1, gapDp = 0, barDp = 8, tickDp = 12)
}
