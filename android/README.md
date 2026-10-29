# 星海FM · 安卓壳

一个极小的 WebView 壳：加载电脑上 `tools/serve.js` 的网页，并把播放状态交给系统（锁屏 / 通知栏 / 耳机键）。
不打包网页资源、不含本地资源库 —— 换 UI 只改仓库根目录的 `index.html` / `css` / `js`，不用重新出包。

## 结构

```
android/
├─ settings.gradle.kts / build.gradle.kts      AGP 8.5 + Kotlin 2.0（零第三方运行时依赖）
├─ gradle.properties
└─ app/
   ├─ build.gradle.kts                         版本号读根 package.json
   └─ src/main/
      ├─ AndroidManifest.xml
      ├─ java/local/xinghai/fm/
      │  ├─ MainActivity.kt                   服务器地址、WebView、返回键、视频全屏
      │  ├─ PlaybackService.kt                 前台服务 + MediaSession + 通知
      │  └─ WebAppBridge.kt → 见 MainActivity 内部类 Bridge
      └─ res/                                 图标、主题、文案
```

## 构建

### 方式一：GitHub Actions（推荐，本机不用装任何东西）

仓库 → **Actions** → **Android APK** → **Run workflow**，跑完在 Artifacts 里下载 `XinghaiFM-apk`。
推送 `v*` 标签（如 `git tag v1.1.0 && git push --tags`）也会自动构建。

### 方式二：本机命令行

需要 **JDK 17** 与 **Android SDK（platform 34 + build-tools 34.0.0）**，然后：

```bash
cd android
# 没有 wrapper 时先生成一次
gradle wrapper --gradle-version 8.9
./gradlew assembleDebug        # Windows: gradlew.bat assembleDebug
```

产物：`app/build/outputs/apk/debug/app-debug.apk`

### 方式三：Android Studio

`File → Open` 选中 `android/` 目录，等 Gradle 同步完直接 Run。

## 说明

- `minSdk 24 / targetSdk 34`：target 34 是为了避开 Android 15 强制 edge-to-edge（那样得处理 insets），后续要升 35 再说
- 无签名配置：debug 与 release 都用 debug 签名，自用侧载足够；要发布请自备 keystore
- 明文 http 依赖 `android:usesCleartextTraffic="true"`，只在局域网 / SSH 隧道场景使用
- 后台播放靠前台服务维持，音频仍在 WebView 里播放；若某些机型锁屏后被掐，下一步是换成原生播放器（Media3）拉 `/api/media`
