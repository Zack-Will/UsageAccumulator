package space.zackwill.ua

import android.app.Activity
import android.content.res.Configuration
import android.view.WindowInsetsController

/** targetSdk 36 强制全面屏，状态栏透明：图标深浅要自己跟着背景走，不然浅色背景上是一排白字 */
object SystemBars {
    fun apply(activity: Activity, dark: Boolean) {
        val light = WindowInsetsController.APPEARANCE_LIGHT_STATUS_BARS or
            WindowInsetsController.APPEARANCE_LIGHT_NAVIGATION_BARS
        activity.window.insetsController?.setSystemBarsAppearance(if (dark) 0 else light, light)
    }

    fun isNight(activity: Activity): Boolean =
        (activity.resources.configuration.uiMode and Configuration.UI_MODE_NIGHT_MASK) == Configuration.UI_MODE_NIGHT_YES
}
