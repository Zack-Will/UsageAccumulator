package space.zackwill.ua

import android.webkit.JavascriptInterface

/**
 * 暴露给看板页面的 `window.UaApp`。
 *
 * 只放无副作用、不涉及凭证的方法：addJavascriptInterface 看不到调用方来源，
 * 外链又已经被 MainActivity 拦去系统浏览器，但这里仍按「任何页面都能调」来设计。
 */
class UaBridge(private val activity: MainActivity) {
    @JavascriptInterface
    fun openSettings() = activity.openSettings()

    /** theme: "dark" | "light"；bg: 页面背景色（CSS 颜色，#RRGGBB），用来给状态栏区域铺底 */
    @JavascriptInterface
    fun setTheme(theme: String, bg: String) = activity.applyTheme(theme, bg)

    @JavascriptInterface
    fun version(): String = BuildConfig.VERSION_NAME
}
