/* ── MainActivity · 星海FM 安卓壳 ────────────────────────
 * 只做三件事：连哪台电脑、把网页装进 WebView、把播放状态告诉前台服务。
 * 界面、数据、播放全部由 tools/serve.js + 现有 web 层负责。
 */
package local.xinghai.fm

import android.app.Activity
import android.app.AlertDialog
import android.content.Intent
import android.content.pm.ActivityInfo
import android.content.pm.PackageManager
import android.graphics.Color
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.text.InputType
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
import android.widget.TextView
import android.widget.Toast

class MainActivity : Activity() {

    companion object {
        private const val PREFS = "fm"
        private const val KEY_BASE = "base"
        private const val BG = 0xFF05070E.toInt()
        private const val NOTI_PERM = 11

        @Volatile
        var current: MainActivity? = null
    }

    private lateinit var root: FrameLayout
    private var web: WebView? = null
    private var offline: View? = null
    private var customView: View? = null
    private var customCallback: WebChromeClient.CustomViewCallback? = null
    private var loadFailed = false
    private var lastBack = 0L

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        current = this
        window.statusBarColor = BG
        window.navigationBarColor = BG
        root = FrameLayout(this)
        root.setBackgroundColor(BG)
        setContentView(root)
        askNotificationPermission()
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
    @Suppress("SetJavaScriptEnabled")
    private fun mountWeb() {
        web?.let { runCatching { root.removeView(it); it.destroy() } }
        web = null
        root.removeAllViews()
        offline = null

        val w = WebView(this)
        web = w
        w.setBackgroundColor(BG)
        w.overScrollMode = View.OVER_SCROLL_NEVER
        w.isVerticalScrollBarEnabled = false
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
            cacheMode = WebSettings.LOAD_DEFAULT
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

            override fun onReceivedError(view: WebView, req: WebResourceRequest, err: WebResourceError) {
                if (req.isForMainFrame) {
                    loadFailed = true
                    showOffline()
                }
            }

            override fun onPageFinished(view: WebView, url: String) {
                if (!loadFailed) hideOffline()
            }
        }

        w.webChromeClient = object : WebChromeClient() {
            override fun onShowCustomView(view: View, callback: CustomViewCallback) = showVideo(view, callback)
            override fun onHideCustomView() = hideVideo()
        }

        root.addView(w, FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))
        load()
    }

    private fun load() {
        loadFailed = false
        web?.loadUrl(serverBase() + "/")
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
            text = "连不上电脑上的服务"
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

    private fun leave() {
        val now = System.currentTimeMillis()
        if (now - lastBack < 2000) {
            finish()
            return
        }
        lastBack = now
        toast("再按一次返回键退出")
    }

    /* ── 服务器设置 ── */
    fun showServerDialog() {
        runOnUiThread {
            val input = EditText(this).apply {
                setText(serverBase())
                setSingleLine(true)
                inputType = InputType.TYPE_TEXT_VARIATION_URI
                setSelection(text.length)
            }
            val box = LinearLayout(this).apply {
                orientation = LinearLayout.VERTICAL
                setPadding(dp(22), dp(8), dp(22), 0)
            }
            box.addView(input, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT))

            AlertDialog.Builder(this)
                .setTitle("服务器设置")
                .setView(box)
                .setPositiveButton("保存") { _, _ ->
                    val b = normalize(input.text.toString())
                    saveBase(b)
                    if (b.isEmpty()) showSetup() else mountWeb()
                }
                .setNeutralButton("清除登录") { _, _ ->
                    CookieManager.getInstance().removeAllCookies(null)
                    CookieManager.getInstance().flush()
                    load()
                }
                .setNegativeButton("取消", null)
                .show()
        }
    }

    /* ── 给前台服务调用 ── */
    fun js(code: String) {
        runOnUiThread { web?.evaluateJavascript(code, null) }
    }

    fun appVersion(): String = runCatching {
        packageManager.getPackageInfo(packageName, 0).versionName ?: ""
    }.getOrDefault("")

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
    }

    override fun onDestroy() {
        if (current === this) current = null
        /* 真正退出（返回两下 / 划掉任务）就停服务；只是按 Home 不会走到这里 */
        if (isFinishing) PlaybackService.stop(this)
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
        fun setTrack(title: String?, sub: String?) {
            runOnUiThread { PlaybackService.current?.updateTrack(title ?: "", sub ?: "") }
        }

        @JavascriptInterface
        fun setNav(hasPrev: Boolean, hasNext: Boolean) {
            runOnUiThread { PlaybackService.current?.updateNav(hasPrev, hasNext) }
        }

        @JavascriptInterface
        fun setFullscreen(on: Boolean) = this@MainActivity.setFullscreen(on)

        @JavascriptInterface
        fun openSettings() = showServerDialog()

        @JavascriptInterface
        fun baseUrl(): String = serverBase()

        @JavascriptInterface
        fun version(): String = appVersion()
    }
}
