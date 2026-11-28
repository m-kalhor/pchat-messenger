package com.pchat.app

import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.launch
import org.json.JSONArray
import org.json.JSONObject

/** 1.29: a chat folder the user made: a name and the chats in it. */
data class Folder(val id: String, val name: String, val convos: List<String>)

/** 1.29: the chat list's tabs (built-in kinds and the user's own folders). */
sealed class ChatTab(val key: String) {
    object All : ChatTab("all")
    object Private : ChatTab("dm")
    object Groups : ChatTab("groups")
    object Channels : ChatTab("chans")
    object Unread : ChatTab("unread")
    class Custom(val f: Folder) : ChatTab("f:" + f.id)
}

/**
 * 1.29: chat folders and the archive. Kept on this phone and synced to my other devices through the
 * server (/api/prefs, key "chatlist"), sealed for me with my own key like a message to myself, so the
 * server never sees folder names or which chats are in them. The newest change wins.
 */
object ChatList {
    const val MAX_FOLDERS = 10
    const val MAX_NAME = 24
    val folders = MutableStateFlow<List<Folder>>(emptyList())
    val archived = MutableStateFlow<Set<String>>(emptySet())
    /** the tab strip above the chat list is hidden */
    val hideTabs = MutableStateFlow(false)
    private var ts = 0L
    private var pushJob: Job? = null
    private val p get() = Engine.prefs

    fun load() {
        try { apply(JSONObject(p.getString("chatlist", "{}") ?: "{}")) } catch (e: Exception) { }
        ts = p.getLong("chatlist_ts", 0)
    }

    private fun apply(o: JSONObject) {
        val fs = ArrayList<Folder>()
        val fa = o.optJSONArray("folders") ?: JSONArray()
        for (i in 0 until minOf(fa.length(), MAX_FOLDERS)) {
            val f = fa.optJSONObject(i) ?: continue
            val c = f.optJSONArray("c") ?: JSONArray()
            fs.add(Folder(f.optString("id").ifEmpty { "f$i" }, f.optString("n").take(MAX_NAME), (0 until c.length()).map { c.getString(it) }.distinct()))
        }
        folders.value = fs
        val aa = o.optJSONArray("archived") ?: JSONArray()
        archived.value = (0 until aa.length()).map { aa.getString(it) }.toSet()
        hideTabs.value = o.optBoolean("hideTabs", false)
    }

    private fun json(): JSONObject = JSONObject()
        .put("v", 1)
        .put("folders", JSONArray().apply {
            for (f in folders.value) put(JSONObject().put("id", f.id).put("n", f.name).put("c", JSONArray(f.convos)))
        })
        .put("archived", JSONArray(archived.value.toList()))
        .put("hideTabs", hideTabs.value)

    /** Saves here and, a moment later, on the server for my other devices. */
    private fun changed() {
        ts = System.currentTimeMillis()
        p.edit().putString("chatlist", json().toString()).putLong("chatlist_ts", ts).apply()
        Prefs.chatTick.value++
        pushJob?.cancel()
        pushJob = Engine.scope.launch { delay(1500); push() }
    }

    private fun push() {
        if (Api.token == null) return
        try {
            val sealed = Engine.sealForMe(json().toString())
            ts = Api.prefsSet("chatlist", sealed, Engine.deviceId)
            p.edit().putLong("chatlist_ts", ts).putBoolean("chatlist_dirty", false).apply()
        } catch (e: Exception) {
            p.edit().putBoolean("chatlist_dirty", true).apply()
        }
    }

    /** After connecting, and when another of my devices changed it: takes the server's copy if it is newer. */
    fun pull() {
        try {
            if (p.getBoolean("chatlist_dirty", false)) { push(); return }
            val (v, sts) = Api.prefsGet("chatlist")
            if (v == null || sts <= ts) return
            val plain = Engine.openFromMe(v) ?: return
            apply(JSONObject(plain))
            ts = sts
            p.edit().putString("chatlist", plain).putLong("chatlist_ts", ts).apply()
            Prefs.chatTick.value++
        } catch (e: Exception) { }
    }

    fun clear() {
        folders.value = emptyList(); archived.value = emptySet(); hideTabs.value = false; ts = 0
        p.edit().remove("chatlist").remove("chatlist_ts").remove("chatlist_dirty").apply()
    }

    // ---- archive ----
    fun isArchived(convo: String) = convo in archived.value
    fun setArchived(convo: String, on: Boolean) {
        if (on == isArchived(convo)) return
        archived.value = if (on) archived.value + convo else archived.value - convo
        changed()
    }
    /** A new message in an archived chat brings it back, unless the chat is muted (like Telegram). */
    fun onIncoming(convo: String) {
        if (isArchived(convo) && !Prefs.isMuted(convo)) setArchived(convo, false)
    }

    // ---- folders ----
    fun setHideTabs(v: Boolean) { hideTabs.value = v; changed() }
    fun saveFolder(id: String?, name: String, convos: List<String>): String? {
        val n = name.trim().take(MAX_NAME)
        if (n.isEmpty()) return "یک نام برای پوشه بنویسید"
        val l = folders.value
        if (id == null && l.size >= MAX_FOLDERS) return "حداکثر $MAX_FOLDERS پوشه می‌شود ساخت"
        val f = Folder(id ?: ("f" + System.currentTimeMillis().toString(36)), n, convos.distinct())
        folders.value = if (id == null) l + f else l.map { if (it.id == id) f else it }
        changed()
        return null
    }
    fun deleteFolder(id: String) { folders.value = folders.value.filter { it.id != id }; changed() }
    fun moveFolder(id: String, by: Int) {
        val l = folders.value.toMutableList()
        val i = l.indexOfFirst { it.id == id }
        val j = i + by
        if (i < 0 || j < 0 || j >= l.size) return
        l.add(j, l.removeAt(i)); folders.value = l; changed()
    }
    fun toggleIn(folderId: String, convo: String) {
        folders.value = folders.value.map { f ->
            if (f.id != folderId) f else f.copy(convos = if (convo in f.convos) f.convos - convo else f.convos + convo)
        }
        changed()
    }

    fun tabs(): List<ChatTab> =
        listOf(ChatTab.All, ChatTab.Private, ChatTab.Groups, ChatTab.Channels, ChatTab.Unread) + folders.value.map { ChatTab.Custom(it) }

    fun tabName(t: ChatTab): String = when (t) {
        ChatTab.All -> "همه"
        ChatTab.Private -> "خصوصی"
        ChatTab.Groups -> "گروه‌ها"
        ChatTab.Channels -> "کانال‌ها"
        ChatTab.Unread -> "نخوانده"
        is ChatTab.Custom -> t.f.name
    }

    /** Whether a chat belongs in tab t (archived chats only show in «همه» through the archive row). */
    fun inTab(t: ChatTab, r: ConvoSummary): Boolean = when (t) {
        ChatTab.All -> true
        ChatTab.Private -> !Engine.isGroup(r.convo)
        ChatTab.Groups -> Engine.isGroup(r.convo) && !Engine.isChan(r.convo)
        ChatTab.Channels -> Engine.isChan(r.convo)
        ChatTab.Unread -> r.unread > 0
        is ChatTab.Custom -> r.convo in t.f.convos
    }
}
