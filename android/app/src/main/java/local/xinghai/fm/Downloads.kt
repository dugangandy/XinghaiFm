/* ── Downloads · 安卓端离线下载 ───────────────────────────
 * 文件落在应用私有目录 downloads/<libId>/<album>/<sha1(rel)>.<ext>，
 * 索引是 downloads/index.json；下载走 OkHttp（带会话 Cookie / Bearer），
 * 播放时由本机 127.0.0.1 的小 HTTP 服务出文件（支持 Range，能拖进度）。
 */
package local.xinghai.fm

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.net.ConnectivityManager
import android.net.Network
import android.net.NetworkCapabilities
import android.net.Uri
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.webkit.CookieManager
import android.widget.Toast
import okhttp3.Call
import okhttp3.OkHttpClient
import okhttp3.Request
import org.json.JSONArray
import org.json.JSONObject
import java.io.BufferedInputStream
import java.io.File
import java.io.FileInputStream
import java.io.FileOutputStream
import java.io.InputStream
import java.io.OutputStream
import java.net.InetAddress
import java.net.ServerSocket
import java.net.Socket
import java.net.URLDecoder
import java.net.URLEncoder
import java.security.MessageDigest
import java.util.UUID
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit

object Dl {

    data class Item(
        val libId: String,
        val libName: String,
        val album: String,
        val rel: String,
        val title: String,
        val ext: String,
        val size: Long,
        val uid: String = ""
    )

    private const val DIR = "downloads"
    private const val INDEX = "index.json"

    private val lock = Any()
    private val items = LinkedHashMap<String, Item>()          // rel -> item（只放已完成的）
    private val states = ConcurrentHashMap<String, String>()   // rel -> queued / downloading / error
    private val loaded = ConcurrentHashMap<String, Long>()     // rel -> 已下载字节
    private val totals = ConcurrentHashMap<String, Long>()     // rel -> 总字节
    private val cancelled = java.util.Collections.newSetFromMap(ConcurrentHashMap<String, Boolean>())  // 下载中被删掉的 rel
    private val calls = ConcurrentHashMap<String, Call>()       // rel -> 正在跑的请求，取消时直接 cancel()
    private val inflight = ConcurrentHashMap<String, Item>()    // rel -> 正在下载的条目（还没进索引）
    private val pending = ConcurrentHashMap<String, Item>()     // rel -> 排队中还没开始的条目
    private val failed = ConcurrentHashMap<String, Item>()      // rel -> 下载失败的条目（可重试）
    private val wifiPaused = ConcurrentHashMap<String, Item>()   // rel -> 断 WIFI 暂停、等 WIFI 回来再续的条目
    private val pausedAttempt = ConcurrentHashMap<String, Long>() // rel -> 被暂停的那次 run 的 attempt
    private val attempt = ConcurrentHashMap<String, Long>()       // rel -> 当前这次下载的 attempt（防旧请求覆盖新状态）
    private val attemptSeq = java.util.concurrent.atomic.AtomicLong(0)
    private val startedOnWifi = ConcurrentHashMap<String, Boolean>()   // rel -> 入队时是否在 WIFI 上

    @Volatile private var netRegistered = false
    @Volatile private var onWifi = false
    private var netCallback: ConnectivityManager.NetworkCallback? = null

    private var appCtx: Context? = null
    private var indexReady = false

    private val net = OkHttpClient.Builder()
        .connectTimeout(10, TimeUnit.SECONDS)
        .readTimeout(30, TimeUnit.SECONDS)
        .build()
    private val workers = Executors.newFixedThreadPool(2)
    private val httpWorkers = Executors.newCachedThreadPool()
    private val connSlots = java.util.concurrent.Semaphore(8)   // 本机播放服务最多 8 个并发连接
    private val main = Handler(Looper.getMainLooper())
    @Volatile private var tickOn = false

    @Volatile private var port = 0
    @Volatile private var pathToken = ""

    /* 两路通知：
       change   —— 条目集合/状态变了（入队、完成、失败、删除），列表要重建；
       progress —— 只是字节数在动，每秒一次，刷新数字就够，别重建列表。
       网页两路都订阅（它自己读快照），原生下载页只在 change 时 render。 */
    private val watchers = java.util.concurrent.CopyOnWriteArrayList<() -> Unit>()
    private val progressWatchers = java.util.concurrent.CopyOnWriteArrayList<() -> Unit>()
    fun watch(fn: () -> Unit) { watchers.add(fn) }
    fun unwatch(fn: () -> Unit) { watchers.remove(fn) }
    fun watchProgress(fn: () -> Unit) { progressWatchers.add(fn) }
    fun unwatchProgress(fn: () -> Unit) { progressWatchers.remove(fn) }

    var onError: ((String) -> Unit)? = null

    /* ── 初始化 / 索引 ── */
    fun init(c: Context) {
        appCtx = c.applicationContext
        synchronized(lock) {
            if (!indexReady) {
                load()
                indexReady = true
            }
        }
        if (port == 0) startServer()
        registerNetwork()
    }

    private fun root(): File = File(appCtx!!.filesDir, DIR)

    private fun fileFor(it: Item): File {
        val dir = File(root(), safe(it.libId) + "/" + safe(it.album))
        return File(dir, sha1(it.rel) + "." + it.ext.ifEmpty { "bin" })
    }

    private fun safe(v: String): String {
        val s = v.replace(Regex("[^\\p{L}\\p{N}._-]"), "_").trim('_')
        return if (s.isEmpty()) "x" else s.take(48)
    }

    private fun sha1(v: String): String {
        val md = MessageDigest.getInstance("SHA-1")
        val bytes = md.digest(v.toByteArray(Charsets.UTF_8))
        val sb = StringBuilder()
        for (b in bytes) sb.append(String.format("%02x", b))
        return sb.toString()
    }

    /* 当前登录用户：下载按用户隔离，换账号不串数据 */
    private fun currentUid(): String = try {
        appCtx?.getSharedPreferences("fm", Context.MODE_PRIVATE)?.getString("uid", "").orEmpty()
    } catch (e: Exception) { "" }

    private fun partOf(it: Item): File = File(fileFor(it).parentFile, fileFor(it).name + ".part")

    /* 索引按「用户 + 相对路径」存，两个账号指向同一目录也不会互相顶掉 */
    private fun keyOf(uid: String, rel: String): String = uid + "|" + rel

    /* 进程被杀留下的 .part 没有续传价值，启动时清掉，免得白占空间 */
    private fun cleanParts() {
        try {
            val r = root()
            if (!r.exists()) return
            /* 只清 3 天前的残片：近期的留给断点续传 */
            val cutoff = System.currentTimeMillis() - 3L * 24 * 3600 * 1000
            r.walkTopDown().forEach { f -> if (f.isFile && f.name.endsWith(".part") && f.lastModified() < cutoff) f.delete() }
        } catch (e: Exception) { }
    }

    private fun load() {
        cleanParts()
        val f = File(root(), INDEX)
        if (!f.exists()) return
        try {
            val arr = JSONObject(f.readText()).optJSONArray("items") ?: return
            for (i in 0 until arr.length()) {
                val o = arr.optJSONObject(i) ?: continue
                val it = Item(
                    o.optString("libId"), o.optString("libName"), o.optString("album"),
                    o.optString("rel"), o.optString("title"), o.optString("ext"), o.optLong("size")
                )
                if (it.rel.isEmpty()) continue
                if (!fileFor(it).exists()) continue
                /* 没写 uid 的旧记录归当前用户，避免升级后列表空掉 */
                val rec = if (it.uid.isEmpty()) it.copy(uid = currentUid()) else it
                items[keyOf(rec.uid, rec.rel)] = rec
            }
        } catch (e: Exception) { /* 索引坏了就当没下载过，文件还在也能被重新识别 */ }
    }

    private fun save() {
        try {
            val arr = JSONArray()
            for (it in items.values) {
                arr.put(JSONObject()
                    .put("libId", it.libId).put("libName", it.libName).put("album", it.album)
                    .put("rel", it.rel).put("title", it.title).put("ext", it.ext).put("size", it.size)
                    .put("uid", it.uid))
            }
            val root = root()
            root.mkdirs()
            val tmp = File(root, INDEX + ".tmp")
            tmp.writeText(JSONObject().put("items", arr).toString())
            val dst = File(root, INDEX)
            if (!tmp.renameTo(dst)) {
                tmp.copyTo(dst, true)
                tmp.delete()
            }
        } catch (e: Exception) { /* 落盘失败不影响本次会话 */ }
    }

    /* ── 查询 ── */
    /* 移动网络判断：原生页面和网页发起的下载共用一套规则 */
    fun isMetered(c: Context): Boolean = try {
        val cm = c.getSystemService(ConnectivityManager::class.java)
        val net = cm.activeNetwork ?: return true
        val caps = cm.getNetworkCapabilities(net) ?: return true
        !caps.hasCapability(NetworkCapabilities.NET_CAPABILITY_NOT_METERED) &&
            !caps.hasTransport(NetworkCapabilities.TRANSPORT_WIFI) &&
            !caps.hasTransport(NetworkCapabilities.TRANSPORT_ETHERNET)
    } catch (e: Exception) { false }

    /* 当前是否处在“可以随便下”的网络：WIFI / 以太网 / 任何非计费网络；
       断网（activeNetwork 为空）算不能下，会触发暂停 */
    private fun isOnWifi(cm: ConnectivityManager): Boolean = try {
        val n = cm.activeNetwork ?: return false
        val caps = cm.getNetworkCapabilities(n) ?: return false
        caps.hasTransport(NetworkCapabilities.TRANSPORT_WIFI) ||
            caps.hasTransport(NetworkCapabilities.TRANSPORT_ETHERNET) ||
            caps.hasCapability(NetworkCapabilities.NET_CAPABILITY_NOT_METERED)
    } catch (e: Exception) { false }

    /* 监听默认网络：WIFI/非计费 ↔ 移动数据/断网 来回切换时，自动暂停 / 续传下载 */
    private fun registerNetwork() {
        val c = appCtx ?: return
        if (netRegistered) return
        netRegistered = true
        try {
            val cm = c.getSystemService(ConnectivityManager::class.java)
            onWifi = isOnWifi(cm)
            val cb = object : ConnectivityManager.NetworkCallback() {
                override fun onAvailable(network: Network) = refreshNetwork()
                override fun onLost(network: Network) = refreshNetwork()
                override fun onCapabilitiesChanged(network: Network, caps: NetworkCapabilities) = refreshNetwork()
            }
            cm.registerDefaultNetworkCallback(cb)
            netCallback = cb
        } catch (e: Exception) {
            netRegistered = false
        }
    }

    private fun refreshNetwork() {
        val c = appCtx ?: return
        val cm = c.getSystemService(ConnectivityManager::class.java)
        val now = isOnWifi(cm)
        val was = onWifi
        onWifi = now
        if (was == now) return
        if (was && !now) pauseForWifi()      // WIFI 断了 → 暂停
        else if (!was && now) resumeForWifi() // WIFI 回来了 → 续传
    }

    /* 断 WIFI：只掐在 WIFI 上发起的下载（数据网络上用户确认过的下载不动），
       .part 留着，等 WIFI 回来从断点续传 */
    private fun pauseForWifi() {
        val active = ArrayList<Item>()
        for (it in inflight.values) if (startedOnWifi[it.rel] == true && states[it.rel] == "downloading") active.add(it)
        for (it in pending.values) if (startedOnWifi[it.rel] == true) active.add(it)
        if (active.isEmpty()) return
        for (it in active) {
            wifiPaused[it.rel] = it
            pausedAttempt[it.rel] = attempt[it.rel] ?: -1L
            pending.remove(it.rel)
            states.remove(it.rel)          // 立刻摘掉，WIFI 若马上回来 enqueue 不会因为还在 downloading 被跳过
            calls[it.rel]?.cancel()
        }
        notice("WIFI 已断开，下载暂停（" + active.size + " 个），恢复后自动继续")
        notifyChange()
    }

    /* WIFI 回来：把暂停的条目按原 base 重新入队，run() 会从 .part 续传 */
    private fun resumeForWifi() {
        if (wifiPaused.isEmpty()) return
        val base = baseOf()
        if (base.isEmpty()) return
        val batch = ArrayList<Item>(wifiPaused.values)
        wifiPaused.clear()
        val n = enqueue(base, batch)
        if (n > 0) notice("WIFI 已恢复，继续下载 " + n + " 个")
    }

    private fun baseOf(): String = try {
        (appCtx?.getSharedPreferences("fm", Context.MODE_PRIVATE)?.getString("base", "") ?: "").trim().trimEnd('/')
    } catch (e: Exception) { "" }

    private fun notice(msg: String) {
        val c = appCtx ?: return
        Handler(Looper.getMainLooper()).post { runCatching { Toast.makeText(c, msg, Toast.LENGTH_SHORT).show() } }
    }

    /* 下载清单（完成 / 排队 / 在途 / 失败），给网页画「下载管理」和曲目上的已下载标记 */
    fun snapshot(): JSONArray = synchronized(lock) {
        val me = currentUid()
        val arr = JSONArray()

        /* 完成 + 排队 + 下载中 + 失败都给网页，队列要立刻可见、进度要能画；
           已标取消的不给，否则删掉的条目会在下一次刷新里复活 */
        fun put(it: Item, state: String) {
            if (state == "cancelling") return
            if (it.uid.isNotEmpty() && it.uid != me) return
            val done = state == "done"
            val loaded = if (done) it.size else (loaded[it.rel] ?: 0L)
            val total = if (done) it.size else (totals[it.rel] ?: it.size)
            arr.put(
                JSONObject()
                    .put("rel", it.rel)
                    .put("libId", it.libId)
                    .put("album", it.album)
                    .put("title", it.title)
                    .put("ext", it.ext)
                    .put("size", it.size)
                    .put("state", state)
                    .put("loaded", loaded)
                    .put("total", total)
            )
        }
        for (it in items.values) put(it, "done")
        /* 在途的跳过两类：已经点了删除的，等请求真正 abort 再消失；
           刚写进索引、还没从 inflight 摘掉的，否则同一条会先报 done 再报 downloading */
        for (it in inflight.values) {
            if (cancelled.contains(it.rel)) continue
            if (items.containsKey(keyOf(it.uid, it.rel))) continue
            put(it, states[it.rel] ?: "downloading")
        }
        for (it in pending.values) put(it, "queued")
        for (it in failed.values) put(it, "error")
        arr
    }

    /* 体积文案：下载页、网页入队提示共用 */
    fun fmtSize(v: Long): String {
        if (v <= 0L) return "0 B"
        val kb = v / 1024.0
        if (kb < 1024) return String.format(java.util.Locale.ROOT, "%.0f KB", kb)
        val mb = kb / 1024.0
        return if (mb < 1024) String.format(java.util.Locale.ROOT, "%.1f MB", mb)
        else String.format(java.util.Locale.ROOT, "%.2f GB", mb / 1024.0)
    }

    fun entries(): List<Item> = synchronized(lock) {
        val me = currentUid()
        items.values.filter { it.uid.isEmpty() || it.uid == me }
    }
    fun isDownloaded(rel: String): Boolean = synchronized(lock) { items.containsKey(keyOf(currentUid(), rel)) }
    fun state(rel: String): String = states[rel] ?: ""
    fun progress(rel: String): Pair<Long, Long> {
        val l = loaded[rel] ?: 0L
        val t = totals[rel] ?: 0L
        return l to t
    }
    fun activeCount(): Int = states.count { it.value == "queued" || it.value == "downloading" }

    fun activeProgress(): Pair<Long, Long> {
        var l = 0L
        var t = 0L
        for ((k, v) in states) {
            if (v == "downloading" || v == "queued") {
                l += loaded[k] ?: 0L
                t += totals[k] ?: 0L
            }
        }
        return l to t
    }

    fun totalBytes(): Long = synchronized(lock) { items.values.sumOf { it.size } }

    fun dismissFailure(rel: String) {
        failed.remove(rel)
        notifyChange()
    }

    fun failedItems(): List<Item> {
        val me = currentUid()
        return failed.values.filter { it.uid.isEmpty() || it.uid == me }
    }

    /* ── 下载 ── */
    fun enqueue(base: String, batch: List<Item>): Int {
        if (base.isEmpty()) return 0
        var queued = 0
        val me = currentUid()
        for (item in batch) {
            if (item.rel.isEmpty()) continue
            val rec = if (item.uid.isEmpty()) item.copy(uid = me) else item
            if (synchronized(lock) { items.containsKey(keyOf(rec.uid, rec.rel)) }) continue
            val st = states[item.rel]
            if (st == "downloading" || st == "queued" || st == "cancelling") continue
            cancelled.remove(item.rel)
            /* 之前断网暂停的，现在重新起跑：从待续队列摘掉，别等 WIFI 回来又加一遍 */
            wifiPaused.remove(item.rel)
            states[rec.rel] = "queued"
            pending[rec.rel] = rec
            failed.remove(rec.rel)
            startedOnWifi[rec.rel] = onWifi
            val aid = attemptSeq.incrementAndGet()
            attempt[rec.rel] = aid
            workers.execute { run(base, rec, aid) }
            queued++
        }
        notifyChange()
        return queued
    }

    private fun run(base: String, it: Item, aid: Long) {
        val c = appCtx ?: return
        /* 已被更新的尝试取代（断网恢复 / 重新入队）：这次直接作废，别动共享状态 */
        if (attempt[it.rel] != aid) return
        pending.remove(it.rel)
        /* 排队期间就被取消：连请求都别发 */
        if (cancelled.remove(it.rel)) { states.remove(it.rel); notifyChange(); return }
        /* 排队期间 WIFI 断了被暂停：别开跑，等 resume 重新入队 */
        if (pausedAttempt[it.rel] == aid) { states.remove(it.rel); notifyChange(); return }
        states[it.rel] = "downloading"
        loaded[it.rel] = 0L
        totals[it.rel] = it.size.coerceAtLeast(1L)
        notifyChange()

        val url = base + "/api/media/" + it.rel.split("/").joinToString("/") { Uri.encode(it) }
        val cookie = try { CookieManager.getInstance().getCookie(url) ?: "" } catch (e: Exception) { "" }
        val token = try {
            c.getSharedPreferences("fm", Context.MODE_PRIVATE).getString("token", "").orEmpty()
        } catch (e: Exception) { "" }
        val target = fileFor(it)
        target.parentFile?.mkdirs()
        val tmp = File(target.parentFile, target.name + ".part")
        /* 有半截文件就续传：Range 从已有长度开始，服务端不支持 206 会退化成整段重下 */
        val offset = if (tmp.exists()) tmp.length().coerceAtLeast(0L) else 0L
        val req = Request.Builder().url(url).apply {
            if (cookie.isNotEmpty()) header("Cookie", cookie)
            if (token.isNotEmpty()) header("Authorization", "Bearer " + token)
            if (offset > 0) header("Range", "bytes=" + offset + "-")
        }.build()
        val call = net.newCall(req)
        calls[it.rel] = call
        inflight[it.rel] = it
        try {
            call.execute().use { resp ->
                if (!resp.isSuccessful) throw RuntimeException("HTTP " + resp.code)
                val body = resp.body ?: throw RuntimeException("empty body")
                val resume = offset > 0 && resp.code == 206
                val startAt = if (resume) offset else 0L
                val len = body.contentLength()
                if (len > 0) totals[it.rel] = startAt + len
                body.byteStream().use { input ->
                    FileOutputStream(tmp, resume).use { out ->
                        val buf = ByteArray(64 * 1024)
                        var sum = startAt
                        loaded[it.rel] = sum
                        while (true) {
                            val n = input.read(buf)
                            if (n <= 0) break
                            out.write(buf, 0, n)
                            sum += n
                            loaded[it.rel] = sum
                        }
                    }
                }
            }
            if (!tmp.exists() || tmp.length() <= 0L) throw RuntimeException("empty file")
            val expected = totals[it.rel] ?: 0L
            if (expected > 0L && tmp.length() != expected) throw RuntimeException("size mismatch")
            if (cancelled.remove(it.rel)) { tmp.delete(); target.delete(); states.remove(it.rel); return }
            if (target.exists()) target.delete()
            if (!tmp.renameTo(target)) {
                tmp.copyTo(target, true)
                tmp.delete()
            }
            synchronized(lock) {
                items[keyOf(it.uid, it.rel)] = it.copy(size = target.length())
                save()
            }
            failed.remove(it.rel)
            states.remove(it.rel)
        } catch (e: Exception) {
            val msg = e.message ?: ""
            if (cancelled.remove(it.rel)) {
                tmp.delete()                       // 用户主动取消：不留半截
                states.remove(it.rel)
            } else if (attempt[it.rel] != aid) {
                /* 已被新尝试接管：旧请求的异常不管，也不许动新状态 */
            } else if (pausedAttempt[it.rel] == aid) {
                /* WIFI 断开导致的中止：.part 留着，状态交给 pauseForWifi，别报错 */
                states.remove(it.rel)
            } else {
                /* 网络类失败保留 .part，重试可以续传；4xx 说明鉴权/文件本身有问题，别留 */
                if (msg.contains("HTTP 4")) tmp.delete()
                states[it.rel] = "error"
                failed[it.rel] = it
                val title = it.title
                val why = when {
                    msg.contains("401") -> "登录已过期，请重新登录"
                    msg.contains("empty") -> "服务端返回空文件"
                    msg.contains("size") -> "文件不完整，已保留断点，可重试"
                    else -> ""
                }
                /* 其余基本都是断网/连不上：统一文案，别暴露原生或后台错误 */
                val text = if (why.isEmpty()) Msg.NET_FAIL else "「" + title + "」下载失败：" + why
                Handler(Looper.getMainLooper()).post { runCatching { onError?.invoke(text) } }
            }
        } finally {
            /* 只清理自己这次尝试的临时状态，别把新一次尝试的 calls/进度抹掉 */
            if (attempt[it.rel] == aid) {
                calls.remove(it.rel)
                inflight.remove(it.rel)
                pending.remove(it.rel)
                loaded.remove(it.rel)
                totals.remove(it.rel)
                /* 还在 wifiPaused 里的保留 attempt/pausedAttempt，等 resume 用；真正结束才清掉 */
                if (pausedAttempt[it.rel] != aid) {
                    attempt.remove(it.rel)
                    pausedAttempt.remove(it.rel)
                    startedOnWifi.remove(it.rel)
                }
            }
            notifyChange()
        }
    }

    /* ── 删除 ── */
    fun remove(rel: String) = removeMany(listOf(rel))

    /* 批量删：逐条收拾，最后只通知一次（网页批量删除用） */
    fun removeMany(rels: List<String>) {
        if (rels.isEmpty()) return
        for (rel in rels) dropOne(rel)
        notifyChange()
    }

    private fun dropOne(rel: String) {
        val me = currentUid()
        val k = keyOf(me, rel)
        val it = synchronized(lock) { items[k] }
        if (it != null && it.uid.isNotEmpty() && it.uid != me) return
        /* 断网暂停中的条目：从待续队列摘掉，.part 也删了，免得 WIFI 回来自动又下起来 */
        wifiPaused.remove(rel)?.let { p -> runCatching { partOf(p).delete() } }
        pausedAttempt.remove(rel)
        startedOnWifi.remove(rel)
        cancelled.add(rel)
        failed.remove(rel)
        calls[rel]?.cancel()
        inflight[rel]?.let { runCatching { partOf(it).delete() } }
        /* 还在排队、连请求都没发的：从队列摘掉并标取消；已提交给线程池的 run() 看到就跳过 */
        if (it == null && pending.remove(rel) != null) states[rel] = "cancelling"
        if (it != null) {
            synchronized(lock) {
                items.remove(k)
                save()
            }
            runCatching { fileFor(it).delete() }
            runCatching { partOf(it).delete() }
        }
        /* 在途任务还没进索引：只打取消标记，完成时自己删文件和 .part */
        if (it != null) states.remove(rel)
    }

    fun removeAlbum(libId: String, album: String): Int {
        val gone = ArrayList<Item>()
        synchronized(lock) {
            val it = items.values.iterator()
            while (it.hasNext()) {
                val x = it.next()
                if (x.libId == libId && x.album == album && (x.uid.isEmpty() || x.uid == currentUid())) {
                    cancelled.add(x.rel)
                    gone.add(x)
                    it.remove()
                }
            }
            if (gone.isNotEmpty()) save()
        }
        val me2 = currentUid()
        for ((k, v) in failed) {
            if (v.libId == libId && v.album == album && (v.uid.isEmpty() || v.uid == me2)) failed.remove(k)
        }
        /* 排队中的同专辑条目：摘出队列 + 标取消，别等它开始 */
        for ((rel, item) in pending) {
            if (item.libId == libId && item.album == album && (item.uid.isEmpty() || item.uid == currentUid())) {
                pending.remove(rel)
                cancelled.add(rel)
                states[rel] = "cancelling"
            }
        }
        /* 正在下载同专辑的条目也一起掐掉 */
        for ((rel, item) in inflight) {
            if (item.libId == libId && item.album == album && (item.uid.isEmpty() || item.uid == currentUid())) {
                cancelled.add(rel)
                calls[rel]?.cancel()
            }
        }
        /* 断网暂停中的同专辑条目也一并清掉 */
        val pausedGone = ArrayList<Item>()
        for ((rel, item) in wifiPaused) {
            if (item.libId == libId && item.album == album && (item.uid.isEmpty() || item.uid == currentUid())) {
                pausedGone.add(item)
                pausedAttempt.remove(rel)
                startedOnWifi.remove(rel)
            }
        }
        for (p in pausedGone) {
            wifiPaused.remove(p.rel)
            runCatching { partOf(p).delete() }
        }
        for (x in gone) {
            runCatching { fileFor(x).delete() }
            runCatching { partOf(x).delete() }
        }
        if (gone.isNotEmpty() || pausedGone.isNotEmpty()) notifyChange()
        return gone.size
    }

    private fun syncNotification() {
        val c = appCtx ?: return
        val n = activeCount()
        val p = activeProgress()
        DownloadNotify.update(c, n, p.first, p.second)
    }

    private val tick = object : Runnable {
        override fun run() {
            syncNotification()
            if (activeCount() > 0) {
                notifyProgress()          /* 有下载在跑就每秒推一次进度 */
                main.postDelayed(this, 1000)
            } else {
                tickOn = false
            }
        }
    }

    private fun scheduleTick() {
        if (tickOn) return
        tickOn = true
        main.postDelayed(tick, 800)
    }

    private fun notifyChange() {
        runCatching { syncNotification() }
        if (activeCount() > 0) scheduleTick()
        notifyWatchers()
    }

    private fun notifyWatchers() {
        if (watchers.isEmpty()) return
        Handler(Looper.getMainLooper()).post {
            for (fn in watchers) runCatching { fn() }
        }
    }

    private fun notifyProgress() {
        if (progressWatchers.isEmpty()) return
        Handler(Looper.getMainLooper()).post {
            for (fn in progressWatchers) runCatching { fn() }
        }
    }

    /* ── 本机播放地址 ── */
    fun localUrl(rel: String): String {
        if (port == 0) return ""
        return "http://127.0.0.1:" + port + "/dl/" + pathToken + "/" + URLEncoder.encode(keyOf(currentUid(), rel), "UTF-8")
    }

    private fun startServer() {
        pathToken = UUID.randomUUID().toString().replace("-", "").substring(0, 16)
        try {
            val ss = ServerSocket(0, 32, InetAddress.getByName("127.0.0.1"))
            port = ss.localPort
            Thread {
                while (true) {
                    val s = try { ss.accept() } catch (e: Exception) { break }
                    httpWorkers.execute { runCatching { serve(s) } }
                }
            }.apply { isDaemon = true }.start()
        } catch (e: Exception) {
            port = 0
        }
    }

    private fun serve(socket: Socket) {
        if (!connSlots.tryAcquire()) { runCatching { socket.close() }; return }
        try {
        socket.use { s ->
            s.soTimeout = 15000
            val input = BufferedInputStream(s.getInputStream())
            val requestLine = readLine(input) ?: return
            val parts = requestLine.split(" ")
            if (parts.size < 2) return
            val headers = HashMap<String, String>()
            var headerLines = 0
            while (true) {
                val line = readLine(input) ?: break
                if (line.isEmpty()) break
                if (++headerLines > 64) { writeStatus(s.getOutputStream(), 400, "bad request"); return }
                val i = line.indexOf(':')
                if (i > 0) headers[line.substring(0, i).trim().lowercase()] = line.substring(i + 1).trim()
            }
            val out = s.getOutputStream()
            val path = parts[1].substringBefore('?')
            val prefix = "/dl/" + pathToken + "/"
            if (!path.startsWith(prefix)) { writeStatus(out, 403, "forbidden"); return }
            val key = try { URLDecoder.decode(path.substring(prefix.length), "UTF-8") } catch (e: Exception) { "" }
            val sep = key.indexOf('|')
            if (sep <= 0) { writeStatus(out, 404, "not found"); return }
            /* 只给当前登录用户放行，换账号后旧会话地址也拿不到别人下好的文件 */
            if (key.substring(0, sep) != currentUid()) { writeStatus(out, 403, "forbidden"); return }
            val it = synchronized(lock) { items[key] }
            if (it == null) { writeStatus(out, 404, "not found"); return }
            val f = fileFor(it)
            if (!f.exists()) { writeStatus(out, 404, "missing"); return }

            val total = f.length()
            if (total <= 0L) { writeStatus(out, 404, "empty"); return }
            var start = 0L
            var end = total - 1
            var partial = false
            val range = headers["range"]
            if (!range.isNullOrEmpty() && range.startsWith("bytes=")) {
                val spec = range.removePrefix("bytes=").split("-")
                try {
                    if (spec[0].isNotEmpty()) start = spec[0].toLong()
                    if (spec.size > 1 && spec[1].isNotEmpty()) end = spec[1].toLong()
                } catch (e: Exception) { /* 按整段处理 */ }
                if (start < 0 || start >= total) start = 0
                if (end >= total || end < start) end = total - 1
                if (start <= end) partial = true
            }
            val length = if (partial) end - start + 1 else total
            val head = StringBuilder()
            head.append(if (partial) "HTTP/1.1 206 Partial Content\r\n" else "HTTP/1.1 200 OK\r\n")
            head.append("Content-Type: ").append(mimeOf(it.ext)).append("\r\n")
            head.append("Accept-Ranges: bytes\r\n")
            head.append("Content-Length: ").append(length).append("\r\n")
            if (partial) head.append("Content-Range: bytes ").append(start).append("-").append(end).append("/").append(total).append("\r\n")
            head.append("Connection: close\r\n\r\n")
            out.write(head.toString().toByteArray())
            if (requestLine.startsWith("HEAD ")) { out.flush(); return }
            FileInputStream(f).use { fin ->
                var skipped = 0L
                while (skipped < start) {
                    val n = fin.skip(start - skipped)
                    if (n <= 0) break
                    skipped += n
                }
                val buf = ByteArray(64 * 1024)
                var left = length
                while (left > 0) {
                    val n = fin.read(buf, 0, minOf(buf.size.toLong(), left).toInt())
                    if (n <= 0) break
                    out.write(buf, 0, n)
                    left -= n
                }
                out.flush()
            }
        }
        } finally { connSlots.release() }
    }

    private fun readLine(input: InputStream): String? {
        val sb = StringBuilder()
        while (true) {
            val b = input.read()
            if (b < 0) return if (sb.isEmpty()) null else sb.toString()
            if (b == '\n'.code) break
            if (b != '\r'.code) sb.append(b.toChar())
            if (sb.length > 8192) break
        }
        return sb.toString()
    }

    private fun writeStatus(out: OutputStream, code: Int, msg: String) {
        val body = msg.toByteArray()
        val head = "HTTP/1.1 " + code + " " + msg + "\r\nContent-Type: text/plain\r\nContent-Length: " + body.size + "\r\nConnection: close\r\n\r\n"
        out.write(head.toByteArray())
        out.write(body)
        out.flush()
    }

    private fun mimeOf(ext: String): String = when (ext.lowercase()) {
        "mp4" -> "video/mp4"
        "m4v" -> "video/x-m4v"
        "webm" -> "video/webm"
        "mov" -> "video/quicktime"
        "m4a", "m4b", "aac" -> "audio/mp4"
        "mp3" -> "audio/mpeg"
        "flac" -> "audio/flac"
        "wav" -> "audio/wav"
        "ogg", "opus" -> "audio/ogg"
        else -> "application/octet-stream"
    }

    /* ── 服务端接口（带会话 Cookie / Bearer） ── */
    @Volatile var lastStatus = 0

    fun apiGet(base: String, path: String): JSONObject? {
        if (base.isEmpty()) return null
        val url = base + path
        val cookie = try { CookieManager.getInstance().getCookie(url) ?: "" } catch (e: Exception) { "" }
        val token = try {
            appCtx?.getSharedPreferences("fm", Context.MODE_PRIVATE)?.getString("token", "").orEmpty()
        } catch (e: Exception) { "" }
        val req = Request.Builder().url(url).apply {
            if (cookie.isNotEmpty()) header("Cookie", cookie)
            if (token.isNotEmpty()) header("Authorization", "Bearer " + token)
        }.build()
        return try {
            net.newCall(req).execute().use { r ->
                lastStatus = r.code
                if (!r.isSuccessful) null else JSONObject(r.body?.string() ?: "{}")
            }
        } catch (e: Exception) { null }
    }
}

/* ── 下载通知：后台下载也能看到进度 ───────────────────── */
object DownloadNotify {
    private const val CHANNEL = "fm_download"
    private const val ID = 7001

    fun update(c: Context, count: Int, loaded: Long, total: Long) {
        runCatching {
            val nm = c.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
            if (count <= 0) { nm.cancel(ID); return }
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                val ch = NotificationChannel(CHANNEL, "下载", NotificationManager.IMPORTANCE_LOW)
                ch.setShowBadge(false)
                nm.createNotificationChannel(ch)
            }
            val pct = if (total > 0L) ((loaded * 100) / total).toInt().coerceIn(0, 100) else 0
            val builder = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O)
                Notification.Builder(c, CHANNEL) else Notification.Builder(c)
            val pi = PendingIntent.getActivity(
                c, 0, Intent(c, DownloadsActivity::class.java),
                PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
            )
            builder.setSmallIcon(R.drawable.ic_download)
                .setContentTitle("正在下载 " + count + " 个")
                .setContentText(pct.toString() + "% · " + mb(loaded) + " / " + mb(total))
                .setProgress(100, pct, total <= 0L)
                .setOngoing(true)
                .setOnlyAlertOnce(true)
                .setContentIntent(pi)
            nm.notify(ID, builder.build())
        }
    }

    private fun mb(v: Long): String {
        if (v <= 0L) return "0 MB"
        return String.format(java.util.Locale.ROOT, "%.1f MB", v / 1024.0 / 1024.0)
    }
}
