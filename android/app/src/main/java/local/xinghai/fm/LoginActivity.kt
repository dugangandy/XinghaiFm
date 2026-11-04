/* ── LoginActivity · 原生登录页 ─────────────────────────────
 * 用户名 + 密码 → POST {base}/api/login → {token}；
 * 把 token 写成会话 cookie(fm_sess) 后进入 MainActivity(网页主页)。
 * 记住登录态：下次启动用 token 校验 /api/config，通过直接进主页。
 * 已经登录过的用户不会看到登录表单：先铺 slogan 页（和网页启动页同一句），
 * 校验通过就进主页，失败（token 失效）才把表单拿出来。
 * 服务器地址是下拉列表（生产 / 测试 / 自定义）：列表与输入框默认不露 URL，
 * 只有长按或鼠标悬浮（tooltip）才显示；勾了「记住密码」后两个地址共用一份账号密码，
 * 切地址不用重打。
 */
package local.xinghai.fm

import android.app.Activity
import android.content.Context
import android.content.Intent
import android.graphics.Color
import android.graphics.Typeface
import android.graphics.drawable.GradientDrawable
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.text.InputType
import android.view.Gravity
import android.view.View
import android.view.ViewGroup
import android.webkit.CookieManager
import android.widget.Button
import android.widget.CheckBox
import android.widget.EditText
import android.widget.FrameLayout
import android.widget.ImageView
import android.widget.LinearLayout
import android.widget.PopupMenu
import android.widget.ProgressBar
import android.widget.TextView
import android.widget.Toast
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONObject
import java.util.concurrent.TimeUnit

class LoginActivity : Activity() {

    private val BG = 0xFF05070E.toInt()
    private val DIM = 0xFF7A869E.toInt()
    private val HINT = 0xFF59637A.toInt()

    private lateinit var serverPick: TextView
    private lateinit var urlInput: EditText       /* 只有「自定义」时才露出来 */
    private lateinit var userInput: EditText
    private lateinit var passInput: EditText
    private lateinit var rememberBox: CheckBox
    private lateinit var loginBtn: Button
    private lateinit var errorView: TextView
    private lateinit var progress: ProgressBar
    private var retryToken = ""
    /* 下拉里选中的地址；选「自定义」时 customMode = true，地址以 urlInput 为准 */
    private var base = ""
    private var customMode = false
    /* 登录表单是否已经建出来：已登录过的用户先看 slogan 页，表单可能一直不建，
       所以 setBusy / err 这些碰控件的入口都要先问一句 */
    private var hasForm = false

    private val ui = Handler(Looper.getMainLooper())

    /* 登录页只列名字，地址藏在 tooltip 里（长按 / 鼠标悬浮才显示）；和服务器设置页共用一份 */
    private val servers = Servers.list
    private val client: OkHttpClient by lazy {
        OkHttpClient.Builder()
            .connectTimeout(8, TimeUnit.SECONDS)
            .readTimeout(15, TimeUnit.SECONDS)
            .build()
    }
    /* 校验「上次的 token 还能不能用」专用：连接不上时不能让人对着 slogan 页干等 8 秒，
       超时就当连不上处理，直接进主页（离线页 / 已下载仍可播） */
    private val probe: OkHttpClient by lazy {
        OkHttpClient.Builder()
            .connectTimeout(3, TimeUnit.SECONDS)
            .readTimeout(4, TimeUnit.SECONDS)
            .build()
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        window.statusBarColor = BG
        window.navigationBarColor = BG
        /* 覆盖安装完被 UpdateReceiver 拉起来：界面已经回来了，把「点击打开」通知收掉 */
        runCatching {
            (getSystemService(Context.NOTIFICATION_SERVICE) as? android.app.NotificationManager)
                ?.cancel(UpdateReceiver.NOTI_ID)
        }
        val base = prefs().getString("base", "").orEmpty()
        val token = prefs().getString("token", "").orEmpty()
        /* 登录过：一进来就是 slogan 页，别让登录表单闪一下（原来先 buildUi 再校验，
           校验那几十毫秒到几秒里用户看到的是登录框） */
        if (base.isNotEmpty() && token.isNotEmpty()) {
            buildSplash()
            autoLogin(base, token)
        } else {
            showForm()
        }
    }

    private fun prefs() = getSharedPreferences("fm", MODE_PRIVATE)

    private fun dp(v: Int) = (v * resources.displayMetrics.density).toInt()

    private fun buildUi() {
        val root = FrameLayout(this).apply { setBackgroundColor(BG) }
        val box = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            gravity = Gravity.CENTER
            setPadding(dp(30), dp(30), dp(30), dp(30))
        }
        box.addView(TextView(this).apply {
            text = "星海 FM"; textSize = 26f; setTextColor(Color.WHITE); gravity = Gravity.CENTER_HORIZONTAL
        }, lp())
        box.addView(TextView(this).apply {
            text = "登录后进入媒体库"; textSize = 13f; setTextColor(DIM)
            gravity = Gravity.CENTER_HORIZONTAL; setPadding(0, dp(8), 0, dp(22))
        }, lp())

        base = prefs().getString("base", "").orEmpty()
        if (base.isEmpty()) base = servers[0].second      /* 首次进：默认生产 */
        customMode = servers.none { it.second == base }

        serverPick = TextView(this).apply {
            textSize = 14f
            setTextColor(Color.WHITE)
            setPadding(dp(12), dp(11), dp(12), dp(11))
            background = GradientDrawable().apply {
                cornerRadius = dp(10).toFloat()
                setColor(0x1AFFFFFF)
                setStroke(dp(1), 0x33FFFFFF)
            }
            setOnClickListener { pickServer() }
        }
        urlInput = field("服务器地址  http://192.168.1.8:8080", InputType.TYPE_TEXT_VARIATION_URI)
        urlInput.setText(base)
        userInput = field("用户名", InputType.TYPE_CLASS_TEXT)
        passInput = field("密码", InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_PASSWORD)
        rememberBox = CheckBox(this).apply {
            text = "记住密码"; textSize = 13f; setTextColor(DIM)
            isChecked = prefs().getBoolean("remember", true)
            setOnCheckedChangeListener { _, on ->
                prefs().edit().putBoolean("remember", on).remove("password").apply()
                /* 取消勾选就把存着的密码抹掉，别留在机器里 */
                if (on) prefs().edit().putString("password", passInput.text.toString()).apply()
            }
        }
        box.addView(serverPick, lp(top = 10))
        box.addView(urlInput, lp(top = 8))
        box.addView(userInput, lp(top = 10))
        box.addView(passInput, lp(top = 10))
        box.addView(rememberBox, lp(top = 4))

        errorView = TextView(this).apply {
            setTextColor(0xFFFF6B6B.toInt()); textSize = 12f
            setPadding(dp(4), dp(10), dp(4), 0); visibility = View.GONE
        }
        box.addView(errorView, lp())

        loginBtn = Button(this).apply {
            text = "登录"
            setOnClickListener { doLogin() }
        }
        box.addView(loginBtn, lp(top = 18))

        progress = ProgressBar(this).apply { visibility = View.GONE }
        box.addView(progress, lp(top = 12))

        root.addView(box, FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))
        setContentView(root)
        hasForm = true
    }

    /* 已登录过的用户在这里等 token 校验：标题就是网页启动页那句 slogan，
       校验通过后进主页（WebView 的启动页承接），失败再退回登录表单 */
    private fun buildSplash() {
        val root = FrameLayout(this).apply { setBackgroundColor(BG) }
        val box = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            gravity = Gravity.CENTER
            setPadding(dp(26), dp(26), dp(26), dp(26))
        }
        box.addView(TextView(this).apply {
            text = "星海有声"; textSize = 32f; setTextColor(Color.WHITE)
            typeface = Typeface.DEFAULT_BOLD; gravity = Gravity.CENTER_HORIZONTAL
            letterSpacing = 0.04f
        }, lp())
        box.addView(TextView(this).apply {
            text = "万物可听"; textSize = 32f; setTextColor(0xFF22D3EE.toInt())
            typeface = Typeface.DEFAULT_BOLD; gravity = Gravity.CENTER_HORIZONTAL
            letterSpacing = 0.04f; setPadding(0, dp(4), 0, 0)
        }, lp())
        /* 底部品牌行：小 logo + 星海 FM（和网页开屏的 .rc-brand 对齐） */
        box.addView(LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER
            setPadding(0, dp(28), 0, 0)
            addView(ImageView(this@LoginActivity).apply {
                setImageResource(R.drawable.icon)
                scaleType = ImageView.ScaleType.FIT_CENTER
            }, LinearLayout.LayoutParams(dp(18), dp(18)).apply { rightMargin = dp(8) })
            addView(TextView(this@LoginActivity).apply {
                text = "星海 FM"; textSize = 11.5f; setTextColor(DIM)
                gravity = Gravity.CENTER_VERTICAL; letterSpacing = 0.26f
            }, LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT))
        }, lp())
        root.addView(box, FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))
        setContentView(root)
    }

    /* 首次使用 / token 失效：建登录表单（并把上次的地址、记住的账号密码带出来） */
    private fun showForm() {
        if (hasForm) return
        buildUi()
        refreshServer()
        fillSaved()
    }

    /* 选中的地址不摆在明面上，只留名字；地址挂在 tooltip 上（悬浮 / 长按才显示） */
    private fun refreshServer() {
        if (!hasForm) return
        val preset = servers.firstOrNull { it.second == base }?.takeUnless { customMode }
        serverPick.text = "服务器：" + (if (preset != null) preset.first else "自定义") + "  ▾"
        /* tooltip 要 API 26+；低版本靠长按 toast 兜底 */
        if (Build.VERSION.SDK_INT >= 26) serverPick.tooltipText = currentUrl().ifEmpty { null }
        serverPick.setOnLongClickListener {
            val url = currentUrl()
            if (url.isNotEmpty()) { toast(url); true } else false
        }
        /* 自定义时才把地址输入框露出来（那本来就是用户自己填的） */
        urlInput.visibility = if (customMode) View.VISIBLE else View.GONE
        if (customMode) urlInput.setText(base)
    }

    private fun currentUrl(): String = normalize(if (customMode) urlInput.text.toString() else base)

    /* 下拉：生产 / 测试 / 自定义…（列表里同样只有名字，不铺地址） */
    private fun pickServer() {
        val pop = PopupMenu(this, serverPick)
        servers.forEachIndexed { i, s -> pop.menu.add(0, i, i, s.first) }
        pop.menu.add(0, servers.size, servers.size, "自定义…")
        pop.setOnMenuItemClickListener { item ->
            val before = currentUrl()
            if (item.itemId < servers.size) {
                base = servers[item.itemId].second
                customMode = false
            } else if (!customMode) {
                /* 从预设切自定义时先带出当前地址，方便改端口 */
                customMode = true
            }
            /* 换了服务器，旧服务器的 token 不作数，别再拿它去重试 / 自动登录 */
            retryToken = ""
            saveBase(normalize(if (customMode) urlInput.text.toString() else base))
            refreshServer()
            if (currentUrl() != before) prefs().edit().remove("token").apply()
            fillSaved()
            true
        }
        pop.show()
    }

    /* 记住的账号密码在两个地址之间共用：切地址后只补空着的框，已经填了的不动 */
    private fun fillSaved() {
        if (!hasForm) return
        if (userInput.text.isEmpty()) userInput.setText(prefs().getString("username", "").orEmpty())
        if (rememberBox.isChecked && passInput.text.isEmpty()) {
            passInput.setText(prefs().getString("password", "").orEmpty())
        }
    }

    private fun lp(top: Int = 0) = LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT).apply {
        topMargin = dp(top)
    }

    private fun field(hintText: String, type: Int): EditText = EditText(this).apply {
        hint = hintText
        setSingleLine(true)
        inputType = type
        setTextColor(Color.WHITE)
        setHintTextColor(HINT)
    }

    private fun normalize(raw: String): String {
        var s = raw.trim()
        if (s.isEmpty()) return ""
        if (!s.startsWith("http://") && !s.startsWith("https://")) s = "http://" + s
        return s.trimEnd('/')
    }

    private fun setBusy(busy: Boolean) {
        if (!hasForm) return
        loginBtn.isEnabled = !busy
        progress.visibility = if (busy) View.VISIBLE else View.GONE
    }

    private fun err(msg: String) {
        if (!hasForm) return      /* slogan 页上没有错误位，失效时会先切到表单再显示 */
        errorView.text = msg
        errorView.visibility = if (msg.isEmpty()) View.GONE else View.VISIBLE
    }

    private fun doLogin() {
        val target = normalize(if (customMode) urlInput.text.toString() else base)
        /* 有未失效 token 且没填密码：走「重试连接」而不是重新登录 */
        if (retryToken.isNotEmpty() && passInput.text.isEmpty()) {
            if (target.isNotEmpty()) { saveBase(target); autoLogin(target, retryToken); return }
        }
        val user = userInput.text.toString().trim()
        val pass = passInput.text.toString()
        if (target.isEmpty()) { err("请填写服务器地址"); return }
        if (user.isEmpty()) { err("请填写用户名"); return }
        if (pass.isEmpty()) { err("请填写密码"); return }
        saveBase(target)
        /* 勾了「记住密码」就把这份账号密码存下来，生产/测试共用，切地址不用重打 */
        prefs().edit().putString("username", user).apply {
            if (rememberBox.isChecked) putString("password", pass) else remove("password")
        }.apply()
        setBusy(true); err("")
        Thread {
            try {
                val json = JSONObject().put("username", user).put("password", pass).toString()
                val body = json.toRequestBody("application/json; charset=utf-8".toMediaType())
                val req = Request.Builder().url(target + "/api/login").post(body).build()
                client.newCall(req).execute().use { r ->
                    val text = r.body?.string().orEmpty()
                    when (r.code) {
                        200 -> {
                            val jo = runCatching { JSONObject(text) }.getOrNull()
                            val token = jo?.optString("token") ?: ""
                            val uid = jo?.optString("uid") ?: ""
                            val setCookies = r.headers("Set-Cookie")
                            ui.post {
                                for (c in setCookies) runCatching { CookieManager.getInstance().setCookie(target, c) }
                                onLoginOk(target, token, uid, user)
                            }
                        }
                        401 -> ui.post { setBusy(false); err("用户名或密码不正确") }
                        429 -> ui.post { setBusy(false); err(text.ifBlank { "尝试过多，请稍后再试" }) }
                        else -> ui.post { setBusy(false); err(Msg.NET_FAIL) }
                    }
                }
            } catch (e: Exception) {
                ui.post { setBusy(false); err(Msg.NET_FAIL) }
            }
        }.start()
    }

    private fun autoLogin(base: String, token: String) {
        Thread {
            try {
                val req = Request.Builder().url(base + "/api/config").header("Authorization", "Bearer " + token).build()
                probe.newCall(req).execute().use { r ->
                if (r.code == 200) {
                    ui.post { onLoginOk(base, token, prefs().getString("uid", "").orEmpty(), prefs().getString("username", "").orEmpty()) }
                } else {
                    /* token 失效：这时候才把登录表单拿出来 */
                    prefs().edit().remove("token").apply()
                    retryToken = ""
                    ui.post {
                        showForm()
                        setBusy(false); loginBtn.text = "登录"; err("登录已失效，请重新登录")
                    }
                }
            }
        } catch (e: Exception) {
            retryToken = token
            /* 有登录态却连不上：直接进主页（会显示离线页），再见「已下载」进原生播放，
               已下载音频/视频走 127.0.0.1 本机文件，没有网络也能播 */
            ui.post {
                onLoginOk(base, token, prefs().getString("uid", "").orEmpty(), prefs().getString("username", "").orEmpty())
            }
        }
        }.start()
    }

    private fun saveBase(v: String) {
        prefs().edit().putString("base", v).apply()
    }

    private fun onLoginOk(base: String, token: String, uid: String, user: String) {
        retryToken = ""
        if (hasForm) loginBtn.text = "登录"
        prefs().edit().putString("base", base).putString("username", user)
            .putString("token", token).putString("uid", uid).apply()
        val cm = CookieManager.getInstance()
        cm.setAcceptCookie(true)
        /* token 与 fm_sess 会话 cookie 同格式：手动种下，页面导航才算已登录 */
        if (token.isNotEmpty()) cm.setCookie(base, "fm_sess=" + token + "; Path=/")
        /* fm_uid 供前端按用户隔离本地缓存（store.js 读 document.cookie） */
        if (uid.isNotEmpty()) cm.setCookie(base, "fm_uid=" + uid + "; Path=/")
        cm.flush()
        startActivity(Intent(this, MainActivity::class.java))
        finish()
    }

    private fun toast(msg: String) = Toast.makeText(this, msg, Toast.LENGTH_SHORT).show()
}
