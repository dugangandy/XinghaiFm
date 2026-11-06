package com.xinghai.fm

import android.app.Activity
import android.os.Bundle

/**
 * 通知栏 / 系统媒体控件点击的跳板。
 *
 * 没有任何界面：进来决定回到视频播放页还是网页主页，立刻退出。
 *
 * 为什么不直接让 PlaybackService 去 startActivity：
 * Android 10+ 限制后台启动 Activity，从 Service 里起的界面可能被系统静默拒绝
 * （表现就是「点了通知没反应」），而从通知 PendingIntent 拉起来的 Activity
 * 本身处在允许启动的窗口里，由它转发不会受限。
 */
class OpenActivity : Activity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        runCatching { PlaybackService.openUi(this) }
        finish()
    }
}
