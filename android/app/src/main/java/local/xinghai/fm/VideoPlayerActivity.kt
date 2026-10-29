/* ── VideoPlayerActivity · 原生视频播放（对齐优酷布局）────
 * 顶部：渐变 + 返回 + 标题。底部：播放/下一集 + 当前时间 + 进度条 + 总时长；
 * 下行右侧「倍速 / 选集」文字按钮（点击弹出选择）。右侧锁定。
 * 手势：点=显隐，长按=快进，左/右半屏上下滑=亮度/音量。无 PiP，离开即暂停。
 */
package local.xinghai.fm

import android.app.Activity
import android.content.Context
import android.content.Intent
import android.content.pm.ActivityInfo
import android.content.res.ColorStateList
import android.graphics.Canvas
import android.graphics.Paint
import android.media.AudioManager
import android.net.Uri
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.provider.Settings
import android.text.TextUtils
import android.util.Log
import android.util.TypedValue
import android.view.Gravity
import android.view.MotionEvent
import android.view.TextureView
import android.view.View
import android.view.ViewConfiguration
import android.view.ViewGroup
import android.webkit.CookieManager
import android.widget.FrameLayout
import android.widget.ImageButton
import android.widget.ImageView
import android.widget.LinearLayout
import android.widget.ProgressBar
import android.widget.ScrollView
import android.widget.TextView
import android.widget.Toast
import androidx.media3.common.MediaItem
import androidx.media3.common.PlaybackException
import androidx.media3.common.Player
import androidx.media3.datasource.okhttp.OkHttpDataSource
import androidx.media3.exoplayer.DefaultLoadControl
import androidx.media3.exoplayer.ExoPlayer
import androidx.media3.exoplayer.source.DefaultMediaSourceFactory
import okhttp3.OkHttpClient
import org.json.JSONArray
import org.json.JSONObject
import java.util.concurrent.TimeUnit
import kotlin.math.abs
import kotlin.math.roundToInt

class VideoPlayerActivity : Activity() {

    private data class Track(val rel: String, val id: String, val title: String, val sub: String)

    private lateinit var rootLayout: FrameLayout
    private lateinit var tex: TextureView
    private lateinit var controls: View
    private lateinit var hud: TextView
    private lateinit var centerBtn: ImageButton
    private lateinit var lockBtn: ImageButton
    private lateinit var loading: ProgressBar
    private lateinit var titleView: TextView
    private lateinit var subView: TextView
    private lateinit var playPauseBtn: ImageButton
    private lateinit var speedBtn: TextView
    private lateinit var episodeBtn: TextView
    private lateinit var curView: TextView
    private lateinit var durView: TextView
    private lateinit var seek: VideoSeekBar

    private var player: ExoPlayer? = null
    private var tracks: List<Track> = emptyList()
    private var index = 0
    private var autoplay = true
    private var base = ""
    private var client: OkHttpClient? = null
    private var am: AudioManager? = null

    private var rate = 1f
    private val RATES = floatArrayOf(0.75f, 1f, 1.25f, 1.5f, 2f, 3f)
    private val FAST = 2f

    private val ui = Handler(Looper.getMainLooper())
    private var hideRunnable: Runnable? = null
    private val hudRunnable = Runnable { fadeHud(false) }
    private val longRunnable = Runnable { enterFast() }

    private var controlsShown = true
    private var locked = false
    private var sheet: View? = null

    private var downX = 0f
    private var downY = 0f
    private var downT = 0L
    private var moved = false
    private var gesture = 0
    private var startVol = 0
    private var maxVol = 15
    private var startBright = 0.5f
    private var slop = 12

    private val ticker = object : Runnable {
        override fun run() {
            val p = player ?: return
            val d = p.duration
            if (d > 0) {
                seek.setProgress(p.currentPosition.toFloat() / d)
                seek.setBuffered(p.bufferedPosition.toFloat() / d)
                curView.text = fmt(p.currentPosition)
                durView.text = fmt(d)
            }
            emitTime()
            ui.postDelayed(this, 1000)
        }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        requestedOrientation = ActivityInfo.SCREEN_ORIENTATION_SENSOR_LANDSCAPE
        base = (getSharedPreferences("fm", MODE_PRIVATE).getString("base", "") ?: "").trim().trimEnd('/')
        am = getSystemService(AudioManager::class.java)
        slop = ViewConfiguration.get(this).scaledTouchSlop
        rate = readRate()
        parseIntent(intent)
        client = OkHttpClient.Builder()
            .connectTimeout(8, TimeUnit.SECONDS)
            .readTimeout(20, TimeUnit.SECONDS)
            .build()
        buildUi()
        goImmersive()
        if (tracks.isEmpty()) { toast("没有可播放的视频"); finish(); return }
        playIndex(index, startFrom(intent), autoplay)
    }

    override fun onNewIntent(intent: Intent?) {
        super.onNewIntent(intent)
        if (intent == null) return
        setIntent(intent)
        parseIntent(intent)
        if (tracks.isNotEmpty()) playIndex(index, startFrom(intent), autoplay)
    }

    private fun readRate(): Float {
        val r = getSharedPreferences("fm", MODE_PRIVATE).getFloat("videoRate", 1f)
        return snapRate(r)
    }

    private fun snapRate(r: Float): Float {
        var best = RATES[0]
        for (x in RATES) if (abs(x - r) < abs(best - r)) best = x
        return best
    }

    private fun parseIntent(i: Intent?) {
        if (i == null) return
        val raw = i.getStringExtra("list") ?: return
        val arr = runCatching { JSONArray(raw) }.getOrDefault(JSONArray())
        val list = ArrayList<Track>()
        for (k in 0 until arr.length()) {
            val o = arr.optJSONObject(k) ?: continue
            list.add(Track(o.optString("rel"), o.optString("id"), o.optString("title"), o.optString("sub")))
        }
        if (list.isEmpty()) return
        tracks = list
        index = i.getIntExtra("index", 0).coerceIn(0, list.size - 1)
        autoplay = i.getBooleanExtra("autoplay", true)
    }

    private fun startFrom(i: Intent?): Long = i?.getLongExtra("start", 0L) ?: 0L

    /* ── UI ── */
    private fun buildUi() {
        val root = FrameLayout(this).apply { setBackgroundColor(0xFF000000.toInt()) }
        rootLayout = root
        tex = TextureView(this)
        root.addView(tex, FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))

        val frame = FrameLayout(this)
        root.addView(frame, FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))

        val scrimTop = View(this).apply { setBackgroundResource(R.drawable.scrim_top) }
        frame.addView(scrimTop, FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, dp(120), Gravity.TOP))
        val scrimBottom = View(this).apply { setBackgroundResource(R.drawable.scrim_bottom) }
        frame.addView(scrimBottom, FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, dp(170), Gravity.BOTTOM))

        /* 顶部 */
        val top = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
            setPadding(dp(6), dp(10), dp(16), dp(6))
        }
        val back = iconBtn(R.drawable.ic_back, 44) { finishWithClosed() }
        val titles = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL; setPadding(dp(10), 0, 0, 0) }
        titleView = TextView(this).apply {
            setTextColor(0xFFFFFFFF.toInt()); textSize = 15f; setShadowLayer(6f, 0f, 1f, 0x99000000.toInt())
            maxLines = 1; ellipsize = TextUtils.TruncateAt.END
        }
        subView = TextView(this).apply { setTextColor(0xB3FFFFFF.toInt()); textSize = 11.5f; maxLines = 1 }
        titles.addView(titleView); titles.addView(subView)
        top.addView(back)
        top.addView(titles, LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f))
        frame.addView(top, FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT, Gravity.TOP))

        /* 底部 */
        val bottom = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(dp(12), dp(2), dp(14), dp(12))
        }

        /* 行 A：播放/下一集 + 当前时间 + 进度条 + 总时长 */
        val rowA = LinearLayout(this).apply { orientation = LinearLayout.HORIZONTAL; gravity = Gravity.CENTER_VERTICAL }
        playPauseBtn = iconBtn(R.drawable.ic_pause, 40) { togglePlay() }
        val next = iconBtn(R.drawable.ic_next, 40) { goNext() }
        curView = timeText()
        seek = VideoSeekBar(this)
        seek.onSeek = { ratio -> player?.let { if (it.duration > 0) it.seekTo((ratio * it.duration).toLong()) } ; showControls() }
        durView = timeText()
        rowA.addView(playPauseBtn)
        rowA.addView(next)
        rowA.addView(curView)
        rowA.addView(seek, LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f).apply { marginStart = dp(10); marginEnd = dp(10) })
        rowA.addView(durView)
        bottom.addView(rowA)

        /* 行 B：右侧文字按钮「倍速 / 选集」 */
        val rowB = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.END or Gravity.CENTER_VERTICAL
            setPadding(0, dp(2), 0, 0)
        }
        speedBtn = textBtn("倍速") { showSpeedSheet() }
        episodeBtn = textBtn("选集") { showEpisodeDrawer() }
        rowB.addView(speedBtn)
        rowB.addView(episodeBtn)
        bottom.addView(rowB)

        frame.addView(bottom, FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT, Gravity.BOTTOM))

        /* 中央播放键 */
        centerBtn = ImageButton(this).apply {
            setImageResource(R.drawable.ic_play)
            scaleType = ImageView.ScaleType.CENTER_INSIDE
            setPadding(dp(18), dp(18), dp(18), dp(18))
            setBackgroundResource(R.drawable.bg_circle_btn)
            visibility = View.GONE
            setOnClickListener { player?.let { if (it.isPlaying) it.pause() else it.play() } }
        }
        root.addView(centerBtn, FrameLayout.LayoutParams(dp(74), dp(74), Gravity.CENTER))

        /* 右侧锁定 */
        lockBtn = iconBtn(R.drawable.ic_unlock, 42) { toggleLock() }
        lockBtn.visibility = View.VISIBLE
        root.addView(lockBtn, FrameLayout.LayoutParams(dp(42), dp(42), Gravity.END or Gravity.CENTER_VERTICAL).apply { marginEnd = dp(6) })

        /* 缓冲圈 */
        loading = ProgressBar(this).apply {
            indeterminateTintList = ColorStateList.valueOf(0xFFFFFFFF.toInt())
            visibility = View.GONE
        }
        root.addView(loading, FrameLayout.LayoutParams(dp(42), dp(42), Gravity.CENTER))

        /* HUD */
        hud = TextView(this).apply {
            setTextColor(0xFFFFFFFF.toInt()); textSize = 14f
            setBackgroundResource(R.drawable.bg_hud)
            setPadding(dp(18), dp(8), dp(18), dp(8))
            gravity = Gravity.CENTER
            alpha = 0f
            visibility = View.GONE
        }
        root.addView(hud, FrameLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT, Gravity.CENTER).apply { topMargin = -dp(96) })

        controls = frame
        bindGestures()
        setContentView(root)
        setControls(true, false)
    }

    private fun dp(v: Int) = (v * resources.displayMetrics.density).toInt()

    private fun rippleBg(): Int {
        val out = TypedValue()
        return if (theme.resolveAttribute(android.R.attr.selectableItemBackgroundBorderless, out, true)) out.resourceId else 0
    }

    private fun iconBtn(res: Int, size: Int, onClick: () -> Unit): ImageButton {
        val b = ImageButton(this)
        b.setImageResource(res)
        b.scaleType = ImageView.ScaleType.CENTER_INSIDE
        b.setPadding(dp(8), dp(8), dp(8), dp(8))
        val bg = rippleBg(); if (bg != 0) b.setBackgroundResource(bg)
        b.setOnClickListener { onClick() }
        b.layoutParams = LinearLayout.LayoutParams(dp(size), dp(size))
        return b
    }

    private fun timeText(): TextView = TextView(this).apply {
        setTextColor(0xE6FFFFFF.toInt()); textSize = 12f
        typeface = android.graphics.Typeface.MONOSPACE
    }

    private fun textBtn(label: String, onClick: () -> Unit): TextView = TextView(this).apply {
        text = label
        setTextColor(0xE6FFFFFF.toInt()); textSize = 13f
        setPadding(dp(12), dp(7), dp(12), dp(7))
        setOnClickListener { onClick() }
    }

    /* ── 底部弹出选择（倍速 / 选集 共用） ── */
    private fun showSheet(title: String, labels: List<String>, current: Int, onPick: (Int) -> Unit) {
        closeSheet()
        val dim = FrameLayout(this).apply {
            setBackgroundColor(0xCC000000.toInt())
            isClickable = true
            setOnClickListener { closeSheet() }
        }
        val panel = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setBackgroundResource(R.drawable.bg_sheet)
            setPadding(dp(16), dp(14), dp(16), dp(18))
            isClickable = true
        }
        panel.addView(TextView(this).apply {
            text = title; setTextColor(0xFFFFFFFF.toInt()); textSize = 15f
            setPadding(dp(6), dp(2), dp(6), dp(10))
        })
        val list = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL }
        labels.forEachIndexed { i, label ->
            list.addView(TextView(this).apply {
                text = label
                textSize = 14f
                maxLines = 1
                ellipsize = TextUtils.TruncateAt.END
                setPadding(dp(10), dp(12), dp(10), dp(12))
                setTextColor(if (i == current) 0xFF22D3EE.toInt() else 0xFFE6EDF5.toInt())
                setOnClickListener { onPick(i); closeSheet() }
            })
        }
        val scroll = ScrollView(this).apply { addView(list) }
        panel.addView(scroll, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, 0, 1f))
        dim.addView(panel, FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, dp(300), Gravity.BOTTOM))
        rootLayout.addView(dim, FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))
        sheet = dim
    }

    private fun closeSheet() {
        sheet?.let { (it.parent as? ViewGroup)?.removeView(it) }
        sheet = null
    }

    private fun showSpeedSheet() {
        val labels = RATES.map { fmtRate(it) + "×" }
        var cur = 0
        for (k in RATES.indices) if (abs(RATES[k] - rate) < 0.001f) { cur = k; break }
        showSheet("倍速播放", labels, cur) { i -> setRate(RATES[i]); showHud("倍速 " + fmtRate(RATES[i]) + "×"); hideHudSoon() }
    }

    /* 选集：从右侧滑出，占屏宽 60% */
    private fun showEpisodeDrawer() {
        closeSheet()
        val dim = FrameLayout(this).apply {
            setBackgroundColor(0x66000000.toInt())
            isClickable = true
            setOnClickListener { closeSheetAnimated() }
        }
        val panelW = (resources.displayMetrics.widthPixels * 0.6f).toInt()
        val panel = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setBackgroundResource(R.drawable.bg_drawer)
            setPadding(dp(14), dp(16), dp(14), dp(16))
            isClickable = true
        }
        panel.addView(TextView(this).apply {
            text = "选集  (" + tracks.size + ")"
            setTextColor(0xFFFFFFFF.toInt()); textSize = 15f
            setPadding(dp(8), dp(2), dp(8), dp(12))
        })
        val list = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL }
        tracks.forEachIndexed { i, t ->
            list.addView(TextView(this).apply {
                text = (i + 1).toString() + ". " + t.title
                textSize = 14f
                maxLines = 1
                ellipsize = TextUtils.TruncateAt.END
                setPadding(dp(10), dp(13), dp(10), dp(13))
                setTextColor(if (i == index) 0xFF22D3EE.toInt() else 0xFFE6EDF5.toInt())
                setOnClickListener { playIndex(i, 0, true); closeSheetAnimated() }
            })
        }
        panel.addView(ScrollView(this).apply { addView(list) }, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, 0, 1f))
        dim.addView(panel, FrameLayout.LayoutParams(panelW, ViewGroup.LayoutParams.MATCH_PARENT, Gravity.END))
        rootLayout.addView(dim, FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))
        sheet = dim
        panel.translationX = panelW.toFloat()
        panel.animate().translationX(0f).setDuration(220).start()
    }

    private fun closeSheetAnimated() {
        val d = sheet ?: return
        sheet = null
        val panel = (d as? ViewGroup)?.getChildAt(0)
        val parent = d.parent as? ViewGroup
        if (panel != null && parent != null) {
            panel.animate().translationX(panel.width.toFloat()).setDuration(180)
                .withEndAction { parent.removeView(d) }.start()
            d.animate().alpha(0f).setDuration(180).start()
        } else {
            parent?.removeView(d)
        }
    }

    /* ── 手势 ── */
    private fun bindGestures() {
        tex.setOnTouchListener { v, e ->
            if (locked) return@setOnTouchListener true
            when (e.actionMasked) {
                MotionEvent.ACTION_DOWN -> {
                    downX = e.x; downY = e.y; downT = System.currentTimeMillis()
                    moved = false; gesture = 0
                    ui.removeCallbacks(longRunnable)
                    if (player?.isPlaying == true) ui.postDelayed(longRunnable, 500)
                }
                MotionEvent.ACTION_MOVE -> {
                    val dx = e.x - downX
                    val dy = e.y - downY
                    if (!moved && (abs(dy) > slop || abs(dx) > slop)) {
                        moved = true
                        ui.removeCallbacks(longRunnable)
                        if (abs(dy) > abs(dx)) {
                            if (downX < v.width / 2f) { gesture = 2; startBright = currentBrightness() }
                            else {
                                gesture = 1
                                startVol = am?.getStreamVolume(AudioManager.STREAM_MUSIC) ?: 0
                                maxVol = (am?.getStreamMaxVolume(AudioManager.STREAM_MUSIC) ?: 15).coerceAtLeast(1)
                            }
                        }
                    }
                    if (gesture == 1 || gesture == 2) {
                        val ratio = (downY - e.y) / v.height.toFloat().coerceAtLeast(1f)
                        if (gesture == 1) {
                            val nv = (startVol + ratio * maxVol).roundToInt().coerceIn(0, maxVol)
                            am?.setStreamVolume(AudioManager.STREAM_MUSIC, nv, 0)
                            showHud("音量 " + (nv * 100 / maxVol) + "%")
                        } else {
                            val nb = (startBright + ratio).coerceIn(0f, 1f)
                            applyBrightness(nb)
                            showHud("亮度 " + (nb * 100).roundToInt() + "%")
                        }
                    }
                }
                MotionEvent.ACTION_UP, MotionEvent.ACTION_CANCEL -> {
                    ui.removeCallbacks(longRunnable)
                    val dur = System.currentTimeMillis() - downT
                    if (gesture == 3) exitFast()
                    else if (gesture == 1 || gesture == 2) hideHudSoon()
                    else if (!moved && dur < 500) toggleControls()
                    gesture = 0
                }
            }
            true
        }
    }

    private fun enterFast() {
        if (gesture != 0) return
        gesture = 3
        player?.setPlaybackSpeed(FAST)
        showHud("快进 " + fmtRate(FAST) + "×")
    }

    private fun exitFast() {
        player?.setPlaybackSpeed(rate)
        hideHudSoon()
    }

    private fun currentBrightness(): Float {
        val a = window.attributes
        if (a.screenBrightness >= 0f) return a.screenBrightness
        val v = runCatching { Settings.System.getInt(contentResolver, Settings.System.SCREEN_BRIGHTNESS) }.getOrDefault(128)
        return (v / 255f).coerceIn(0.05f, 1f)
    }

    private fun applyBrightness(v: Float) {
        val a = window.attributes
        a.screenBrightness = v.coerceIn(0.05f, 1f)
        window.attributes = a
    }

    /* ── HUD ── */
    private fun fadeHud(show: Boolean) {
        if (show) {
            hud.visibility = View.VISIBLE
            hud.animate().alpha(1f).setDuration(120).start()
        } else {
            hud.animate().alpha(0f).setDuration(220).withEndAction { hud.visibility = View.GONE }.start()
        }
    }

    private fun showHud(text: String) {
        hud.text = text
        ui.removeCallbacks(hudRunnable)
        fadeHud(true)
    }

    private fun hideHudSoon() {
        ui.removeCallbacks(hudRunnable)
        ui.postDelayed(hudRunnable, 700)
    }

    /* ── 播放 ── */
    private fun playIndex(i: Int, startMs: Long, auto: Boolean) {
        if (tracks.isEmpty()) return
        index = i.coerceIn(0, tracks.size - 1)
        val t = tracks[index]
        titleView.text = t.title
        subView.text = if (t.sub.isNotEmpty()) t.sub + "  ·  " + (index + 1) + "/" + tracks.size else (index + 1).toString() + "/" + tracks.size

        val url = mediaUrl(t.rel)
        val cookie = CookieManager.getInstance().getCookie(url) ?: ""
        val ds = OkHttpDataSource.Factory(client!!).setDefaultRequestProperties(mapOf("Cookie" to cookie))
        val loadControl = DefaultLoadControl.Builder()
            .setBufferDurationsMs(30000, 120000, 5000, 10000)
            .build()

        player?.release()
        val p = ExoPlayer.Builder(this)
            .setMediaSourceFactory(DefaultMediaSourceFactory(ds))
            .setLoadControl(loadControl)
            .build()
        p.addListener(object : Player.Listener {
            override fun onIsPlayingChanged(playing: Boolean) {
                playPauseBtn.setImageResource(if (playing) R.drawable.ic_pause else R.drawable.ic_play)
                centerBtn.visibility = if (!playing && !locked) View.VISIBLE else View.GONE
                emit("state", trackJson().put("playing", playing))
                if (playing) scheduleHide() else showControls()
            }
            override fun onPlaybackStateChanged(state: Int) {
                loading.visibility = if (state == Player.STATE_BUFFERING) View.VISIBLE else View.GONE
                if (state == Player.STATE_ENDED) ui.post { onEnded() }
            }
            override fun onPlayerError(error: PlaybackException) {
                Log.w("VideoPlayer", "error: " + error.errorCodeName + " " + (error.message ?: ""))
                toast("播放失败：" + error.errorCodeName)
            }
        })
        p.setVideoTextureView(tex)
        p.setMediaItem(MediaItem.fromUri(url), startMs.coerceAtLeast(0))
        p.setPlaybackSpeed(rate)
        p.prepare()
        p.playWhenReady = auto
        player = p
        ui.removeCallbacks(ticker)
        ui.post(ticker)
        emit("track", trackJson())
    }

    private fun setRate(r: Float) {
        rate = r
        player?.setPlaybackSpeed(r)
        getSharedPreferences("fm", MODE_PRIVATE).edit().putFloat("videoRate", r).apply()
    }

    private fun fmtRate(r: Float): String {
        return if (abs(r - Math.round(r).toFloat()) < 0.001f) Math.round(r).toString()
        else String.format("%.2f", r).trimEnd('0').trimEnd('.')
    }

    private fun togglePlay() {
        val p = player ?: return
        if (p.isPlaying) p.pause() else p.play()
        showControls()
    }

    private fun goNext() {
        if (index + 1 < tracks.size) playIndex(index + 1, 0, true) else toast("已经是最后一集")
    }

    private fun onEnded() {
        if (index + 1 < tracks.size) playIndex(index + 1, 0, true)
        else { emit("ended", trackJson()); player?.pause() }
    }

    private fun mediaUrl(rel: String): String {
        val enc = rel.split("/").joinToString("/") { Uri.encode(it) }
        return base + "/api/media/" + enc
    }

    /* ── 锁定 ── */
    private fun toggleLock() {
        locked = !locked
        lockBtn.setImageResource(if (locked) R.drawable.ic_lock else R.drawable.ic_unlock)
        if (locked) {
            setControls(false, true)
            centerBtn.visibility = View.GONE
        } else {
            showControls()
            if (player?.isPlaying != true) centerBtn.visibility = View.VISIBLE
        }
    }

    /* ── 事件回传 ── */
    private fun trackJson(): JSONObject {
        val o = JSONObject()
        o.put("index", index)
        o.put("total", tracks.size)
        if (index in tracks.indices) {
            val t = tracks[index]
            o.put("id", t.id); o.put("title", t.title); o.put("sub", t.sub)
        }
        return o
    }

    private fun emitTime() {
        val p = player ?: return
        val d = p.duration
        if (d <= 0) return
        val o = trackJson()
        o.put("cur", p.currentPosition / 1000.0)
        o.put("dur", d / 1000.0)
        o.put("playing", p.isPlaying)
        emit("time", o)
    }

    private fun emit(type: String, data: JSONObject) {
        val json = data.toString().replace("\\", "\\\\").replace("'", "\\'")
        MainActivity.current?.js(
            "window.FM && FM.android && FM.android.onNativeVideo && FM.android.onNativeVideo('" + type + "', '" + json + "')"
        )
    }

    /* ── 控件显隐 ── */
    private fun setControls(show: Boolean, animate: Boolean) {
        controlsShown = show
        controls.animate().cancel()
        lockBtn.visibility = if (show || locked) View.VISIBLE else View.GONE
        if (!animate) {
            controls.alpha = if (show) 1f else 0f
            controls.visibility = if (show) View.VISIBLE else View.GONE
            return
        }
        controls.visibility = View.VISIBLE
        controls.animate().alpha(if (show) 1f else 0f).setDuration(200)
            .withEndAction { if (!controlsShown) controls.visibility = View.GONE }.start()
    }

    private fun showControls() {
        setControls(true, false)
        if (player?.isPlaying == true) scheduleHide()
    }

    private fun scheduleHide() {
        hideRunnable?.let { ui.removeCallbacks(it) }
        val r = Runnable { setControls(false, true) }
        hideRunnable = r
        ui.postDelayed(r, 3500)
    }

    private fun toggleControls() {
        if (controlsShown) setControls(false, true) else showControls()
    }

    /* ── 生命周期 ── */
    private fun goImmersive() {
        @Suppress("DEPRECATION")
        window.decorView.systemUiVisibility = (
            View.SYSTEM_UI_FLAG_LAYOUT_STABLE or
                View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION or
                View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN or
                View.SYSTEM_UI_FLAG_HIDE_NAVIGATION or
                View.SYSTEM_UI_FLAG_FULLSCREEN or
                View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY
            )
    }

    override fun onWindowFocusChanged(hasFocus: Boolean) {
        super.onWindowFocusChanged(hasFocus)
        if (hasFocus) goImmersive()
    }

    override fun onStop() {
        super.onStop()
        player?.pause()
    }

    @Deprecated("Deprecated in Java")
    override fun onBackPressed() {
        finishWithClosed()
    }

    private fun finishWithClosed() {
        val o = trackJson()
        player?.let {
            o.put("cur", it.currentPosition / 1000.0)
            o.put("dur", (if (it.duration > 0) it.duration else 0L) / 1000.0)
        }
        emit("closed", o)
        finish()
    }

    override fun onDestroy() {
        super.onDestroy()
        ui.removeCallbacks(ticker)
        ui.removeCallbacks(hudRunnable)
        ui.removeCallbacks(longRunnable)
        hideRunnable?.let { ui.removeCallbacks(it) }
        player?.release()
        player = null
    }

    private fun toast(msg: String) = Toast.makeText(this, msg, Toast.LENGTH_SHORT).show()

    private fun fmt(ms: Long): String {
        val s = ms / 1000
        return String.format("%d:%02d", s / 60, s % 60)
    }
}

/* ── 自绘细进度条：细轨道 + 缓冲 + 白色进度 + 拖动圆点 ── */
class VideoSeekBar(ctx: Context) : View(ctx) {

    private var progress = 0f
    private var buffered = 0f
    private var dragging = false
    var onSeek: ((Float) -> Unit)? = null

    private val trackPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply { color = 0x33FFFFFF }
    private val bufPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply { color = 0x66FFFFFF }
    private val progPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply { color = 0xFFFFFFFF.toInt() }
    private val thumbPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply { color = 0xFFFFFFFF.toInt() }

    private fun dp(v: Float) = v * resources.displayMetrics.density
    private fun edgeL(): Float = dp(6f)
    private fun edgeR(): Float = width - dp(6f)

    override fun onMeasure(widthMeasureSpec: Int, heightMeasureSpec: Int) {
        setMeasuredDimension(MeasureSpec.getSize(widthMeasureSpec), dp(26f).toInt())
    }

    override fun onDraw(c: Canvas) {
        val cy = height / 2f
        val l = edgeL(); val r = edgeR(); val w = (r - l).coerceAtLeast(1f)
        val th = if (dragging) dp(4f) else dp(2.5f)
        c.drawRoundRect(l, cy - th / 2, r, cy + th / 2, th / 2, th / 2, trackPaint)
        if (buffered > 0f) {
            val bx = l + w * buffered.coerceIn(0f, 1f)
            c.drawRoundRect(l, cy - th / 2, bx, cy + th / 2, th / 2, th / 2, bufPaint)
        }
        val px = l + w * progress.coerceIn(0f, 1f)
        c.drawRoundRect(l, cy - th / 2, px, cy + th / 2, th / 2, th / 2, progPaint)
        val tr = if (dragging) dp(7f) else dp(4.5f)
        c.drawCircle(px, cy, tr, thumbPaint)
    }

    private fun ratioAt(x: Float): Float {
        val l = edgeL(); val r = edgeR()
        return ((x - l) / (r - l)).coerceIn(0f, 1f)
    }

    override fun onTouchEvent(e: MotionEvent): Boolean {
        when (e.actionMasked) {
            MotionEvent.ACTION_DOWN -> {
                dragging = true
                progress = ratioAt(e.x)
                parent?.requestDisallowInterceptTouchEvent(true)
                invalidate()
                return true
            }
            MotionEvent.ACTION_MOVE -> {
                progress = ratioAt(e.x)
                invalidate()
                return true
            }
            MotionEvent.ACTION_UP, MotionEvent.ACTION_CANCEL -> {
                dragging = false
                progress = ratioAt(e.x)
                invalidate()
                onSeek?.invoke(progress)
                return true
            }
        }
        return super.onTouchEvent(e)
    }

    fun setProgress(p: Float) { if (!dragging) { progress = p.coerceIn(0f, 1f); invalidate() } }
    fun setBuffered(b: Float) { buffered = b.coerceIn(0f, 1f); invalidate() }
}
