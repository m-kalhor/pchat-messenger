package com.pchat.app

import android.app.NotificationChannel
import android.app.NotificationManager
import android.content.Context
import android.media.AudioAttributes
import android.media.RingtoneManager
import android.net.ConnectivityManager
import android.net.NetworkCapabilities
import android.os.Build
import kotlinx.coroutines.flow.MutableStateFlow
import java.io.File

/** User preferences from the Settings screen, kept in the app's SharedPreferences. */
object Prefs {
    const val THEME_SYSTEM = 0
    const val THEME_LIGHT = 1
    const val THEME_DARK = 2
    const val AUTO_ALWAYS = 0
    const val AUTO_WIFI = 1
    const val AUTO_NEVER = 2
    const val MUTE_FOREVER = Long.MAX_VALUE

    val textSizes = listOf(14, 16, 18, 20)
    val theme = MutableStateFlow(THEME_SYSTEM)
    /** message text size in sp (16 = normal) */
    val textSize = MutableStateFlow(16)
    /** bumps whenever a notification / mute setting changes, so screens can recompose */
    val notifTick = MutableStateFlow(0)

    private val p get() = Engine.prefs

    fun load() {
        theme.value = p.getInt("theme", THEME_SYSTEM)
        textSize.value = p.getInt("text_size", 16)
        wallpaper.value = p.getBoolean("wallpaper", true)
        diagText.value = p.getBoolean("diag_text", true)
    }

    fun setTheme(v: Int) { p.edit().putInt("theme", v).apply(); theme.value = v }
    fun setTextSize(v: Int) { p.edit().putInt("text_size", v).apply(); textSize.value = v }

    // ---- 1.9 ----
    /** the Bluetooth permission (Android 12+) was asked once already */
    var btAsked: Boolean
        get() = p.getBoolean("bt_asked", false)
        set(v) { p.edit().putBoolean("bt_asked", v).apply() }
    /** chat background: true = the patterned wallpaper (default), false = plain */
    val wallpaper = MutableStateFlow(true)
    fun setWallpaper(v: Boolean) { p.edit().putBoolean("wallpaper", v).apply(); wallpaper.value = v }
    /** the admins' ping / route text over the call (1.7 diagnostics) is shown */
    val diagText = MutableStateFlow(true)
    fun setDiagText(v: Boolean) { p.edit().putBoolean("diag_text", v).apply(); diagText.value = v }
    /** the update to this versionCode was dismissed with «بعداً» in this run of the app */
    var updateDismissed = 0

    // ---- notifications ----
    var notifyPrivate: Boolean
        get() = p.getBoolean("notif_dm", true)
        set(v) { p.edit().putBoolean("notif_dm", v).apply(); notifTick.value++ }
    var notifyGroups: Boolean
        get() = p.getBoolean("notif_group", true)
        set(v) { p.edit().putBoolean("notif_group", v).apply(); notifTick.value++ }
    var sound: Boolean
        get() = p.getBoolean("notif_sound", true)
        set(v) { p.edit().putBoolean("notif_sound", v).apply(); notifTick.value++ }
    var vibrate: Boolean
        get() = p.getBoolean("notif_vibrate", true)
        set(v) { p.edit().putBoolean("notif_vibrate", v).apply(); notifTick.value++ }

    /** Muted until this time (ms); 0 = not muted. */
    fun mutedUntil(convo: String): Long = p.getLong("mute_$convo", 0L)
    fun isMuted(convo: String): Boolean = mutedUntil(convo) > System.currentTimeMillis()
    fun mute(convo: String, forMs: Long?) {
        val until = if (forMs == null) MUTE_FOREVER else System.currentTimeMillis() + forMs
        p.edit().putLong("mute_$convo", until).apply(); notifTick.value++
    }
    fun unmute(convo: String) { p.edit().remove("mute_$convo").apply(); notifTick.value++ }

    fun shouldNotify(convo: String, group: Boolean): Boolean =
        (if (group) notifyGroups else notifyPrivate) && !isMuted(convo)

    /**
     * Channel matching the sound / vibration switches. Android fixes a channel's sound once it is created,
     * so each combination has its own channel; the default one (sound + vibration) is the original "msgs".
     */
    fun messageChannel(ctx: Context): String {
        val id = when {
            sound && vibrate -> Engine.CH_MSG
            sound -> "msgs_sound"
            vibrate -> "msgs_vibrate"
            else -> "msgs_quiet"
        }
        if (Build.VERSION.SDK_INT >= 26 && id != Engine.CH_MSG) {
            val nm = ctx.getSystemService(NotificationManager::class.java)
            if (nm.getNotificationChannel(id) == null) {
                val ch = NotificationChannel(id, "پیام‌ها" + when (id) { "msgs_sound" -> " (بدون لرزش)"; "msgs_vibrate" -> " (بی‌صدا)"; else -> " (بی‌صدا و بدون لرزش)" },
                    NotificationManager.IMPORTANCE_HIGH)
                if (sound) ch.setSound(RingtoneManager.getDefaultUri(RingtoneManager.TYPE_NOTIFICATION),
                    AudioAttributes.Builder().setUsage(AudioAttributes.USAGE_NOTIFICATION).build())
                else ch.setSound(null, null)
                ch.enableVibration(vibrate)
                if (!vibrate) ch.vibrationPattern = longArrayOf(0)
                nm.createNotificationChannel(ch)
            }
        }
        return id
    }

    // ---- data and storage ----
    var autoDownload: Int
        get() = p.getInt("auto_dl", AUTO_ALWAYS)
        set(v) { p.edit().putInt("auto_dl", v).apply(); notifTick.value++ }

    fun autoDownloadAllowed(ctx: Context): Boolean = when (autoDownload) {
        AUTO_NEVER -> false
        AUTO_WIFI -> {
            val cm = ctx.getSystemService(ConnectivityManager::class.java)
            val caps = cm.getNetworkCapabilities(cm.activeNetwork)
            caps != null && (caps.hasTransport(NetworkCapabilities.TRANSPORT_WIFI) || caps.hasTransport(NetworkCapabilities.TRANSPORT_ETHERNET))
        }
        else -> true
    }

    // ---- chat list: pinned chats and drafts (belong to the account, cleared on logout) ----
    const val MAX_PINNED = 5
    /** bumps when pins or drafts change */
    val chatTick = MutableStateFlow(0)

    fun pinnedChats(): List<String> = (p.getString("pinned_chats", "") ?: "").split('\n').filter { it.isNotEmpty() }

    /** Pins / unpins a chat at the top of the list. Returns false when 5 are pinned already. */
    fun togglePinned(convo: String): Boolean {
        val l = pinnedChats()
        val n = when {
            convo in l -> l - convo
            l.size >= MAX_PINNED -> return false
            else -> l + convo
        }
        p.edit().putString("pinned_chats", n.joinToString("\n")).apply()
        chatTick.value++
        return true
    }

    fun draft(convo: String): String = p.getString("draft_$convo", "") ?: ""
    fun setDraft(convo: String, text: String) {
        if (draft(convo) == text || (text.isBlank() && draft(convo).isEmpty())) return
        p.edit().apply { if (text.isBlank()) remove("draft_$convo") else putString("draft_$convo", text) }.apply()
        chatTick.value++
    }

    fun clearChatPrefs() {
        val e = p.edit()
        p.all.keys.filter { it.startsWith("draft_") }.forEach { e.remove(it) }
        e.remove("pinned_chats").apply()
        chatTick.value++
    }

    fun dirSize(f: File): Long = if (f.isDirectory) (f.listFiles()?.sumOf { dirSize(it) } ?: 0L) else f.length()
}
