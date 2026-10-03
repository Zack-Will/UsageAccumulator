package space.zackwill.ua

import android.content.Context
import android.util.AtomicFile
import org.json.JSONObject
import java.io.File
import java.net.URI

/**
 * App 与小部件共用的配置。
 *
 * 为什么不用 SharedPreferences：小部件跑在独立进程 :widgetProvider，
 * SharedPreferences 的跨进程读是靠不住的（进程内缓存不会失效）。
 * 这里每次都从文件现读，写用 AtomicFile，读到的要么是旧的完整版本要么是新的。
 */
data class AppConfig(
    /** 已规范化的服务器地址，形如 https://host（无尾 `/`、无 `/v1`）；空 = 未配置 */
    val serverUrl: String = "",
    /** 从 WebView 里抄出来的会话 Cookie（`name=value; ...`），给小部件带着请求 */
    val sessionCookie: String = "",
    /** 可选的 Bearer token；服务端没开密码登录时小部件只能靠它 */
    val token: String = "",
) {
    val isConfigured: Boolean get() = serverUrl.isNotEmpty()

    companion object {
        private const val FILE = "config.json"

        private fun file(context: Context) = AtomicFile(File(context.filesDir, FILE))

        fun load(context: Context): AppConfig {
            val raw = try {
                file(context).readFully().toString(Charsets.UTF_8)
            } catch (_: Exception) {
                return AppConfig()
            }
            return try {
                val o = JSONObject(raw)
                AppConfig(
                    serverUrl = o.optString("server_url", ""),
                    sessionCookie = o.optString("session_cookie", ""),
                    token = o.optString("token", ""),
                )
            } catch (_: Exception) {
                AppConfig()
            }
        }

        @Synchronized
        fun save(context: Context, config: AppConfig) {
            val body = JSONObject()
                .put("server_url", config.serverUrl)
                .put("session_cookie", config.sessionCookie)
                .put("token", config.token)
                .toString()
                .toByteArray(Charsets.UTF_8)
            val f = file(context)
            val out = f.startWrite()
            try {
                out.write(body)
                f.finishWrite(out)
            } catch (e: Exception) {
                f.failWrite(out)
                throw e
            }
        }

        @Synchronized
        fun update(context: Context, block: (AppConfig) -> AppConfig): AppConfig {
            val next = block(load(context))
            save(context, next)
            return next
        }
    }
}

object ServerUrl {
    /** 去掉首尾空白、尾部 `/` 和误粘上的 `/v1`；没写协议时补 https:// */
    fun normalize(raw: String): String {
        var s = raw.trim()
        if (s.isNotEmpty() && !s.contains("://")) s = "https://$s"
        while (s.endsWith("/")) s = s.dropLast(1)
        if (s.endsWith("/v1")) s = s.dropLast(3)
        while (s.endsWith("/")) s = s.dropLast(1)
        return s
    }

    /** 返回错误文案；null = 合法。只收 https：会话 Cookie 与 token 不能走明文 */
    fun validate(normalized: String): String? {
        if (normalized.isEmpty()) return "请填写地址"
        val uri = try {
            URI(normalized)
        } catch (_: Exception) {
            return "地址无效"
        }
        if (uri.scheme?.lowercase() != "https") return "只支持 https"
        if (uri.host.isNullOrEmpty()) return "地址无效"
        if (!uri.rawQuery.isNullOrEmpty() || !uri.rawFragment.isNullOrEmpty()) return "地址无效"
        return null
    }

    fun host(normalized: String): String = try {
        URI(normalized).host ?: normalized
    } catch (_: Exception) {
        normalized
    }

    /** 同源判断：只有本服务器的页面留在 App 里，其他链接交给系统浏览器 */
    fun isSameOrigin(base: String, url: String): Boolean = try {
        val a = URI(base)
        val b = URI(url)
        a.scheme.equals(b.scheme, ignoreCase = true) &&
            a.host.equals(b.host, ignoreCase = true) &&
            effectivePort(a) == effectivePort(b)
    } catch (_: Exception) {
        false
    }

    private fun effectivePort(u: URI): Int = when {
        u.port != -1 -> u.port
        u.scheme.equals("https", ignoreCase = true) -> 443
        else -> 80
    }
}
