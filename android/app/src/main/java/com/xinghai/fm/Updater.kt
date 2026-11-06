/* ── Updater · APK 在线更新 ────────────────────────────────
 * 更新源就是手机连的那台机器（serve.js 的 /api/app/... 两个接口），包落在应用私有目录：
 *   filesDir/update/XinghaiFM-<版本>.apk
 * 这里只管「下载 + 状态机」：安装交给 MainActivity（FileProvider + 系统安装器），
 * 装完重启交给 UpdateReceiver。网页通过 FM.android.onUpdateProgress 订阅状态。
 *
 * 断点续传：服务端支持 Range，.part 留着就能接着下；ETag 存 .part.etag，
 * 服务端文件被换过时 If-Range 不匹配会整包重发，不会拼出坏包。
 */
package com.xinghai.fm

import android.content.Context
import android.content.pm.PackageInfo
import android.content.pm.PackageManager
import android.net.ConnectivityManager
import android.net.NetworkCapabilities
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.os.StatFs
import android.os.SystemClock
import android.webkit.CookieManager
import okhttp3.Call
import okhttp3.OkHttpClient
import okhttp3.Request
import org.json.JSONObject
import java.io.File
import java.io.FileOutputStream
import java.security.MessageDigest
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicLong

object Updater {

    const val IDLE = "idle"
    const val DOWNLOADING = "downloading"
    const val READY = "ready"
    const val FAILED = "failed"
    const val NEED_PERMISSION = "need_permission"
    const val INSTALLING = "installing"

    private const val DIR = "update"
    private const val APK_MIN = 100L * 1024          /* 小于这个只可能是半截文件 */
    private const val SPACE_HEADROOM = 20L * 1024 * 1024
    private const val MAX_ATTEMPT = 3

    private val NAME_RE = Regex("^XinghaiFM-(\\d+\\.\\d+\\.\\d+)\\.apk$")

    @Volatile private var appCtx: Context? = null
    /* 由 MainActivity 挂上：状态/进度统一从这一条通道回推网页 */
    @Volatile var onProgress: ((String) -> Unit)? = null

    @Volatile private var state = IDLE
    @Volatile private var version = ""
    @Volatile private var loaded = 0L
    @Volatile private var total = 0L
    @Volatile private var reason = ""
    @Volatile private var etag = ""
    @Volatile private var currentPath = ""

    private val io = Executors.newSingleThreadExecutor()
    private val main = Handler(Looper.getMainLooper())
    private val seq = AtomicLong(0)
    @Volatile private var call: Call? = null
    private var lastPush = 0L

    private val net = OkHttpClient.Builder()
        .connectTimeout(10, TimeUnit.SECONDS)
        .readTimeout(30, TimeUnit.SECONDS)
        .build()

    private class Cancelled : Exception()
    private class Auth : Exception()
    private class NoSpace : Exception()

    /* ── 生命周期 ── */

    fun init(c: Context) {
        if (appCtx != null) return
        appCtx = c.applicationContext
        restore()
        /* 已经装上去了（重启后版本对上了）：这份 APK 留着只会占空间 */
        if (state == READY && version.isNotEmpty() && expectedCode() in 1..appCode(c)) {
            runCatching { File(currentPath).delete() }
            state = IDLE
            reason = ""
            version = ""
            currentPath = ""
            loaded = 0
            total = 0
        }
    }

    private fun appCode(c: Context): Long = try {
        val info = c.packageManager.getPackageInfo(c.packageName, 0)
        if (Build.VERSION.SDK_INT >= 28) {
            info.longVersionCode
        } else {
            @Suppress("DEPRECATION") info.versionCode.toLong()
        }
    } catch (e: Exception) { 0L }

    /* 进程重启后把上次下好的包认回来：用户点开设置就能直接「安装」 */
    private fun restore() {
        try {
            val f = dir().listFiles()?.filter { it.isFile && NAME_RE.matches(it.name) }
                ?.maxByOrNull { it.lastModified() } ?: return
            if (f.length() < APK_MIN) return
            val m = NAME_RE.find(f.name) ?: return
            version = m.groupValues[1]
            currentPath = f.absolutePath
            loaded = f.length()
            total = loaded
            state = READY
        } catch (e: Exception) { }
    }

    private fun dir(): File = File(appCtx!!.filesDir, DIR)

    private fun apkFor(v: String): File = File(dir(), "XinghaiFM-" + v + ".apk")

    /* 只留当前版本的包，旧版本和残片一起清掉 */
    private fun cleanOthers(keep: String) {
        try {
            val d = dir()
            if (!d.exists()) return
            val prefix = "XinghaiFM-" + keep + ".apk"
            d.listFiles()?.forEach { f ->
                if (!f.isFile) return@forEach
                if (f.name.startsWith(prefix)) return@forEach
                if (f.name.endsWith(".apk") || f.name.endsWith(".part") || f.name.endsWith(".etag")) f.delete()
            }
        } catch (e: Exception) { }
    }

    /* ── 对外：下载 / 取消 / 状态 ── */

    fun download(base: String, path: String, ver: String, tag: String) {
        val c = appCtx ?: return
        if (ver.isEmpty() || path.isEmpty()) return
        if (state == DOWNLOADING && version == ver) return
        abortRunning()
        cleanOthers(ver)
        version = ver
        etag = tag
        reason = ""
        loaded = 0
        total = 0
        val target = apkFor(ver)
        currentPath = target.absolutePath
        /* 之前已经下完整：直接进「待安装」，不重下 */
        if (target.length() >= APK_MIN) {
            loaded = target.length()
            total = loaded
            state = READY
            push(true)
            return
        }
        val url = try {
            if (path.startsWith("http")) path
            else base.trimEnd('/') + (if (path.startsWith("/")) path else "/" + path)
        } catch (e: Exception) { return }
        if (url.isEmpty()) return

        state = DOWNLOADING
        val aid = seq.incrementAndGet()
        push(true)
        io.execute { run(c, url, ver, aid) }
    }

    fun cancel() {
        abortRunning()
        val f = currentPath
        if (f.isNotEmpty()) {
            File(f + ".part").delete()
            File(f + ".part.etag").delete()
        }
        state = IDLE
        loaded = 0
        total = 0
        reason = ""
        push(true)
    }

    fun markInstalling() {
        state = INSTALLING
        push(true)
    }

    /* 从系统安装器回来：安装动作已经结束。装成功进程会被系统杀掉，走不到这里；
       能回到 onResume 基本是用户点了「取消」或安装器没接住，退回「待安装」让他再试。 */
    fun backFromInstall() {
        if (state != INSTALLING) return
        state = READY
        reason = ""
        push(true)
    }

    fun needPermission() {
        state = NEED_PERMISSION
        push(true)
    }

    fun failWith(why: String) {
        state = FAILED
        reason = why
        push(true)
    }

    fun currentApk(): File? {
        val p = currentPath
        if (p.isEmpty()) return null
        val f = File(p)
        return if (f.isFile && f.length() >= APK_MIN) f else null
    }

    fun stateJson(): String = try {
        JSONObject().apply {
            put("state", state)
            put("version", version)
            put("loaded", loaded)
            put("total", total)
            put("reason", reason)
            put("file", currentPath)
        }.toString()
    } catch (e: Exception) { "{}" }

    /* 版本号换算成 versionCode，与 gradle / serve.js 同一套公式 */
    fun expectedCode(): Long {
        val p = version.split(".")
        fun at(i: Int): Long = p.getOrNull(i)?.toLongOrNull() ?: 0L
        return at(0) * 10000 + at(1) * 100 + at(2)
    }

    /* 非计费网络（Wi-Fi / 以太网）：网页据此决定要不要静默预下载 */
    fun isWifi(c: Context): Boolean = try {
        val cm = c.getSystemService(Context.CONNECTIVITY_SERVICE) as ConnectivityManager
        val n = cm.activeNetwork
        val cap = if (n == null) null else cm.getNetworkCapabilities(n)
        cap != null && cap.hasCapability(NetworkCapabilities.NET_CAPABILITY_NOT_METERED)
    } catch (e: Exception) { false }

    /* ── 安装前校验：包名 / 版本 / minSdk / 签名，装之前就把明显装不上的挡掉 ── */
    fun verify(c: Context, expected: Long): String? {
        val f = currentApk() ?: return "bad_apk"
        val pm = c.packageManager
        val flags = if (Build.VERSION.SDK_INT >= 28) {
            PackageManager.GET_SIGNING_CERTIFICATES
        } else {
            @Suppress("DEPRECATION") PackageManager.GET_SIGNATURES
        }
        val info = try { pm.getPackageArchiveInfo(f.absolutePath, flags) } catch (e: Exception) { null }
            ?: return "bad_apk"
        if (info.packageName != c.packageName) return "bad_apk"
        val code = if (Build.VERSION.SDK_INT >= 28) {
            info.longVersionCode
        } else {
            @Suppress("DEPRECATION") info.versionCode.toLong()
        }
        if (expected > 0 && code != expected) return "bad_apk"
        val minSdk = try { info.applicationInfo?.minSdkVersion ?: 0 } catch (e: Exception) { 0 }
        if (minSdk > Build.VERSION.SDK_INT) return "bad_apk"
        val self = try { pm.getPackageInfo(c.packageName, flags) } catch (e: Exception) { null } ?: return "bad_apk"
        val a = digestOf(info) ?: return "bad_apk"
        val b = digestOf(self) ?: return "bad_apk"
        if (a != b) return "signature"
        return null
    }

    private fun digestOf(info: PackageInfo): String? {
        val cert = try {
            if (Build.VERSION.SDK_INT >= 28) {
                val si = info.signingInfo ?: return null
                if (si.hasMultipleSigners()) si.apkContentsSigners.firstOrNull() else si.signingCertificateHistory.firstOrNull()
            } else {
                @Suppress("DEPRECATION") info.signatures?.firstOrNull()
            }
        } catch (e: Exception) { null } ?: return null
        val d = MessageDigest.getInstance("SHA-256").digest(cert.toByteArray())
        val sb = StringBuilder()
        for (b in d) sb.append(String.format("%02x", b))
        return sb.toString()
    }

    /* ── 下载 ── */

    private fun abortRunning() {
        seq.incrementAndGet()
        runCatching { call?.cancel() }
        call = null
    }

    private fun run(c: Context, url: String, ver: String, aid: Long) {
        val target = apkFor(ver)
        target.parentFile?.mkdirs()
        val tmp = File(target.parentFile, target.name + ".part")
        val meta = File(target.parentFile, target.name + ".part.etag")
        var attempt = 0
        while (true) {
            if (seq.get() != aid) return
            try {
                val offset = if (tmp.exists()) tmp.length().coerceAtLeast(0L) else 0L
                val savedTag = if (meta.exists()) runCatching { meta.readText().trim() }.getOrDefault("") else ""
                val cookie = try { CookieManager.getInstance().getCookie(url) ?: "" } catch (e: Exception) { "" }
                val token = try {
                    c.getSharedPreferences("fm", Context.MODE_PRIVATE).getString("token", "").orEmpty()
                } catch (e: Exception) { "" }
                val req = Request.Builder().url(url).apply {
                    if (cookie.isNotEmpty()) header("Cookie", cookie)
                    if (token.isNotEmpty()) header("Authorization", "Bearer " + token)
                    if (offset > 0) {
                        header("Range", "bytes=" + offset + "-")
                        val t = if (savedTag.isNotEmpty()) savedTag else etag
                        if (t.isNotEmpty()) header("If-Range", t)
                    }
                }.build()
                val c0 = net.newCall(req)
                call = c0
                c0.execute().use { resp ->
                    if (resp.code == 401 || resp.code == 403) throw Auth()
                    if (!resp.isSuccessful) throw RuntimeException("HTTP " + resp.code)
                    val body = resp.body ?: throw RuntimeException("empty body")
                    val resume = offset > 0 && resp.code == 206
                    val startAt = if (resume) offset else 0L
                    val len = body.contentLength()
                    val need = if (len > 0) startAt + len else 0L
                    total = need
                    /* 空间不够就别开始写，写一半把磁盘塞满更麻烦 */
                    val free = runCatching { StatFs(dir().absolutePath).availableBytes }.getOrDefault(Long.MAX_VALUE)
                    if (need > 0 && free < need + SPACE_HEADROOM) throw NoSpace()
                    runCatching { meta.writeText(resp.header("ETag") ?: etag) }
                    body.byteStream().use { input ->
                        FileOutputStream(tmp, resume).use { out ->
                            val buf = ByteArray(64 * 1024)
                            var sum = startAt
                            loaded = sum
                            while (true) {
                                val n = input.read(buf)
                                if (n <= 0) break
                                out.write(buf, 0, n)
                                sum += n
                                loaded = sum
                                if (seq.get() != aid) throw Cancelled()
                                push(false)
                            }
                        }
                    }
                    if (need > 0 && tmp.length() != need) throw RuntimeException("size")
                }
                if (seq.get() != aid) return
                if (!tmp.exists() || tmp.length() < APK_MIN) throw RuntimeException("size")
                if (target.exists()) target.delete()
                if (!tmp.renameTo(target)) {
                    tmp.copyTo(target, true)
                    tmp.delete()
                }
                meta.delete()
                loaded = target.length()
                total = loaded
                state = READY
                reason = ""
                call = null
                push(true)
                return
            } catch (e: Cancelled) {
                /* 用户取消：半截文件不留（cancel() 那边也在删，这边兜住「删的时候还在写」的竞态） */
                runCatching { tmp.delete() }
                runCatching { meta.delete() }
                return
            } catch (e: Auth) {
                if (seq.get() == aid) { call = null; fail("auth") }
                return
            } catch (e: NoSpace) {
                if (seq.get() == aid) { call = null; fail("space") }
                return
            } catch (e: Exception) {
                if (seq.get() != aid) return
                call = null
                val msg = e.message ?: ""
                /* 鉴权 / 文件不存在这类重试也没用，别留着半截 */
                if (msg.startsWith("HTTP 4")) {
                    tmp.delete(); meta.delete()
                    fail("bad")
                    return
                }
                attempt++
                if (attempt >= MAX_ATTEMPT) {
                    fail(if (msg == "size") "checksum" else "network")
                    return
                }
                /* 断网/超时：.part 留着，退避后接着下 */
                try { Thread.sleep(1000L * attempt) } catch (e2: Exception) { return }
            }
        }
    }

    private fun fail(why: String) {
        state = FAILED
        reason = why
        push(true)
    }

    /* 300ms 节流：进度条每帧都跨 JNI 推一次太浪费；状态变化用 push(true) 立即发 */
    private fun push(force: Boolean) {
        val now = SystemClock.elapsedRealtime()
        if (!force && now - lastPush < 300) return
        lastPush = now
        val json = stateJson()
        main.post { runCatching { onProgress?.invoke(json) } }
    }
}
