package space.zackwill.ua

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import space.zackwill.ua.widget.WidgetUpdater

/**
 * 只进 debug 包：从电脑上触发一次小部件刷新（系统的 APPWIDGET_UPDATE 广播 adb 发不了）。
 *   adb shell am broadcast -a space.zackwill.ua.DEBUG_REFRESH -n space.zackwill.ua/.DebugRefreshReceiver
 */
class DebugRefreshReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        WidgetUpdater.requestAll(context)
    }
}
