import java.io.File

plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

/* 版本号跟桌面端 package.json 走，省得两处对不上 */
val pkgVersion: String = run {
    val f = File(rootProject.projectDir, "../package.json")
    val text = if (f.exists()) f.readText() else ""
    Regex("\"version\"\\s*:\\s*\"([^\"]+)\"").find(text)?.groupValues?.get(1) ?: "1.0.0"
}
val vp = pkgVersion.split(".").map { it.filter(Char::isDigit).toIntOrNull() ?: 0 }
val vCode = vp.getOrElse(0) { 0 } * 10000 + vp.getOrElse(1) { 0 } * 100 + vp.getOrElse(2) { 0 }

android {
    namespace = "local.xinghai.fm"
    compileSdk = 34

    defaultConfig {
        applicationId = "local.xinghai.fm"
        minSdk = 24
        targetSdk = 34
        versionCode = if (vCode > 0) vCode else 1
        versionName = pkgVersion
        /* 产物名在 CI 里统一改，这里不折腾 archivesBaseName */
    }

    buildTypes {
        debug {
            isMinifyEnabled = false
        }
        release {
            isMinifyEnabled = false
            /* 侧载自用：release 也沿用 debug 签名，省一套 keystore */
            signingConfig = signingConfigs.getByName("debug")
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    kotlinOptions {
        jvmTarget = "17"
    }

    lint {
        abortOnError = false
    }
}

/* 零第三方运行时依赖：WebView / MediaSession / 通知全用平台 API */
dependencies {
}
