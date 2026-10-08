import java.util.Properties

plugins {
    alias(libs.plugins.android.application)
}

val localProperties = Properties().apply {
    val file = rootProject.file("local.properties")
    if (file.isFile) file.inputStream().use { load(it) }
}

fun localProperty(name: String): String =
    (localProperties.getProperty(name) ?: providers.gradleProperty(name).orNull ?: System.getenv(name) ?: "").trim()

// 发布版本号由 tag 给（CI 传 -PUA_VERSION=x.y.z）；versionCode = x*10000 + y*100 + z，保证单调递增
val uaVersion = localProperty("UA_VERSION").removePrefix("v").ifEmpty { "0.1.0" }
val uaVersionCode = uaVersion.substringBefore("-").split(".").map { it.toInt() }
    .let { (ma, mi, pa) -> ma * 10000 + mi * 100 + pa }

// 正式签名：keystore 不进仓库，路径与口令来自 local.properties 或 CI 的环境变量
val releaseKeystore = localProperty("UA_KEYSTORE_FILE").takeIf { it.isNotEmpty() }?.let { file(it) }

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
        versionCode = uaVersionCode
        versionName = uaVersion

        // 首次启动时设置页预填的服务器地址。只从 local.properties 读，仓库里不写死任何域名
        buildConfigField("String", "UA_DEFAULT_SERVER", buildConfigString(localProperty("UA_DEFAULT_SERVER")))

        // 是否声明为小米小部件（见 AndroidManifest 里的说明）。没过小米审核前必须关
        manifestPlaceholders["miuiWidgetKey"] =
            if (localProperty("UA_MIUI_WIDGET") == "true") "miuiWidget" else "space.zackwill.ua.miuiWidget.off"
    }

    signingConfigs {
        if (releaseKeystore != null) {
            create("release") {
                storeFile = releaseKeystore
                storePassword = localProperty("UA_KEYSTORE_PASSWORD")
                keyAlias = localProperty("UA_KEY_ALIAS")
                keyPassword = localProperty("UA_KEY_PASSWORD")
            }
        }
    }

    buildTypes {
        release {
            // 有正式 keystore 就用它（GitHub Release 发的包都是这个签名）；
            // 没配时退回 debug 密钥，只适合装在自己手机上试，和 Release 包不能互相覆盖安装。
            signingConfig = signingConfigs.findByName("release") ?: signingConfigs.getByName("debug")
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
