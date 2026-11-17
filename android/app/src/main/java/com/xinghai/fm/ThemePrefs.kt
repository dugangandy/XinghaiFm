package com.xinghai.fm

import android.app.Activity
import android.content.Context
import android.content.res.Configuration
import android.graphics.Color
import android.os.Build
import android.view.View
import android.view.Window

object ThemePrefs {
    const val KEY_MODE = "appearance"
    const val SYSTEM = "system"
    const val LIGHT = "light"
    const val DARK = "dark"

    fun mode(context: Context): String {
        val value = context.getSharedPreferences("fm", Context.MODE_PRIVATE)
            .getString(KEY_MODE, DARK)
        return when (value) {
            SYSTEM, LIGHT, DARK -> value
            else -> DARK
        }
    }

    fun save(context: Context, value: String) {
        val next = when (value) {
            SYSTEM, LIGHT, DARK -> value
            else -> DARK
        }
        context.getSharedPreferences("fm", Context.MODE_PRIVATE)
            .edit().putString(KEY_MODE, next).apply()
    }

    fun isDark(context: Context): Boolean = when (mode(context)) {
        LIGHT -> false
        SYSTEM -> (context.resources.configuration.uiMode and Configuration.UI_MODE_NIGHT_MASK) == Configuration.UI_MODE_NIGHT_YES
        else -> true
    }

    fun label(value: String): String = when (value) {
        SYSTEM -> "跟随系统"
        LIGHT -> "浅色"
        else -> "深色"
    }

    fun apply(activity: Activity, root: View? = null) {
        val dark = isDark(activity)
        val bg = if (dark) Color.rgb(5, 7, 14) else Color.rgb(248, 250, 252)
        activity.window.statusBarColor = bg
        activity.window.navigationBarColor = bg
        if (Build.VERSION.SDK_INT >= 23) {
            var flags = activity.window.decorView.systemUiVisibility
            flags = if (dark) flags and View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR.inv()
            else flags or View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR
            if (Build.VERSION.SDK_INT >= 26) {
                flags = if (dark) flags and View.SYSTEM_UI_FLAG_LIGHT_NAVIGATION_BAR.inv()
                else flags or View.SYSTEM_UI_FLAG_LIGHT_NAVIGATION_BAR
            }
            activity.window.decorView.systemUiVisibility = flags
        }
        root?.setBackgroundColor(bg)
    }

    fun background(context: Context): Int = if (isDark(context)) Color.rgb(5, 7, 14) else Color.rgb(248, 250, 252)
    fun primary(context: Context): Int = if (isDark(context)) Color.WHITE else Color.rgb(25, 32, 45)
    fun secondary(context: Context): Int = if (isDark(context)) Color.rgb(122, 134, 158) else Color.rgb(86, 98, 116)
    fun hint(context: Context): Int = if (isDark(context)) Color.rgb(89, 99, 122) else Color.rgb(126, 138, 156)
}
