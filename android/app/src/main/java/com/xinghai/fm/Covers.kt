/* ── Covers · 封面磁盘缓存 ────────────────────────────────
 * 移动端最费的流量：WebView 为每个 <img> 去 /api/cover/… 取图，
 * 锁屏/通知封面更是每切一集就重新下一张。
 * 这里统一落一份到 cacheDir/covers/，命中就直读本地文件，只有第一次真联网。
 *
 * 缓存键 = host:port + path + query（剔掉 t= 票据）：换封面时 URL 会变（新文件名带内容哈希，
 * 或网页加了 ?r= 版本号），旧缓存自然失效；换服务器时 host 不同，也不会串图。
 * 放 cacheDir 而不是 filesDir：系统「清除缓存」能收回空间，符合预期。
 */
package com.xinghai.fm

import android.content.Context
import java.io.File
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.TimeUnit
import okhttp3.OkHttpClient
import okhttp3.Request

object Covers {
    private const val DIR = "covers"
    /* 目录总上限：2GB ≈ 2.4 万张（按 86KB/张），实际等于「永不淘汰」，
       留着只是防病态增长。文件数多时扫目录很贵，所以下面用估算 + 节流，别每次写盘都全量 stat */
    private const val MAX_TOTAL = 2L * 1024 * 1024 * 1024
    private const val MAX_ONE = 4L * 1024 * 1024       // 单张上限：正常封面几十 KB
    private const val TRIM_GAP = 60_000L               // 两次真扫描之间至少隔 1 分钟
    private const val FAIL_TTL = 60_000L               // 下载失败后的冷却，别让每次渲染都再试一遍

    /* 固定 64 把锁按 key 取模（striped）：同一 key 必定落在同一把锁上，
       又不会像「每个 key 一个锁」那样常驻几万个对象 */
    private val stripes = Array(64) { Any() }
    private val failAt = ConcurrentHashMap<String, Long>()   // key -> 上次失败时间
    private val trimLock = Any()

    private fun lockOf(k: String): Any = stripes[Math.floorMod(k.hashCode(), stripes.size)]
    @Volatile private var knownTotal = -1L             // 估算的目录总字节，-1 = 还没算过
    @Volatile private var lastTrimAt = 0L

    private val http: OkHttpClient by lazy {
        OkHttpClient.Builder()
            .connectTimeout(8, TimeUnit.SECONDS)
            .readTimeout(20, TimeUnit.SECONDS)
            .followRedirects(true)
            .build()
    }

    fun dir(ctx: Context): File = File(ctx.cacheDir, DIR).apply { if (!exists()) mkdirs() }

    /* 把 URL 折成一个安全的文件名。
       必须带上 host:port：生产/测试是同一台机器的 8889/8899 两个实例、库目录还可能是同一套，
       封面文件名又只由目录名派生 —— 不带 origin 时切换服务器会直接串图 */
    fun key(rawUrl: String): String {
        val u = runCatching { java.net.URL(rawUrl) }.getOrNull() ?: return ""
        val q = (u.query ?: "").split("&")
            .filter { it.isNotEmpty() && !it.startsWith("t=") }
            .joinToString("&")
        val s = u.host + "_" + u.port + u.path + (if (q.isEmpty()) "" else "?" + q)
        return s.replace(Regex("[^A-Za-z0-9._-]"), "_").take(150)
    }

    /* 类型按原始 URL 的扩展名判断：缓存名里带了 query 尾巴，不能再从文件名推 */
    fun mimeOf(url: String): String {
        val p = runCatching { java.net.URL(url) }.getOrNull()?.path ?: url
        return when (p.substringAfterLast('.', "").lowercase()) {
            "png" -> "image/png"
            "webp" -> "image/webp"
            "gif" -> "image/gif"
            else -> "image/jpeg"
        }
    }

    /* 命中直接返回本地文件；没有就下这一次。
       非 200 / 网络失败 / 体积异常一律不落盘，下次再试（401 不能缓存成坏图） */
    fun get(ctx: Context, url: String, cookie: String): File? {
        val k = key(url)
        if (k.isEmpty()) return null
        val f = File(dir(ctx), k)
        if (f.length() > 0) { touch(f); return f }
        /* 刚失败过就先别试：拦截层返回 null 后 WebView 还会自己发一次请求，
           没有冷却的话会话过期/服务端没开时每张封面都是「原生试一次 + WebView 再试一次」 */
        if (coolingDown(k)) return null

        synchronized(lockOf(k)) {
            /* 同一个 key 并发请求时，等锁的那个直接拿到刚写好的文件 */
            if (f.length() > 0) { touch(f); return f }
            if (coolingDown(k)) return null
            val tmp = File(dir(ctx), k + ".part")
            try {
                val req = Request.Builder()
                    .url(url)
                    .header("User-Agent", "XinghaiFM")
                    .apply { if (cookie.isNotEmpty()) header("Cookie", cookie) }
                    .build()
                http.newCall(req).execute().use { res ->
                    if (!res.isSuccessful) return markFail(k)
                    val body = res.body ?: return markFail(k)
                    if (body.contentLength() > MAX_ONE) return markFail(k)
                    /* 不信任 content-length（chunked/透明 gzip 时是 -1）：边读边数，超了立刻停 */
                    var size = 0L
                    body.byteStream().use { input ->
                        tmp.outputStream().use { out ->
                            val buf = ByteArray(64 * 1024)
                            while (true) {
                                val n = input.read(buf)
                                if (n < 0) break
                                size += n
                                if (size > MAX_ONE) return markFail(k)
                                out.write(buf, 0, n)
                            }
                        }
                    }
                }
                if (tmp.length() <= 0) return markFail(k)
                if (f.exists()) f.delete()
                /* 只走 rename：copyTo 直接写目标文件，进程在中间被杀会留下半张图，
                   而它是 length>0 的，之后会一直被当成有效缓存命中 */
                if (!tmp.renameTo(f)) return markFail(k)
                touch(f)
                failAt.remove(k)
                noteWrite(ctx, f.length())
                return f
            } catch (e: Exception) {
                return markFail(k)
            } finally {
                runCatching { tmp.delete() }
            }
        }
    }

    /* 命中时刷一次访问时间，trim 才是按 LRU 淘汰 */
    private fun touch(f: File) {
        runCatching { f.setLastModified(System.currentTimeMillis()) }
    }

    private fun coolingDown(k: String): Boolean {
        val at = failAt[k] ?: return false
        if (System.currentTimeMillis() - at < FAIL_TTL) return true
        failAt.remove(k)
        return false
    }

    private fun markFail(k: String): File? {
        failAt[k] = System.currentTimeMillis()
        return null
    }

    /* 单条失效：网页换封面后旧地址可能和新地址相同（同名覆盖），由壳调这里把旧图删掉 */
    fun drop(ctx: Context, url: String) {
        val k = key(url)
        if (k.isEmpty()) return
        failAt.remove(k)
        runCatching { File(dir(ctx), k).delete() }
    }

    /* 记账 + 节流：正常情况只累加一个 Long，只有估算值超上限才真去扫目录淘汰，
       且两次扫描至少隔 TRIM_GAP（2GB 上限下文件数可能上万，每次写盘都 stat 会拖慢拦截线程） */
    private fun noteWrite(ctx: Context, size: Long) {
        synchronized(trimLock) {
            knownTotal = if (knownTotal < 0) totalOf(ctx) + size else knownTotal + size
            if (knownTotal <= MAX_TOTAL) return
            val now = System.currentTimeMillis()
            if (now - lastTrimAt < TRIM_GAP) return
            lastTrimAt = now
            trim(ctx)
            knownTotal = totalOf(ctx)
        }
    }

    private fun totalOf(ctx: Context): Long {
        val files = dir(ctx).listFiles() ?: return 0L
        var total = 0L
        files.forEach { f -> if (!f.name.endsWith(".part")) total += f.length() }
        return total
    }

    /* 超上限时按最后访问时间淘汰（命中时会刷 lastModified，所以是 LRU）：封面丢了顶多再下一次 */
    private fun trim(ctx: Context) {
        val files = dir(ctx).listFiles() ?: return
        var total = 0L
        files.forEach { f ->
            if (f.name.endsWith(".part")) f.delete() else total += f.length()
        }
        if (total <= MAX_TOTAL) return
        val ordered = files.filter { !it.name.endsWith(".part") }.sortedBy { it.lastModified() }
        for (f in ordered) {
            if (total <= MAX_TOTAL) break
            total -= f.length()
            f.delete()
        }
    }

    /* 清空全部缓存：退出登录 / 换服务器时调用，别让上一个服务器的图留在本地 */
    fun clear(ctx: Context) {
        dir(ctx).listFiles()?.forEach { runCatching { it.delete() } }
        synchronized(trimLock) {
            knownTotal = 0
            lastTrimAt = 0
            failAt.clear()
        }
    }
}
