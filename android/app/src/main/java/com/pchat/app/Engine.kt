package com.pchat.app

import android.Manifest
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.content.SharedPreferences
import android.content.pm.PackageManager
import android.net.ConnectivityManager
import android.net.Network
import android.net.Uri
import android.os.Build
import androidx.compose.ui.graphics.ImageBitmap
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import androidx.core.content.ContextCompat
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeoutOrNull
import org.json.JSONObject
import java.io.BufferedInputStream
import java.io.DataInputStream
import java.io.File
import java.io.FileInputStream
import java.io.FileOutputStream
import java.io.IOException
import java.io.RandomAccessFile

class UserError(msg: String) : Exception(msg)

object Engine {
    const val CH_MSG = "msgs"
    const val CH_SVC = "svc"
    const val CH_CALL = "calls"
    private const val CALL_NOTIF_ID = 77

    lateinit var app: Context
    lateinit var db: Db
    lateinit var prefs: SharedPreferences
    var identity: Identity? = null
    val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)

    val tick = MutableStateFlow(0L)
    val users = MutableStateFlow<List<UserInfo>>(emptyList())
    val groups = MutableStateFlow<List<GroupInfo>>(emptyList())
    val incomingRequests = MutableStateFlow<List<ContactRequest>>(emptyList())
    val outgoingRequests = MutableStateFlow<List<ContactRequest>>(emptyList())
    /** conversation key -> pinned message id */
    val pins = MutableStateFlow<Map<String, Long>>(emptyMap())
    val typing = MutableStateFlow<Map<String, Long>>(emptyMap())
    val loggedIn = MutableStateFlow(false)
    /** null = unknown yet, true = the server holds a backup of this device's identity key, false = it does not */
    val keyBackedUp = MutableStateFlow<Boolean?>(null)
    val connected = MutableStateFlow(false)
    /** message id -> 0..1 for running uploads/downloads */
    val progress = MutableStateFlow<Map<Long, Float>>(emptyMap())
    /** message id -> reason a queued message failed permanently */
    val failures = MutableStateFlow<Map<Long, String>>(emptyMap())

    @Volatile var currentConvo: String? = null
    @Volatile var appVisible = false
    private var lastTypingSent = 0L
    private val wake = Channel<Unit>(Channel.CONFLATED)
    private val textLock = Mutex()
    private val fileLock = Mutex()
    private var ticker: Job? = null
    private var netRegistered = false
    private val lastProgressAt = HashMap<Long, Long>()

    val me: String get() = prefs.getString("me", "") ?: ""

    fun isGroup(convo: String) = convo == "all" || convo.startsWith("g:")

    fun nameOf(user: String): String =
        users.value.firstOrNull { it.username == user }?.displayName?.takeIf { it.isNotBlank() } ?: user

    fun groupName(key: String): String =
        groups.value.firstOrNull { it.key == key }?.name ?: if (key == "all") "گروه عمومی" else key

    fun titleOf(convo: String) = if (isGroup(convo)) groupName(convo) else nameOf(convo)

    @Synchronized
    fun init(ctx: Context) {
        if (::app.isInitialized) return
        app = ctx.applicationContext
        prefs = app.getSharedPreferences("state", Context.MODE_PRIVATE)
        db = Db(app)
        Api.init(app)
        identity = Crypto.loadOrCreateIdentity(app)
        Api.token = prefs.getString("token", null)
        loggedIn.value = Api.token != null
        try { users.value = parseUsers(prefs.getString("users_raw", "[]") ?: "[]") } catch (e: Exception) { }
        try { groups.value = parseGroups(prefs.getString("groups_raw", "[]") ?: "[]") } catch (e: Exception) { }
        Prefs.load()
        CallManager.init(app)
        if (Build.VERSION.SDK_INT >= 26) {
            val nm = app.getSystemService(NotificationManager::class.java)
            nm.createNotificationChannel(NotificationChannel(CH_MSG, "پیام‌ها", NotificationManager.IMPORTANCE_HIGH))
            nm.createNotificationChannel(NotificationChannel(CH_SVC, "اتصال", NotificationManager.IMPORTANCE_MIN))
            nm.createNotificationChannel(NotificationChannel(CH_CALL, "تماس", NotificationManager.IMPORTANCE_HIGH).apply { setSound(null, null) })
        }
    }

    /** Bytes used by downloaded/sent files, the partial-download folder and the avatar cache. */
    fun storageUsage(): Long = Prefs.dirSize(mediaDir()) + Prefs.dirSize(dlDir()) + Prefs.dirSize(avatarDir())

    /**
     * Frees space: deletes received and sent files that are already delivered, partial downloads and cached avatars.
     * Messages stay; their files are downloaded again from the server when opened (while the server still keeps them).
     */
    suspend fun clearMedia() = withContext(Dispatchers.IO) {
        val keep = db.unsentPaths().map { File(it).name }.toSet()
        mediaDir().listFiles()?.forEach { if (it.name !in keep) it.delete() }
        dlDir().listFiles()?.forEach { it.delete() }
        avatarDir().listFiles()?.forEach { it.delete() }
        avatarMem.evictAll()
        db.clearLocalPaths()
        tick.value++
    }

    private fun mediaDir(): File = File(app.filesDir, "media").also { it.mkdirs() }
    private fun dlDir(): File = File(app.filesDir, "dl").also { it.mkdirs() }
    private fun avatarDir(): File = File(app.filesDir, "avatars").also { it.mkdirs() }

    private fun wipeLocal() {
        db.clearAll()
        mediaDir().listFiles()?.forEach { it.delete() }
        dlDir().listFiles()?.forEach { it.delete() }
        avatarDir().listFiles()?.forEach { it.delete() }
        avatarMem.evictAll()
        prefs.edit().putLong("last_id", 0).remove("users_raw").remove("groups_raw").apply()
        users.value = emptyList()
        groups.value = emptyList()
        incomingRequests.value = emptyList()
        outgoingRequests.value = emptyList()
        pins.value = emptyMap()
        progress.value = emptyMap()
        failures.value = emptyMap()
        keyBackedUp.value = null
        tick.value++
    }

    private fun errText(e: Exception): String = when (e) {
        is UserError -> e.message ?: "خطا"
        is Api.HttpError -> when (e.code) {
            401 -> "نشست منقضی شده؛ دوباره وارد شوید"
            403 -> "اجازه‌ی ارسال به این گفتگو را ندارید"
            404 -> "گیرنده یا گروه پیدا نشد"
            413 -> "حجم فایل بیش از حد مجاز است"
            429 -> "تلاش‌های زیاد؛ کمی صبر کنید"
            507 -> "فضای سرور پر است"
            else -> "خطای سرور (${e.code})"
        }
        is IOException -> "اتصال به سرور برقرار نیست"
        else -> "خطا: " + (e.message ?: e.javaClass.simpleName)
    }

    /** true when retrying later makes sense (network trouble / server busy), false for definitive refusals. */
    private fun isTransient(e: Exception): Boolean = when (e) {
        is Api.HttpError -> e.code == 401 || e.code == 408 || e.code == 429 || e.code == 502 || e.code == 503 || e.code == 504 || e.code == 500
        is UserError -> false
        is IOException -> true
        else -> false
    }

    // ---------------- account ----------------

    suspend fun login(user: String, pass: String): String? = withContext(Dispatchers.IO) {
        try {
            val u = user.trim().lowercase()
            val prevMe = prefs.getString("me", null)
            // another account on this phone must not reuse the previous account's key
            val local = if (prevMe != null && prevMe != u) Crypto.generateIdentity() else identity!!
            val r = Api.login(u, pass, local.pubB64)
            val t = r.getString("token")
            if (prevMe != u) wipeLocal()
            prefs.edit().putString("token", t).putString("me", u).apply()
            Api.token = t
            useIdentity(syncKeyBackup(u, pass, r.optJSONObject("key_backup"), local))
            loggedIn.value = true
            null
        } catch (e: Api.HttpError) {
            when (e.code) {
                401 -> "نام کاربری یا رمز اشتباه است"
                429 -> "تلاش‌های ناموفق زیاد بود؛ ۱۰ دقیقه صبر کنید"
                else -> "خطای سرور (${e.code})"
            }
        } catch (e: Exception) {
            "اتصال به سرور برقرار نشد"
        }
    }

    private fun useIdentity(id: Identity) {
        if (id.pubB64 != identity?.pubB64) Crypto.saveIdentity(app, id)
        identity = id
    }

    /**
     * One identity key per account, kept on the server encrypted with the login password (the server cannot read it).
     * A new device (or a reinstall) restores the key, so old messages stay readable after logging in again.
     * Returns the identity to use; upload failures never fail the login.
     */
    private fun syncKeyBackup(u: String, pass: String, kb: JSONObject?, local: Identity): Identity {
        if (kb != null) {
            try {
                val restored = Crypto.importBackup(kb, u, pass)
                keyBackedUp.value = true
                return restored
            } catch (e: Exception) {
                // the backup was made with an older password (reset by the admin): fall through and back up again.
                // when it holds a different key that key cannot be recovered, so this device's key replaces it.
            }
        }
        keyBackedUp.value = try { Api.uploadKeyBackup(Crypto.exportBackup(local, u, pass), pass); true } catch (e: Exception) { false }
        return local
    }

    /** For accounts logged in before key backup existed: Settings asks for the password once. Returns an error or null. */
    suspend fun enableKeyBackup(pass: String): String? = withContext(Dispatchers.IO) {
        val u = me
        try {
            val kb = Api.keyBackup()
            val id = if (kb != null) try { Crypto.importBackup(kb, u, pass) } catch (e: Exception) { null } else null
            // the account's key is in the backup (e.g. restored on another phone): use it here too
            if (id != null) { useIdentity(id); keyBackedUp.value = true; refreshDirectory(); return@withContext null }
            Api.uploadKeyBackup(Crypto.exportBackup(identity!!, u, pass), pass)
            keyBackedUp.value = true
            null
        } catch (e: Api.HttpError) {
            if (e.code == 403) "رمز عبور اشتباه است" else if (e.code == 429) "تلاش‌های زیاد؛ کمی صبر کنید" else "خطای سرور (${e.code})"
        } catch (e: Exception) {
            "اتصال به سرور برقرار نشد"
        }
    }

    fun logout() {
        CallManager.endCall("", true)
        val t = Api.token
        Api.cancelStream()
        Api.token = null
        prefs.edit().remove("token").apply()
        loggedIn.value = false
        scope.launch {
            try { Api.logout(t) } catch (e: Exception) { }
            wipeLocal()
        }
    }

    private fun forceLogout() {
        Api.token = null
        prefs.edit().remove("token").apply()
        loggedIn.value = false
    }

    // ---------------- live connection ----------------

    fun refreshUsers() {
        val raw = Api.usersRaw()
        val list = parseUsers(raw)
        for (u in list) if (u.pubkey != null && u.username != me) db.saveKey(u.username, u.pubkey)
        prefs.edit().putString("users_raw", raw).apply()
        users.value = list
        tick.value++
    }

    fun refreshGroups() {
        val raw = Api.groupsRaw()
        val list = parseGroups(raw)
        prefs.edit().putString("groups_raw", raw).apply()
        groups.value = list
        tick.value++
    }

    /** Re-reads contacts and groups in the background, so a group the admin added while a "refresh" event was missed still shows up. */
    fun refreshDirectory() {
        if (Api.token == null) return
        scope.launch {
            try { refreshUsers() } catch (e: Exception) { }
            try { refreshGroups() } catch (e: Exception) { }
            try { refreshRequests() } catch (e: Exception) { }
            try { keyBackedUp.value = Api.keyBackup()?.optString("pub") == identity?.pubB64 } catch (e: Exception) { }
        }
    }

    fun refreshRequests() {
        val (inc, out) = Api.contactRequests()
        val known = incomingRequests.value.map { it.username }.toSet()
        incomingRequests.value = inc
        outgoingRequests.value = out
        for (r in inc) if (r.username !in known && !prefs.getBoolean("req_seen_${r.username}_${r.ts}", false)) {
            prefs.edit().putBoolean("req_seen_${r.username}_${r.ts}", true).apply()
            postRequestNotification(r)
        }
    }

    private fun contactErr(e: Exception): String {
        val code = (e as? Api.HttpError)?.let { try { JSONObject(it.message ?: "").optString("error") } catch (x: Exception) { "" } } ?: ""
        return when (code) {
            "no_such_user" -> "کاربری با این نام کاربری پیدا نشد"
            "bad_username" -> "نام کاربری نامعتبر است"
            "already_connected" -> "شما از قبل به این کاربر متصل هستید"
            "declined_recently" -> "این کاربر درخواست قبلی شما را رد کرده؛ فردا دوباره امتحان کنید"
            "not_allowed" -> "مدیر ارتباط شما با این کاربر را بسته است"
            "no_request" -> "این درخواست دیگر وجود ندارد"
            else -> errText(e)
        }
    }

    /** Sends / answers / withdraws a connection request, or removes a connection. Returns (error, result). */
    suspend fun contactAction(what: String, username: String, accept: Boolean = false): Pair<String?, String?> = withContext(Dispatchers.IO) {
        try {
            val r = Api.contactAction(what, username.trim().lowercase(), accept)
            try { refreshRequests() } catch (e: Exception) { }
            try { refreshUsers() } catch (e: Exception) { }
            null to r
        } catch (e: Exception) { contactErr(e) to null }
    }

    private fun postRequestNotification(r: ContactRequest) {
        if (appVisible) return
        if (Build.VERSION.SDK_INT >= 33 &&
            ContextCompat.checkSelfPermission(app, Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED
        ) return
        val i = Intent(app, MainActivity::class.java).apply { flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP }
        val pi = PendingIntent.getActivity(app, 7702, i, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
        val who = r.displayName?.let { "$it (${r.username})" } ?: r.username
        val n = NotificationCompat.Builder(app, Prefs.messageChannel(app))
            .setSmallIcon(android.R.drawable.stat_notify_chat)
            .setContentTitle("درخواست اتصال")
            .setContentText("$who می‌خواهد با شما در ارتباط باشد")
            .setAutoCancel(true)
            .setContentIntent(pi)
            .build()
        NotificationManagerCompat.from(app).notify(("req:" + r.username).hashCode(), n)
    }

    private fun pubOf(u: String): String? =
        if (u == me) identity?.pubB64 else users.value.firstOrNull { it.username == u }?.pubkey

    /** Wakes the reconnect loop immediately (network came back, user pressed retry, ...). */
    fun wakeUp() { wake.trySend(Unit) }

    /** Reconnects instantly when the phone switches between Wi-Fi / mobile data. */
    fun watchNetwork() {
        if (netRegistered) return
        netRegistered = true
        try {
            val cm = app.getSystemService(ConnectivityManager::class.java)
            var first = true
            cm.registerDefaultNetworkCallback(object : ConnectivityManager.NetworkCallback() {
                override fun onAvailable(network: Network) {
                    if (first) { first = false; return }
                    // the old TCP connection is probably dead after a network change
                    Api.cancelStream()
                    wakeUp()
                }
            })
        } catch (e: Exception) { }
    }

    /** Re-tries queued messages every few seconds while connected. */
    fun startOutboxTicker() {
        if (ticker?.isActive == true) return
        ticker = scope.launch {
            while (isActive) {
                delay(10_000)
                if (connected.value && Api.token != null && db.outbox().isNotEmpty()) flushAll()
            }
        }
    }

    fun flushAll() {
        scope.launch { flushTexts() }
        scope.launch { flushFiles() }
    }

    suspend fun streamLoop() = withContext(Dispatchers.IO) {
        var backoff = 1000L
        while (isActive && Api.token != null) {
            try {
                refreshUsers()
                try { refreshGroups() } catch (e: Api.HttpError) { if (e.code == 401) throw e }
                try { refreshRequests() } catch (e: Exception) { }
                Api.stream(
                    prefs.getLong("last_id", 0),
                    onOpen = {
                        connected.value = true
                        backoff = 1000L
                        pins.value = emptyMap() // the server re-sends every current pin right after connecting
                        flushAll()
                    },
                    onEvent = { ev, data -> try { handleEvent(ev, data) } catch (e: Exception) { } }
                )
            } catch (e: Api.HttpError) {
                if (e.code == 401) { forceLogout(); connected.value = false; return@withContext }
            } catch (e: Exception) {
            }
            connected.value = false
            if (withTimeoutOrNull(backoff) { wake.receive() } != null) backoff = 1000L
            else backoff = minOf(backoff * 2, 15000L)
        }
    }

    private fun handleEvent(ev: String, data: String) {
        val o = JSONObject(data)
        when (ev) {
            "msg" -> handleMsg(o)
            "presence" -> {
                val u = o.getString("user")
                val on = o.getBoolean("online")
                if (users.value.none { it.username == u } || on) {
                    try { refreshUsers() } catch (e: Exception) { }
                }
                users.value = users.value.map { if (it.username == u) it.copy(online = on) else it }
            }
            "profile" -> {
                val u = o.getString("username")
                val dn = if (o.isNull("display_name")) null else o.getString("display_name")
                val ver = o.optInt("avatar_ver", 0)
                val bio = if (o.isNull("bio")) null else o.optString("bio", "").ifEmpty { null }
                if (users.value.none { it.username == u }) {
                    try { refreshUsers() } catch (e: Exception) { }
                } else {
                    users.value = users.value.map { if (it.username == u) it.copy(displayName = dn, avatarVer = ver, bio = bio) else it }
                }
                tick.value++
            }
            "refresh" -> {
                try { refreshUsers() } catch (e: Exception) { }
                try { refreshGroups() } catch (e: Exception) { }
            }
            "contacts" -> try { refreshRequests() } catch (e: Exception) { }
            "pin" -> {
                val convo = o.getString("convo")
                if (o.isNull("messageId")) pins.value = pins.value - convo
                else pins.value = pins.value + (convo to o.getLong("messageId"))
            }
            "sig" -> {
                val kind = o.getString("kind")
                if (kind == "sig_typing") {
                    typing.value = typing.value + (o.getString("from") to System.currentTimeMillis())
                } else {
                    CallManager.onSignal(o.getString("from"), kind, o.getString("payload"))
                }
            }
        }
    }

    private fun handleMsg(o: JSONObject) {
        val id = o.getLong("id")
        val from = o.getString("from")
        val target = o.getString("target")
        val ts = o.getLong("ts")
        val payload = o.getString("payload")
        val fileId = if (o.isNull("fileId")) null else o.getString("fileId")
        val mine = from == me
        val convo = if (isGroup(target)) target else if (mine) target else from
        val visible = appVisible && currentConvo == convo

        val msg: Msg = try {
            val pub = if (mine) null else (pubOf(from) ?: run { refreshUsers(); pubOf(from) })
            val plain = JSONObject(String(Crypto.decryptFrom(identity!!, me, from, target, pub, payload), Charsets.UTF_8))
            val r = plain.optJSONObject("r")
            Msg(
                id, convo, from, mine, ts,
                plain.optString("t", "text"), plain.optString("x", ""),
                fileId, if (plain.has("n")) plain.getString("n") else null, if (plain.has("m")) plain.getString("m") else null,
                plain.optLong("s", 0), if (plain.has("fk")) plain.getString("fk") else null,
                plain.optInt("w", 0), plain.optInt("h", 0),
                r?.optLong("id", 0) ?: 0L, r?.optString("u"), r?.optString("x"),
                null, mine || visible
            )
        } catch (e: Exception) {
            Msg(id, convo, from, mine, ts, "text", "🔒 این پیام قابل رمزگشایی نیست (کلید قدیمی یا مشکل رمزنگاری)",
                null, null, null, 0, null, 0, 0, 0L, null, null, null, true)
        }
        val isNew = db.insert(msg)
        if (isNew && !msg.read) postNotification(msg)
        if (id > prefs.getLong("last_id", 0)) prefs.edit().putLong("last_id", id).apply()
        if (isNew) tick.value++
    }

    private fun postNotification(m: Msg) {
        if (Build.VERSION.SDK_INT >= 33 &&
            ContextCompat.checkSelfPermission(app, Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED
        ) return
        val group = isGroup(m.convo)
        if (!Prefs.shouldNotify(m.convo, group)) return
        val title = if (group) groupName(m.convo) else nameOf(m.sender)
        val body = (if (group) nameOf(m.sender) + ": " else "") + U.preview(m)
        val i = Intent(app, MainActivity::class.java).apply {
            flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP
            putExtra("convo", m.convo)
        }
        val pi = PendingIntent.getActivity(app, m.convo.hashCode(), i, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
        val n = NotificationCompat.Builder(app, Prefs.messageChannel(app))
            .setSmallIcon(android.R.drawable.stat_notify_chat)
            .setContentTitle(title)
            .setContentText(body)
            .setStyle(NotificationCompat.BigTextStyle().bigText(body))
            .setAutoCancel(true)
            .setContentIntent(pi)
            .setPriority(NotificationCompat.PRIORITY_HIGH)
            .setCategory(NotificationCompat.CATEGORY_MESSAGE)
            .build()
        NotificationManagerCompat.from(app).notify(m.convo.hashCode(), n)
    }

    // ---------------- calls support ----------------

    fun decryptSignal(from: String, payload: String): String? = try {
        String(Crypto.decryptFrom(identity!!, me, from, me, pubOf(from), payload), Charsets.UTF_8)
    } catch (e: Exception) { null }

    fun addCallLog(peer: String, text: String, mine: Boolean) {
        db.insert(
            Msg(-System.nanoTime(), peer, if (mine) me else peer, mine, System.currentTimeMillis(), "call", text,
                null, null, null, 0, null, 0, 0, 0L, null, null, null, true)
        )
        tick.value++
    }

    fun postCallNotification(peer: String, video: Boolean) {
        if (Build.VERSION.SDK_INT >= 33 &&
            ContextCompat.checkSelfPermission(app, Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED
        ) return
        val i = Intent(app, MainActivity::class.java).apply { flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP }
        val pi = PendingIntent.getActivity(app, 7701, i, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
        val n = NotificationCompat.Builder(app, CH_CALL)
            .setSmallIcon(android.R.drawable.sym_call_incoming)
            .setContentTitle(if (video) "تماس تصویری ورودی" else "تماس صوتی ورودی")
            .setContentText(nameOf(peer))
            .setPriority(NotificationCompat.PRIORITY_HIGH)
            .setCategory(NotificationCompat.CATEGORY_CALL)
            .setOngoing(true)
            .setContentIntent(pi)
            .setFullScreenIntent(pi, true)
            .build()
        NotificationManagerCompat.from(app).notify(CALL_NOTIF_ID, n)
    }

    fun cancelCallNotification() { NotificationManagerCompat.from(app).cancel(CALL_NOTIF_ID) }

    // ---------------- conversations ----------------

    fun summaries(): List<ConvoSummary> {
        val keys = LinkedHashSet<String>()
        groups.value.forEach { keys.add(it.key) }
        users.value.filter { it.username != me }.forEach { keys.add(it.username) }
        keys.addAll(db.convos())
        val canDm = users.value.filter { it.dm }.map { it.username }.toSet()
        return keys.map { db.summary(it) }
            .filter { isGroup(it.convo) || it.convo in canDm || it.last != null }
            .sortedWith(compareByDescending<ConvoSummary> { it.last?.ts ?: if (isGroup(it.convo)) 1L else 0L })
    }

    fun openConvo(convo: String) {
        db.markRead(convo)
        NotificationManagerCompat.from(app).cancel(convo.hashCode())
        tick.value++
    }

    fun markReadSilently(convo: String) { db.markRead(convo) }

    fun deleteLocal(m: Msg) {
        db.delete(m.id)
        m.localPath?.let { File(it).delete() }
        failures.value = failures.value - m.id
        tick.value++
    }

    fun sendTyping(convo: String) {
        if (isGroup(convo)) return
        val t = System.currentTimeMillis()
        if (t - lastTypingSent < 3000) return
        lastTypingSent = t
        scope.launch { try { Api.signal(convo, "sig_typing", "1") } catch (e: Exception) { } }
    }

    // ---------------- profile ----------------

    private val avatarMem = object : android.util.LruCache<String, ImageBitmap>(40) {}

    /** Cached avatar of [user] at version [ver] (downloads it the first time). Null = no avatar. */
    suspend fun avatarBitmap(user: String, ver: Int): ImageBitmap? = withContext(Dispatchers.IO) {
        if (ver <= 0) return@withContext null
        val key = "$user#$ver"
        avatarMem.get(key)?.let { return@withContext it }
        val f = File(avatarDir(), "${user}_$ver.webp")
        try {
            if (!f.exists()) {
                val bytes = Api.downloadAvatar(user)
                f.writeBytes(bytes)
                avatarDir().listFiles()?.forEach { if (it.name.startsWith(user + "_") && it != f) it.delete() }
            }
            val bmp = decodeBytes(f.readBytes())
            if (bmp != null) avatarMem.put(key, bmp)
            bmp
        } catch (e: Exception) {
            null
        }
    }

    suspend fun saveProfile(name: String, bio: String): String? = withContext(Dispatchers.IO) {
        try {
            Api.setProfile(name.trim(), bio.trim())
            refreshUsers()
            null
        } catch (e: Exception) { errText(e) }
    }

    suspend fun removeAvatar(): String? = withContext(Dispatchers.IO) {
        try {
            val ver = Api.deleteAvatar()
            users.value = users.value.map { if (it.username == me) it.copy(avatarVer = ver) else it }
            tick.value++
            null
        } catch (e: Exception) { errText(e) }
    }

    suspend fun saveAvatar(uri: Uri): String? = withContext(Dispatchers.IO) {
        try {
            val webp = makeAvatarWebp(app, uri) ?: return@withContext "تصویر خوانده نشد"
            val ver = Api.uploadAvatar(webp)
            users.value = users.value.map { if (it.username == me) it.copy(avatarVer = ver) else it }
            tick.value++
            null
        } catch (e: Exception) { errText(e) }
    }

    // ---------------- pins ----------------

    suspend fun pinMessage(convo: String, messageId: Long?): String? = withContext(Dispatchers.IO) {
        try {
            Api.pin(convo, messageId)
            pins.value = if (messageId == null) pins.value - convo else pins.value + (convo to messageId)
            null
        } catch (e: Exception) { errText(e) }
    }

    // ---------------- sending ----------------

    fun encryptFor(convo: String, plain: ByteArray): String {
        val id = identity!!
        val rec = LinkedHashMap<String, String>()
        rec[me] = id.pubB64
        if (isGroup(convo)) {
            val members = groups.value.firstOrNull { it.key == convo }?.members ?: users.value.map { it.username }
            for (u in members) {
                if (u == me) continue
                val pk = pubOf(u)
                if (pk != null) rec[u] = pk
            }
        } else {
            rec[convo] = users.value.firstOrNull { it.username == convo }?.pubkey
                ?: throw UserError("این کاربر هنوز وارد برنامه نشده و کلید امنیتی ندارد")
        }
        return Crypto.encryptFor(id, me, convo, rec, plain)
    }

    private fun replyJson(plain: JSONObject, m: Msg) {
        if (m.replyId != 0L) plain.put("r", JSONObject().put("id", m.replyId).put("u", m.replyUser ?: "").put("x", m.replyText ?: ""))
    }

    private fun setProgress(id: Long, v: Float?) {
        if (v == null) {
            lastProgressAt.remove(id)
            progress.value = progress.value - id
            return
        }
        val t = System.currentTimeMillis()
        val last = lastProgressAt[id] ?: 0L
        if (t - last < 150 && v < 1f && progress.value.containsKey(id)) return
        lastProgressAt[id] = t
        progress.value = progress.value + (id to v)
    }

    /** Queues a text message (shown immediately, sent in the background, retried until it succeeds). */
    fun sendText(convo: String, text: String, reply: Msg?) {
        val localId = -System.nanoTime()
        db.insert(
            Msg(localId, convo, me, true, System.currentTimeMillis(), "text", text, null, null, null, 0, null, 0, 0,
                reply?.id?.takeIf { it > 0 } ?: 0L, reply?.sender, reply?.let { U.preview(it).take(80) }, null, true, status = 1)
        )
        tick.value++
        scope.launch { flushTexts() }
    }

    /** Copies the picked file into app storage, then queues it for chunked/resumable encrypted upload. */
    suspend fun sendUri(convo: String, uri: Uri, asImage: Boolean, reply: Msg?): String? = withContext(Dispatchers.IO) {
        var staged: File? = null
        try {
            val declared = U.fileSize(app, uri)
            if (declared > Config.MAX_FILE_BYTES) return@withContext "حجم فایل بیشتر از ۲ گیگابایت است"
            if (declared > 0 && mediaDir().usableSpace < declared + 64L * 1024 * 1024) return@withContext "فضای کافی روی گوشی نیست"
            val name = U.fileName(app, uri)
            val mime = app.contentResolver.getType(uri) ?: "application/octet-stream"
            val localId = -System.nanoTime()
            val f = File(mediaDir(), "out_${-localId}")
            staged = f
            var size = 0L
            val ins = app.contentResolver.openInputStream(uri) ?: return@withContext "فایل خوانده نشد"
            ins.use { input ->
                FileOutputStream(f).use { os ->
                    val buf = ByteArray(256 * 1024)
                    while (true) {
                        val n = input.read(buf)
                        if (n < 0) break
                        os.write(buf, 0, n)
                        size += n
                        if (size > Config.MAX_FILE_BYTES) return@withContext "حجم فایل بیشتر از ۲ گیگابایت است".also { f.delete() }
                    }
                }
            }
            var w = 0
            var h = 0
            var type = "file"
            if (asImage) {
                val dim = imageSizeOf(f.absolutePath)
                if (dim != null) { type = "image"; w = dim.first; h = dim.second }
            }
            db.insert(
                Msg(localId, convo, me, true, System.currentTimeMillis(), type, "", null, name, mime, size,
                    Crypto.newFileKey(), w, h,
                    reply?.id?.takeIf { it > 0 } ?: 0L, reply?.sender, reply?.let { U.preview(it).take(80) },
                    f.absolutePath, true, status = 1)
            )
            tick.value++
            scope.launch { flushFiles() }
            staged = null
            null
        } catch (e: Exception) {
            staged?.delete()
            errText(e)
        }
    }

    fun retry(m: Msg) {
        failures.value = failures.value - m.id
        db.setStatus(m.id, 1)
        tick.value++
        flushAll()
    }

    private fun failPermanently(m: Msg, e: Exception) {
        db.setStatus(m.id, 2)
        failures.value = failures.value + (m.id to errText(e))
        setProgress(m.id, null)
        tick.value++
    }

    private suspend fun flushTexts() {
        if (Api.token == null) return
        textLock.withLock {
            for (m in db.outbox()) {
                if (m.type != "text" || Api.token == null) continue
                try {
                    sendQueuedText(m)
                } catch (e: Exception) {
                    if (isTransient(e)) return // keep order: stop and retry later
                    failPermanently(m, e)
                }
            }
        }
    }

    private fun sendQueuedText(m: Msg) {
        val plain = JSONObject().put("t", "text").put("x", m.text)
        replyJson(plain, m)
        val (id, ts) = Api.send(m.convo, encryptFor(m.convo, plain.toString().toByteArray()), null)
        db.insert(m.copy(id = id, ts = ts, status = 0, uploadId = null, read = true))
        db.delete(m.id)
        tick.value++
    }

    private suspend fun flushFiles() {
        if (Api.token == null) return
        fileLock.withLock {
            for (m in db.outbox()) {
                if (m.type == "text" || Api.token == null) continue
                try {
                    sendQueuedFile(m)
                } catch (e: Exception) {
                    if (isTransient(e)) { setProgress(m.id, null); return }
                    failPermanently(m, e)
                }
            }
        }
    }

    private fun sendQueuedFile(m: Msg) {
        val path = m.localPath ?: throw UserError("فایل محلی پیدا نشد")
        val f = File(path)
        if (!f.exists()) throw UserError("فایل محلی پیدا نشد")
        val fkey = m.fkey ?: throw UserError("کلید فایل پیدا نشد")
        val total = Crypto.cipherSize(m.size)
        val chunks = Crypto.chunkCount(m.size)

        var fileId: String? = m.uploadId?.takeIf { it.startsWith("f:") }?.substring(2)
        if (fileId == null) {
            var upId = m.uploadId
            var off = 0L
            if (upId != null) {
                try { off = Api.uploadStatus(upId) } catch (e: Api.HttpError) {
                    if (e.code == 404) { upId = null; off = 0 } else throw e
                }
                if (upId != null && off % Crypto.CIPHER_CHUNK != 0L) { upId = null; off = 0 }
            }
            if (upId == null) {
                upId = Api.createUpload(total)
                db.setUploadId(m.id, upId)
                off = 0
            }
            val up: String = upId
            setProgress(m.id, off.toFloat() / total)
            val plainBuf = ByteArray(Crypto.FILE_CHUNK)
            val block = ByteArray(Crypto.CIPHER_CHUNK * 4)
            var resyncs = 0
            RandomAccessFile(f, "r").use { raf ->
                while (fileId == null) {
                    var idx = (off / Crypto.CIPHER_CHUNK).toInt()
                    var pos = 0
                    var k = 0
                    while (k < 4 && idx < chunks) {
                        val start = idx.toLong() * Crypto.FILE_CHUNK
                        val len = minOf(Crypto.FILE_CHUNK.toLong(), m.size - start).toInt().coerceAtLeast(0)
                        raf.seek(start)
                        raf.readFully(plainBuf, 0, len)
                        val sealed = Crypto.sealChunk(fkey, idx, idx == chunks - 1, plainBuf, len)
                        System.arraycopy(sealed, 0, block, pos, sealed.size)
                        pos += sealed.size
                        idx++; k++
                    }
                    if (pos == 0) throw IOException("nothing to upload")
                    try {
                        val r = Api.patchUpload(up, off, block, pos)
                        off = r.offset
                        setProgress(m.id, off.toFloat() / total)
                        if (r.done) fileId = r.fileId
                    } catch (e: Api.HttpError) {
                        if (e.code == 409 && resyncs++ < 5) {
                            off = Api.uploadStatus(up)
                            if (off % Crypto.CIPHER_CHUNK != 0L) throw IOException("misaligned upload offset")
                        } else throw e
                    }
                }
            }
            db.setUploadId(m.id, "f:$fileId")
        }

        val plain = JSONObject().put("t", m.type).put("n", m.fileName ?: "file").put("m", m.mime ?: "application/octet-stream")
            .put("s", m.size).put("fk", fkey).put("w", m.w).put("h", m.h)
        replyJson(plain, m)
        val (id, ts) = Api.send(m.convo, encryptFor(m.convo, plain.toString().toByteArray()), fileId)
        val dest = File(mediaDir(), fileId!!)
        if (!f.renameTo(dest)) { f.copyTo(dest, overwrite = true); f.delete() }
        db.insert(m.copy(id = id, ts = ts, status = 0, uploadId = null, fileId = fileId, localPath = dest.absolutePath, read = true))
        db.setLocalPath(id, dest.absolutePath)
        db.delete(m.id)
        setProgress(m.id, null)
        tick.value++
    }

    // ---------------- downloading ----------------

    private fun readFully(ins: DataInputStream, buf: ByteArray, len: Int) { ins.readFully(buf, 0, len) }

    /** Downloads + decrypts a file/image (resumes interrupted downloads). Returns the local path, or null on failure. */
    suspend fun downloadMedia(m: Msg): String? = withContext(Dispatchers.IO) {
        val fid = m.fileId ?: return@withContext null
        m.localPath?.let { if (File(it).exists()) return@withContext it }
        val existing = File(mediaDir(), fid)
        if (existing.exists()) { db.setLocalPath(m.id, existing.absolutePath); tick.value++; return@withContext existing.absolutePath }
        if (progress.value.containsKey(m.id)) return@withContext null
        setProgress(m.id, 0f)
        try {
            val fk = m.fkey ?: return@withContext null
            val dest = File(mediaDir(), fid)
            if (!Crypto.isChunked(fk)) {
                dest.writeBytes(Crypto.openFile(Crypto.unb64(fk), Api.download(fid)))
            } else {
                val total = Crypto.cipherSize(m.size)
                val part = File(dlDir(), "$fid.part")
                var have = if (part.exists()) part.length() else 0L
                if (have > total) { part.delete(); have = 0L }
                var tries = 0
                while (have < total) {
                    if (tries++ > 40 || Api.token == null) throw IOException("download stalled")
                    try {
                        Api.downloadRange(fid, have) { ins ->
                            FileOutputStream(part, true).use { os ->
                                val b = ByteArray(64 * 1024)
                                while (true) {
                                    val n = ins.read(b)
                                    if (n < 0) break
                                    os.write(b, 0, n)
                                    have += n
                                    setProgress(m.id, 0.9f * have / total)
                                }
                            }
                        }
                    } catch (e: Api.HttpError) {
                        throw e
                    } catch (e: IOException) {
                        have = part.length()
                        delay(1500)
                    }
                    have = part.length()
                }
                val tmp = File(mediaDir(), "$fid.tmp")
                val chunks = Crypto.chunkCount(m.size)
                try {
                    DataInputStream(BufferedInputStream(FileInputStream(part), 256 * 1024)).use { input ->
                        FileOutputStream(tmp).use { os ->
                            val inb = ByteArray(Crypto.CIPHER_CHUNK)
                            for (i in 0 until chunks) {
                                val last = i == chunks - 1
                                val clen = if (last) (total - i.toLong() * Crypto.CIPHER_CHUNK).toInt() else Crypto.CIPHER_CHUNK
                                readFully(input, inb, clen)
                                os.write(Crypto.openChunk(fk, i, last, inb, clen))
                                setProgress(m.id, 0.9f + 0.1f * (i + 1) / chunks)
                            }
                        }
                    }
                } catch (e: Exception) {
                    tmp.delete(); part.delete() // corrupt download: start over next time
                    throw e
                }
                if (!tmp.renameTo(dest)) { tmp.copyTo(dest, overwrite = true); tmp.delete() }
                part.delete()
            }
            db.setLocalPath(m.id, dest.absolutePath)
            tick.value++
            dest.absolutePath
        } catch (e: Exception) {
            null
        } finally {
            setProgress(m.id, null)
        }
    }
}
