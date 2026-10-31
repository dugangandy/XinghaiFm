/* ── DownloadsActivity · 安卓端下载管理 ───────────────────
 * 一个页面两件事：管理已下载（播放 / 删除），从资源库挑内容下载（整张或单集）。
 * 只跑在 APK 里，网页不参与；文件与索引都在 Downloads.kt 里。
 */
package local.xinghai.fm

import android.app.Activity
import android.app.AlertDialog
import android.content.Intent
import android.graphics.Color
import android.graphics.Typeface
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.text.TextUtils
import android.view.Gravity
import android.view.View
import android.view.ViewGroup
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView
import android.widget.Toast
import org.json.JSONArray
import org.json.JSONObject
import java.text.Collator
import java.util.Locale

class DownloadsActivity : Activity() {

    private data class Track(val rel: String, val title: String, val size: Long, val ext: String)
    private data class Album(val name: String, val size: Long, val tracks: List<Track>)

    private val ui = Handler(Looper.getMainLooper())
    private var content: LinearLayout? = null
    private var subtitle: TextView? = null
    private var addBtn: TextView? = null
    private var footer: TextView? = null

    private var libId = ""
    private var libName = ""
    private var albums: List<Album> = emptyList()
    private var libraryLoading = true
    private var libraryError = ""
    private var refreshQueued = false
    private val coll: Collator = Collator.getInstance(Locale.CHINA)

    /* 批量下载时回调很密：350ms 合帧，别每完成一集就重建整表 */
    private val onDlChange: () -> Unit = {
        runOnUiThread {
            if (!refreshQueued) {
                refreshQueued = true
                ui.postDelayed({
                    refreshQueued = false
                    render()
                    ui.removeCallbacks(ticker)
                    if (Dl.activeCount() > 0) ui.postDelayed(ticker, 400)
                }, 350)
            }
        }
    }

    private val ticker = object : Runnable {
        override fun run() {
            paintFooter()
            if (Dl.activeCount() > 0) {
                render()
                ui.postDelayed(this, 1200)
            }
        }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        Dl.init(this)
        buildUi()
        Dl.watch(onDlChange)
        Dl.onError = { msg -> toast(msg) }
        render()
        loadLibrary()
    }

    override fun onDestroy() {
        Dl.unwatch(onDlChange)
        Dl.onError = null
        ui.removeCallbacksAndMessages(null)
        super.onDestroy()
    }

    /* ── 界面骨架 ── */
    private fun buildUi() {
        val root = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setBackgroundColor(0xFF05070E.toInt())
        }
        val header = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
            setPadding(dp(18), dp(18), dp(12), dp(6))
        }
        header.addView(TextView(this).apply {
            text = "下载"
            textSize = 19f
            setTextColor(Color.WHITE)
            typeface = Typeface.DEFAULT_BOLD
        }, LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f))
        addBtn = actionText("添加") { pickAlbum() }
        header.addView(addBtn)
        header.addView(actionText("关闭") { finish() })
        root.addView(header)

        subtitle = TextView(this).apply {
            text = "正在读取资源库…"
            textSize = 11.5f
            setTextColor(0xFF7A869E.toInt())
            setPadding(dp(18), 0, dp(18), dp(10))
        }
        root.addView(subtitle)

        val scroll = ScrollView(this)
        content = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(dp(14), 0, dp(14), dp(24))
        }
        scroll.addView(content, ViewGroup.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT))
        root.addView(scroll, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, 0, 1f))

        footer = TextView(this).apply {
            textSize = 11f
            setTextColor(0xFF66D9FF.toInt())
            setPadding(dp(18), dp(8), dp(18), dp(14))
            visibility = View.GONE
        }
        root.addView(footer)
        setContentView(root)
    }

    private fun actionText(label: String, onClick: () -> Unit): TextView =
        TextView(this).apply {
            text = label
            textSize = 13f
            setTextColor(0xFF9FB0CC.toInt())
            setPadding(dp(12), dp(8), dp(12), dp(8))
            setOnClickListener { onClick() }
        }

    /* ── 已下载列表 ── */
    private fun render() {
        val box = content ?: return
        box.removeAllViews()
        val list = Dl.entries()
        val fails = Dl.failedItems()
        if (list.isEmpty() && fails.isEmpty()) {
            box.addView(TextView(this).apply {
                text = "还没有下载\n点右上角「添加」，从电脑上的资源库挑专辑或单集"
                textSize = 12.5f
                setTextColor(0xFF7A869E.toInt())
                setLineSpacing(dp(6).toFloat(), 1f)
                setPadding(dp(6), dp(28), dp(6), 0)
            })
        } else {
            val groups = LinkedHashMap<String, MutableList<Dl.Item>>()
            for (it in list) {
                val key = it.libId + "|" + it.album
                groups.getOrPut(key) { ArrayList() }.add(it)
            }
            for ((_, tracks) in groups) {
                val first = tracks[0]
                box.addView(albumHeader(first, tracks))
                sortedTracks(tracks).forEach { t ->
                    box.addView(trackRow(t, tracks))
                }
            }
        }
        if (fails.isNotEmpty()) {
            box.addView(sectionLabel("下载失败（" + fails.size + "）"))
            fails.sortedWith { a, b -> coll.compare(a.title, b.title) }.forEach { f ->
                box.addView(failRow(f))
            }
        }
        paintFooter()
        val total = list.size
        val size = list.sumOf { it.size }
        subtitle?.text = if (total == 0) {
            if (libraryLoading) "正在读取资源库…" else if (libraryError.isNotEmpty()) libraryError else "资源库：" + libName
        } else {
            "已下载 " + total + " 集 · " + Dl.fmtSize(size) + " · 资源库：" + libName
        }
    }

    private fun sortedTracks(list: List<Dl.Item>): List<Dl.Item> = list.sortedWith { a, b -> coll.compare(a.title, b.title) }

    private fun sectionLabel(label: String): View = TextView(this).apply {
        text = label
        textSize = 11f
        setTextColor(0xFF9FB0CC.toInt())
        setPadding(dp(6), dp(18), dp(6), dp(4))
    }

    private fun failRow(item: Dl.Item): View {
        val row = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
            setPadding(dp(10), dp(10), dp(4), dp(10))
            setBackgroundColor(0x14FF6B6B)
        }
        row.addView(TextView(this).apply {
            text = item.title
            textSize = 12.5f
            setTextColor(0xFFFFC7C7.toInt())
            maxLines = 1
            ellipsize = TextUtils.TruncateAt.END
        }, LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f))
        row.addView(actionText("重试") {
            /* 重试也走同一套流程：空间不够/移动网络会重新问一次 */
            DownloadQueue.enqueue(this, listOf(item)) { n -> if (n <= 0) toast("已经在下载队列里") }
        })
        row.addView(actionText("移除") { Dl.dismissFailure(item.rel) })
        return row
    }

    private fun albumHeader(first: Dl.Item, tracks: List<Dl.Item>): View {
        val row = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
            setPadding(dp(4), dp(16), dp(4), dp(6))
        }
        row.addView(TextView(this).apply {
            text = first.album
            textSize = 13.5f
            setTextColor(Color.WHITE)
            typeface = Typeface.DEFAULT_BOLD
            maxLines = 1
            ellipsize = TextUtils.TruncateAt.END
        }, LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f))
        row.addView(TextView(this).apply {
            text = tracks.size.toString() + " 集 · " + Dl.fmtSize(tracks.sumOf { it.size })
            textSize = 10.5f
            setTextColor(0xFF7A869E.toInt())
            setPadding(0, 0, dp(10), 0)
        })
        row.addView(actionText("删除") {
            confirm("删除整张？", "「" + first.album + "」的 " + tracks.size + " 个文件会从手机里删掉。") {
                Dl.removeAlbum(first.libId, first.album)
            }
        })
        return row
    }

    private fun trackRow(item: Dl.Item, group: List<Dl.Item>): View {
        val row = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
            setPadding(dp(10), dp(11), dp(4), dp(11))
            setBackgroundColor(0x14FFFFFF)
            setOnClickListener {
                val sorted = group.sortedBy { it.title }
                play(sorted, sorted.indexOfFirst { it.rel == item.rel }, sorted.all { !isVideo(it.ext) })
            }
        }
        val info = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL }
        info.addView(TextView(this).apply {
            text = item.title
            textSize = 12.5f
            setTextColor(0xFFE8F1FF.toInt())
            maxLines = 1
            ellipsize = TextUtils.TruncateAt.END
        })
        info.addView(TextView(this).apply {
            text = Dl.fmtSize(item.size) + " · " + if (isVideo(item.ext)) "视频" else "音频"
            textSize = 10f
            setTextColor(0xFF6C7A93.toInt())
            setPadding(0, dp(2), 0, 0)
        })
        row.addView(info, LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f))
        row.addView(TextView(this).apply {
            text = "✕"
            textSize = 15f
            setTextColor(0xFF9FB0CC.toInt())
            setPadding(dp(12), dp(6), dp(12), dp(6))
            setOnClickListener {
                confirm("删除下载？", "「" + item.title + "」会从手机里删掉。") { Dl.remove(item.rel) }
            }
        })
        return row
    }

    private fun paintFooter() {
        val f = footer ?: return
        val n = Dl.activeCount()
        if (n <= 0) {
            f.visibility = View.GONE
            return
        }
        f.visibility = View.VISIBLE
        val (loaded, total) = Dl.activeProgress()
        val pct = if (total > 0L) (loaded * 100 / total).toInt() else 0
        f.text = "下载中 " + n + " 个 · " + pct + "%（" + Dl.fmtSize(loaded) + " / " + Dl.fmtSize(total) + "）"
    }

    /* ── 选择要下载的内容 ── */
    private fun pickAlbum() {
        if (libraryLoading) { toast("正在读取资源库，稍等一下"); return }
        if (albums.isEmpty()) { toast(libraryError.ifEmpty { "资源库里没有可下载的内容" }); return }
        val done = HashMap<String, Int>()
        for (e in Dl.entries()) done[e.album] = (done[e.album] ?: 0) + 1
        val names = albums.map {
            val n = done[it.name] ?: 0
            it.name + "（" + it.tracks.size + " 集" + (if (n > 0) " · 已下 " + n else "") + "）"
        }.toTypedArray()
        AlertDialog.Builder(this)
            .setTitle("选择专辑")
            .setItems(names) { _, which -> chooseAlbum(albums[which]) }
            .setNeutralButton("刷新") { _, _ -> loadLibrary(true) }
            .setNegativeButton("取消", null)
            .show()
    }

    private fun chooseAlbum(album: Album) {
        val opts = arrayOf("下载整张（跳过已下载）", "选择单集…")
        AlertDialog.Builder(this)
            .setTitle(album.name)
            .setItems(opts) { _, which -> if (which == 0) downloadAlbum(album) else pickTracks(album) }
            .setNegativeButton("取消", null)
            .show()
    }

    private fun downloadAlbum(album: Album) {
        val todo = album.tracks.filterNot { Dl.isDownloaded(it.rel) }
        if (todo.isEmpty()) { toast("这张专辑已经全部下载"); return }
        startDownload(album, todo)
    }

    private fun pickTracks(album: Album) {
        if (album.tracks.isEmpty()) { toast("这张专辑没有可下载的音频"); return }
        val names = album.tracks.map { it.title + "  ·  " + Dl.fmtSize(it.size) }.toTypedArray()
        val checked = BooleanArray(album.tracks.size) { !Dl.isDownloaded(album.tracks[it].rel) }
        val doneCount = album.tracks.count { Dl.isDownloaded(it.rel) }
        val dlgTitle = if (doneCount > 0) album.name + "（已下载 " + doneCount + "/" + album.tracks.size + "）" else album.name
        AlertDialog.Builder(this)
            .setTitle(dlgTitle)
            .setMultiChoiceItems(names, checked) { _, which, isChecked -> checked[which] = isChecked }
            .setPositiveButton("下载选中") { _, _ ->
                val picked = album.tracks.filterIndexed { i, _ -> checked[i] }
                if (picked.isEmpty()) toast("没有选中任何一集") else startDownload(album, picked)
            }
            .setNegativeButton("取消", null)
            .show()
    }

    /* 空间、流量确认、入队、提示都在 DownloadQueue 里，这里只管转条目 + 刷新界面 */
    private fun startDownload(album: Album, picked: List<Track>) {
        val batch = picked.map { Dl.Item(libId, libName, album.name, it.rel, it.title, it.ext, it.size) }
        DownloadQueue.enqueue(this, batch) { n ->
            if (n > 0) ui.postDelayed({ render(); ui.removeCallbacks(ticker); ui.postDelayed(ticker, 300) }, 300)
        }
    }

    /* ── 播放 ── */
    private fun play(tracks: List<Dl.Item>, index: Int, audioOnly: Boolean) {
        if (tracks.isEmpty()) return
        val arr = JSONArray()
        for (t in tracks) {
            arr.put(JSONObject()
                .put("rel", Dl.localUrl(t.rel))
                .put("id", t.rel)
                .put("title", t.title)
                .put("sub", t.album))
        }
        val i = Intent(this, VideoPlayerActivity::class.java)
        i.putExtra("list", arr.toString())
        i.putExtra("index", index.coerceIn(0, tracks.size - 1))
        i.putExtra("start", 0L)
        i.putExtra("autoplay", true)
        i.putExtra("audio", audioOnly)
        startActivity(i)
    }

    /* ── 资源库 ── */
    private fun loadLibrary(force: Boolean = false) {
        val now = System.currentTimeMillis()
        val uid = getSharedPreferences("fm", MODE_PRIVATE).getString("uid", "").orEmpty()
        if (!force && cacheAlbums != null && cacheBase == baseUrl() && cacheUid == uid && now - cacheAt < CACHE_MS) {
            libId = cacheLibId
            libName = cacheLibName
            albums = cacheAlbums!!
            libraryLoading = false
            addBtn?.alpha = if (albums.isEmpty()) 0.5f else 1f
            render()
            return
        }
        libraryLoading = true
        libraryError = ""
        Thread {
            val base = baseUrl()
            var name = ""
            var id = ""
            val cfg = Dl.apiGet(base, "/api/config")
            val libs = Dl.apiGet(base, "/api/libs")
            if (libs != null) {
                id = libs.optString("active")
                val arr = libs.optJSONArray("libs")
                if (arr != null) {
                    for (k in 0 until arr.length()) {
                        val o = arr.optJSONObject(k) ?: continue
                        if (o.optString("id") == id) name = o.optString("name")
                    }
                }
            }
            if (name.isEmpty() && cfg != null) name = cfg.optString("rootName")
            val scan = Dl.apiGet(base, "/api/scan")
            val out = ArrayList<Album>()
            if (scan != null) {
                val files = scan.optJSONArray("files") ?: JSONArray()
                val rootName = scan.optString("rootName")
                val groups = LinkedHashMap<String, MutableList<Track>>()
                for (k in 0 until files.length()) {
                    val o = files.optJSONObject(k) ?: continue
                    val rel = o.optString("rel")
                    if (rel.isEmpty()) continue
                    val slash = rel.indexOf('/')
                    val albumName = if (slash > 0) rel.substring(0, slash) else rootName
                    val fileName = o.optString("name")
                    val ext = o.optString("ext").lowercase(Locale.ROOT)
                    val title = if (fileName.contains('.')) fileName.substringBeforeLast('.') else fileName
                    val size = o.optLong("size")
                    groups.getOrPut(albumName) { ArrayList() }.add(Track(rel, title, size, ext))
                }
                for ((k, v) in groups) out.add(Album(k, v.sumOf { it.size }, v.sortedBy { it.title }))
            }
            ui.post {
                libId = id
                libName = name
                albums = out.sortedWith { a, b -> coll.compare(a.name, b.name) }
                cacheAlbums = albums
                cacheLibId = id
                cacheLibName = name
                cacheBase = base
                cacheUid = uid
                cacheAt = System.currentTimeMillis()
                libraryLoading = false
                if (out.isEmpty()) libraryError = if (Dl.lastStatus == 401) "登录已过期，请重新登录" else Msg.NET_FAIL
                addBtn?.alpha = if (out.isEmpty()) 0.5f else 1f
                render()
            }
        }.start()
    }

    /* ── 杂项 ── */
    private fun baseUrl(): String =
        (getSharedPreferences("fm", MODE_PRIVATE).getString("base", "") ?: "").trim().trimEnd('/')

    private fun isVideo(ext: String): Boolean =
        ext.lowercase(Locale.ROOT) in setOf("mp4", "m4v", "mov", "webm", "ogv")

    private fun confirm(title: String, msg: String, onYes: () -> Unit) {
        AlertDialog.Builder(this)
            .setTitle(title)
            .setMessage(msg)
            .setPositiveButton("删除") { _, _ -> onYes() }
            .setNegativeButton("取消", null)
            .show()
    }

    private fun toast(msg: String) = Toast.makeText(this, msg, Toast.LENGTH_SHORT).show()
    private fun dp(v: Int): Int = (v * resources.displayMetrics.density).toInt()

    companion object {
        private const val CACHE_MS = 5 * 60 * 1000L
        private var cacheAlbums: List<Album>? = null
        private var cacheAt = 0L
        private var cacheLibId = ""
        private var cacheLibName = ""
        private var cacheBase = ""
        private var cacheUid = ""
    }
}
