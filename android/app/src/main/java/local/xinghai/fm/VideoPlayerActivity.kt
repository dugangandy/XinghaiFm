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
import android.widget.HorizontalScrollView
import android.widget.ImageButton
import android.widget.ImageView
import android.widget.LinearLayout
import android.widget.ProgressBar
import android.widget.ScrollView
import android.widget.Switch
import android.widget.TextView
import android.widget.Toast
import androidx.media3.common.C
import androidx.media3.common.MediaItem
import androidx.media3.common.PlaybackException
import androidx.media3.common.Player
import androidx.media3.common.VideoSize
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
    private lateinit var videoFrame: AspectLayout
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
    private lateinit var episodeIcon: ImageButton    // 窄屏（竖屏）代替文字版「选集」
    private lateinit var fullscreenBtn: ImageButton
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
    private var audioOnly = false
    private var isFullscreen = false      // 竖屏看片；点「全屏」才切横屏
    private val RATES = floatArrayOf(0.75f, 1f, 1.25f, 1.5f, 2f, 3f)
    private val FAST = 2f

    private val ui = Handler(Looper.getMainLooper())
    private var hideRunnable: Runnable? = null
    private val hudRunnable = Runnable { fadeHud(false) }
    private val longRunnable = Runnable { enterFast() }
    private val singleTapRunnable = Runnable { toggleControls() }
    private var lastTapAt = 0L

    private var controlsShown = true
    private var locked = false
    private var sheet: View? = null
    private var sheetBottom = false       // 当前面板是从底部弹出来的（竖屏），关闭时往下收
    private var scaleMode = 1                 // 0 满屏 1 原比例 2 4:3 3 16:9 4 21:9
    private var loopOne = false            // 单集循环
    private var bgAudio = false            // 锁屏/切后台后继续播放声音
    private var videoDetached = false      // 后台时已释放画面，回来要重新挂载
    private var timerMode = 0              // 定时关闭：0 不开启 1 播完当前 2 30分钟 3 60分钟
    private var timerRunnable: Runnable? = null

    /* 画面尺寸：满屏（拉伸铺满全屏）／原比例（保持宽高比，留黑边） */
    private val SCALE_NAMES = arrayOf("满屏", "原比例", "4:3", "16:9")
    private val LOOP_NAMES = arrayOf("连续播放", "单集循环")
    private val TIMER_NAMES = arrayOf("不开启", "播完当前", "30分钟", "60分钟")

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
        audioOnly = intent?.getBooleanExtra("audio", false) == true
        /* 视频先竖屏看，点「全屏」才横过来；纯音频跟系统走 */
        requestedOrientation = if (audioOnly) ActivityInfo.SCREEN_ORIENTATION_UNSPECIFIED
            else ActivityInfo.SCREEN_ORIENTATION_PORTRAIT
        base = (getSharedPreferences("fm", MODE_PRIVATE).getString("base", "") ?: "").trim().trimEnd('/')
        am = getSystemService(AudioManager::class.java)
        slop = ViewConfiguration.get(this).scaledTouchSlop
        rate = readRate()
        scaleMode = getSharedPreferences("fm", MODE_PRIVATE).getInt("videoScale", 1).coerceIn(0, SCALE_NAMES.size - 1)
        loopOne = getSharedPreferences("fm", MODE_PRIVATE).getBoolean("videoLoop", false)
        bgAudio = getSharedPreferences("fm", MODE_PRIVATE).getBoolean("videoBgPlay", false)
        parseIntent(intent)
        client = OkHttpClient.Builder()
            .connectTimeout(8, TimeUnit.SECONDS)
            .readTimeout(20, TimeUnit.SECONDS)
            .build()
        buildUi()
        if (audioOnly) videoFrame.visibility = View.GONE
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

        /* 画面层：按视频原始宽高比摆放，不再拉伸铺满 */
        videoFrame = AspectLayout(this)
        applyScale(scaleMode, false)
        videoFrame.addView(tex, FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))
        root.addView(videoFrame, FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))

        /* 手势层：覆盖全屏（含上下黑边），控件层在其上 */
        val gestureLayer = View(this)
        root.addView(gestureLayer, FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))

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
        top.addView(iconBtn(R.drawable.ic_more, 44) { showSettingsPanel() })
        frame.addView(top, FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT, Gravity.TOP))

        /* 底部 */
        val bottom = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(dp(12), dp(2), dp(12), dp(12))
        }

        /* 底栏就一行：播放/下一集 + 当前时间 + 进度条 + 总时长 + 倍速/选集/全屏 */
        val row = LinearLayout(this).apply { orientation = LinearLayout.HORIZONTAL; gravity = Gravity.CENTER_VERTICAL }
        playPauseBtn = iconBtn(R.drawable.ic_pause, 40) { togglePlay() }
        val next = iconBtn(R.drawable.ic_next, 40) { goNext() }
        curView = timeText()
        seek = VideoSeekBar(this)
        seek.onSeek = { ratio -> player?.let { if (it.duration > 0) it.seekTo((ratio * it.duration).toLong()) } ; showControls() }
        durView = timeText()
        speedBtn = textBtn(fmtRate(rate) + "x") { showSpeedPanel() }
        episodeBtn = textBtn("选集") { showEpisodeDrawer() }
        episodeIcon = iconBtn(R.drawable.ic_list, 40) { showEpisodeDrawer() }.apply {
            contentDescription = "选集"
            visibility = View.GONE
        }
        fullscreenBtn = iconBtn(R.drawable.ic_fullscreen, 40) { toggleFullscreen() }.apply {
            contentDescription = "全屏"
        }
        row.addView(playPauseBtn)
        row.addView(next)
        row.addView(curView)
        row.addView(seek, LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f).apply { marginStart = dp(10); marginEnd = dp(10) })
        row.addView(durView)
        row.addView(speedBtn)
        row.addView(episodeBtn)
        row.addView(episodeIcon)
        if (!audioOnly) row.addView(fullscreenBtn)
        bottom.addView(row)

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
        bindGestures(gestureLayer)
        setContentView(root)
        layoutControlRows()
        setControls(true, false)
    }

    /* 底栏只有一行，按钮和进度条并排：竖屏挤，字号/内边距/图标收小一档，横屏放回正常尺寸 */
    private fun layoutControlRows() {
        if (audioOnly) return
        val compact = !isFullscreen
        listOf(speedBtn, episodeBtn).forEach { b ->
            b.textSize = if (compact) 12f else 13f
            b.setPadding(dp(if (compact) 6 else 12), dp(7), dp(if (compact) 6 else 12), dp(7))
        }
        /* 竖屏窄，选集也用图标；横屏恢复文字，认起来更清楚 */
        episodeBtn.visibility = if (compact) View.GONE else View.VISIBLE
        episodeIcon.visibility = if (compact) View.VISIBLE else View.GONE
        listOf(fullscreenBtn, episodeIcon).forEach { b ->
            /* 34dp 的按钮里留 3dp 内边距，图标本身还能画到 ~24dp，不至于缩成小点 */
            b.setPadding(dp(if (compact) 5 else 8), dp(if (compact) 5 else 8), dp(if (compact) 5 else 8), dp(if (compact) 5 else 8))
            (b.layoutParams as? LinearLayout.LayoutParams)?.let { lp ->
                lp.width = dp(if (compact) 34 else 40)
                lp.height = dp(if (compact) 34 else 40)
                b.requestLayout()             // 直接改 LayoutParams 不会自动重排
            }
        }
        (seek.layoutParams as? LinearLayout.LayoutParams)?.let { lp ->
            lp.marginStart = dp(if (compact) 6 else 10)
            lp.marginEnd = dp(if (compact) 6 else 10)
        }
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

    private fun closeSheet() {
        sheet?.let { (it.parent as? ViewGroup)?.removeView(it) }
        sheet = null
        sheetBottom = false
    }

    /* 面板按方向换形态：竖屏从底部弹（主流播放器做法），横屏仍从右侧抽屉滑出。
       heightPx > 0 用固定高度，否则按内容贴合 —— 倍速/设置贴合，选集给 0.6 屏高。 */
    private fun openPanel(heightPx: Int, fill: LinearLayout.() -> Unit) {
        if (isFullscreen) openRightPanel(fill) else openBottomSheet(heightPx, fill)
    }

    private fun openBottomSheet(heightPx: Int, fill: LinearLayout.() -> Unit) {
        closeSheet()
        val dim = FrameLayout(this).apply {
            setBackgroundColor(0x66000000.toInt())
            isClickable = true
            setOnClickListener { closeSheetAnimated() }
        }
        val panel = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setBackgroundResource(R.drawable.bg_sheet_bottom)
            setPadding(dp(16), dp(4), dp(16), dp(16))
            isClickable = true
            alpha = 0f                    // 量出高度前先别露，免得从 0 位置闪一下
        }
        panel.addView(View(this).apply {
            setBackgroundResource(R.drawable.bg_handle)
            layoutParams = LinearLayout.LayoutParams(dp(38), dp(4)).apply {
                gravity = Gravity.CENTER_HORIZONTAL
                topMargin = dp(7)
            }
        })
        panel.fill()
        val lp = FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT,
            ViewGroup.LayoutParams.WRAP_CONTENT, Gravity.BOTTOM)
        if (heightPx > 0) lp.height = heightPx
        dim.addView(panel, lp)
        rootLayout.addView(dim, FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))
        sheet = dim
        sheetBottom = true
        panel.post {
            if (sheet !== dim) return@post
            panel.translationY = panel.height.toFloat()
            panel.alpha = 1f
            panel.animate().translationY(0f).setDuration(220).start()
        }
    }

    /* 底部弹窗的小标题：和右侧抽屉里的段落标题同一套字号 */
    private fun sheetTitle(text: String): TextView = TextView(this).apply {
        this.text = text
        setTextColor(0xFFFFFFFF.toInt())
        textSize = 15f
        setPadding(dp(2), dp(14), 0, dp(10))
    }

    /* ── 右侧设置面板（倍速 / 画面尺寸共用）：占屏宽 30%，从右滑出 ── */
    private fun openRightPanel(fill: LinearLayout.() -> Unit) {
        closeSheet()
        val dim = FrameLayout(this).apply {
            setBackgroundColor(0x66000000)
            isClickable = true
            setOnClickListener { closeSheetAnimated() }
        }
        val panelW = panelWidth()
        val panel = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setBackgroundResource(R.drawable.bg_drawer)
            setPadding(dp(16), dp(6), dp(14), dp(16))
            isClickable = true
        }
        panel.addView(divider())
        panel.fill()
        panel.addView(divider())
        dim.addView(panel, FrameLayout.LayoutParams(panelW, ViewGroup.LayoutParams.MATCH_PARENT, Gravity.END))
        rootLayout.addView(dim, FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))
        sheet = dim
        sheetBottom = false
        panel.translationX = panelW.toFloat()
        panel.animate().translationX(0f).setDuration(200).start()
    }

    private fun panelWidth(): Int =
        (resources.displayMetrics.widthPixels * 0.34f).toInt().coerceAtLeast(dp(230))

    private fun chipView(name: String): TextView = TextView(this).apply {
        text = name
        textSize = 13f
        maxLines = 1
        gravity = Gravity.CENTER
        setPadding(dp(8), dp(6), dp(8), dp(6))
    }

    private fun styleChip(v: TextView, selected: Boolean) {
        v.setTextColor(if (selected) 0xFFFFFFFF.toInt() else 0xFFC9D4E2.toInt())
        if (selected) v.setBackgroundResource(R.drawable.bg_chip) else v.background = null
    }

    /* 右上角三点：播放设置（竖屏底部弹窗，横屏右侧抽屉） */
    private fun showSettingsPanel() {
        openPanel(0) {
            addView(scaleRow())
            addView(divider())
            addView(loopRow())
            addView(divider())
            addView(timerRow())
            addView(divider())
            addView(bgPlayRow())
        }
    }

    /* 一行设置：标题在左，选项在右；放不下时单行左右滑动，不换行
     * visible 用来按当前状态藏掉没意义的选项（比如竖屏下的「满屏」） */
    private fun chipGridRow(label: String, names: Array<String>,
                            selectedOf: () -> Int, visible: (Int) -> Boolean = { true },
                            onPick: (Int) -> Unit): LinearLayout {
        val chips = ArrayList<Pair<Int, TextView>>()
        val opts = LinearLayout(this).apply { orientation = LinearLayout.HORIZONTAL }
        names.forEachIndexed { i, name ->
            if (!visible(i)) return@forEachIndexed
            val v = chipView(name)
            chips.add(i to v)
            opts.addView(v, LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT).apply { marginStart = dp(4) })
        }
        val scroller = HorizontalScrollView(this).apply {
            isHorizontalScrollBarEnabled = false
            addView(opts, ViewGroup.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT))
        }
        val row = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
            setPadding(dp(2), dp(13), 0, dp(13))
            layoutParams = LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT)
        }
        row.addView(TextView(this).apply {
            text = label
            setTextColor(0xFFFFFFFF.toInt())
            textSize = 13f
            maxLines = 1
        })
        /* 选项紧跟标题，固定 10dp 间距；剩余宽度全给可滚区，放不下就滑 */
        row.addView(scroller, LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f)
            .apply { marginStart = dp(10) })

        val paint = {
            val sel = selectedOf()
            chips.forEach { (i, v) -> styleChip(v, i == sel) }
            scroller.post {
                chips.firstOrNull { it.first == sel }?.let { scroller.smoothScrollTo(Math.max(0, it.second.left - dp(8)), 0) }
            }
        }
        chips.forEach { (i, v) -> v.setOnClickListener { onPick(i); paint() } }
        paint()
        return row
    }

    /* 当前真正生效的画面尺寸：竖屏下「满屏」退化成原比例 */
    private fun effectiveScale(): Int = if (!isFullscreen && scaleMode == 0) 1 else scaleMode

    /* 竖屏不给「满屏」：铺不满还会把人像片拉变形；高亮跟着实际生效的比例走
     * （竖屏下即便存的是满屏，实际也是原比例），点已选中的那一项只提示不动存储 */
    private fun scaleRow(): LinearLayout =
        chipGridRow("画面尺寸", SCALE_NAMES,
            { effectiveScale() },
            { i -> isFullscreen || i != 0 }) { i ->
            if (i != effectiveScale()) applyScale(i)
            showHud("画面 " + SCALE_NAMES[i]); hideHudSoon()
        }

    private fun loopRow(): LinearLayout =
        chipGridRow("播放方式", LOOP_NAMES, { if (loopOne) 1 else 0 }) { i ->
            loopOne = i == 1
            getSharedPreferences("fm", MODE_PRIVATE).edit().putBoolean("videoLoop", loopOne).apply()
            showHud(LOOP_NAMES[i]); hideHudSoon()
        }

    private fun timerRow(): LinearLayout =
        chipGridRow("定时关闭", TIMER_NAMES, { timerMode }) { i ->
            setTimer(i)
            showHud(if (i == 0) "定时关闭已取消" else "定时关闭：" + TIMER_NAMES[i]); hideHudSoon()
        }

    private fun bgPlayRow(): LinearLayout {
        val row = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
            setPadding(dp(2), dp(12), 0, dp(12))
        }
        val texts = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL }
        texts.addView(TextView(this).apply {
            text = "后台自动播放"
            setTextColor(0xFFFFFFFF.toInt())
            textSize = 13f
        })
        texts.addView(TextView(this).apply {
            text = "锁屏的时候后台自动播放音频"
            setTextColor(0x99FFFFFF.toInt())
            textSize = 11f
            setPadding(0, dp(3), 0, 0)
        })
        row.addView(texts, LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f))
        row.addView(Switch(this).apply {
            isChecked = bgAudio
            showText = false
            setPadding(0, 0, 0, 0)
            setOnCheckedChangeListener { _, on ->
                bgAudio = on
                getSharedPreferences("fm", MODE_PRIVATE).edit().putBoolean("videoBgPlay", on).apply()
                player?.setWakeMode(if (on) C.WAKE_MODE_NETWORK else C.WAKE_MODE_NONE)
                showHud(if (on) "后台自动播放已开启" else "后台自动播放已关闭")
                hideHudSoon()
            }
        })
        return row
    }

    private fun setTimer(mode: Int) {
        timerMode = mode
        timerRunnable?.let { ui.removeCallbacks(it) }
        timerRunnable = null
        val ms = when (mode) { 2 -> 30 * 60_000L; 3 -> 60 * 60_000L; else -> 0L }
        if (ms > 0) {
            val r = Runnable {
                timerMode = 0
                player?.pause()
                showHud("定时关闭：已暂停"); hideHudSoon()
            }
            timerRunnable = r
            ui.postDelayed(r, ms)
        }
    }

    /* 倍速：方块磁贴样式（沿用现有 6 档），竖屏从底部弹、横屏从右侧滑 */
    private fun showSpeedPanel() {
        val grid = speedTiles()
        openPanel(0) {
            if (isFullscreen) {
                addView(TextView(this@VideoPlayerActivity).apply {
                    text = "倍速"
                    setTextColor(0xB3FFFFFF.toInt())
                    textSize = 13f
                    setPadding(dp(2), dp(14), 0, dp(10))
                })
            } else {
                addView(sheetTitle("倍速"))
            }
            addView(grid, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT))
        }
    }

    /* 倍速磁贴：两个面板形态共用一份，别写两套 */
    private fun speedTiles(): LinearLayout {
        var cur = 0
        for (k in RATES.indices) if (abs(RATES[k] - rate) < 0.001f) { cur = k; break }
        val tiles = ArrayList<TextView>()
        val grid = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(0, 0, 0, dp(6))
        }
        RATES.indices.chunked(3).forEach { idxs ->
            val line = LinearLayout(this).apply { orientation = LinearLayout.HORIZONTAL }
            idxs.forEach { i ->
                val t = TextView(this).apply {
                    text = fmtRate(RATES[i]) + "x"
                    textSize = 14f
                    maxLines = 1
                    gravity = Gravity.CENTER
                }
                tiles.add(t)
                line.addView(t, LinearLayout.LayoutParams(0, dp(44), 1f).apply {
                    marginStart = dp(4); marginEnd = dp(4)
                })
            }
            grid.addView(line, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT)
                .apply { if (idxs.first() > 0) topMargin = dp(8) })
        }
        val paint = { tiles.forEachIndexed { i, v -> styleTile(v, i == cur) } }
        tiles.forEachIndexed { i, v ->
            v.setOnClickListener {
                cur = i; setRate(RATES[i]); paint()
                showHud("倍速 " + fmtRate(RATES[i]) + "x"); hideHudSoon()
            }
        }
        paint()
        return grid
    }

    private fun styleTile(v: TextView, selected: Boolean) {
        v.setTextColor(if (selected) 0xFFFFFFFF.toInt() else 0xFFD6DEE9.toInt())
        v.setBackgroundResource(if (selected) R.drawable.bg_tile_on else R.drawable.bg_tile)
    }

    private fun divider(): View = View(this).apply {
        setBackgroundColor(0x26FFFFFF)
        layoutParams = LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, Math.max(1, dp(1)))
    }

    /* 画面尺寸：满屏拉伸；原比例按片源；固定比例把画面拉伸进该比例的框里
     * 「满屏」只在横屏全屏下算数：竖屏拉伸会把人像片拉成一整屏变形，按原比例留黑边 */
    private fun applyScale(i: Int, save: Boolean = true) {
        scaleMode = i.coerceIn(0, SCALE_NAMES.size - 1)
        videoFrame.stretch = scaleMode == 0 && isFullscreen
        videoFrame.fixedRatio = when (scaleMode) {
            2 -> 4f / 3f
            3 -> 16f / 9f
            else -> 0f
        }
        if (save) getSharedPreferences("fm", MODE_PRIVATE).edit().putInt("videoScale", scaleMode).apply()
    }

    /* 选集：竖屏从底部弹（0.6 屏高，主流播放器的手感），横屏仍从右侧抽屉滑出 */
    private fun showEpisodeDrawer() {
        if (!isFullscreen) {
            val h = (resources.displayMetrics.heightPixels * 0.6f).toInt()
            openBottomSheet(h) {
                addView(sheetTitle("选集  (" + tracks.size + ")"))
                addView(episodeList(), LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, 0, 1f))
            }
            return
        }
        closeSheet()
        val dim = FrameLayout(this).apply {
            setBackgroundColor(0x66000000.toInt())
            isClickable = true
            setOnClickListener { closeSheetAnimated() }
        }
        val panelW = panelWidth()
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
        panel.addView(episodeList(), LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, 0, 1f))
        dim.addView(panel, FrameLayout.LayoutParams(panelW, ViewGroup.LayoutParams.MATCH_PARENT, Gravity.END))
        rootLayout.addView(dim, FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))
        sheet = dim
        panel.translationX = panelW.toFloat()
        panel.animate().translationX(0f).setDuration(220).start()
    }

    /* 选集列表：底部弹窗和右侧抽屉共用一份，别写两套 */
    private fun episodeList(): ScrollView {
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
        return ScrollView(this).apply { addView(list) }
    }

    private fun closeSheetAnimated() {
        val d = sheet ?: return
        sheet = null
        val panel = (d as? ViewGroup)?.getChildAt(0)
        val parent = d.parent as? ViewGroup
        if (panel != null && parent != null) {
            val anim = panel.animate().setDuration(180)
            if (sheetBottom) anim.translationY(panel.height.toFloat()) else anim.translationX(panel.width.toFloat())
            anim.withEndAction { parent.removeView(d) }.start()
            d.animate().alpha(0f).setDuration(180).start()
        } else {
            parent?.removeView(d)
        }
        sheetBottom = false
    }

    /* ── 手势 ── */
    private fun bindGestures(target: View) {
        target.setOnTouchListener { v, e ->
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
                    else if (!moved && dur < 500 && e.actionMasked == MotionEvent.ACTION_UP) {
                        /* 单击=显隐控件（延迟 240ms 等第二击）；双击=播放/暂停 */
                        val now = System.currentTimeMillis()
                        if (now - lastTapAt < 300) {
                            ui.removeCallbacks(singleTapRunnable)
                            lastTapAt = 0
                            togglePlay()
                        } else {
                            lastTapAt = now
                            ui.removeCallbacks(singleTapRunnable)
                            ui.postDelayed(singleTapRunnable, 240)
                        }
                    }
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
        showHud("快进 " + fmtRate(FAST) + "x")
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
            override fun onVideoSizeChanged(videoSize: VideoSize) {
                var w = videoSize.width * videoSize.pixelWidthHeightRatio
                var h = videoSize.height.toFloat()
                if (videoSize.unappliedRotationDegrees == 90 || videoSize.unappliedRotationDegrees == 270) {
                    val t = w; w = h; h = t
                }
                if (w > 0f && h > 0f) videoFrame.ratio = w / h
            }
            override fun onPlaybackStateChanged(state: Int) {
                loading.visibility = if (state == Player.STATE_BUFFERING) View.VISIBLE else View.GONE
                if (state == Player.STATE_ENDED) ui.post { onEnded() }
            }
            override fun onPlayerError(error: PlaybackException) {
                Log.w("VideoPlayer", "error: " + error.errorCodeName + " " + (error.message ?: ""))
                /* 断网/连不上服务器统一文案；其它错误也不暴露原生 code */
                val net = error.errorCode == PlaybackException.ERROR_CODE_IO_NETWORK_CONNECTION_FAILED ||
                    error.errorCode == PlaybackException.ERROR_CODE_IO_NETWORK_CONNECTION_TIMEOUT
                toast(if (net) Msg.NET_FAIL else "播放失败，请稍后重试")
            }
        })
        p.setWakeMode(if (bgAudio) C.WAKE_MODE_NETWORK else C.WAKE_MODE_NONE)
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
        if (::speedBtn.isInitialized) speedBtn.text = fmtRate(r) + "x"
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
        when {
            loopOne -> { player?.seekTo(0); player?.play() }
            timerMode == 1 -> { timerMode = 0; emit("ended", trackJson()); player?.pause() }
            index + 1 < tracks.size -> playIndex(index + 1, 0, true)
            else -> { emit("ended", trackJson()); player?.pause() }
        }
    }

    private fun mediaUrl(rel: String): String {
        if (rel.startsWith("http://") || rel.startsWith("https://")) return rel
        /* 已下载的曲目优先走本机文件（127.0.0.1 小服务），不直连服务器、不耗流量 */
        val local = runCatching {
            Dl.init(this)
            if (Dl.isDownloaded(rel)) Dl.localUrl(rel) else ""
        }.getOrDefault("")
        if (local.isNotEmpty()) return local
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
        lockBtn.visibility = if (isFullscreen && (show || locked)) View.VISIBLE else View.GONE
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

    /* ── 全屏：竖屏看片，点按钮才横过来 ── */
    private fun toggleFullscreen() = setFullscreen(!isFullscreen)

    private fun setFullscreen(on: Boolean) {
        if (audioOnly || isFullscreen == on) return
        isFullscreen = on
        requestedOrientation = if (on) ActivityInfo.SCREEN_ORIENTATION_SENSOR_LANDSCAPE
            else ActivityInfo.SCREEN_ORIENTATION_PORTRAIT
        if (on) goImmersive() else exitImmersive()
        applyScale(scaleMode, false)        /* 满屏只在横屏生效，转屏后重算画面尺寸 */
        layoutControlRows()                 /* 竖屏收小一档、横屏正常尺寸 */
        fullscreenBtn.setImageResource(if (on) R.drawable.ic_fullscreen_exit else R.drawable.ic_fullscreen)
        fullscreenBtn.contentDescription = if (on) "退出全屏" else "全屏"
        /* 锁定是横屏看片时才有的操作，回竖屏顺手解开 */
        if (!on && locked) {
            locked = false
            lockBtn.setImageResource(R.drawable.ic_unlock)
        }
        lockBtn.visibility = if (on) View.VISIBLE else View.GONE
        showControls()
    }

    /* 退出沉浸式：系统栏放回来，内容也不再铺到状态栏底下 */
    private fun exitImmersive() {
        @Suppress("DEPRECATION")
        window.decorView.systemUiVisibility = View.SYSTEM_UI_FLAG_LAYOUT_STABLE
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
        if (hasFocus && !audioOnly && isFullscreen) goImmersive()
    }

    override fun onStart() {
        super.onStart()
        if (videoDetached) {
            player?.setVideoTextureView(tex)
            videoDetached = false
        }
    }

    override fun onStop() {
        super.onStop()
        val p = player ?: return
        if (bgAudio && p.playWhenReady && p.playbackState != Player.STATE_ENDED) {
            /* 后台只保留声音：释放视频画面，避免锁屏后继续解码画面 */
            p.clearVideoSurface()
            videoDetached = true
        } else {
            p.pause()
        }
    }

    @Deprecated("Deprecated in Java")
    override fun onBackPressed() {
        /* 面板开着先收面板；横屏全屏再退回竖屏；最后才关播放器 */
        if (sheet != null) { closeSheetAnimated(); return }
        if (isFullscreen) { setFullscreen(false); return }
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
        ui.removeCallbacks(singleTapRunnable)
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

/* ── 画面容器：stretch=false 保持原比例居中留黑边；true 拉伸铺满 ──
 * 只决定视频画面在屏幕上的尺寸与居中方式，容器本身始终占满全屏。
 */
class AspectLayout(ctx: Context) : ViewGroup(ctx) {

    var stretch = false
        set(v) { if (field != v) { field = v; requestLayout() } }

    /** 视频宽高比（width / height），<=0 表示未知，按铺满处理 */
    var ratio = 0f
        set(v) { if (field != v) { field = v; requestLayout() } }

    /** 强制画面比例（0 = 跟随片源），如 4:3 / 16:9；画面会拉伸进该比例的框 */
    var fixedRatio = 0f
        set(v) { if (field != v) { field = v; requestLayout() } }

    private var childW = 0
    private var childH = 0

    init { setClipChildren(true) }

    override fun onMeasure(widthMeasureSpec: Int, heightMeasureSpec: Int) {
        val pw = MeasureSpec.getSize(widthMeasureSpec)
        val ph = MeasureSpec.getSize(heightMeasureSpec)
        setMeasuredDimension(pw, ph)

        val r = if (fixedRatio > 0f) fixedRatio else ratio
        if (stretch || r <= 0f || pw <= 0 || ph <= 0) {
            childW = pw; childH = ph
        } else if (pw / ph.toFloat() > r) {
            /* 屏幕比画面更宽：贴高度，左右留边 */
            childH = ph; childW = (ph * r + 0.5f).toInt()
        } else {
            /* 屏幕比画面更窄：贴宽度，上下留边 */
            childW = pw; childH = (pw / r + 0.5f).toInt()
        }

        if (childCount > 0) {
            getChildAt(0).measure(
                MeasureSpec.makeMeasureSpec(childW, MeasureSpec.EXACTLY),
                MeasureSpec.makeMeasureSpec(childH, MeasureSpec.EXACTLY)
            )
        }
    }

    override fun onLayout(changed: Boolean, l: Int, t: Int, r: Int, b: Int) {
        if (childCount == 0) return
        val cx = (width - childW) / 2
        val cy = (height - childH) / 2
        getChildAt(0).layout(cx, cy, cx + childW, cy + childH)
    }
}

