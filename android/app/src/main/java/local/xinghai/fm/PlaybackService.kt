/* ── PlaybackService · 后台播放与锁屏控制 ──────────────
 * 音频仍在 WebView 里放，这里只做三件事：
 *   1) 前台服务让进程在后台活下去
 *   2) MediaSession 把播放状态交给系统（锁屏 / 耳机键 / 蓝牙）
 *   3) 收到控制指令就 evaluateJavascript 交给网页里的播放器
 */
package local.xinghai.fm

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.pm.ServiceInfo
import android.media.AudioManager
import android.media.MediaMetadata
import android.media.session.MediaSession
import android.media.session.PlaybackState
import android.os.Build
import android.os.IBinder
import android.os.PowerManager
import android.os.SystemClock
import android.os.Handler
import android.os.Looper
import android.webkit.CookieManager
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Canvas
import java.net.HttpURLConnection
import java.net.URL

class PlaybackService : Service() {

    companion object {
        private const val CHANNEL = "fm-playback"
        private const val NOTI_ID = 4101
        private const val EXTRA_CMD = "cmd"
        private const val TARGET_ART = 384   // 锁屏封面边长上限，控制位图大小避免 binder 1MB 上限

        @Volatile
        var current: PlaybackService? = null
            private set

        fun start(ctx: Context) {
            val i = Intent(ctx, PlaybackService::class.java)
            if (Build.VERSION.SDK_INT >= 26) ctx.startForegroundService(i) else ctx.startService(i)
        }

        fun stop(ctx: Context) {
            ctx.stopService(Intent(ctx, PlaybackService::class.java))
        }

        /* 界面已经拆掉时，通知栏按下的指令没处可发：先存这儿，
           等界面被拉起来、网页就绪（MainActivity.Bridge.ready）再补执行 */
        @Volatile
        private var pendingCmd: String? = null
        private var pendingAt = 0L

        private fun putPending(cmd: String) {
            pendingCmd = cmd
            pendingAt = SystemClock.elapsedRealtime()
        }

        /* 取一次就清空；超过 60 秒还没被消费（界面没起来）就作废，
           免得下次正常打开时莫名其妙自己开始播 */
        fun takePending(): String? {
            val c = pendingCmd ?: return null
            pendingCmd = null
            return if (SystemClock.elapsedRealtime() - pendingAt < 60000) c else null
        }
    }

    private var session: MediaSession? = null
    private var wake: PowerManager.WakeLock? = null
    private var registered = false

    private var playing = false
    private var title = ""
    private var sub = ""
    private var coverUrl = ""
    private var artBitmap: Bitmap? = null
    private var logoArt: Bitmap? = null
    private var metaKey = ""
    private val mainHandler = Handler(Looper.getMainLooper())
    private var hasPrev = false
    private var hasNext = false
    private var position = 0L
    private var duration = 0L

    val isPlaying: Boolean get() = playing

    private val noisy = object : BroadcastReceiver() {
        override fun onReceive(ctx: Context?, intent: Intent?) {
            if (intent?.action == AudioManager.ACTION_AUDIO_BECOMING_NOISY && playing) {
                act("pause")
            }
        }
    }

    override fun onCreate() {
        super.onCreate()
        current = this
        createChannel()

        session = MediaSession(this, "xinghaifm").apply {
            setFlags(MediaSession.FLAG_HANDLES_MEDIA_BUTTONS or MediaSession.FLAG_HANDLES_TRANSPORT_CONTROLS)
            setCallback(object : MediaSession.Callback() {
                override fun onPlay() = act("play")
                override fun onPause() = act("pause")
                override fun onStop() = act("pause")
                override fun onSkipToNext() = act("next")
                override fun onSkipToPrevious() = act("prev")
            })
            isActive = true
        }

        val filter = IntentFilter(AudioManager.ACTION_AUDIO_BECOMING_NOISY)
        if (Build.VERSION.SDK_INT >= 33) {
            registerReceiver(noisy, filter, Context.RECEIVER_NOT_EXPORTED)
        } else {
            registerReceiver(noisy, filter)
        }
        registered = true

        startForegroundCompat()
        refresh()
        /* 服务是异步建起来的：网页第一次 setPlaying 时 current 还是 null，那条「正在播放」会丢掉，
           通知栏就会停在「播放」按钮、也不是常驻的。建好后让网页把当前状态重推一遍。 */
        MainActivity.current?.js("window.FM && FM.android && FM.android.syncMedia && FM.android.syncMedia(true)")
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        intent?.getStringExtra(EXTRA_CMD)?.let { act(it) }
        return START_STICKY
    }

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onDestroy() {
        current = null
        if (registered) runCatching { unregisterReceiver(noisy) }
        releaseWake()
        session?.isActive = false
        session?.release()
        session = null
        if (Build.VERSION.SDK_INT >= 24) stopForeground(STOP_FOREGROUND_REMOVE)
        super.onDestroy()
    }

    /* ── 网页回传的状态 ── */
    fun updatePlaying(on: Boolean) {
        if (playing == on) {
            refresh()
            return
        }
        playing = on
        if (on) acquireWake() else releaseWake()
        refresh()
    }

    fun updateTrack(t: String, s: String, cover: String) {
        title = t
        sub = s
        if (cover != coverUrl) {
            coverUrl = cover
            loadArtwork(cover)
        }
        refresh()
    }

    fun updateNav(prev: Boolean, next: Boolean) {
        hasPrev = prev
        hasNext = next
        refresh()
    }

    /* ── 网页回传的播放进度（毫秒）── */
    fun updateProgress(posMs: Long, durMs: Long) {
        position = posMs
        duration = durMs
        refresh(notify = false)
    }

    /* ── 把指令送回网页里的播放器 ── */
    private fun act(cmd: String) {
        /* 用户把通知栏这条划掉了（暂停态才可划）：服务跟着收掉，别留个没有入口的前台服务。
           个别机型播放中也能划掉，那种先把声音停掉，否则又会变成「有声音没入口」 */
        if (cmd == "dismiss") {
            if (playing) MainActivity.current?.js("FM.android.mediaAction('pause')")
            stopSelf()
            return
        }
        val js = when (cmd) {
            "toggle" -> if (playing) "FM.android.mediaAction('pause')" else "FM.android.mediaAction('play')"
            "play", "pause", "next", "prev" -> "FM.android.mediaAction('$cmd')"
            else -> return
        }
        val host = MainActivity.current
        if (host != null) {
            host.js(js)
            return
        }
        /* App 已经退出，只剩通知栏：把界面拉起来，指令等网页就绪后补发 */
        putPending(cmd)
        runCatching {
            startActivity(Intent(this, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
        }
    }

    /* 从最近任务里划掉 = 真退出：连通知栏一起收掉。
       （返回键退出不会走这里，那条路要保留通知栏，见 MainActivity.onDestroy） */
    override fun onTaskRemoved(rootIntent: Intent?) {
        pendingCmd = null
        stopSelf()
        super.onTaskRemoved(rootIntent)
    }

    /* ── 锁屏封面：有封面用专辑图、无封面用 App logo ──
     * 网页传进来的是封面 URL（服务器模式下多半是站内相对路径 + 会话 cookie）。
     * 原生下载拿不到 WebView 的同源身份，所以这里要自己补绝对地址、带上 WebView 的 cookie；
     * 拉取失败或没有封面就回退到应用图标。 */
    private fun loadArtwork(url: String) {
        if (url.isEmpty()) { artBitmap = null; return }
        val full = absoluteCoverUrl(url)
        if (full.isEmpty()) { artBitmap = null; return }
        /* cookie 得在主线程取（CookieManager 要走 WebView 的线程） */
        val cookie = runCatching { CookieManager.getInstance().getCookie(full) }.getOrNull().orEmpty()
        Thread {
            val bmp = runCatching { downloadBitmap(full, cookie) }.getOrNull()
            /* 回到主线程应用；期间可能已切了别的封面，只应用仍是最新的那次 */
            mainHandler.post {
                if (url == coverUrl) {
                    artBitmap = bmp
                    refresh()
                }
            }
        }.apply { isDaemon = true }.start()
    }

    /* 网页给的是站内路径（/api/cover/…）时补上当前连的服务端。
       界面已经拆掉的话拿不到 base，这时只能放弃（回退应用图标） */
    private fun absoluteCoverUrl(url: String): String {
        if (url.startsWith("http://") || url.startsWith("https://")) return url
        val base = MainActivity.current?.serverBase().orEmpty()
        if (base.isEmpty()) return ""
        return base + if (url.startsWith("/")) url else "/" + url
    }

    private fun downloadBitmap(url: String, cookie: String): Bitmap? {
        val conn = (URL(url).openConnection() as? HttpURLConnection) ?: return null
        conn.connectTimeout = 5000
        conn.readTimeout = 8000
        conn.instanceFollowRedirects = true
        conn.setRequestProperty("User-Agent", "XinghaiFM")
        if (cookie.isNotEmpty()) conn.setRequestProperty("Cookie", cookie)
        try {
            val bytes = conn.inputStream.use { it.readBytes() }
            val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
            BitmapFactory.decodeByteArray(bytes, 0, bytes.size, bounds)
            if (bounds.outWidth <= 0 || bounds.outHeight <= 0) return null
            var sample = 1
            while (maxOf(bounds.outWidth, bounds.outHeight) / (sample * 2) > TARGET_ART) sample *= 2
            val opts = BitmapFactory.Options().apply {
                inSampleSize = sample
                inPreferredConfig = Bitmap.Config.ARGB_8888
            }
            val bmp = BitmapFactory.decodeByteArray(bytes, 0, bytes.size, opts) ?: return null
            val maxDim = maxOf(bmp.width, bmp.height)
            if (maxDim > TARGET_ART) {
                val sc = TARGET_ART.toFloat() / maxDim
                return Bitmap.createScaledBitmap(
                    bmp,
                    (bmp.width * sc).toInt().coerceAtLeast(1),
                    (bmp.height * sc).toInt().coerceAtLeast(1),
                    true
                )
            }
            return bmp
        } finally {
            conn.disconnect()
        }
    }

    private fun logoBitmap(): Bitmap? {
        logoArt?.let { return it }
        val d = getDrawable(R.drawable.icon) ?: return null
        val bmp = Bitmap.createBitmap(TARGET_ART, TARGET_ART, Bitmap.Config.ARGB_8888)
        val canvas = Canvas(bmp)
        val iw = if (d.intrinsicWidth > 0) d.intrinsicWidth else TARGET_ART
        val ih = if (d.intrinsicHeight > 0) d.intrinsicHeight else TARGET_ART
        val scale = minOf(TARGET_ART.toFloat() / iw, TARGET_ART.toFloat() / ih)
        val w = (iw * scale).toInt()
        val h = (ih * scale).toInt()
        val left = (TARGET_ART - w) / 2
        val top = (TARGET_ART - h) / 2
        d.setBounds(left, top, left + w, top + h)
        d.draw(canvas)
        logoArt = bmp
        return bmp
    }

    /* ── 通知 ── */
    private fun createChannel() {
        if (Build.VERSION.SDK_INT < 26) return
        val mgr = getSystemService(NotificationManager::class.java) ?: return
        if (mgr.getNotificationChannel(CHANNEL) != null) return
        val ch = NotificationChannel(CHANNEL, "播放控制", NotificationManager.IMPORTANCE_LOW).apply {
            description = "锁屏与通知栏的播放控制"
            setShowBadge(false)
            lockscreenVisibility = Notification.VISIBILITY_PUBLIC
        }
        mgr.createNotificationChannel(ch)
    }

    private fun startForegroundCompat() {
        val n = build()
        if (Build.VERSION.SDK_INT >= 34) {
            startForeground(NOTI_ID, n, ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PLAYBACK)
        } else {
            startForeground(NOTI_ID, n)
        }
    }

    private fun refresh(notify: Boolean = true) {
        val s = session ?: return
        val art = artBitmap ?: logoBitmap()
        /* 元数据含大位图，只在曲目/封面变化时重发；播放进度刷新不动它，避免频繁走 binder */
        val key = title + "\u0000" + sub + "\u0000" + duration + "\u0000" + System.identityHashCode(art)
        if (key != metaKey) {
            metaKey = key
            val md = MediaMetadata.Builder()
                .putString(MediaMetadata.METADATA_KEY_TITLE, title.ifEmpty { "星海 FM" })
                .putString(MediaMetadata.METADATA_KEY_ARTIST, sub)
                .putString(MediaMetadata.METADATA_KEY_ALBUM, "星海 FM")
                .putLong(MediaMetadata.METADATA_KEY_DURATION, if (duration > 0) duration else 0L)
            if (art != null) {
                md.putBitmap(MediaMetadata.METADATA_KEY_ALBUM_ART, art)
                md.putBitmap(MediaMetadata.METADATA_KEY_ART, art)
            }
            s.setMetadata(md.build())
        }
        val state = if (playing) PlaybackState.STATE_PLAYING else PlaybackState.STATE_PAUSED
        val speed = if (playing) 1f else 0f
        s.setPlaybackState(
            PlaybackState.Builder()
                .setActions(
                    PlaybackState.ACTION_PLAY or PlaybackState.ACTION_PAUSE or
                        PlaybackState.ACTION_PLAY_PAUSE or PlaybackState.ACTION_STOP or
                        (if (hasNext) PlaybackState.ACTION_SKIP_TO_NEXT else 0L) or
                        (if (hasPrev) PlaybackState.ACTION_SKIP_TO_PREVIOUS else 0L)
                )
                .setState(state, position, speed, SystemClock.elapsedRealtime())
                .build()
        )
        if (notify) runCatching {
            getSystemService(NotificationManager::class.java)?.notify(NOTI_ID, build())
        }
    }

    private fun build(): Notification {
        val open = PendingIntent.getActivity(
            this, 0, Intent(this, MainActivity::class.java),
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT
        )
        val style = Notification.MediaStyle().setMediaSession(session?.sessionToken).setShowActionsInCompactView(0, 1, 2)
        val builder = if (Build.VERSION.SDK_INT >= 26) Notification.Builder(this, CHANNEL) else Notification.Builder(this)
        return builder
            .setSmallIcon(android.R.drawable.ic_media_play)
            .setLargeIcon(artBitmap ?: logoBitmap())
            .setContentTitle(title.ifEmpty { "星海 FM" })
            .setContentText(sub.ifEmpty { "点击回到播放界面" })
            .setContentIntent(open)
            .setOngoing(playing)
            /* 暂停态可以被划掉：划掉就等于「不要这个播放器了」，服务一起收 */
            .setDeleteIntent(cmd("dismiss", 4))
            .setShowWhen(false)
            .setVisibility(Notification.VISIBILITY_PUBLIC)
            .addAction(android.R.drawable.ic_media_previous, "上一集", cmd("prev", 1))
            .addAction(
                if (playing) android.R.drawable.ic_media_pause else android.R.drawable.ic_media_play,
                if (playing) "暂停" else "播放",
                cmd("toggle", 2)
            )
            .addAction(android.R.drawable.ic_media_next, "下一集", cmd("next", 3))
            .setStyle(style)
            .build()
    }

    private fun cmd(c: String, code: Int): PendingIntent = PendingIntent.getService(
        this, code,
        Intent(this, PlaybackService::class.java).putExtra(EXTRA_CMD, c),
        PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT
    )

    /* ── 唤醒锁 ──
     * 音频焦点交给 WebView（Chromium 自己会申请）：这里再申请一次 AUDIOFOCUS_GAIN，
     * 系统会把 LOSS 发给同一个 App 里的媒体播放器，表现就是「刚出声就被自动暂停」。 */
    private fun acquireWake() {
        if (wake?.isHeld == true) return
        wake = (getSystemService(PowerManager::class.java)?.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "xinghaifm:playback"))
        runCatching { wake?.acquire() }
    }

    private fun releaseWake() {
        runCatching { if (wake?.isHeld == true) wake?.release() }
        wake = null
    }
}
