/* ── UpdateReceiver · 覆盖安装完成后把 App 拉回来 ──────────
 * 系统替换 APK 会杀掉旧进程，装完只有一条 MY_PACKAGE_REPLACED 广播能叫醒新版本。
 * 这里两手准备：
 *   1) 先发一条「已更新，点击打开」通知（用户点击 = 前台启动，不受 Android 10+ 后台启动限制）；
 *   2) 再直接 startActivity 试着无缝回主页。MIUI 这类会拦后台启动，失败时用户还有通知可点。
 */
package local.xinghai.fm

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.os.Build

class UpdateReceiver : BroadcastReceiver() {

    companion object {
        const val CHANNEL = "update"
        const val NOTI_ID = 4211
    }

    override fun onReceive(c: Context, intent: Intent?) {
        if (intent?.action != Intent.ACTION_MY_PACKAGE_REPLACED) return
        val ver = runCatching {
            c.packageManager.getPackageInfo(c.packageName, 0).versionName
        }.getOrNull().orEmpty()
        runCatching { notifyReady(c, ver) }
        runCatching {
            c.startActivity(
                Intent(c, LoginActivity::class.java)
                    .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP)
            )
        }
    }

    private fun notifyReady(c: Context, ver: String) {
        val nm = c.getSystemService(Context.NOTIFICATION_SERVICE) as? NotificationManager ?: return
        if (Build.VERSION.SDK_INT >= 26 && nm.getNotificationChannel(CHANNEL) == null) {
            nm.createNotificationChannel(
                NotificationChannel(CHANNEL, "应用更新", NotificationManager.IMPORTANCE_LOW)
            )
        }
        val pi = PendingIntent.getActivity(
            c, 0,
            Intent(c, LoginActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )
        val builder = if (Build.VERSION.SDK_INT >= 26) {
            Notification.Builder(c, CHANNEL)
        } else {
            @Suppress("DEPRECATION") Notification.Builder(c)
        }
        val n = builder
            .setSmallIcon(R.drawable.ic_download)
            .setContentTitle("星海 FM 已更新")
            .setContentText(if (ver.isNotEmpty()) "当前版本 v" + ver + "，点击打开" else "点击打开")
            .setContentIntent(pi)
            .setAutoCancel(true)
            .build()
        runCatching { nm.notify(NOTI_ID, n) }
    }
}
