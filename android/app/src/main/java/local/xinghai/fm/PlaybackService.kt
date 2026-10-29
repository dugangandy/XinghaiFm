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

class PlaybackService : Service() {

    companion object {
        private const val CHANNEL = "fm-playback"
        private const val NOTI_ID = 4101
        private const val EXTRA_CMD = "cmd"

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
    }

    private var session: MediaSession? = null
    private var wake: PowerManager.WakeLock? = null
    private var registered = false

    private var playing = false
    private var title = ""
    private var sub = ""
    private var hasPrev = false
    private var hasNext = false

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

    fun updateTrack(t: String, s: String) {
        title = t
        sub = s
        refresh()
    }

    fun updateNav(prev: Boolean, next: Boolean) {
        hasPrev = prev
        hasNext = next
        refresh()
    }

    /* ── 把指令送回网页里的播放器 ── */
    private fun act(cmd: String) {
        val js = when (cmd) {
            "toggle" -> if (playing) "FM.android.mediaAction('pause')" else "FM.android.mediaAction('play')"
            "play", "pause", "next", "prev" -> "FM.android.mediaAction('$cmd')"
            else -> return
        }
        MainActivity.current?.js(js)
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

    private fun refresh() {
        val s = session ?: return
        s.setMetadata(
            MediaMetadata.Builder()
                .putString(MediaMetadata.METADATA_KEY_TITLE, title.ifEmpty { "星海 FM" })
                .putString(MediaMetadata.METADATA_KEY_ARTIST, sub)
                .putString(MediaMetadata.METADATA_KEY_ALBUM, "星海 FM")
                .build()
        )
        s.setPlaybackState(
            PlaybackState.Builder()
                .setActions(
                    PlaybackState.ACTION_PLAY or PlaybackState.ACTION_PAUSE or
                        PlaybackState.ACTION_PLAY_PAUSE or PlaybackState.ACTION_STOP or
                        (if (hasNext) PlaybackState.ACTION_SKIP_TO_NEXT else 0L) or
                        (if (hasPrev) PlaybackState.ACTION_SKIP_TO_PREVIOUS else 0L)
                )
                .setState(if (playing) PlaybackState.STATE_PLAYING else PlaybackState.STATE_PAUSED, PlaybackState.PLAYBACK_POSITION_UNKNOWN, if (playing) 1f else 0f)
                .build()
        )
        runCatching {
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
            .setContentTitle(title.ifEmpty { "星海 FM" })
            .setContentText(sub.ifEmpty { "点击回到播放界面" })
            .setContentIntent(open)
            .setOngoing(playing)
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
