/* ── CoversTest · 封面缓存里能脱离 Android 跑的那部分 ────────
 * 覆盖三个真出过问题的点：缓存键要带 host:port（否则切服务器串图）、
 * 票据参数不能进键（否则每次启动都换键）、mime 要按 URL 判断（缓存名带 query 尾巴）。
 * 跑法：cd android && ./gradlew :app:testDebugUnitTest
 */
package com.xinghai.fm

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class CoversTest {

    @Test
    fun `缓存键带上 host 和 port`() {
        val k = Covers.key("http://192.168.1.8:8889/api/cover/abc.jpg?libId=l1")
        assertTrue(k.contains("192.168.1.8"))
        assertTrue(k.contains("8889"))
        assertTrue(k.contains("abc.jpg"))
    }

    @Test
    fun `同一路径换端口不会共用缓存`() {
        val a = Covers.key("http://139.198.29.121:8889/api/cover/abc.jpg?libId=l1")
        val b = Covers.key("http://139.198.29.121:8899/api/cover/abc.jpg?libId=l1")
        assertNotEquals(a, b)
    }

    @Test
    fun `剔掉票据但保留库和版本参数`() {
        val k = Covers.key("http://h:8080/api/cover/abc.jpg?libId=l1&t=t.123.u_admin.cover.0.sig")
        assertFalse(k.contains("t.123"))
        assertTrue(k.contains("libId_l1"))
        val v = Covers.key("http://h:8080/api/cover/abc.jpg?libId=l1&r=1700000000")
        assertTrue(v.contains("r_1700000000"))
    }

    @Test
    fun `mime 按 URL 路径判断`() {
        assertEquals("image/png", Covers.mimeOf("http://h/api/cover/a.png?libId=l1"))
        assertEquals("image/webp", Covers.mimeOf("http://h/api/cover/a.webp"))
        assertEquals("image/jpeg", Covers.mimeOf("http://h/api/cover/a.jpg?x=1"))
        /* 没有扩展名时兜底成 jpeg */
        assertEquals("image/jpeg", Covers.mimeOf("http://h/api/cover/a"))
        /* 相对路径（不进拦截，但函数本身要保持健壮） */
        assertEquals("image/png", Covers.mimeOf("/api/cover/a.png"))
    }

    @Test
    fun `空地址和未知协议返回空键`() {
        assertEquals("", Covers.key(""))
        /* 桌面端的 fm:// 不会进这里；真进来了也只是返回空键，不产生垃圾缓存名 */
        assertEquals("", Covers.key("fm://app/__cover/a.jpg"))
    }
}
