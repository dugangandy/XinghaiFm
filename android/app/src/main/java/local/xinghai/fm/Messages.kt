/* ── Messages · 面向用户的统一提示 ───────────────────────
 * 断网/连不上服务器时，不要把原生异常或后台状态码抛给用户，统一用这一句。
 */
package local.xinghai.fm

object Msg {
    const val NET_FAIL = "服务器连接失败，请检查网络。"
    /* 通知被关掉时后台播放没有可控入口，退出时直接停播并告诉用户原因 */
    const val NO_NOTI_STOPPED = "通知权限被关闭，已停止播放"
}
