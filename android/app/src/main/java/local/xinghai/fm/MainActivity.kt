/* ── MainActivity · 星海FM 安卓壳 ────────────────────────
 * 只做三件事：连哪台电脑、把网页装进 WebView、把播放状态告诉前台服务。
 * 界面、数据、播放全部由 tools/serve.js + 现有 web 层负责。
 */
package local.xinghai.fm

import android.app.Activity
import android.app.AlertDialog
import android.app.NotificationManager
import android.content.Context
import android.content.Intent
import android.content.pm.ActivityInfo
import android.content.pm.PackageManager
import android.graphics.Bitmap
import android.graphics.Color
import android.graphics.drawable.GradientDrawable
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.os.StatFs
import android.provider.Settings
import android.text.InputType
import android.view.ActionMode
import android.view.Gravity
import android.view.View
import android.view.ViewGroup
import android.view.WindowInsets
import android.view.WindowInsetsController
import android.view.WindowManager
import android.webkit.CookieManager
import android.webkit.JavascriptInterface
import android.webkit.WebChromeClient
import android.webkit.WebResourceError
import android.webkit.WebResourceRequest
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.Button
import android.widget.EditText
import android.widget.FrameLayout
import android.widget.LinearLayout
import android.widget.PopupMenu
import android.widget.TextView
import android.widget.Toast
import androidx.core.content.FileProvider
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONArray
import org.json.JSONObject
import java.util.concurrent.TimeUnit

class MainActivity : Activity() {

    companion object {
        private const val PREFS = "fm"
        private const val KEY_BASE = "base"
        private const val BG = 0xFF05070E.toInt()
        private const val NOTI_PERM = 11
        private const val MAX_MS = 24L * 60 * 60 * 1000

        @Volatile
        var current: MainActivity? = null
    }

    private lateinit var root: FrameLayout
    private var web: WebView? = null
    private var offline: View? = null
    private var customView: View? = null
    private var customCallback: WebChromeClient.CustomViewCallback? = null
    private val ui = Handler(Looper.getMainLooper())
    /* 换服务器后静默重登用；网页本体走 WebView，不经这里 */
    private val client: OkHttpClient by lazy {
        OkHttpClient.Builder()
            .connectTimeout(6, TimeUnit.SECONDS)
            .readTimeout(10, TimeUnit.SECONDS)
            .build()
    }
    /* 下载状态变化 / 进度 → 让网页刷新「下载管理」和曲目上的已下载标记（500ms 合帧，
       同一批变化只排一次，别让一次批量完成排出一串 evaluateJavascript） */
    private var pushQueued = false
    private val pushDlState = Runnable {
        pushQueued = false
        web?.evaluateJavascript("window.FM && FM.android && FM.android.onChange()", null)
    }
    private val onDlChanged: () -> Unit = {
        if (!pushQueued) {
            pushQueued = true
            ui.postDelayed(pushDlState, 500)
        }
    }

    private var loadFailed = false
    private var lastBack = 0L
    private var authRetried = false
    /* 网页上报的「这次长按允许选字」：只对输入框和 .selectable 纯文字为 true。
       由 JS 线程写、触摸线程读，用 @Volatile 保证看见最新值。
       默认 true：登录页（/__auth 是独立 HTML，不加载 android.js）等没有上报的页面
       必须保持原生行为，否则用户名/密码框连长按粘贴都点不出来 */
    @Volatile
    private var selectAllowed = true

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        current = this
        window.statusBarColor = BG
        window.navigationBarColor = BG
        root = FrameLayout(this)
        root.setBackgroundColor(BG)
        setContentView(root)
        askNotificationPermission()
        Dl.watch(onDlChanged)          /* 条目/状态变化 */
        Dl.watchProgress(onDlChanged)  /* 每秒的字节进度 */
        /* 在线更新：下载状态只在原生这边，进度统一回推给网页弹窗 */
        Updater.init(this)
        Updater.onProgress = { json ->
            js("window.FM && FM.android && FM.android.onUpdateProgress(" + JSONObject.quote(json) + ")")
        }
        if (serverBase().isEmpty()) showSetup() else mountWeb()
    }

    /* ── 服务器地址 ── */
    fun serverBase(): String = getSharedPreferences(PREFS, MODE_PRIVATE).getString(KEY_BASE, "") ?: ""

    private fun saveBase(v: String) {
        getSharedPreferences(PREFS, MODE_PRIVATE).edit().putString(KEY_BASE, v).apply()
    }

    /* 用户可能只打 192.168.1.8:8080，补全协议、去掉末尾斜杠 */
    private fun normalize(raw: String): String {
        var s = raw.trim()
        if (s.isEmpty()) return ""
        if (!s.startsWith("http://") && !s.startsWith("https://")) s = "http://" + s
        return s.trimEnd('/')
    }

    private fun askNotificationPermission() {
        if (Build.VERSION.SDK_INT >= 33 &&
            checkSelfPermission("android.permission.POST_NOTIFICATIONS") != PackageManager.PERMISSION_GRANTED
        ) {
            requestPermissions(arrayOf("android.permission.POST_NOTIFICATIONS"), NOTI_PERM)
        }
    }

    /* ── 首次配置 ── */
    private fun showSetup() {
        web?.let { runCatching { root.removeView(it); it.destroy() } }
        web = null
        root.removeAllViews()

        val box = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            gravity = Gravity.CENTER
            setPadding(dp(28), dp(28), dp(28), dp(28))
        }
        box.addView(TextView(this).apply {
            text = "星海 FM"
            textSize = 26f
            setTextColor(Color.WHITE)
            gravity = Gravity.CENTER_HORIZONTAL
        }, lp())
        box.addView(TextView(this).apply {
            text = "连接电脑上的星海 FM 服务"
            textSize = 13f
            setTextColor(0xFF7A869E.toInt())
            gravity = Gravity.CENTER_HORIZONTAL
            setPadding(0, dp(8), 0, dp(24))
        }, lp())

        val input = EditText(this).apply {
            hint = "http://192.168.1.8:8080"
            setSingleLine(true)
            inputType = InputType.TYPE_TEXT_VARIATION_URI
            setTextColor(Color.WHITE)
            setHintTextColor(0xFF59637A.toInt())
        }
        box.addView(input, lp())

        box.addView(TextView(this).apply {
            text = "先在电脑上运行：node tools/serve.js 8080\n手机与电脑需在同一局域网（或已配好隧道）"
            textSize = 11.5f
            setTextColor(0xFF59637A.toInt())
            setPadding(0, dp(14), 0, dp(22))
            setLineSpacing(dp(4).toFloat(), 1f)
        }, lp())

        box.addView(Button(this).apply {
            text = "连接"
            setOnClickListener {
                val b = normalize(input.text.toString())
                if (b.isEmpty()) {
                    toast("请填写电脑上的服务地址")
                    return@setOnClickListener
                }
                saveBase(b)
                mountWeb()
            }
        }, lp())

        root.addView(box, FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))
    }

    /* ── WebView ── */
    /* 不建文本选择 ActionMode：页面里的选字手柄和「复制/全选/分享」工具栏都由它派生，
       关掉就从原生这层断掉。只有网页上报 selectAllowed（输入框内、或 .selectable 纯文字上）时放行，
       否则搜索框、资源库地址输入框会连长按粘贴都用不了。
       两个重载都要覆写：View 的单参内部虽然会转到双参，但 WebView 自己覆写了单参，
       内部路径不一定再回到这里（补上零成本，别指望它去猜） */
    private inner class NoSelectWeb(ctx: Context) : WebView(ctx) {
        override fun startActionMode(callback: ActionMode.Callback?, type: Int): ActionMode? {
            if (!selectAllowed) return null
            return super.startActionMode(callback, type)
        }

        @Suppress("DEPRECATION")
        override fun startActionMode(callback: ActionMode.Callback?): ActionMode? {
            if (!selectAllowed) return null
            return super.startActionMode(callback)
        }
    }

    @Suppress("SetJavaScriptEnabled")
    private fun mountWeb() {
        web?.let { runCatching { root.removeView(it); it.destroy() } }
        web = null
        root.removeAllViews()
        offline = null

        val w = NoSelectWeb(this)
        web = w
        w.setBackgroundColor(BG)
        w.overScrollMode = View.OVER_SCROLL_NEVER
        w.isVerticalScrollBarEnabled = false
        /* 压掉原生的长按 contextmenu（图片/链接的「保存图片」「打开链接」）。
           选区本身在渲染进程里起、不走 View.performLongClick，所以这里拦不住选字——
           那道防线是上面的 NoSelectWeb.startActionMode 加网页层的 user-select:none。
           返回 true = 消费长按，因此「允许选字」的位置返回 false：
           网页报过 selectAllowed，或者命中输入框（EDIT_TEXT，交给网页自己弹粘贴/选择菜单） */
        w.setOnLongClickListener {
            val editable = w.hitTestResult.type == WebView.HitTestResult.EDIT_TEXT_TYPE
            !(selectAllowed || editable)
        }
        with(w.settings) {
            javaScriptEnabled = true
            domStorageEnabled = true
            mediaPlaybackRequiresUserGesture = false     // 连播下一集不能等用户再点一次
            useWideViewPort = true
            loadWithOverviewMode = true
            textZoom = 100                              // 别跟着系统字号把布局撑坏
            setSupportZoom(false)
            builtInZoomControls = false
            displayZoomControls = false
            allowFileAccess = false
            allowContentAccess = false
            /* 页面可能是 https（公网隧道），已下载曲目走 http://127.0.0.1 本机文件，需放行混合内容 */
            mixedContentMode = WebSettings.MIXED_CONTENT_ALWAYS_ALLOW
            cacheMode = WebSettings.LOAD_DEFAULT
        }
        /* 切后台时页面不可见，WebView 默认会被当成「可随手回收」的渲染进程（waivedWhenNotVisible）。
           播放时渲染进程得一直活着，否则回来要重建画面和媒体管线，表现就是「黑一下 + 声音断一下」。
           这里不让「不可见」成为降级理由：常驻一个渲染进程，内存代价很小。 */
        if (Build.VERSION.SDK_INT >= 26) {
            w.setRendererPriorityPolicy(WebView.RENDERER_PRIORITY_IMPORTANT, false)
        }
        CookieManager.getInstance().setAcceptCookie(true)
        CookieManager.getInstance().setAcceptThirdPartyCookies(w, false)
        w.addJavascriptInterface(Bridge(), "fmAndroid")

        w.webViewClient = object : WebViewClient() {
            override fun shouldOverrideUrlLoading(view: WebView, req: WebResourceRequest): Boolean {
                val url = req.url.toString()
                val base = serverBase()
                if (base.isNotEmpty() && url.startsWith(base)) return false
                runCatching { startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(url))) }
                return true
            }

            /* 换页时先恢复成「允许选字」：主页跳登录页（/__auth 不加载 android.js）后
               收不到新上报，残留的 false 会把登录框的长按粘贴一起禁掉 */
            override fun onPageStarted(view: WebView, url: String, favicon: Bitmap?) {
                selectAllowed = true
            }

            override fun onReceivedError(view: WebView, req: WebResourceRequest, err: WebResourceError) {
                if (req.isForMainFrame) {
                    loadFailed = true
                    showOffline()
                }
            }

            override fun onPageFinished(view: WebView, url: String) {
                if (!loadFailed) hideOffline()
                /* 兜底：有 token 却被跳到登录页（cookie 竞态），补种 cookie 再刷一次 */
                if (!authRetried && url.contains("/__auth") &&
                    getSharedPreferences(PREFS, MODE_PRIVATE).getString("token", "").orEmpty().isNotEmpty()
                ) {
                    authRetried = true
                    applyAuthCookies { runOnUiThread { view.loadUrl(serverBase() + "/") } }
                }
            }
        }

        w.webChromeClient = object : WebChromeClient() {
            override fun onShowCustomView(view: View, callback: CustomViewCallback) = showVideo(view, callback)
            override fun onHideCustomView() = hideVideo()
        }

        root.addView(w, FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))

        load()
    }

    private fun openDownloads() {
        runCatching { startActivity(Intent(this, DownloadsActivity::class.java)) }
    }

    private fun load() {
        loadFailed = false
        /* 先把会话 cookie 写好（带回调），再加载，避免导航早于 cookie 生效 */
        applyAuthCookies { runOnUiThread { web?.loadUrl(serverBase() + "/") } }
    }

    /* 从 prefs 读取 token/uid，种成 fm_sess / fm_uid，完成后回调 */
    private fun applyAuthCookies(onDone: () -> Unit) {
        val p = getSharedPreferences(PREFS, MODE_PRIVATE)
        val token = p.getString("token", "").orEmpty()
        val base = serverBase()
        if (token.isEmpty() || base.isEmpty()) { onDone(); return }
        val uid = p.getString("uid", "").orEmpty()
        val cm = CookieManager.getInstance()
        cm.setAcceptCookie(true)
        cm.setCookie(base, "fm_sess=" + token + "; Path=/", null)
        if (uid.isNotEmpty()) {
            cm.setCookie(base, "fm_uid=" + uid + "; Path=/") { _ -> cm.flush(); onDone() }
        } else {
            cm.flush(); onDone()
        }
    }

    /* ── 连不上电脑：给一张能自己救回来的页面 ── */
    private fun showOffline() {
        if (offline != null) return
        val box = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            gravity = Gravity.CENTER
            setBackgroundColor(BG)
            setPadding(dp(28), dp(28), dp(28), dp(28))
        }
        box.addView(TextView(this).apply {
            text = Msg.NET_FAIL
            textSize = 17f
            setTextColor(Color.WHITE)
            gravity = Gravity.CENTER_HORIZONTAL
        })
        box.addView(TextView(this).apply {
            text = serverBase()
            textSize = 12f
            setTextColor(0xFF7A869E.toInt())
            gravity = Gravity.CENTER_HORIZONTAL
            setPadding(0, dp(10), 0, dp(6))
        })
        box.addView(TextView(this).apply {
            text = "确认电脑上已运行 tools/serve.js，且手机和电脑在同一网络"
            textSize = 11.5f
            setTextColor(0xFF59637A.toInt())
            gravity = Gravity.CENTER_HORIZONTAL
            setPadding(0, 0, 0, dp(22))
        })
        val row = LinearLayout(this).apply { orientation = LinearLayout.HORIZONTAL }
        row.addView(Button(this).apply {
            text = "重试"
            setOnClickListener { load() }
        })
        row.addView(Button(this).apply {
            text = "更换地址"
            setOnClickListener { showServerDialog() }
        })
        row.addView(Button(this).apply {
            text = "离线播放已下载"
            setOnClickListener { openDownloads() }
        })
        box.addView(row)
        offline = box
        root.addView(box, FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))
    }

    private fun hideOffline() {
        offline?.let { root.removeView(it) }
        offline = null
    }

    /* ── 视频全屏 ── */
    @Suppress("DEPRECATION")
    private fun showVideo(view: View, callback: WebChromeClient.CustomViewCallback) {
        if (customView != null) {
            callback.onCustomViewHidden()
            return
        }
        customView = view
        customCallback = callback
        root.addView(view, FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))
        web?.visibility = View.GONE
        window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        immersive(true)
    }

    /* 沉浸式：藏状态栏和导航栏，下拉临时唤出 */
    @Suppress("DEPRECATION")
    private fun immersive(on: Boolean) {
        if (Build.VERSION.SDK_INT >= 30) {
            window.setDecorFitsSystemWindows(!on)
            window.insetsController?.apply {
                if (on) {
                    hide(WindowInsets.Type.systemBars())
                    systemBarsBehavior = WindowInsetsController.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE
                } else {
                    show(WindowInsets.Type.systemBars())
                }
            }
        } else if (on) {
            window.decorView.systemUiVisibility = (View.SYSTEM_UI_FLAG_FULLSCREEN
                or View.SYSTEM_UI_FLAG_HIDE_NAVIGATION
                or View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY
                or View.SYSTEM_UI_FLAG_LAYOUT_STABLE)
        } else {
            window.decorView.systemUiVisibility = View.SYSTEM_UI_FLAG_VISIBLE
        }
    }

    private fun hideVideo() {
        val v = customView ?: return
        customView = null
        root.removeView(v)
        web?.visibility = View.VISIBLE
        window.clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        immersive(false)
        customCallback?.onCustomViewHidden()
        customCallback = null
    }

    /* ── 全屏：网页那边只负责把画面铺满，系统栏和横屏由这里管 ── */
    private var appFullscreen = false

    fun setFullscreen(on: Boolean) {
        runOnUiThread {
            if (appFullscreen == on) return@runOnUiThread
            appFullscreen = on
            if (on) {
                requestedOrientation = ActivityInfo.SCREEN_ORIENTATION_SENSOR_LANDSCAPE
                window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
                immersive(true)
            } else {
                requestedOrientation = ActivityInfo.SCREEN_ORIENTATION_UNSPECIFIED
                window.clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
                immersive(false)
            }
        }
    }

    /* 返回键：先让网页处理（关播放页 / 抽屉 / 搜索），再退历史，最后双击退出 ── */
    override fun onBackPressed() {
        if (customView != null) {
            hideVideo()
            return
        }
        val w = web
        if (w == null) {
            if (offline != null) {
                finish()
                return
            }
            super.onBackPressed()
            return
        }
        w.evaluateJavascript("(window.FM && FM.android && typeof FM.android.back === 'function') ? FM.android.back() : false") { value ->
            if (value == "true") return@evaluateJavascript
            if (w.canGoBack()) w.goBack() else leave()
        }
    }

    /* 最后一次返回：
     *   正在播放 → 退回后台继续播（服务与通知栏都留着，点通知直接回来）
     *   没在播放 → 再按一次退出
     * 以前这里一律 finish：finish 会停前台服务（通知没了），但 WebView 里的媒体还在渲染进程里出声，
     * 于是变成「有声音、没入口」，既控制不了也回不来。 */
    private fun leave() {
        val svc = PlaybackService.current
        if (svc != null && svc.isPlaying) {
            /* 通知被系统关掉时「后台继续播」照样是有声音没入口：这种就直接停播退出 */
            if (notificationsBlocked()) {
                web?.evaluateJavascript("window.FM && FM.player && FM.player.pause && FM.player.pause()", null)
                toast(Msg.NO_NOTI_STOPPED)
                finish()
                return
            }
            moveTaskToBack(true)
            return
        }
        val now = System.currentTimeMillis()
        if (now - lastBack < 2000) {
            finish()
            return
        }
        lastBack = now
        toast("再按一次返回键退出")
    }

    /* 通知被用户/系统关掉了吗（13+ 未授权，或用户手动关了通知） */
    private fun notificationsBlocked(): Boolean {
        if (Build.VERSION.SDK_INT >= 33 &&
            checkSelfPermission("android.permission.POST_NOTIFICATIONS") != PackageManager.PERMISSION_GRANTED
        ) return true
        return runCatching {
            getSystemService(NotificationManager::class.java)?.areNotificationsEnabled() == false
        }.getOrDefault(false)
    }

    /* ── 服务器设置 ──
       和登录页一致：下拉只列名字（生产 / 测试 / 自定义），地址藏在 tooltip 上。
       换服务器后旧 token 不作数，拿登录页记住的账号密码静默重登一次，
       省得用户又要在网页登录页里重输 */
    fun showServerDialog() {
        runOnUiThread {
            val p = getSharedPreferences(PREFS, MODE_PRIVATE)
            val saved = serverBase()
            var base = if (saved.isEmpty()) Servers.list[0].second else saved
            var custom = Servers.list.none { it.second == base }

            val pick = TextView(this).apply {
                textSize = 14f
                setTextColor(Color.WHITE)
                setPadding(dp(12), dp(11), dp(12), dp(11))
                background = GradientDrawable().apply {
                    cornerRadius = dp(10).toFloat()
                    setColor(0x1AFFFFFF)
                    setStroke(dp(1), 0x33FFFFFF)
                }
            }
            val input = EditText(this).apply {
                hint = "http://192.168.1.8:8080"
                setText(base)
                setSingleLine(true)
                inputType = InputType.TYPE_TEXT_VARIATION_URI
                setSelection(text.length)
            }
            val box = LinearLayout(this).apply {
                orientation = LinearLayout.VERTICAL
                setPadding(dp(22), dp(8), dp(22), 0)
            }
            box.addView(pick, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT))
            box.addView(input, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT).apply { topMargin = dp(8) })

            fun current() = normalize(if (custom) input.text.toString() else base)
            fun refresh() {
                pick.text = "服务器：" + (if (custom) "自定义" else Servers.nameOf(base)) + "  ▾"
                /* tooltip 要 API 26+；低版本靠长按 toast 兜底 */
                if (Build.VERSION.SDK_INT >= 26) pick.tooltipText = current().ifEmpty { null }
                input.visibility = if (custom) View.VISIBLE else View.GONE
            }
            pick.setOnLongClickListener {
                val u = current()
                if (u.isEmpty()) false else { toast(u); true }
            }
            pick.setOnClickListener {
                val pop = PopupMenu(this, pick)
                Servers.list.forEachIndexed { i, s -> pop.menu.add(0, i, i, s.first) }
                pop.menu.add(0, Servers.list.size, Servers.list.size, "自定义…")
                pop.setOnMenuItemClickListener { item ->
                    if (item.itemId < Servers.list.size) {
                        base = Servers.list[item.itemId].second
                        custom = false
                    } else if (!custom) {
                        /* 从预设切自定义时先带出当前地址，方便改端口 */
                        custom = true
                        input.setText(base)
                    }
                    refresh()
                    true
                }
                pop.show()
            }
            refresh()

            AlertDialog.Builder(this)
                .setTitle("服务器设置")
                .setView(box)
                .setPositiveButton("保存") { _, _ ->
                    val old = serverBase()
                    val b = current()
                    if (b.isEmpty()) { toast("请填写服务器地址"); return@setPositiveButton }
                    saveBase(b)
                    if (b == old) { mountWeb(); return@setPositiveButton }
                    /* 换服务器：旧 token / uid 都作废，先静默重登，换不到就让网页自己弹登录页 */
                    p.edit().remove("token").remove("uid").apply()
                    reloginSilently(b) { mountWeb() }
                }
                .setNegativeButton("取消", null)
                .show()
        }
    }

    /* 退出登录：原先是「服务器设置」弹窗里的中立按钮，现由网页设置菜单通过 JS 桥触发。
       清掉会话后回原生登录页；账号密码按「记住密码」的原有口径保留 */
    private fun logout() {
        runOnUiThread {
            CookieManager.getInstance().removeAllCookies(null)
            CookieManager.getInstance().flush()
            getSharedPreferences(PREFS, MODE_PRIVATE).edit().remove("token").apply()
            startActivity(Intent(this@MainActivity, LoginActivity::class.java))
            finish()
        }
    }

    /* 换了服务器，用登录页记住的账号密码静默换一张新 token（token 跟服务器绑定，不能复用）。
       没记住凭据、或者对面不认，就静默放弃：照旧加载，网页会自己弹登录页 */
    private fun reloginSilently(base: String, onDone: () -> Unit) {
        val p = getSharedPreferences(PREFS, MODE_PRIVATE)
        val user = p.getString("username", "").orEmpty()
        val pass = if (p.getBoolean("remember", true)) p.getString("password", "").orEmpty() else ""
        if (user.isEmpty() || pass.isEmpty()) { onDone(); return }
        Thread {
            val ok = runCatching {
                val body = JSONObject().put("username", user).put("password", pass).toString()
                    .toRequestBody("application/json; charset=utf-8".toMediaType())
                val req = Request.Builder().url(base + "/api/login").post(body).build()
                client.newCall(req).execute().use { r ->
                    if (r.code != 200) return@use false
                    val jo = JSONObject(r.body?.string().orEmpty())
                    /* cookie 由 mountWeb → applyAuthCookies 统一种，这里只落 token/uid */
                    p.edit().putString("token", jo.optString("token"))
                        .putString("uid", jo.optString("uid")).apply()
                    true
                }
            }.getOrDefault(false)
            ui.post {
                if (!ok) runCatching { p.edit().remove("token").apply() }
                onDone()
            }
        }.start()
    }

    /* ── 给前台服务调用 ── */
    fun js(code: String) {
        runOnUiThread { web?.evaluateJavascript(code, null) }
    }

    fun appVersion(): String = runCatching {
        packageManager.getPackageInfo(packageName, 0).versionName ?: ""
    }.getOrDefault("")

    /* ── 在线更新：调系统安装器 ──────────────────────────────
     * 装之前先自己校验一遍（包名/版本/minSdk/签名）：
     * 签名对不上时系统只会弹一句「应用未安装」，这里能给出人话提示。
     * 8.0+ 还要用户允许「安装未知应用」，没开就跳过去，回来再点一次安装。 */
    private fun installUpdate() {
        Updater.init(this)
        val f = Updater.currentApk()
        if (f == null) {
            Updater.failWith("bad_apk")
            toast("安装包不存在，请重新下载")
            return
        }
        val bad = Updater.verify(this, Updater.expectedCode())
        if (bad != null) {
            Updater.failWith(bad)
            toast(if (bad == "signature") "安装包签名与当前 App 不一致，请卸载后重装" else "安装包校验失败，请重新下载")
            return
        }
        if (Build.VERSION.SDK_INT >= 26 && !packageManager.canRequestPackageInstalls()) {
            Updater.needPermission()
            toast("请先允许安装未知应用")
            runCatching {
                startActivity(Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES, Uri.parse("package:" + packageName)))
            }
            return
        }
        val uri = runCatching {
            FileProvider.getUriForFile(this, "local.xinghai.fm.fileprovider", f)
        }.getOrNull()
        if (uri == null) {
            Updater.failWith("io")
            toast("无法读取安装包")
            return
        }
        val intent = Intent(Intent.ACTION_VIEW).apply {
            setDataAndType(uri, "application/vnd.android.package-archive")
            addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_ACTIVITY_NEW_TASK)
        }
        Updater.markInstalling()
        runCatching { startActivity(intent) }.onFailure {
            Updater.failWith("io")
            toast("没有找到系统安装程序")
        }
    }

    private fun toast(msg: String) = Toast.makeText(this, msg, Toast.LENGTH_SHORT).show()

    private fun dp(v: Int): Int = (v * resources.displayMetrics.density).toInt()

    private fun lp() = LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT)

    override fun onPause() {
        CookieManager.getInstance().flush()      // 会话 Cookie 落盘，下次打开不用重新登录
        super.onPause()
    }

    override fun onResume() {
        super.onResume()
        web?.onResume()
        /* 从系统安装器回来（多半是点了取消）：把「正在安装」退回「待安装」，别卡在那 */
        Updater.backFromInstall()
    }

    override fun onDestroy() {
        if (current === this) current = null
        /* 网页没了就别再往里推更新进度；下载本身在 Updater 里继续跑 */
        Updater.onProgress = null
        /* 真正退出（返回两下 / 划掉任务）就停服务；只是按 Home 不会走到这里 */
        Dl.unwatch(onDlChanged)
        Dl.unwatchProgress(onDlChanged)
        ui.removeCallbacks(pushDlState)
        if (isFinishing) {
            /* 先把网页里的播放停掉再拆 WebView：媒体挂在渲染进程里，不先停就会「App 已经退出声音还在」 */
            web?.let { w ->
                runCatching { w.evaluateJavascript("window.FM && FM.player && FM.player.pause && FM.player.pause()", null) }
                runCatching { w.loadUrl("about:blank") }
                ui.postDelayed({ runCatching { w.destroy() } }, 150)
            }
            web = null
            /* 前台服务留着不 stop：退出后通知栏/锁屏还要显示上一集，点一下能接着播。
               网页这时已经拆了，通知栏的指令由 PlaybackService 存下来、下次界面就绪后补发。
               这里只把播放态改成暂停，别让通知栏还挂着「暂停」按钮。
               真要收干净的是「从最近任务划掉」，那条路走 PlaybackService.onTaskRemoved。 */
            runCatching { PlaybackService.current?.updatePlaying(false) }
        }
        super.onDestroy()
    }

    /* ── JS 桥：只暴露必要方法，网页全部来自自己连的那台服务器 ── */
    private inner class Bridge {
        @JavascriptInterface
        fun setPlaying(on: Boolean) {
            runOnUiThread {
                /* 后台里被通知栏按下暂停时不要再 startForegroundService（12+ 会抛异常） */
                if (on || PlaybackService.current != null) {
                    runCatching { PlaybackService.start(this@MainActivity) }
                    PlaybackService.current?.updatePlaying(on)
                }
            }
        }

        @JavascriptInterface
        fun setTrack(title: String?, sub: String?, cover: String?) {
            val t = title ?: ""
            runOnUiThread {
                /* 有曲目就把前台服务拉起来，哪怕没在播：冷启动后通知栏也要显示上一集，
                   否则界面底部有节目、通知栏却是空的（以前只有 setPlaying(true) 才建服务）。
                   后台起 FGS 会被系统拦，拦了就等下次真正播放时再说。 */
                if (t.isNotEmpty() && PlaybackService.current == null) {
                    runCatching { PlaybackService.start(this@MainActivity) }
                }
                PlaybackService.current?.updateTrack(t, sub ?: "", cover ?: "")
            }
        }

        /* 网页上报「这次长按允许选字」：手指落在输入框或 .selectable 纯文字上才为 true。
           只改一个标记，别在这里碰 UI（该方法由 WebView 的 JS 线程调用）。
           名字跟语义对齐（不是「是否在编辑」，是「是否允许选字」），网页侧同名调用 */
        @JavascriptInterface
        fun setSelectAllowed(on: Boolean) {
            selectAllowed = on
        }

        /* 网页脚本就绪（android.js 首次 syncMedia 之后调一次）：
           通知栏在界面没起来时按下的播放/暂停先存在服务里，这里补发执行 */
        @JavascriptInterface
        fun ready() {
            val cmd = PlaybackService.takePending() ?: return
            this@MainActivity.js("window.FM && FM.android && FM.android.mediaAction && FM.android.mediaAction('" + cmd + "')")
        }

        @JavascriptInterface
        fun setNav(hasPrev: Boolean, hasNext: Boolean) {
            runOnUiThread { PlaybackService.current?.updateNav(hasPrev, hasNext) }
        }

        @JavascriptInterface
        fun setProgress(posMs: Double, durMs: Double) {
            /* NaN / Infinity → 0；上限 24 小时，防止脏值把锁屏时长撑爆 */
            val p = if (posMs.isFinite()) posMs.toLong().coerceIn(0L, MAX_MS) else 0L
            val d = if (durMs.isFinite()) durMs.toLong().coerceIn(0L, MAX_MS) else 0L
            runOnUiThread { PlaybackService.current?.updateProgress(p, d) }
        }

        /* 网页把整条视频队列交给原生播放器：{ list:[{rel,id,title,sub}], index, start(ms), autoplay } */
        @JavascriptInterface
        fun playVideo(json: String) {
            runOnUiThread {
                val obj = runCatching { JSONObject(json) }.getOrNull() ?: return@runOnUiThread
                val list = obj.optJSONArray("list")?.toString() ?: "[]"
                val i = Intent(this@MainActivity, VideoPlayerActivity::class.java)
                i.putExtra("list", list)
                i.putExtra("index", obj.optInt("index", 0))
                i.putExtra("start", obj.optLong("start", 0L))
                i.putExtra("autoplay", obj.optBoolean("autoplay", true))
                startActivity(i)
            }
        }

        @JavascriptInterface
        fun setFullscreen(on: Boolean) = this@MainActivity.setFullscreen(on)

        /* 播放详情页（音频）锁竖屏：只有网页里那一页要禁横屏，
           视频走原生播放器（VideoPlayerActivity 自己管横竖），列表页也照旧跟随系统。
           这里只是临时改 requestedOrientation，不改 Activity 的固定横竖屏属性 */
        @JavascriptInterface
        fun lockPortrait(on: Boolean) {
            runOnUiThread {
                if (appFullscreen) return@runOnUiThread     /* 网页全屏看视频时别抢方向 */
                requestedOrientation = if (on) ActivityInfo.SCREEN_ORIENTATION_PORTRAIT
                else ActivityInfo.SCREEN_ORIENTATION_UNSPECIFIED
            }
        }

        /* 网页点「下载」：传 [{libId,libName,album,rel,title,ext,size}]，交给下载队列 */
        @JavascriptInterface
        fun downloadTracks(json: String) {
            val arr = runCatching { JSONArray(json) }.getOrNull() ?: return
            val batch = ArrayList<Dl.Item>()
            for (k in 0 until arr.length()) {
                val o = arr.optJSONObject(k) ?: continue
                val rel = o.optString("rel")
                if (rel.isEmpty()) continue
                batch.add(
                    Dl.Item(
                        libId = o.optString("libId"),
                        libName = o.optString("libName"),
                        album = o.optString("album"),
                        rel = rel,
                        title = o.optString("title"),
                        ext = o.optString("ext"),
                        size = o.optLong("size")
                    )
                )
            }
            if (batch.isEmpty()) return
            /* 空间检查、流量确认、入队、提示都在 DownloadQueue，和原生下载页同一套流程 */
            runOnUiThread { DownloadQueue.enqueue(this@MainActivity, batch) }
        }

        @JavascriptInterface
        fun openSettings() = showServerDialog()

        /* 网页设置菜单里的「退出登录」；服务器设置弹窗里已不再放这个按钮 */
        @JavascriptInterface
        fun logout() = this@MainActivity.logout()

        /* 侧栏「下载管理」里的「管理」按钮：打开原生下载页（删除/重试在那儿） */
        @JavascriptInterface
        fun openDownloads() = runOnUiThread { this@MainActivity.openDownloads() }

        /* 网页删掉已下载曲目（单个 / 批量）：文件、索引、在途请求都由 Dl 收拾 */
        @JavascriptInterface
        fun removeDownload(rel: String) {
            if (rel.isEmpty()) return
            runOnUiThread {
                Dl.init(this@MainActivity)
                Dl.remove(rel)
            }
        }

        @JavascriptInterface
        fun removeDownloads(relsJson: String) {
            val arr = runCatching { JSONArray(relsJson) }.getOrNull() ?: return
            val rels = ArrayList<String>(arr.length())
            for (k in 0 until arr.length()) {
                val r = arr.optString(k)
                if (r.isNotEmpty()) rels.add(r)
            }
            if (rels.isEmpty()) return
            runOnUiThread {
                Dl.init(this@MainActivity)
                Dl.removeMany(rels)
            }
        }

        /* 手机可用空间（字节），下载管理页显示「已占用 / 可用」 */
        @JavascriptInterface
        fun freeSpace(): Long =
            runCatching { StatFs(filesDir.absolutePath).availableBytes }.getOrDefault(0L)

        /* 已下载清单：[{rel,libId,album,title,ext,size}]，网页据此画下载管理页和已下载标记 */
        @JavascriptInterface
        fun downloads(): String = runCatching {
            Dl.init(this@MainActivity)
            Dl.snapshot().toString()
        }.getOrDefault("[]")

        /* 已下载曲目的本机播放地址（127.0.0.1 小服务，带 Range）；没下载或没起服务返回空 */
        @JavascriptInterface
        fun localUrl(rel: String): String = runCatching {
            if (rel.isEmpty()) "" else { Dl.init(this@MainActivity); Dl.localUrl(rel) }
        }.getOrDefault("")

        @JavascriptInterface
        fun baseUrl(): String = serverBase()

        @JavascriptInterface
        fun version(): String = appVersion()

        /* ── 在线更新 ──
           url 是 /api/app/version 给的站内相对路径，这里拼上 serverBase 再去下载：
           只有同源地址才取得到 WebView 的会话 Cookie（见 Updater.run）。 */
        @JavascriptInterface
        fun downloadApk(url: String, version: String, etag: String) {
            Updater.init(this@MainActivity)
            Updater.download(serverBase(), url, version, etag)
        }

        @JavascriptInterface
        fun cancelDownload() = Updater.cancel()

        @JavascriptInterface
        fun updateState(): String = Updater.stateJson()

        /* 当前是不是不计费网络（Wi-Fi/以太网）：网页据此决定要不要静默预下载 */
        @JavascriptInterface
        fun isWifi(): Boolean = Updater.isWifi(this@MainActivity)

        @JavascriptInterface
        fun installApk() {
            runOnUiThread { this@MainActivity.installUpdate() }
        }
    }
}
