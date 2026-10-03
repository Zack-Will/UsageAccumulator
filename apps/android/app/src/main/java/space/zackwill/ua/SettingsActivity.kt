package space.zackwill.ua

import android.app.Activity
import android.appwidget.AppWidgetManager
import android.content.ComponentName
import android.content.Intent
import android.os.Bundle
import android.view.View
import android.view.WindowInsets
import android.webkit.CookieManager
import android.widget.Button
import android.widget.EditText
import android.widget.TextView
import space.zackwill.ua.widget.ListWidget
import space.zackwill.ua.widget.WideWidget
import space.zackwill.ua.widget.WidgetCache
import space.zackwill.ua.widget.WidgetUpdater
import kotlin.concurrent.thread

/**
 * 原生设置页：服务器地址、可选 token、添加小部件、退出登录。
 * 首次启动（还没配地址）时从这里进，保存后直接进看板。
 */
class SettingsActivity : Activity() {
    private lateinit var server: EditText
    private lateinit var token: EditText
    private lateinit var message: TextView
    private lateinit var save: Button
    private var firstRun = false

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_settings)
        firstRun = intent.getBooleanExtra(EXTRA_FIRST_RUN, false)
        SystemBars.apply(this, SystemBars.isNight(this))

        val root = findViewById<View>(R.id.root)
        root.setOnApplyWindowInsetsListener { v, insets ->
            val i = insets.getInsets(
                WindowInsets.Type.systemBars() or WindowInsets.Type.displayCutout() or WindowInsets.Type.ime(),
            )
            v.setPadding(i.left, i.top, i.right, i.bottom)
            WindowInsets.CONSUMED
        }

        server = findViewById(R.id.server)
        token = findViewById(R.id.token)
        message = findViewById(R.id.message)
        save = findViewById(R.id.save)

        val config = AppConfig.load(this)
        server.setText(config.serverUrl.ifEmpty { BuildConfig.UA_DEFAULT_SERVER })
        token.setText(config.token)

        save.setOnClickListener { onSave() }
        findViewById<View>(R.id.pin_widget).setOnClickListener { pinWidget(WideWidget::class.java) }
        findViewById<View>(R.id.pin_list).setOnClickListener { pinWidget(ListWidget::class.java) }
        findViewById<View>(R.id.logout).apply {
            visibility = if (config.isConfigured) View.VISIBLE else View.GONE
            setOnClickListener { logout() }
        }
        for (id in listOf(R.id.pin_widget, R.id.pin_list)) {
            findViewById<View>(id).visibility = if (config.isConfigured) View.VISIBLE else View.GONE
        }
    }

    private fun onSave() {
        val url = ServerUrl.normalize(server.text.toString())
        ServerUrl.validate(url)?.let { return showMessage(it) }
        val tokenValue = token.text.toString().trim()

        save.isEnabled = false
        showMessage(null)
        thread(name = "ua-health") {
            // 先验后存：填错的地址不要落盘，否则下次一打开就是错误页
            val err = SummaryClient.checkHealth(url)
            runOnUiThread {
                save.isEnabled = true
                if (err != null) return@runOnUiThread showMessage(err.text)
                AppConfig.update(this) { old ->
                    // 换了服务器，旧会话就不属于新地址了
                    val cookie = if (old.serverUrl == url) old.sessionCookie else ""
                    old.copy(serverUrl = url, token = tokenValue, sessionCookie = cookie)
                }
                WidgetUpdater.requestAll(this)
                if (firstRun) startActivity(Intent(this, MainActivity::class.java))
                finish()
            }
        }
    }

    private fun logout() {
        CookieManager.getInstance().removeAllCookies {
            CookieManager.getInstance().flush()
            AppConfig.update(this) { it.copy(sessionCookie = "") }
            WidgetCache.clear(this)
            WidgetUpdater.requestAll(this)
            MainActivity.pendingReload = true
            finish()
        }
    }

    /**
     * 小米桌面会弹「添加到桌面」确认框。这是侧载应用唯一能加小部件的路：
     * 小米的小部件选择器只认小米服务器清单里的应用（见 README）
     */
    private fun pinWidget(provider: Class<*>) {
        val manager = getSystemService(AppWidgetManager::class.java)
        if (manager?.isRequestPinAppWidgetSupported == true) {
            manager.requestPinAppWidget(ComponentName(this, provider), null, null)
        } else {
            showMessage("请长按桌面添加")
        }
    }

    private fun showMessage(text: String?) {
        message.text = text ?: ""
        message.visibility = if (text == null) View.GONE else View.VISIBLE
    }

    companion object {
        const val EXTRA_FIRST_RUN = "first_run"
    }
}
