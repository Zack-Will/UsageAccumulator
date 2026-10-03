package space.zackwill.ua

import android.annotation.SuppressLint
import android.app.Activity
import android.content.ActivityNotFoundException
import android.content.Intent
import android.graphics.Color
import android.os.Build
import android.os.Bundle
import android.view.View
import android.view.WindowInsets
import android.webkit.CookieManager
import android.webkit.RenderProcessGoneDetail
import android.webkit.WebResourceError
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.TextView
import android.window.OnBackInvokedDispatcher
import space.zackwill.ua.widget.WidgetUpdater

/**
 * 外壳：WebView 直接加载服务端托管的看板（同源，会话 Cookie 由 WebView 自己保管）。
 * 网页端一部署，这里下次打开就是新 UI——外壳本身几乎不用跟着发版。
 *
 * 与网页之间只约定两件事（apps/web/src/app-bridge.ts）：
 *   · UA 后缀 `UsageAccumulatorApp/<版本>`
 *   · `window.UaApp`：openSettings() / setTheme(name, bg)
 */
class MainActivity : Activity() {
    private lateinit var root: View
    private lateinit var web: WebView
    private lateinit var errorView: View

    /** 当前 WebView 加载的是哪个服务器；设置页改了地址回来要重新加载 */
    private var loadedBase = ""
    private var mainFrameFailed = false

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val config = AppConfig.load(this)
        if (!config.isConfigured) {
            startActivity(Intent(this, SettingsActivity::class.java).putExtra(SettingsActivity.EXTRA_FIRST_RUN, true))
            finish()
            return
        }

        setContentView(R.layout.activity_main)
        root = findViewById(R.id.root)
        web = findViewById(R.id.web)
        errorView = findViewById(R.id.error)

        applyInsets()
        SystemBars.apply(this, SystemBars.isNight(this))
        setupWebView()
        findViewById<View>(R.id.error_retry).setOnClickListener { reload() }
        findViewById<View>(R.id.error_settings).setOnClickListener { openSettings() }
        registerBack()

        load(config.serverUrl)
    }

    override fun onResume() {
        super.onResume()
        if (!::web.isInitialized) return
        web.onResume()
        val config = AppConfig.load(this)
        when {
            !config.isConfigured -> {
                startActivity(Intent(this, SettingsActivity::class.java).putExtra(SettingsActivity.EXTRA_FIRST_RUN, true))
                finish()
            }
            config.serverUrl != loadedBase -> load(config.serverUrl)
            pendingReload -> reload()
        }
        pendingReload = false
    }

    override fun onPause() {
        super.onPause()
        if (!::web.isInitialized) return
        // 离开前台时把会话抄给小部件，并让它立刻重拉：回到桌面看到的就是最新数字，
        // 在页面里登录/退出后桌面也马上跟上
        captureSession()
        WidgetUpdater.requestAll(this)
        // 暂停 JS 定时器与 SSE，后台不耗电
        web.onPause()
    }

    override fun onDestroy() {
        if (::web.isInitialized) web.destroy()
        super.onDestroy()
    }

    // ── WebView ─────────────────────────────────────────────────

    @SuppressLint("SetJavaScriptEnabled")
    private fun setupWebView() {
        WebView.setWebContentsDebuggingEnabled(BuildConfig.DEBUG)
        CookieManager.getInstance().setAcceptCookie(true)
        CookieManager.getInstance().setAcceptThirdPartyCookies(web, false)

        with(web.settings) {
            javaScriptEnabled = true
            domStorageEnabled = true
            allowFileAccess = false
            allowContentAccess = false
            setSupportMultipleWindows(false)
            userAgentString = "$userAgentString $UA_SUFFIX/${BuildConfig.VERSION_NAME}"
        }
        web.addJavascriptInterface(UaBridge(this), "UaApp")
        web.webViewClient = object : WebViewClient() {
            override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
                val url = request.url.toString()
                if (ServerUrl.isSameOrigin(loadedBase, url)) return false
                // 外链交给系统浏览器：JS 桥只该暴露给自己的看板
                try {
                    startActivity(Intent(Intent.ACTION_VIEW, request.url))
                } catch (_: ActivityNotFoundException) {
                }
                return true
            }

            override fun onPageStarted(view: WebView, url: String?, favicon: android.graphics.Bitmap?) {
                mainFrameFailed = false
            }

            override fun onPageFinished(view: WebView, url: String?) {
                if (!mainFrameFailed) errorView.visibility = View.GONE
                captureSession()
                WidgetUpdater.requestAll(this@MainActivity)
            }

            override fun onReceivedError(view: WebView, request: WebResourceRequest, error: WebResourceError) {
                if (request.isForMainFrame) showError("无法连接")
            }

            override fun onReceivedHttpError(view: WebView, request: WebResourceRequest, response: WebResourceResponse) {
                if (request.isForMainFrame && response.statusCode >= 500) showError("服务端故障")
            }

            override fun onRenderProcessGone(view: WebView, detail: RenderProcessGoneDetail): Boolean {
                // 渲染进程被系统杀掉后这个 WebView 就废了，整个界面重建
                recreate()
                return true
            }
        }
    }

    private fun load(base: String) {
        loadedBase = base
        errorView.visibility = View.GONE
        web.loadUrl("$base/")
    }

    private fun reload() {
        errorView.visibility = View.GONE
        if (web.url.isNullOrEmpty()) load(loadedBase) else web.reload()
    }

    private fun showError(title: String) {
        mainFrameFailed = true
        findViewById<TextView>(R.id.error_title).text = title
        findViewById<TextView>(R.id.error_host).text = ServerUrl.host(loadedBase)
        errorView.visibility = View.VISIBLE
    }

    private fun captureSession() {
        if (loadedBase.isEmpty()) return
        val cm = CookieManager.getInstance()
        cm.flush()
        val cookie = cm.getCookie(loadedBase) ?: ""
        val before = AppConfig.load(this)
        if (before.serverUrl != loadedBase || before.sessionCookie == cookie) return
        AppConfig.save(this, before.copy(sessionCookie = cookie))
    }

    // ── 桥接回调（UaBridge 在 JS 线程调，这里切回主线程） ─────────

    fun openSettings() {
        runOnUiThread { startActivity(Intent(this, SettingsActivity::class.java)) }
    }

    fun applyTheme(theme: String, bg: String) {
        runOnUiThread {
            val color = try {
                Color.parseColor(bg)
            } catch (_: IllegalArgumentException) {
                null
            }
            if (color != null) root.setBackgroundColor(color)
            SystemBars.apply(this, theme == "dark")
        }
    }

    // ── 系统栏 ───────────────────────────────────────────────────

    /** targetSdk 36 强制全面屏：内容自己躲开状态栏、导航栏、刘海和键盘 */
    private fun applyInsets() {
        root.setOnApplyWindowInsetsListener { v, insets ->
            val types = WindowInsets.Type.systemBars() or WindowInsets.Type.displayCutout() or WindowInsets.Type.ime()
            val i = insets.getInsets(types)
            v.setPadding(i.left, i.top, i.right, i.bottom)
            WindowInsets.CONSUMED
        }
    }

    // ── 返回键：先在看板里后退，退到头再离开 ───────────────────────

    private fun registerBack() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            onBackInvokedDispatcher.registerOnBackInvokedCallback(OnBackInvokedDispatcher.PRIORITY_DEFAULT) {
                if (web.canGoBack()) web.goBack() else finish()
            }
        }
    }

    @Deprecated("API 33 以下的返回键")
    override fun onBackPressed() {
        if (::web.isInitialized && web.canGoBack()) web.goBack() else super.onBackPressed()
    }

    companion object {
        const val UA_SUFFIX = "UsageAccumulatorApp"

        /** 设置页退出登录后置位，回到这里时整页重载 */
        @Volatile
        var pendingReload = false
    }
}
