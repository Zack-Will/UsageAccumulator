import java.util.Properties

plugins {
    alias(libs.plugins.android.application)
}

val localProperties = Properties().apply {
    val file = rootProject.file("local.properties")
    if (file.isFile) file.inputStream().use { load(it) }
}

fun localProperty(name: String): String =
    (localProperties.getProperty(name) ?: providers.gradleProperty(name).orNull ?: "").trim()

fun buildConfigString(value: String): String =
    "\"" + value.replace("\\", "\\\\").replace("\"", "\\\"") + "\""

android {
    namespace = "space.zackwill.ua"
    compileSdk {
        version = release(36) {
            minorApiLevel = 1
        }
    }

    defaultConfig {
        applicationId = "space.zackwill.ua"
        minSdk = 31
        targetSdk = 36
        versionCode = 1
        versionName = "0.1.0"

        // 首次启动时设置页预填的服务器地址。只从 local.properties 读，仓库里不写死任何域名
        buildConfigField("String", "UA_DEFAULT_SERVER", buildConfigString(localProperty("UA_DEFAULT_SERVER")))

        // 是否声明为小米小部件（见 AndroidManifest 里的说明）。没过小米审核前必须关
        manifestPlaceholders["miuiWidgetKey"] =
            if (localProperty("UA_MIUI_WIDGET") == "true") "miuiWidget" else "space.zackwill.ua.miuiWidget.off"
    }

    buildTypes {
        release {
            // 只装在自己手机上：用本机 debug 密钥签名，免得另管一套 keystore；
            // 与 debug 包签名一致，覆盖安装不用卸载，登录态和设置都保留。
            // 超级岛的设备白名单要登记签名指纹，届时再换正式 keystore。
            signingConfig = signingConfigs.getByName("debug")
            optimization {
                enable = true
            }
        }
    }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    buildFeatures {
        buildConfig = true
    }
}

// 刻意零运行时依赖：小部件跑在小米要求的独立进程里（内存上限 35MB），
// 平台自带的 WebView / HttpURLConnection / org.json 已经够用。
dependencies {
    testImplementation(libs.junit)
    testImplementation(libs.json)
}
