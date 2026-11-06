/* ── Servers · 服务器地址候选 ─────────────────────────────
 * 登录页和「服务器设置」页共用这一份：界面只显示名字，
 * 完整地址默认藏着（鼠标悬浮 / 长按才看得到）。
 */
package com.xinghai.fm

object Servers {
    val list = listOf(
        "生产" to "http://139.198.29.121:8889",
        "测试" to "http://139.198.29.121:8899"
    )

    /* 地址对应的名字；不是预设里的（局域网 / 隧道）就叫「自定义」 */
    fun nameOf(base: String): String = list.firstOrNull { it.second == base }?.first ?: "自定义"
}
