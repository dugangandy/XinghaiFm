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

### 方式二：本机命令行（推荐）

装好 **JDK 17+** 和 **Android SDK（platform 34 + build-tools 34.0.0）** 后，在仓库根目录：

```bash
npm run dist:apk                # debug 包
npm run dist:apk -- --release   # release 包（同样用 debug 签名）
```

脚本会自己找 JDK / Gradle（也可以用 `JAVA_HOME`、`GRADLE_HOME`、`ANDROID_HOME` 指定），
构建完把产物拷成 `out/XinghaiFM-<version>-debug.apk`。

也可以手动跑：

```bash
cd android
gradle assembleDebug           # 有 wrapper 时用 ./gradlew assembleDebug
```

产物：`app/build/outputs/apk/debug/app-debug.apk`

### 方式三：Android Studio

`File → Open` 选中 `android/` 目录，等 Gradle 同步完直接 Run。

## 说明

- `minSdk 24 / targetSdk 34`：target 34 是为了避开 Android 15 强制 edge-to-edge（那样得处理 insets），后续要升 35 再说
- 无签名配置：debug 与 release 都用 debug 签名，自用侧载足够；要发布请自备 keystore
- 明文 http 依赖 `android:usesCleartextTraffic="true"`，只在局域网 / SSH 隧道场景使用
- 后台播放靠前台服务维持，音频仍在 WebView 里播放；若某些机型锁屏后被掐，下一步是换成原生播放器（Media3）拉 `/api/media`

## 下载 / 离线

- **入口**：网页右下角的悬浮下载按钮；断网时的「连不上电脑」页也有「已下载」按钮。网页本身不参与下载逻辑。
- **能下什么**：单集或整张专辑，音频视频都行；按专辑分组管理，可删单集、可删整张。
- **存哪**：应用私有目录 `files/downloads/<libId>/<专辑>/<sha1(rel)>.<ext>`，索引是同目录下的 `index.json`（按「用户 + 相对路径」记，换账号看不到别人的下载）。不需要存储权限，卸载 App 会一起清掉。
- **离线播放**：壳内起一个只监听 `127.0.0.1` 的小 HTTP 服务出文件（带随机路径 + Range 支持，能拖进度），播放复用 `VideoPlayerActivity`（音频不强制横屏，画面是黑的，控件照常）。
- **鉴权**：下载走 `/api/media/<rel>`，带上 WebView 的会话 Cookie，同时兜底带 `Authorization: Bearer <token>`；服务端会话过期会提示下载失败。
- **进度**：底部一行汇总「下载中 N 个 · 百分比（已下 / 总量）」；列表刷新按 350ms 合帧，批量下载不会卡。
- **失败**：失败的集会在列表下方单独列出，可单条重试或移除；401 会直接提示「登录已过期」。
- **选择**：专辑先选「下载整张（跳过已下载）」或「选择单集…」，单集对话框默认只勾未下载的。
- **空间**：入队前会和手机可用空间比对，不够就直接拒绝。
- **流量**：检测到移动网络会先弹确认框，同意才下。
- **续传**：失败保留 `.part`（3 天内），重试自动带 `Range` 续传；服务端不支持 206 就退化成整段重下。
- **通知**：下载中在通知栏显示「正在下载 N 个 · 百分比（已下 / 总量）」，点通知回到下载页。
- **缓存**：资源库列表在进程内缓存 5 分钟，「添加」对话框里有「刷新」可按需重扫。
- **本机服务**：只监听 127.0.0.1，最多 8 个并发连接、单请求头部 64 行上限，避免被本机其它 App 刷爆。
- **悬浮按钮**：网页打开弹窗/抽屉/播放页时会自动隐藏，避免压在上面误触。
- **清理**：下载中的临时文件是 `*.part`；删除单集/整张会真正中断正在跑的请求（`Call.cancel()`）并删掉半截文件；排队中还没开始的直接跳过；进程被杀留下的残片在下次启动时清掉。

限制：网页层不提供下载入口/状态，所有操作都在这个原生页面里；音频复用了视频播放器的界面，只有控制条没有专门的音频皮肤。
