package com.pchat.app

import android.content.ContentValues
import android.content.Context
import android.database.Cursor
import android.database.sqlite.SQLiteDatabase
import android.database.sqlite.SQLiteOpenHelper

data class Msg(
    val id: Long, val convo: String, val sender: String, val mine: Boolean, val ts: Long,
    val type: String, val text: String, val fileId: String?, val fileName: String?, val mime: String?,
    val size: Long, val fkey: String?, val w: Int, val h: Int,
    val replyId: Long, val replyUser: String?, val replyText: String?,
    val localPath: String?, val read: Boolean,
    /** 0 = delivered to server, 1 = queued / sending, 2 = failed permanently */
    val status: Int = 0, val uploadId: String? = null,
    /** when the sender last edited it (0 = never) */
    val edited: Long = 0,
    /** forwarded: the original sender's username and display name */
    val fwFrom: String? = null, val fwName: String? = null,
    /** voice message: length in ms and 50 waveform bars of 0..31 */
    val dur: Long = 0, val wave: List<Int> = emptyList(),
    /** shared location (type "location") */
    val loc: Loc? = null,
    /** emoji reactions: username -> emoji */
    val reactions: Map<String, String> = emptyMap()
)

data class Loc(val lat: Double, val lon: Double, val acc: Int)

private fun locStr(l: Loc?) = l?.let { "${it.lat},${it.lon},${it.acc}" }
private fun parseLoc(s: String?): Loc? = s?.split(',')?.takeIf { it.size == 3 }?.let {
    val lat = it[0].toDoubleOrNull(); val lon = it[1].toDoubleOrNull()
    if (lat == null || lon == null) null else Loc(lat, lon, it[2].toIntOrNull() ?: 0)
}
private fun waveStr(w: List<Int>) = if (w.isEmpty()) null else w.joinToString(",")
private fun parseWave(s: String?): List<Int> = s?.split(',')?.mapNotNull { it.toIntOrNull() } ?: emptyList()
fun reactionsStr(r: Map<String, String>): String? =
    if (r.isEmpty()) null else org.json.JSONObject().apply { r.forEach { (u, e) -> put(u, e) } }.toString()
fun parseReactions(s: String?): Map<String, String> = try {
    if (s.isNullOrEmpty()) emptyMap() else org.json.JSONObject(s).let { o -> o.keys().asSequence().associateWith { o.getString(it) } }
} catch (e: Exception) { emptyMap() }

data class ConvoSummary(val convo: String, val last: Msg?, val unread: Int)

private const val COLS = "id,convo,sender,mine,ts,type,text,file_id,file_name,mime,size,fkey,w,h,reply_id,reply_user,reply_text,local_path,read,status,upload_id,edited,fw_from,fw_name,dur,wave,loc,reactions"

private fun Cursor.toMsg() = Msg(
    id = getLong(0), convo = getString(1), sender = getString(2), mine = getInt(3) == 1, ts = getLong(4),
    type = getString(5), text = getString(6) ?: "", fileId = getString(7), fileName = getString(8), mime = getString(9),
    size = getLong(10), fkey = getString(11), w = getInt(12), h = getInt(13),
    replyId = getLong(14), replyUser = getString(15), replyText = getString(16),
    localPath = getString(17), read = getInt(18) == 1,
    status = getInt(19), uploadId = getString(20),
    edited = getLong(21), fwFrom = getString(22), fwName = getString(23),
    dur = getLong(24), wave = parseWave(getString(25)), loc = parseLoc(getString(26)), reactions = parseReactions(getString(27))
)

class Db(ctx: Context) : SQLiteOpenHelper(ctx, "pchat.db", null, 4) {
    override fun onCreate(db: SQLiteDatabase) {
        db.execSQL(
            "CREATE TABLE messages(id INTEGER PRIMARY KEY, convo TEXT NOT NULL, sender TEXT NOT NULL, " +
                "mine INTEGER NOT NULL, ts INTEGER NOT NULL, type TEXT NOT NULL, text TEXT, file_id TEXT, " +
                "file_name TEXT, mime TEXT, size INTEGER, fkey TEXT, w INTEGER, h INTEGER, reply_id INTEGER, " +
                "reply_user TEXT, reply_text TEXT, local_path TEXT, read INTEGER NOT NULL DEFAULT 0, " +
                "status INTEGER NOT NULL DEFAULT 0, upload_id TEXT, edited INTEGER NOT NULL DEFAULT 0, fw_from TEXT, fw_name TEXT, " +
                "dur INTEGER NOT NULL DEFAULT 0, wave TEXT, loc TEXT, reactions TEXT)"
        )
        db.execSQL("CREATE INDEX idx_convo ON messages(convo, id)")
        db.execSQL("CREATE TABLE contacts(username TEXT PRIMARY KEY, pubkey TEXT, key_changed INTEGER NOT NULL DEFAULT 0)")
    }

    override fun onUpgrade(db: SQLiteDatabase, oldVersion: Int, newVersion: Int) {
        if (oldVersion < 2) {
            db.execSQL("ALTER TABLE messages ADD COLUMN status INTEGER NOT NULL DEFAULT 0")
            db.execSQL("ALTER TABLE messages ADD COLUMN upload_id TEXT")
        }
        if (oldVersion < 3) {
            db.execSQL("ALTER TABLE messages ADD COLUMN edited INTEGER NOT NULL DEFAULT 0")
            db.execSQL("ALTER TABLE messages ADD COLUMN fw_from TEXT")
            db.execSQL("ALTER TABLE messages ADD COLUMN fw_name TEXT")
        }
        if (oldVersion < 4) {
            db.execSQL("ALTER TABLE messages ADD COLUMN dur INTEGER NOT NULL DEFAULT 0")
            db.execSQL("ALTER TABLE messages ADD COLUMN wave TEXT")
            db.execSQL("ALTER TABLE messages ADD COLUMN loc TEXT")
            db.execSQL("ALTER TABLE messages ADD COLUMN reactions TEXT")
        }
    }

    /** Returns true if the message was new. */
    fun insert(m: Msg): Boolean {
        val v = ContentValues().apply {
            put("id", m.id); put("convo", m.convo); put("sender", m.sender); put("mine", if (m.mine) 1 else 0)
            put("ts", m.ts); put("type", m.type); put("text", m.text); put("file_id", m.fileId)
            put("file_name", m.fileName); put("mime", m.mime); put("size", m.size); put("fkey", m.fkey)
            put("w", m.w); put("h", m.h); put("reply_id", m.replyId); put("reply_user", m.replyUser)
            put("reply_text", m.replyText); put("local_path", m.localPath); put("read", if (m.read) 1 else 0)
            put("status", m.status); put("upload_id", m.uploadId)
            put("edited", m.edited); put("fw_from", m.fwFrom); put("fw_name", m.fwName)
            put("dur", m.dur); put("wave", waveStr(m.wave)); put("loc", locStr(m.loc)); put("reactions", reactionsStr(m.reactions))
        }
        return writableDatabase.insertWithOnConflict("messages", null, v, SQLiteDatabase.CONFLICT_IGNORE) != -1L
    }

    fun messages(convo: String, limit: Int = 400): List<Msg> {
        val out = ArrayList<Msg>()
        readableDatabase.rawQuery(
            "SELECT $COLS FROM messages WHERE convo=? ORDER BY ts DESC, id DESC LIMIT $limit", arrayOf(convo)
        ).use { c -> while (c.moveToNext()) out.add(c.toMsg()) }
        out.reverse()
        return out
    }

    fun summary(convo: String): ConvoSummary {
        var last: Msg? = null
        readableDatabase.rawQuery(
            "SELECT $COLS FROM messages WHERE convo=? ORDER BY ts DESC, id DESC LIMIT 1", arrayOf(convo)
        ).use { c -> if (c.moveToFirst()) last = c.toMsg() }
        var unread = 0
        readableDatabase.rawQuery(
            "SELECT COUNT(*) FROM messages WHERE convo=? AND read=0 AND mine=0", arrayOf(convo)
        ).use { c -> if (c.moveToFirst()) unread = c.getInt(0) }
        return ConvoSummary(convo, last, unread)
    }

    fun markRead(convo: String) {
        writableDatabase.execSQL("UPDATE messages SET read=1 WHERE convo=? AND read=0", arrayOf<Any>(convo))
    }

    /** Marks incoming messages up to [upTo] as read (read on another device of mine). Returns true if any changed. */
    fun markReadUpTo(convo: String, upTo: Long): Boolean {
        val st = writableDatabase.compileStatement("UPDATE messages SET read=1 WHERE convo=? AND read=0 AND id>0 AND id<=?")
        st.bindString(1, convo); st.bindLong(2, upTo)
        return st.executeUpdateDelete() > 0
    }

    /** Newest incoming message id of a conversation (only read ones with [readOnly]); 0 if none. */
    fun lastIncoming(convo: String, readOnly: Boolean = false): Long {
        var r = 0L
        readableDatabase.rawQuery(
            "SELECT MAX(id) FROM messages WHERE convo=? AND mine=0 AND id>0" + if (readOnly) " AND read=1" else "", arrayOf(convo)
        ).use { c -> if (c.moveToFirst() && !c.isNull(0)) r = c.getLong(0) }
        return r
    }

    fun setReactions(id: Long, r: Map<String, String>) {
        writableDatabase.execSQL("UPDATE messages SET reactions=? WHERE id=?", arrayOf<Any?>(reactionsStr(r), id))
    }

    fun setLocalPath(id: Long, path: String) {
        writableDatabase.execSQL("UPDATE messages SET local_path=? WHERE id=?", arrayOf<Any>(path, id))
    }

    /** Files of messages that are not delivered yet (queued or failed); these must survive a cleanup. */
    fun unsentPaths(): List<String> {
        val out = ArrayList<String>()
        readableDatabase.rawQuery("SELECT local_path FROM messages WHERE status<>0 AND local_path IS NOT NULL", null).use { c -> while (c.moveToNext()) out.add(c.getString(0)) }
        return out
    }

    /** Forget where delivered messages' files are stored (after the files were deleted to free space). */
    fun clearLocalPaths() {
        writableDatabase.execSQL("UPDATE messages SET local_path=NULL WHERE status=0")
    }

    /** An edit arrived (or was made here): new text and edit time, everything else stays. */
    fun setEdited(id: Long, text: String, edited: Long) {
        writableDatabase.execSQL("UPDATE messages SET text=?, edited=? WHERE id=?", arrayOf<Any>(text, edited, id))
    }

    /** Deletes messages stored as unreadable; returns the smallest server id among them (0 if none). */
    fun deleteLocked(text: String): Long {
        var min = 0L
        readableDatabase.rawQuery("SELECT MIN(id) FROM messages WHERE text=? AND id>0", arrayOf(text)).use { c -> if (c.moveToFirst() && !c.isNull(0)) min = c.getLong(0) }
        writableDatabase.execSQL("DELETE FROM messages WHERE text=? AND id>0", arrayOf<Any>(text))
        return min
    }

    fun delete(id: Long) {
        writableDatabase.execSQL("DELETE FROM messages WHERE id=?", arrayOf<Any>(id))
    }


    fun convos(): List<String> {
        val out = ArrayList<String>()
        readableDatabase.rawQuery("SELECT DISTINCT convo FROM messages", null).use { c -> while (c.moveToNext()) out.add(c.getString(0)) }
        return out
    }

    fun get(id: Long): Msg? {
        var r: Msg? = null
        readableDatabase.rawQuery("SELECT $COLS FROM messages WHERE id=?", arrayOf(id.toString())).use { c -> if (c.moveToFirst()) r = c.toMsg() }
        return r
    }

    /** Messages still waiting to be sent (oldest first). */
    fun outbox(): List<Msg> {
        val out = ArrayList<Msg>()
        readableDatabase.rawQuery("SELECT $COLS FROM messages WHERE status=1 ORDER BY ts, id", null).use { c -> while (c.moveToNext()) out.add(c.toMsg()) }
        return out
    }

    fun setStatus(id: Long, status: Int) {
        writableDatabase.execSQL("UPDATE messages SET status=? WHERE id=?", arrayOf<Any>(status, id))
    }

    fun setUploadId(id: Long, uploadId: String?) {
        writableDatabase.execSQL("UPDATE messages SET upload_id=? WHERE id=?", arrayOf<Any?>(uploadId, id))
    }

    /** Case-insensitive keyword search inside one conversation (text and file names). */
    fun search(convo: String, q: String, limit: Int = 300): List<Msg> {
        val out = ArrayList<Msg>()
        val like = "%" + q.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_") + "%"
        readableDatabase.rawQuery(
            "SELECT $COLS FROM messages WHERE convo=? AND type!='call' AND (text LIKE ? ESCAPE '\\' OR file_name LIKE ? ESCAPE '\\') " +
                "ORDER BY ts DESC, id DESC LIMIT $limit", arrayOf(convo, like, like)
        ).use { c -> while (c.moveToNext()) out.add(c.toMsg()) }
        out.reverse()
        return out
    }

    /** Saves the contact key. Returns true if a previously known key changed. */
    fun saveKey(user: String, pub: String): Boolean {
        var old: String? = null
        var known = false
        readableDatabase.rawQuery("SELECT pubkey FROM contacts WHERE username=?", arrayOf(user)).use { c ->
            if (c.moveToFirst()) { known = true; old = c.getString(0) }
        }
        if (!known) {
            writableDatabase.execSQL("INSERT INTO contacts(username,pubkey,key_changed) VALUES(?,?,0)", arrayOf<Any>(user, pub))
            return false
        }
        if (old != pub) {
            writableDatabase.execSQL("UPDATE contacts SET pubkey=?, key_changed=1 WHERE username=?", arrayOf<Any>(pub, user))
            return true
        }
        return false
    }

    fun keyChanged(user: String): Boolean {
        var r = false
        readableDatabase.rawQuery("SELECT key_changed FROM contacts WHERE username=?", arrayOf(user)).use { c ->
            if (c.moveToFirst()) r = c.getInt(0) == 1
        }
        return r
    }

    fun clearKeyChanged(user: String) {
        writableDatabase.execSQL("UPDATE contacts SET key_changed=0 WHERE username=?", arrayOf<Any>(user))
    }

    fun clearAll() {
        writableDatabase.execSQL("DELETE FROM messages")
        writableDatabase.execSQL("DELETE FROM contacts")
    }
}
