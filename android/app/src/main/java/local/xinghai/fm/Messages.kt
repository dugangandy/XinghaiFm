/* ── Messages · 面向用户的统一提示 ───────────────────────
 * 断网/连不上服务器时，不要把原生异常或后台状态码抛给用户，统一用这一句。
 */
package local.xinghai.fm

object Msg {
    const val NET_FAIL = "服务器连接失败，请检查网络。"
}
