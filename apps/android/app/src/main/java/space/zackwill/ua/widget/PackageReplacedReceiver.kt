package space.zackwill.ua.widget

import android.appwidget.AppWidgetManager
import android.content.BroadcastReceiver
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.widget.RemoteViews
import space.zackwill.ua.R

/**
 * App 升级后重画小部件，分两步：
 *   1. 先推一个空的占位布局——逼桌面丢掉旧版的界面。小米桌面在布局 id 不变时会把新版的指令
 *      套到旧界面上，而升级后控件 id 全变了：实测新旧两版叠在一起、一半文字还是旧字体。
 *   2. 再让小部件按新版正常刷新。
 * 不收这个广播的话，桌面上会一直挂着旧版，直到下一次 30 分钟一次的定时刷新。
 */
class PackageReplacedReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action != Intent.ACTION_MY_PACKAGE_REPLACED) return
        val manager = AppWidgetManager.getInstance(context)
        val reset = RemoteViews(context.packageName, R.layout.widget_reset)
        for (cls in WidgetUpdater.PROVIDERS) {
            val ids = manager.getAppWidgetIds(ComponentName(context, cls))
            if (ids.isNotEmpty()) manager.updateAppWidget(ids, reset)
        }
        WidgetUpdater.requestAll(context)
    }
}
