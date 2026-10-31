/* ── LoginActivity · 原生登录页 ─────────────────────────────
 * 用户名 + 密码 → POST {base}/api/login → {token}；
 * 把 token 写成会话 cookie(fm_sess) 后进入 MainActivity(网页主页)。
 * 记住登录态：下次启动用 token 校验 /api/config，通过直接进主页。
 */
package local.xinghai.fm

import android.app.Activity
import android.content.Intent
import android.graphics.Color
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.text.InputType
import android.view.Gravity
import android.view.View
import android.view.ViewGroup
import android.webkit.CookieManager
import android.widget.Button
import android.widget.EditText
import android.widget.FrameLayout
import android.widget.LinearLayout
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

    private lateinit var urlInput: EditText
    private lateinit var userInput: EditText
    private lateinit var passInput: EditText
    private lateinit var loginBtn: Button
    private lateinit var errorView: TextView
    private lateinit var progress: ProgressBar
    private var retryToken = ""

    private val ui = Handler(Looper.getMainLooper())
    private val client: OkHttpClient by lazy {
        OkHttpClient.Builder()
            .connectTimeout(8, TimeUnit.SECONDS)
            .readTimeout(15, TimeUnit.SECONDS)
            .build()
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        window.statusBarColor = BG
        window.navigationBarColor = BG
        buildUi()
        val base = prefs().getString("base", "").orEmpty()
        val token = prefs().getString("token", "").orEmpty()
        urlInput.setText(base)
        userInput.setText(prefs().getString("username", "").orEmpty())
        if (base.isNotEmpty() && token.isNotEmpty()) autoLogin(base, token)
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

        urlInput = field("服务器地址  http://192.168.1.8:8080", InputType.TYPE_TEXT_VARIATION_URI)
        userInput = field("用户名", InputType.TYPE_CLASS_TEXT)
        passInput = field("密码", InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_PASSWORD)
        box.addView(urlInput, lp(top = 10))
        box.addView(userInput, lp(top = 10))
        box.addView(passInput, lp(top = 10))

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
        loginBtn.isEnabled = !busy
        progress.visibility = if (busy) View.VISIBLE else View.GONE
    }

    private fun err(msg: String) {
        errorView.text = msg
        errorView.visibility = if (msg.isEmpty()) View.GONE else View.VISIBLE
    }

    private fun doLogin() {
        /* 有未失效 token 且没填密码：走「重试连接」而不是重新登录 */
        if (retryToken.isNotEmpty() && passInput.text.isEmpty()) {
            val rb = normalize(urlInput.text.toString())
            if (rb.isNotEmpty()) { saveBase(rb); autoLogin(rb, retryToken); return }
        }
        val base = normalize(urlInput.text.toString())
        val user = userInput.text.toString().trim()
        val pass = passInput.text.toString()
        if (base.isEmpty()) { err("请填写服务器地址"); return }
        if (user.isEmpty()) { err("请填写用户名"); return }
        if (pass.isEmpty()) { err("请填写密码"); return }
        saveBase(base)
        setBusy(true); err("")
        Thread {
            try {
                val json = JSONObject().put("username", user).put("password", pass).toString()
                val body = json.toRequestBody("application/json; charset=utf-8".toMediaType())
                val req = Request.Builder().url(base + "/api/login").post(body).build()
                client.newCall(req).execute().use { r ->
                    val text = r.body?.string().orEmpty()
                    when (r.code) {
                        200 -> {
                            val jo = runCatching { JSONObject(text) }.getOrNull()
                            val token = jo?.optString("token") ?: ""
                            val uid = jo?.optString("uid") ?: ""
                            val setCookies = r.headers("Set-Cookie")
                            ui.post {
                                for (c in setCookies) runCatching { CookieManager.getInstance().setCookie(base, c) }
                                onLoginOk(base, token, uid, user)
                            }
                        }
                        401 -> ui.post { setBusy(false); err("用户名或密码不正确") }
                        429 -> ui.post { setBusy(false); err(text.ifBlank { "尝试过多，请稍后再试" }) }
                        else -> ui.post { setBusy(false); err("登录失败（" + r.code + "）") }
                    }
                }
            } catch (e: Exception) {
                ui.post { setBusy(false); err("连不上服务器，请检查地址或网络") }
            }
        }.start()
    }

    private fun autoLogin(base: String, token: String) {
        setBusy(true); err("")
        Thread {
            try {
                val req = Request.Builder().url(base + "/api/config").header("Authorization", "Bearer " + token).build()
                client.newCall(req).execute().use { r ->
                if (r.code == 200) {
                    ui.post { onLoginOk(base, token, prefs().getString("uid", "").orEmpty(), prefs().getString("username", "").orEmpty()) }
                } else {
                    prefs().edit().remove("token").apply()
                    retryToken = ""
                    ui.post { setBusy(false); loginBtn.text = "登录"; err("登录已失效，请重新登录") }
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
        loginBtn.text = "登录"
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
