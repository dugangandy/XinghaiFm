/* ── DownloadQueue · 入队流程的唯一入口 ───────────────────
 * 网页（downloadTracks 桥）和原生下载页都走这里：
 * 空间检查 → 移动网络确认 → Dl.enqueue → toast。
 * 只负责“问”和“报”，下载本身、去重、续传都在 Downloads.kt 里。
 */
package local.xinghai.fm

import android.app.Activity
import android.app.AlertDialog
import android.content.Context
import android.os.StatFs
import android.widget.Toast

object DownloadQueue {

    /**
     * 把一批曲目排进下载队列。
     * @param onQueued 真正入队的条数回调（0 表示全在队列里或已下载），在 UI 线程上调用
     */
    fun enqueue(act: Activity, batch: List<Dl.Item>, onQueued: (Int) -> Unit = {}) {
        if (batch.isEmpty()) return
        val base = baseOf(act)
        if (base.isEmpty()) { toast(act, "还没有配置服务器地址"); return }
        val need = batch.sumOf { it.size }
        val free = runCatching { StatFs(act.filesDir.absolutePath).availableBytes }.getOrDefault(Long.MAX_VALUE)
        if (need > 0L && need > free) {
            toast(act, "手机空间不足：还需 " + Dl.fmtSize(need) + "，可用 " + Dl.fmtSize(free))
            return
        }
        Dl.init(act)
        if (!Dl.isMetered(act)) { push(act, batch, base, onQueued); return }
        AlertDialog.Builder(act)
            .setTitle("当前连接的是数据网络")
            .setMessage("下载 " + batch.size + " 集会消耗流量，确认下载吗？")
            .setPositiveButton("继续下载") { _, _ -> push(act, batch, base, onQueued) }
            .setNegativeButton("取消", null)
            .show()
    }

    private fun push(act: Activity, batch: List<Dl.Item>, base: String, onQueued: (Int) -> Unit) {
        val n = Dl.enqueue(base, batch)
        toast(act, if (n > 0) "已加入下载队列：" + n + " 集" else "这些内容已经在队列里或已下载")
        onQueued(n)
    }

    /* 服务器地址就存在 prefs 里，壳和下载页共用同一份 */
    private fun baseOf(c: Context): String =
        (c.getSharedPreferences("fm", Context.MODE_PRIVATE).getString("base", "") ?: "").trim().trimEnd('/')

    private fun toast(c: Context, msg: String) = Toast.makeText(c, msg, Toast.LENGTH_SHORT).show()
}
