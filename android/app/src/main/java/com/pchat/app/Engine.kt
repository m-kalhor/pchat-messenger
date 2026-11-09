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
import androidx.core.app.Person
import androidx.core.app.RemoteInput
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
import org.json.JSONArray
import org.json.JSONObject
import java.io.BufferedInputStream
import java.io.DataInputStream
import java.io.File
import java.io.FileInputStream
import java.io.FileOutputStream
import java.io.IOException
import java.io.RandomAccessFile
import java.util.Locale

class UserError(msg: String) : Exception(msg)

enum class KeyStep { CHOOSE, SET_PASSWORD }

/** Engine.codeLogin answer: the number is new and open sign-up asks for a username. */
const val SIGNUP = "\u0000signup"
const val SMS_DOWN = "پیامک در دسترس نیست. کد را از دستگاه دیگرتان (تنظیمات › ورود دستگاه تازه) یا از مدیر بگیرید و «کد را دارم» را بزنید."
const val LOCKED_TEXT = "🔒 این پیام قابل رمزگشایی نیست (کلید قدیمی یا مشکل رمزنگاری)"

/** Messages that travel as text: a location and a sticker are text with an extra field. */
val TEXTISH = setOf("text", "location", "sticker")

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
    /** Message requests I declined (can still be accepted) and the people I blocked (1.7). */
    val declinedRequests = MutableStateFlow<List<ContactRequest>>(emptyList())
    val blockedRequests = MutableStateFlow<List<ContactRequest>>(emptyList())
    /** People who are not my contacts may write to me (message requests); requestsOn = the admin allows them at all. */
    val allowRequests = MutableStateFlow(true)
    val requestsOn = MutableStateFlow(true)
    /** Call diagnostics (ping, route) for the admins listed in the panel — a test feature, see Diag.kt. */
    val diag = MutableStateFlow(false)
    /** conversation key -> pinned message id */
    val pins = MutableStateFlow<Map<String, Long>>(emptyMap())
    val typing = MutableStateFlow<Map<String, Long>>(emptyMap())
    /** group key -> member -> when they last typed there */
    val gtyping = MutableStateFlow<Map<String, Map<String, Long>>>(emptyMap())
    /** Delivered / seen watermarks: conversation -> user -> (delivered, seen) message ids (see the server's receipts). */
    val receipts = MutableStateFlow<Map<String, Map<String, Pair<Long, Long>>>>(emptyMap())
    /** My privacy switches (both work both ways: who hides it does not see it from others either). */
    val hideSeen = MutableStateFlow(false)
    val hideLastSeen = MutableStateFlow(false)
    /** Others who have my mobile number may find me in Sepan (Settings › privacy). */
    val findable = MutableStateFlow(true)
    val loggedIn = MutableStateFlow(false)
    /** null = unknown yet, true = the server holds a key-password backup of this device's identity key, false = it does not */
    val keyBackedUp = MutableStateFlow<Boolean?>(null)
    /** What the user must settle about the identity key before chatting (see checkKey), null = nothing. */
    val keyStep = MutableStateFlow<KeyStep?>(null)
    /** The server's key backup while keyStep is CHOOSE (null when the server has none). */
    @Volatile var keyBackup: JSONObject? = null
    /** The login password, in memory only, so the key step right after logging in needs no second password. */
    @Volatile private var loginPass: String? = null
    val connected = MutableStateFlow(false)
    /** message id -> 0..1 for running uploads/downloads */
    val progress = MutableStateFlow<Map<Long, Float>>(emptyMap())
    /** 1.8: downloads cut off by the network; they continue by themselves from where they stopped once it is back. */
    val waitingDownloads = MutableStateFlow<Map<Long, Msg>>(emptyMap())
    /** message id -> reason a queued message failed permanently */
    val failures = MutableStateFlow<Map<Long, String>>(emptyMap())

    @Volatile var currentConvo: String? = null
    @Volatile var appVisible = false
    private val lastTypingSent = HashMap<String, Long>()
    private val wake = Channel<Unit>(Channel.CONFLATED)
    private val textLock = Mutex()
    private val fileLock = Mutex()
    private var ticker: Job? = null
    private var netRegistered = false
    private val lastProgressAt = HashMap<Long, Long>()

    val me: String get() = prefs.getString("me", "") ?: ""

    /** Random id of this phone, so the server can tell which of my devices has the app on screen. */
    val deviceId: String by lazy {
        prefs.getString("dev", null) ?: ByteArray(8).also { java.security.SecureRandom().nextBytes(it) }
            .joinToString("") { "%02x".format(it) }.also { prefs.edit().putString("dev", it).apply() }
    }

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
        receipts.value = parseReceipts(prefs.getString("receipts_raw", null))
        hideSeen.value = prefs.getBoolean("hide_seen", false)
        hideLastSeen.value = prefs.getBoolean("hide_last_seen", false)
        Stickers.load()
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
        prefs.edit().putLong("last_id", 0).putLong("cseq", -1).putLong("rseq", -1).remove("users_raw").remove("groups_raw")
            .remove("receipts_raw").remove("hide_seen").remove("hide_last_seen").apply()
        Prefs.clearChatPrefs()
        receipts.value = emptyMap()
        gtyping.value = emptyMap()
        hideSeen.value = false
        hideLastSeen.value = false
        synchronized(acks) { acks.clear(); acked.clear() }
        synchronized(notifLines) { notifLines.clear() }
        users.value = emptyList()
        groups.value = emptyList()
        incomingRequests.value = emptyList()
        outgoingRequests.value = emptyList()
        declinedRequests.value = emptyList()
        blockedRequests.value = emptyList()
        diag.value = false
        pins.value = emptyMap()
        progress.value = emptyMap()
        waitingDownloads.value = emptyMap()
        failures.value = emptyMap()
        keyBackedUp.value = null
        keyStep.value = null
        keyBackup = null
        loginPass = null
        tick.value++
    }

    fun errorText(e: Exception): String = errText(e)

    private fun errText(e: Exception): String = when (e) {
        is UserError -> e.message ?: "خطا"
        is Api.HttpError -> when (e.error) {
            "stickers_disabled" -> "مدیر ساختن استیکر را خاموش کرده است"
            "pack_limit" -> "به حداکثر تعداد پک‌های شخصی رسیده‌اید"
            "pack_full" -> "این پک پر است"
            "sticker_too_large" -> "حجم استیکر بیش از حد مجاز است"
            "bad_sticker" -> "این عکس به‌عنوان استیکر پذیرفته نشد"
            "no_such_pack" -> "این پک دیگر وجود ندارد"
            "bad_title" -> "نام پک را بنویسید"
            "request_limit" -> "تا وقتی درخواست شما را نپذیرد، بیش از ۳ پیام نمی‌شود فرستاد"
            "request_text_only" -> "تا پذیرفته شدن درخواست فقط پیام متنی می‌شود فرستاد"
            "not_connected" -> "تماس بعد از پذیرفتن درخواست ممکن است؛ تماس شما به او خبر داده شد"
            "sms_foreign" -> "پیامک فقط به شماره‌های ایران (+98) فرستاده می‌شود. کد را از دستگاه دیگرتان یا از مدیر بگیرید و «کد را دارم» را بزنید."
            else -> httpText(e)
        }
        is IOException -> "اتصال به سرور برقرار نیست"
        else -> "خطا: " + (e.message ?: e.javaClass.simpleName)
    }

    private fun httpText(e: Api.HttpError): String = when (e.code) {
            401 -> "نشست منقضی شده؛ دوباره وارد شوید"
            403 -> "اجازه‌ی ارسال به این گفتگو را ندارید"
            404 -> "گیرنده یا گروه پیدا نشد"
            413 -> "حجم فایل بیش از حد مجاز است"
            429 -> "تلاش‌های زیاد؛ کمی صبر کنید"
            507 -> "فضای سرور پر است"
            else -> "خطای سرور (${e.code})"
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
            finishLogin(Api.login(u, pass, local.pubB64), local, pass)
            null
        } catch (e: Api.HttpError) {
            when {
                e.code == 401 -> "نام کاربری یا رمز اشتباه است"
                e.error == "password_login_disabled" -> "ورود با رمز خاموش است؛ با شمارهٔ موبایل وارد شوید"
                e.code == 429 -> "تلاش‌های ناموفق زیاد بود؛ ۱۰ دقیقه صبر کنید"
                else -> "خطای سرور (${e.code})"
            }
        } catch (e: Exception) {
            "اتصال به سرور برقرار نشد"
        }
    }

    /**
     * Signs in with a one-time code: from the SMS, from another signed-in device of the user, or from the
     * admin. No login password is involved, so right after it the server takes the key backup without one.
     */
    suspend fun codeLogin(phone: String, code: String): String? = withContext(Dispatchers.IO) {
        try {
            // the account is only known after the answer, so the key goes along only from a phone without a previous account
            val prev = identity!!
            val prevMe = prefs.getString("me", null)
            val r = Api.codeLogin(phone.trim(), code.trim(), if (prevMe == null) prev.pubB64 else null)
            // a new number with open sign-up: the login screen asks for a username next (signup())
            if (r.optBoolean("signup")) { signupTicket = r.getString("ticket"); return@withContext SIGNUP }
            val local = if (prevMe != null && prevMe != r.getString("username")) Crypto.generateIdentity() else prev
            finishLogin(r, local, "")
            null
        } catch (e: Api.HttpError) {
            when (e.code) {
                401 -> "کد درست نیست یا منقضی شده"
                429 -> "تلاش‌های ناموفق زیاد بود؛ ۱۰ دقیقه صبر کنید"
                else -> "خطای سرور (${e.code})"
            }
        } catch (e: Exception) {
            "اتصال به سرور برقرار نشد"
        }
    }

    @Volatile private var signupTicket: String? = null

    /** Open sign-up, second step: opens the account with the chosen username. Returns an error or null. */
    suspend fun signup(username: String, displayName: String): String? = withContext(Dispatchers.IO) {
        val t = signupTicket ?: return@withContext "زمان ثبت‌نام گذشت؛ دوباره کد بگیرید"
        try {
            val u = username.trim().lowercase()
            val prevMe = prefs.getString("me", null)
            val local = if (prevMe != null && prevMe != u) Crypto.generateIdentity() else identity!!
            finishLogin(Api.signup(t, u, displayName.trim(), local.pubB64), local, "")
            signupTicket = null
            null
        } catch (e: Api.HttpError) {
            when (e.error) {
                "user_exists" -> "این نام کاربری گرفته شده؛ نام دیگری انتخاب کنید"
                "invalid_username" -> "نام کاربری: ۲ تا ۲۰ حرف انگلیسی کوچک، رقم یا _ (فقط رقم نباشد)"
                "bad_ticket" -> { signupTicket = null; "زمان ثبت‌نام گذشت؛ دوباره کد بگیرید" }
                "phone_taken" -> "این شماره همین حالا حساب دارد؛ دوباره وارد شوید"
                "rate_limited" -> "از این شبکه امروز ثبت‌نام زیادی انجام شده؛ بعداً امتحان کنید"
                else -> "خطای سرور (${e.code})"
            }
        } catch (e: Exception) { "اتصال به سرور برقرار نشد" }
    }

    /** Asks for an SMS login code. Returns null when sent, else an error (and how many seconds to wait). */
    suspend fun requestSms(phone: String): Pair<String?, Int> = withContext(Dispatchers.IO) {
        try { Api.smsCode(phone.trim()); null to 60 } catch (e: Api.HttpError) {
            when (e.error) {
                "wait" -> "کمی صبر کنید و دوباره بخواهید" to e.wait
                "sms_unavailable" -> SMS_DOWN to 0
                "bad_phone" -> "شمارهٔ موبایل درست نیست" to 0
                "rate_limited" -> "درخواست زیاد بود؛ چند دقیقه بعد دوباره امتحان کنید" to 0
                else -> "خطای سرور (${e.code})" to 0
            }
        } catch (e: Exception) { "اتصال به سرور برقرار نشد" to 0 }
    }

    /** {sms, password, apk} from the server, or null when it cannot be reached. */
    suspend fun authConfig(): JSONObject? = withContext(Dispatchers.IO) { try { Api.authConfig() } catch (e: Exception) { null } }

    private fun finishLogin(r: JSONObject, start: Identity, pass: String) {
        var local = start
        val u = r.getString("username")
        val t = r.getString("token")
        if (prefs.getString("me", null) != u) wipeLocal()
        prefs.edit().putString("token", t).putString("me", u).apply()
        Api.token = t
        val kb = r.optJSONObject("key_backup")
        // a v1 backup (1.1-1.2) opens with the login password: take that key silently, only the key password is missing then
        if (pass.isNotEmpty() && kb != null && kb.optInt("v", 1) == 1 && kb.optString("pub") != local.pubB64) {
            try { local = Crypto.importBackup(kb, u, pass) } catch (e: Exception) { }
        }
        useIdentity(local)
        loginPass = pass
        try { checkKey(kb) } catch (e: Exception) { }
        loggedIn.value = true
    }

    /** A one-time code (5 minutes) that signs this account in on another device; Pair(code json, error). */
    suspend fun deviceCode(): Pair<JSONObject?, String?> = withContext(Dispatchers.IO) {
        try { Api.deviceCode() to null } catch (e: Exception) { null to errText(e) }
    }

    /** 1.9: changes the login password; returns an error text or null */
    suspend fun changePassword(current: String, password: String): String? = withContext(Dispatchers.IO) {
        try { Api.changePassword(current, password); null } catch (e: Api.HttpError) {
            when (e.error) {
                "bad_password" -> "رمز فعلی (یا کد پیامکی) درست نیست"
                "weak_password" -> "رمز تازه باید دست‌کم ۸ نویسه باشد"
                else -> errText(e)
            }
        } catch (e: Exception) { errText(e) }
    }

    /** Sends an SMS code that confirms the account instead of the login password. Returns an error or null. */
    suspend fun reauthSms(): String? = withContext(Dispatchers.IO) {
        try { Api.reauthSms(); null } catch (e: Api.HttpError) {
            when (e.error) {
                "no_phone" -> "برای حساب شما شمارهٔ موبایل ثبت نشده؛ از مدیر بخواهید"
                "sms_unavailable" -> "پیامک در دسترس نیست"
                else -> errText(e)
            }
        } catch (e: Exception) { errText(e) }
    }

    private fun useIdentity(id: Identity) {
        if (id.pubB64 != identity?.pubB64) Crypto.saveIdentity(app, id)
        identity = id
    }

    // ---------------- identity key: restore / new key / key password ----------------

    /**
     * One identity key per account, kept on the server locked with the user's key password (v2) or, for
     * accounts from 1.1-1.2, the login password (v1), so every device uses the same key and old messages
     * stay readable. Decides what the user must do first:
     * CHOOSE = this phone's key is not the account's key (restore it, or make a new one);
     * SET_PASSWORD = the key is right but has no key password yet (mandatory); null = all good.
     * Pass the backup when the caller already has it (login), otherwise it is fetched.
     */
    fun checkKey(kbIn: JSONObject? = null, fetch: Boolean = kbIn == null): KeyStep? {
        val kb = if (fetch) Api.keyBackup() else kbIn
        val mine = identity!!.pubB64
        val serverPub = parseUsers(Api.usersRaw()).firstOrNull { it.username == me }?.pubkey
        val step = when {
            kb != null && kb.optString("pub") != mine -> KeyStep.CHOOSE
            kb == null && serverPub != null && serverPub != mine -> KeyStep.CHOOSE
            kb == null || kb.optInt("v", 1) != 2 -> KeyStep.SET_PASSWORD
            else -> null
        }
        keyBackup = kb
        keyBackedUp.value = step == null
        keyStep.value = step
        if (step == KeyStep.CHOOSE) Api.cancelStream()
        return step
    }

    /** true when the key screen must ask for the login password (it is not in memory any more). */
    fun needsAccountPassword(): Boolean = loginPass == null  // "" = signed in by a code a moment ago

    private fun uploadBackup(id: Identity, keyPass: String, accountPass: String?) {
        val ap = accountPass ?: loginPass ?: throw UserError("رمز ورود حساب یا کد پیامکی را وارد کنید")
        Api.uploadKeyBackup(Crypto.exportBackup(id, me, keyPass), ap)
        loginPass = ap
    }

    private fun keyErr(e: Exception): String =
        if (e is Api.HttpError && e.code == 403) { loginPass = null; "رمز ورود حساب یا کد پیامکی درست نیست" } else errText(e)

    /** The key changed (restored or new): re-open messages that arrived while the wrong key was in use. */
    private fun keyDone(id: Identity) {
        useIdentity(id)
        val from = db.deleteLocked(LOCKED_TEXT)
        if (from > 0 && from - 1 < prefs.getLong("last_id", 0)) prefs.edit().putLong("last_id", from - 1).apply()
        keyStep.value = null
        keyBackedUp.value = true
        tick.value++
        Api.cancelStream()
        wakeUp()
    }

    /** Restores the account key from the server backup with the key password. Returns an error or null. */
    suspend fun restoreKey(secret: String): String? = withContext(Dispatchers.IO) {
        val kb = keyBackup ?: return@withContext "پشتیبانی از کلید روی سرور نیست"
        val id = try { Crypto.importBackup(kb, me, secret) } catch (e: Exception) {
            return@withContext if (kb.optInt("v", 1) == 1) "رمز درست نیست (برای این حساب رمز ورود قبلی را بزنید)" else "رمز کلید درست نیست"
        }
        keyDone(id)
        if (kb.optInt("v", 1) != 2) { keyStep.value = KeyStep.SET_PASSWORD; keyBackedUp.value = false }
        null
    }

    /** Replaces the account key with a new one (old messages cannot be opened with it). */
    suspend fun newKey(keyPass: String, accountPass: String?): String? = withContext(Dispatchers.IO) {
        val id = Crypto.generateIdentity()
        try { uploadBackup(id, keyPass, accountPass) } catch (e: Exception) { return@withContext keyErr(e) }
        keyDone(id)
        null
    }

    /** Locks this phone's key with a (new) key password. */
    suspend fun setKeyPassword(keyPass: String, accountPass: String?): String? = withContext(Dispatchers.IO) {
        try { uploadBackup(identity!!, keyPass, accountPass) } catch (e: Exception) { return@withContext keyErr(e) }
        if (keyStep.value == KeyStep.SET_PASSWORD) keyStep.value = null
        keyBackedUp.value = true
        null
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
        val self = list.firstOrNull { it.username == me }?.pubkey
        // another device made a new key for this account: stop until the user restores it here
        if (self != null && self != identity?.pubB64 && keyStep.value != KeyStep.CHOOSE) try { checkKey() } catch (e: Exception) { }
        prefs.edit().putString("users_raw", raw).apply()
        // someone found by @username stays known until the server lists them (after the first message)
        val found = users.value.filter { u -> u.found && list.none { it.username == u.username } }
        users.value = list + found
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
            try { checkKey() } catch (e: Exception) { }
        }
    }

    fun refreshRequests() {
        val l = Api.contactRequests()
        val inc = l.incoming
        val known = incomingRequests.value.map { it.username }.toSet()
        incomingRequests.value = inc
        outgoingRequests.value = l.outgoing
        declinedRequests.value = l.declined
        blockedRequests.value = l.blocked
        tick.value++
        // a request that came with messages is already announced by the message notification
        for (r in inc) if (r.msgs == 0 && r.username !in known && !prefs.getBoolean("req_seen_${r.username}_${r.ts}", false)) {
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
            "rate_limited" -> "امروز به آدم‌های تازهٔ زیادی پیام داده‌اید؛ فردا دوباره امتحان کنید"
            "not_allowed" -> "امکان ارتباط با این کاربر نیست"
            "no_request" -> "این درخواست دیگر وجود ندارد"
            else -> errText(e)
        }
    }

    /** The message-request state of a private chat: "in" / "declined" (to me), "out" (mine or a stranger), or null. */
    fun reqOf(convo: String): String? = if (isGroup(convo)) null else users.value.firstOrNull { it.username == convo }?.req

    /** Finds a member by exact @username and makes a chat with them possible. Returns (username, error). */
    suspend fun findUser(name: String): Pair<String?, String?> = withContext(Dispatchers.IO) {
        val n = name.trim().removePrefix("@").lowercase()
        try {
            val o = Api.findUser(n)
            if (o.optBoolean("me")) return@withContext null to "این نام کاربری خودتان است"
            val u = o.getString("username")
            val connected = o.optBoolean("connected")
            val canMessage = o.optBoolean("can_message")
            if (!connected && !canMessage) return@withContext null to "این کاربر از کسانی که در مخاطبانش نیستند پیام نمی‌گیرد؛ می‌توانید درخواست ارتباط بفرستید"
            val pub = if (o.isNull("pubkey")) null else o.optString("pubkey").ifEmpty { null }
            if (pub != null) db.saveKey(u, pub)
            if (users.value.none { it.username == u }) {
                val req = if (connected) null else if (o.isNull("req")) "out" else o.optString("req", "out")
                users.value = users.value + UserInfo(
                    u, pub, false, if (o.isNull("display_name")) null else o.optString("display_name"), 0, true,
                    if (o.isNull("bio")) null else o.optString("bio"), null, true, false, req, found = true
                )
                tick.value++
            }
            u to null
        } catch (e: Api.HttpError) {
            null to when (e.code) { 404 -> "کاربری با این نام کاربری پیدا نشد"; 400 -> "نام کاربری درست نیست"; 429 -> "جستجوی زیاد؛ فردا دوباره امتحان کنید"; else -> errText(e) }
        } catch (e: Exception) { null to errText(e) }
    }

    suspend fun setAllowRequests(on: Boolean): String? = withContext(Dispatchers.IO) {
        try { setPrivacyLocal(Api.setAllowRequests(on)); null } catch (e: Exception) { errText(e) }
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

    /** Another device just signed in to this account: always shown, also with the app open. */
    private fun postLoginAlert(o: JSONObject) {
        if (Build.VERSION.SDK_INT >= 33 &&
            ContextCompat.checkSelfPermission(app, Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED
        ) return
        val via = when (o.optString("via")) {
            "sms" -> "با کد پیامکی"; "device" -> "با کد دستگاه دیگر"; "admin" -> "با کد مدیر"; "password" -> "با رمز"; else -> ""
        }
        val dev = o.optString("device", "").takeIf { it.isNotEmpty() && !o.isNull("device") }?.let { " از $it" } ?: ""
        val i = Intent(app, MainActivity::class.java).apply { flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP }
        val pi = PendingIntent.getActivity(app, 7703, i, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
        val body = "ورود تازه به حساب شما$dev $via. اگر خودتان نبودید، به مدیر خبر دهید."
        val n = NotificationCompat.Builder(app, Prefs.messageChannel(app))
            .setSmallIcon(android.R.drawable.ic_lock_lock)
            .setContentTitle("🔐 ورود تازه")
            .setContentText(body)
            .setStyle(NotificationCompat.BigTextStyle().bigText(body))
            .setAutoCancel(true)
            .setContentIntent(pi)
            .build()
        NotificationManagerCompat.from(app).notify(("login:" + o.optLong("ts")).hashCode(), n)
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
            .setContentTitle(if (r.calls > 0) "تماس بی‌پاسخ" else "درخواست اتصال")
            .setContentText(if (r.calls > 0) "$who به شما زنگ زد (هنوز در مخاطبان شما نیست)" else "$who می‌خواهد با شما در ارتباط باشد")
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
                    resumeDownloads()
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
                if (connected.value && Api.token != null) resumeDownloads()
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
            // never read messages with the wrong key: they would be stored as unreadable
            if (keyStep.value == KeyStep.CHOOSE) {
                connected.value = false
                wake.receive()
                continue
            }
            try {
                refreshUsers()
                if (keyStep.value == KeyStep.CHOOSE) continue
                try { refreshGroups() } catch (e: Api.HttpError) { if (e.code == 401) throw e }
                try { refreshRequests() } catch (e: Exception) { }
                try { refreshMe() } catch (e: Exception) { }
                Stickers.refresh()
                Api.stream(
                    prefs.getLong("last_id", 0), prefs.getLong("cseq", -1), prefs.getLong("rseq", -1), deviceId, appVisible,
                    onOpen = {
                        connected.value = true
                        backoff = 1000L
                        pins.value = emptyMap() // the server re-sends every current pin right after connecting
                        flushAll()
                        synchronized(acks) { acked.clear() }
                        scope.launch { delay(2500); syncReceipts() }
                        scope.launch { delay(4000); Updater.checkAndNotify(app, appVisible) }
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
            "change" -> handleChange(o)
            "cseq" -> prefs.edit().putLong("cseq", o.getLong("seq")).apply()
            "presence" -> {
                val u = o.getString("user")
                val on = o.getBoolean("online")
                if (users.value.none { it.username == u } || on) {
                    try { refreshUsers() } catch (e: Exception) { }
                }
                val ls = if (o.isNull("last_seen")) null else o.optLong("last_seen").takeIf { it > 0 }
                users.value = users.value.map {
                    if (it.username == u) it.copy(online = on, lastSeen = ls, hidden = o.optBoolean("hidden", false), recently = o.optBoolean("recently", false)) else it
                }
            }
            "typing" -> {
                val c = o.getString("convo")
                gtyping.value = gtyping.value + (c to ((gtyping.value[c] ?: emptyMap()) + (o.getString("from") to System.currentTimeMillis())))
            }
            "receipt" -> { setReceipt(o); saveReceipts() }
            "receipts" -> {
                val a = o.optJSONArray("list") ?: JSONArray()
                for (i in 0 until a.length()) setReceipt(a.getJSONObject(i))
                saveReceipts()
            }
            "react" -> handleReact(o)
            "rseq" -> prefs.edit().putLong("rseq", o.getLong("seq")).apply()
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
            "login_alert" -> postLoginAlert(o)
            "stickers" -> scope.launch { Stickers.refresh() }
            "app_update" -> scope.launch { Updater.checkAndNotify(app, appVisible) }
            "pin" -> {
                val convo = o.getString("convo")
                if (o.isNull("messageId")) pins.value = pins.value - convo
                else pins.value = pins.value + (convo to o.getLong("messageId"))
            }
            "sig" -> {
                val kind = o.getString("kind")
                if (kind == "sig_typing") {
                    typing.value = typing.value + (o.getString("from") to System.currentTimeMillis())
                } else if (kind == "sig_lan") {
                    Lan.onSignal(o.getString("from"), o.getString("payload"))
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

        var lx: String? = null
        val msg: Msg = try {
            val pub = if (mine) null else (pubOf(from) ?: run { refreshUsers(); pubOf(from) })
            val plain = JSONObject(String(Crypto.decryptFrom(identity!!, me, from, target, pub, payload), Charsets.UTF_8))
            if (!mine) lx = plain.optString("lx").ifEmpty { null }
            val r = plain.optJSONObject("r")
            val f = plain.optJSONObject("f")
            val t = plain.optString("t", "text")
            // a voice message travels as a file with v:1, a location as text with "loc" (older apps show a file / a map link)
            val voice = t == "file" && plain.optInt("v", 0) == 1
            val loc = locOf(plain)
            val stk = stkOf(plain)
            val wf = plain.optJSONArray("wf")
            Msg(
                id, convo, from, mine, ts,
                if (voice) "voice" else if (loc != null) "location" else if (stk != null) "sticker" else t, plain.optString("x", ""),
                fileId, if (plain.has("n")) plain.getString("n") else null, if (plain.has("m")) plain.getString("m") else null,
                plain.optLong("s", 0), if (plain.has("fk")) plain.getString("fk") else null,
                plain.optInt("w", 0), plain.optInt("h", 0),
                r?.optLong("id", 0) ?: 0L, r?.optString("u"), r?.optString("x"),
                null, mine || visible,
                edited = o.optLong("edited", 0),
                fwFrom = f?.optString("u")?.ifEmpty { null }, fwName = f?.optString("n")?.ifEmpty { null },
                dur = if (voice) plain.optLong("d", 0).coerceAtLeast(0) else 0,
                wave = if (voice && wf != null) (0 until minOf(wf.length(), 100)).map { wf.optInt(it).coerceIn(0, 31) } else emptyList(),
                loc = loc, reactions = reactionMap(o.optJSONObject("reactions")), stk = stk
            )
        } catch (e: Exception) {
            Msg(id, convo, from, mine, ts, "text", LOCKED_TEXT,
                null, null, null, 0, null, 0, 0, 0L, null, null, null, true)
        }
        val isNew = db.insert(msg)
        if (isNew && lx != null && fileId != null) lanServerMessage(lx!!, msg)
        if (!isNew && msg.reactions.isNotEmpty()) db.setReactions(id, msg.reactions)
        if (!mine) ack(convo, id, if (msg.read) id else 0)
        if (isNew && !msg.read) postNotification(msg)
        if (id > prefs.getLong("last_id", 0)) prefs.edit().putLong("last_id", id).apply()
        if (isNew) tick.value++
    }

    /** An edit or a delete-for-everyone of a message we may already have. */
    private fun handleChange(o: JSONObject) {
        val id = o.getLong("id")
        when (o.getString("kind")) {
            "del" -> { db.get(id)?.let { pins.value = pins.value.filterValues { v -> v != id } }; db.delete(id) }
            "edit" -> if (db.get(id) != null) {
                val from = o.getString("from")
                val pub = if (from == me) null else pubOf(from)
                try {
                    val plain = JSONObject(String(Crypto.decryptFrom(identity!!, me, from, o.getString("target"), pub, o.getString("payload")), Charsets.UTF_8))
                    db.setEdited(id, plain.optString("x", ""), o.optLong("edited", System.currentTimeMillis()))
                } catch (e: Exception) { }
            }
        }
        val seq = o.optLong("seq", 0)
        if (seq > prefs.getLong("cseq", -1)) prefs.edit().putLong("cseq", seq).apply()
        tick.value++
    }

    private fun notifAllowed(): Boolean = Build.VERSION.SDK_INT < 33 ||
        ContextCompat.checkSelfPermission(app, Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED

    private fun openIntent(convo: String): PendingIntent {
        val i = Intent(app, MainActivity::class.java).apply {
            flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP
            putExtra("convo", convo)
        }
        return PendingIntent.getActivity(app, convo.hashCode(), i, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
    }

    /** Unread messages shown in each chat's notification (oldest first), so they stack like a conversation. */
    private class NotifLine(val sender: String, val text: String, val ts: Long)
    private val notifLines = HashMap<String, ArrayList<NotifLine>>()

    /** One notification per chat (MessagingStyle) with an inline «پاسخ» and a «خوانده شد» button. */
    private fun postNotification(m: Msg) {
        if (!notifAllowed()) return
        val group = isGroup(m.convo)
        if (!Prefs.shouldNotify(m.convo, group)) return
        val lines = synchronized(notifLines) {
            notifLines.getOrPut(m.convo) { ArrayList() }.apply { add(NotifLine(m.sender, U.preview(m), m.ts)); while (size > 8) removeAt(0) }.toList()
        }
        val style = NotificationCompat.MessagingStyle(Person.Builder().setName("شما").setKey(me).build())
        if (group) style.setConversationTitle(groupName(m.convo)).setGroupConversation(true)
        for (l in lines) style.addMessage(l.text, l.ts, Person.Builder().setName(nameOf(l.sender)).setKey(l.sender).build())
        val reply = NotificationCompat.Action.Builder(android.R.drawable.ic_menu_send, "پاسخ", NotifActions.pending(app, NotifActions.REPLY, m.convo))
            .addRemoteInput(RemoteInput.Builder(NotifActions.KEY_TEXT).setLabel("پاسخ…").build())
            .setSemanticAction(NotificationCompat.Action.SEMANTIC_ACTION_REPLY)
            .setShowsUserInterface(false)
            .setAllowGeneratedReplies(true)
            .build()
        val read = NotificationCompat.Action.Builder(android.R.drawable.ic_menu_view, "خوانده شد", NotifActions.pending(app, NotifActions.READ, m.convo))
            .setSemanticAction(NotificationCompat.Action.SEMANTIC_ACTION_MARK_AS_READ)
            .setShowsUserInterface(false)
            .build()
        val n = NotificationCompat.Builder(app, Prefs.messageChannel(app))
            .setSmallIcon(android.R.drawable.stat_notify_chat)
            .setContentTitle(if (group) groupName(m.convo) else nameOf(m.sender))
            .setContentText((if (group) nameOf(m.sender) + ": " else "") + U.preview(m))
            .setStyle(style)
            .addAction(reply)
            .addAction(read)
            .setAutoCancel(true)
            .setContentIntent(openIntent(m.convo))
            .setPriority(NotificationCompat.PRIORITY_HIGH)
            .setCategory(NotificationCompat.CATEGORY_MESSAGE)
            .build()
        NotificationManagerCompat.from(app).notify(m.convo.hashCode(), n)
    }

    /** Removes a chat's message notification (it was read here, on another device or from the notification). */
    private fun clearNotif(convo: String) {
        synchronized(notifLines) { notifLines.remove(convo) }
        NotificationManagerCompat.from(app).cancel(convo.hashCode())
    }

    private fun postReactionNotification(m: Msg, user: String, emoji: String) {
        if (appVisible && currentConvo == m.convo) return
        if (!notifAllowed() || !Prefs.shouldNotify(m.convo, isGroup(m.convo))) return
        val body = "${nameOf(user)} به پیام شما واکنش $emoji نشان داد: " + U.preview(m).take(60)
        val n = NotificationCompat.Builder(app, Prefs.messageChannel(app))
            .setSmallIcon(android.R.drawable.stat_notify_chat)
            .setContentTitle(titleOf(m.convo))
            .setContentText(body)
            .setStyle(NotificationCompat.BigTextStyle().bigText(body))
            .setAutoCancel(true)
            .setContentIntent(openIntent(m.convo))
            .setCategory(NotificationCompat.CATEGORY_MESSAGE)
            .build()
        NotificationManagerCompat.from(app).notify(("react:" + m.id).hashCode(), n)
    }

    /** «پاسخ» typed in a notification: send it, mark the chat read and wait (briefly) until it is out. */
    suspend fun replyFromNotification(convo: String, text: String) {
        sendText(convo, text, null)
        readFromNotification(convo)
        withTimeoutOrNull(8000) { flushTexts() }
    }

    /** «خوانده شد» in a notification. */
    suspend fun readFromNotification(convo: String) = withContext(Dispatchers.IO) {
        db.markRead(convo)
        clearNotif(convo)
        tick.value++
        val last = db.lastIncoming(convo)
        ack(convo, last, last)
        sendAcks()
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
        val canDm = users.value.filter { it.dm && it.req == null }.map { it.username }.toSet()
        // message requests to me live under «درخواست‌ها», not in the chat list
        val requests = users.value.filter { it.req == "in" || it.req == "declined" }.map { it.username }.toSet()
        return keys.map { db.summary(it) }
            .filter { it.convo !in requests && (isGroup(it.convo) || it.convo in canDm || it.last != null) }
            .sortedWith(compareByDescending<ConvoSummary> { it.last?.ts ?: if (isGroup(it.convo)) 1L else 0L })
    }

    fun openConvo(convo: String) {
        db.markRead(convo)
        clearNotif(convo)
        if (appVisible) ack(convo, 0, db.lastIncoming(convo))
        tick.value++
    }

    fun markReadSilently(convo: String) {
        db.markRead(convo)
        if (appVisible) ack(convo, 0, db.lastIncoming(convo))
    }

    fun deleteLocal(m: Msg) {
        db.delete(m.id)
        m.localPath?.let { File(it).delete() }
        failures.value = failures.value - m.id
        tick.value++
    }

    fun sendTyping(convo: String) {
        if (reqOf(convo) == "out") return // no "typing…" to someone who has not accepted yet
        val t = System.currentTimeMillis()
        if (t - (lastTypingSent[convo] ?: 0L) < 3000) return
        lastTypingSent[convo] = t
        scope.launch {
            try { if (isGroup(convo)) Api.typing(convo) else Api.signal(convo, "sig_typing", "1") } catch (e: Exception) { }
        }
    }

    /** Who is typing in a group right now. */
    fun typingIn(convo: String, now: Long = System.currentTimeMillis()): List<String> =
        gtyping.value[convo]?.filter { it.key != me && now - it.value < 4500 }?.keys?.toList() ?: emptyList()

    // ---------------- delivered / seen ticks ----------------

    private fun parseReceipts(raw: String?): Map<String, Map<String, Pair<Long, Long>>> = try {
        val o = JSONObject(raw ?: "{}")
        o.keys().asSequence().associateWith { c ->
            val u = o.getJSONObject(c)
            u.keys().asSequence().associateWith { k -> u.getJSONArray(k).let { it.getLong(0) to it.getLong(1) } }
        }
    } catch (e: Exception) { emptyMap() }

    private var saveReceiptsJob: Job? = null
    private fun saveReceipts() {
        if (saveReceiptsJob?.isActive == true) return
        saveReceiptsJob = scope.launch {
            delay(1000)
            val o = JSONObject()
            for ((c, us) in receipts.value) o.put(c, JSONObject().apply { for ((u, v) in us) put(u, JSONArray().put(v.first).put(v.second)) })
            prefs.edit().putString("receipts_raw", o.toString()).apply()
        }
    }

    /** Receipts are watermarks: everything up to `delivered` reached a device of that user, up to `seen` was read. */
    private fun setReceipt(o: JSONObject) {
        val convo = o.getString("convo")
        val user = o.getString("user")
        val d = o.optLong("delivered", 0)
        val s = o.optLong("seen", 0)
        val c = receipts.value[convo] ?: emptyMap()
        val old = c[user] ?: (0L to 0L)
        val nw = maxOf(old.first, d) to maxOf(old.second, s)
        if (nw != old) receipts.value = receipts.value + (convo to (c + (user to nw)))
        // read on another device of mine: read here too
        if (user == me && s > 0 && db.markReadUpTo(convo, s)) {
            if (db.summary(convo).unread == 0) clearNotif(convo)
            tick.value++
        }
    }

    private fun groupMembers(convo: String): List<String> = groups.value.firstOrNull { it.key == convo }?.members ?: emptyList()

    /** "sent" (grey ✓), "delivered" (blue ✓) or "seen" (blue ✓✓) for my message, null for others. In a group: every member. */
    fun tickOf(m: Msg, rc: Map<String, Map<String, Pair<Long, Long>>> = receipts.value): String? {
        if (!m.mine || m.id <= 0 || m.status != 0 || m.type == "call") return null
        val c = rc[m.convo] ?: emptyMap()
        fun d(u: String) = c[u]?.let { maxOf(it.first, it.second) } ?: 0L
        fun s(u: String) = c[u]?.second ?: 0L
        if (isGroup(m.convo)) {
            val others = groupMembers(m.convo).filter { it != me }
            if (others.isEmpty()) return "sent"
            if (others.all { s(it) >= m.id }) return "seen"
            return if (others.all { d(it) >= m.id }) "delivered" else "sent"
        }
        if (!hideSeen.value && s(m.convo) >= m.id) return "seen"
        return if (d(m.convo) >= m.id) "delivered" else "sent"
    }

    /** Group members by how far they got with my message: (seen, delivered, not yet delivered). */
    fun readersOf(m: Msg): Triple<List<String>, List<String>, List<String>> {
        val c = receipts.value[m.convo] ?: emptyMap()
        val seen = ArrayList<String>(); val delivered = ArrayList<String>(); val sent = ArrayList<String>()
        for (u in groupMembers(m.convo).filter { it != me }) {
            val r = c[u] ?: (0L to 0L)
            when {
                r.second >= m.id -> seen.add(u)
                maxOf(r.first, r.second) >= m.id -> delivered.add(u)
                else -> sent.add(u)
            }
        }
        return Triple(seen, delivered, sent)
    }

    /** Acks waiting to be sent (conversation -> [delivered, seen]) and the ones the server already has. */
    private val acks = HashMap<String, LongArray>()
    private val acked = HashMap<String, LongArray>()
    private var ackJob: Job? = null

    private fun ack(convo: String, delivered: Long, seen: Long, delayMs: Long = 700) {
        synchronized(acks) {
            val done = acked[convo]
            val d = if (done != null && delivered <= done[0]) 0L else delivered
            val s = if (done != null && seen <= done[1]) 0L else seen
            if (d <= 0 && s <= 0) return
            val a = acks.getOrPut(convo) { LongArray(2) }
            if (d > a[0]) a[0] = d
            if (s > a[1]) a[1] = s
            if (ackJob?.isActive == true) return
            ackJob = scope.launch { delay(delayMs); sendAcks() }
        }
    }

    private fun sendAcks() {
        val items = synchronized(acks) {
            ackJob = null
            val m = acks.mapValues { it.value[0] to it.value[1] }
            acks.clear()
            m
        }
        if (items.isEmpty() || Api.token == null) return
        try {
            Api.receipts(items)
            synchronized(acks) {
                for ((c, v) in items) {
                    val a = acked.getOrPut(c) { LongArray(2) }
                    a[0] = maxOf(a[0], v.first); a[1] = maxOf(a[1], v.second)
                }
            }
        } catch (e: Exception) {
            for ((c, v) in items) ack(c, v.first, v.second, 10_000)
        }
    }

    /** After (re)connecting: report what this phone has, so lost acks and messages from before 1.4 get ticks too. */
    private fun syncReceipts() {
        for (c in db.convos()) ack(c, db.lastIncoming(c), db.lastIncoming(c, true))
    }

    // ---------------- reactions ----------------

    val QUICK_REACTIONS = listOf("👍", "❤️", "😂", "😮", "😢", "🙏")

    private fun reactionMap(o: JSONObject?): Map<String, String> =
        o?.keys()?.asSequence()?.associateWith { o.getString(it) } ?: emptyMap()

    private fun handleReact(o: JSONObject) {
        val seq = o.optLong("seq", 0)
        if (seq > prefs.getLong("rseq", -1)) prefs.edit().putLong("rseq", seq).apply()
        val m = db.get(o.getLong("id")) ?: return
        val u = o.getString("user")
        val e = if (o.isNull("emoji")) null else o.getString("emoji")
        val before = m.reactions[u]
        db.setReactions(m.id, if (e != null) m.reactions + (u to e) else m.reactions - u)
        tick.value++
        if (m.mine && u != me && e != null && e != before) postReactionNotification(m, u, e)
    }

    /** Sets (or with null removes) my reaction to m. Returns an error text or null. */
    suspend fun react(m: Msg, emoji: String?): String? = withContext(Dispatchers.IO) {
        val before = db.get(m.id)?.reactions ?: m.reactions
        db.setReactions(m.id, if (emoji != null) before + (me to emoji) else before - me)
        tick.value++
        try { Api.react(m.id, emoji); null } catch (e: Exception) {
            db.setReactions(m.id, before)
            tick.value++
            if (e is Api.HttpError && e.code == 404) "این پیام دیگر وجود ندارد" else errText(e)
        }
    }

    /** (emoji, who) pairs, most used first. */
    fun reactionsOf(m: Msg): List<Pair<String, List<String>>> =
        m.reactions.entries.groupBy({ it.value }, { it.key }).toList().sortedByDescending { it.second.size }

    // ---------------- presence / privacy ----------------

    /** The app came to the screen or left it (others see "online" / "last seen" from this). */
    fun setActive(active: Boolean) {
        if (Api.token == null) return
        scope.launch { try { Api.presence(deviceId, active) } catch (e: Exception) { } }
    }

    private fun setPrivacyLocal(o: JSONObject) {
        hideSeen.value = o.optBoolean("hide_seen", false)
        hideLastSeen.value = o.optBoolean("hide_last_seen", false)
        if (o.has("findable")) findable.value = o.optBoolean("findable", true)
        if (o.has("allow_requests")) allowRequests.value = o.optBoolean("allow_requests", true)
        if (o.has("requests_on")) requestsOn.value = o.optBoolean("requests_on", true)
        if (o.has("username")) diag.value = o.optBoolean("diag", false) // /api/me only
        prefs.edit().putBoolean("hide_seen", hideSeen.value).putBoolean("hide_last_seen", hideLastSeen.value).apply()
    }

    private fun refreshMe() = setPrivacyLocal(Api.me())

    suspend fun setFindable(on: Boolean): String? = withContext(Dispatchers.IO) {
        try { setPrivacyLocal(Api.setFindable(on)); null } catch (e: Exception) { errText(e) }
    }

    /** A member found by mobile number. */
    data class Found(val phone: String, val name: String?, val username: String, val displayName: String?, val connected: Boolean)

    /** Matches (phone, name in the phone's contacts) against the members; Pair(found, error). */
    suspend fun lookup(numbers: List<Pair<String, String?>>): Pair<List<Found>?, String?> = withContext(Dispatchers.IO) {
        try {
            val a = Api.lookup(numbers.map { it.first })
            // the server answers with normalized numbers: match them back to the contact names by their last 10 digits
            val names = numbers.associate { it.first.filter(Char::isDigit).takeLast(10) to it.second }
            val out = (0 until a.length()).map { i ->
                val o = a.getJSONObject(i)
                val ph = o.getString("phone")
                Found(ph, names[ph.filter(Char::isDigit).takeLast(10)], o.getString("username"),
                    if (o.isNull("display_name")) null else o.optString("display_name"), o.optBoolean("connected"))
            }
            out to null
        } catch (e: Api.HttpError) {
            null to (if (e.code == 429) "امروز بیش از حد جستجو کرده‌اید؛ فردا دوباره امتحان کنید" else errText(e))
        } catch (e: Exception) { null to errText(e) }
    }

    /** Mobile numbers in the phone's contacts (needs READ_CONTACTS): (number, contact name). */
    fun phoneContacts(): List<Pair<String, String?>> {
        val out = LinkedHashMap<String, String?>()
        val uri = android.provider.ContactsContract.CommonDataKinds.Phone.CONTENT_URI
        val cols = arrayOf(android.provider.ContactsContract.CommonDataKinds.Phone.NUMBER, android.provider.ContactsContract.CommonDataKinds.Phone.DISPLAY_NAME)
        app.contentResolver.query(uri, cols, null, null, null)?.use { c ->
            while (c.moveToNext()) {
                val n = c.getString(0) ?: continue
                val digits = n.filter { it.isDigit() || it == '+' }
                if (digits.count { it.isDigit() } >= 7) out.putIfAbsent(digits, c.getString(1))
            }
        }
        return out.entries.take(2000).map { it.key to it.value }
    }

    suspend fun setPrivacy(hideSeen: Boolean, hideLastSeen: Boolean): String? = withContext(Dispatchers.IO) {
        try {
            setPrivacyLocal(Api.privacy(hideSeen, hideLastSeen))
            try { refreshUsers() } catch (e: Exception) { }
            null
        } catch (e: Exception) { errText(e) }
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

    // ---------------- edit / delete for everyone / forward ----------------

    const val EDIT_WINDOW_MS = 48 * 3600_000L

    fun canEdit(m: Msg): Boolean =
        m.mine && m.type == "text" && m.id > 0 && m.status == 0 && System.currentTimeMillis() - m.ts < EDIT_WINDOW_MS

    /** The plaintext JSON a message is sent with (also rebuilt from what we stored, for edits). */
    private fun plainOf(m: Msg, text: String = m.text): JSONObject {
        val l = m.loc
        val p = when {
            m.type == "sticker" && m.stk != null -> JSONObject().put("t", "text").put("x", stickerText(m.stk))
                .put("stk", JSONObject().put("id", m.stk.id).put("p", m.stk.p).put("e", m.stk.e))
            m.type == "text" || m.type == "sticker" || (m.type == "location" && l == null) -> JSONObject().put("t", "text").put("x", text)
            m.type == "location" && l != null -> JSONObject().put("t", "text").put("x", locText(l))
                .put("loc", JSONObject().put("lat", l.lat).put("lon", l.lon).put("acc", l.acc))
            else -> JSONObject().put("t", if (m.type == "voice") "file" else m.type).put("n", m.fileName ?: "file")
                .put("m", m.mime ?: "application/octet-stream").put("s", m.size).put("fk", m.fkey ?: "").put("w", m.w).put("h", m.h)
                .also { if (m.type == "voice") it.put("v", 1).put("d", m.dur).put("wf", JSONArray(m.wave)) }
        }
        replyJson(p, m)
        forwardJson(p, m)
        return p
    }

    // ---------------- location ----------------

    /** A location is a text message with an extra "loc" field, so apps before 1.4 show it as a map link. */
    private fun locOf(plain: JSONObject): Loc? {
        if (plain.optString("t", "text") != "text") return null
        val l = plain.optJSONObject("loc") ?: return null
        val lat = l.optDouble("lat", Double.NaN)
        val lon = l.optDouble("lon", Double.NaN)
        if (lat.isNaN() || lon.isNaN() || kotlin.math.abs(lat) > 90 || kotlin.math.abs(lon) > 180) return null
        return Loc(lat, lon, l.optDouble("acc", 0.0).toInt().coerceAtLeast(0))
    }

    fun locText(l: Loc): String {
        val a = "%.6f".format(Locale.US, l.lat)
        val b = "%.6f".format(Locale.US, l.lon)
        return "📍 موقعیت مکانی: https://www.openstreetmap.org/?mlat=$a&mlon=$b#map=17/$a/$b"
    }

    /** Queues my current position (one point, end-to-end encrypted like any message). */
    fun sendLocation(convo: String, loc: Loc, reply: Msg?) {
        db.insert(
            Msg(-System.nanoTime(), convo, me, true, System.currentTimeMillis(), "location", locText(loc), null, null, null, 0, null, 0, 0,
                reply?.id?.takeIf { it > 0 } ?: 0L, reply?.sender, reply?.let { U.preview(it).take(80) }, null, true, status = 1, loc = loc)
        )
        tick.value++
        scope.launch { flushTexts() }
    }

    // ---------------- stickers (1.10) ----------------

    /** A sticker is a text message with an extra "stk" field, so apps before 1.10 show its emoji and «استیکر». */
    private fun stkOf(plain: JSONObject): Stk? {
        if (plain.optString("t", "text") != "text") return null
        val k = plain.optJSONObject("stk") ?: return null
        val id = k.optString("id"); val p = k.optString("p")
        if (!Regex("^[a-f0-9]{32}$").matches(id) || !Regex("^[a-f0-9]{16}$").matches(p)) return null
        return Stk(id, p, k.optString("e").take(16))
    }

    fun stickerText(k: Stk) = (k.e.ifEmpty { "🎭" }) + " استیکر"

    fun sendSticker(convo: String, k: Stk, reply: Msg?) {
        Stickers.addRecent(k)
        db.insert(
            Msg(-System.nanoTime(), convo, me, true, System.currentTimeMillis(), "sticker", stickerText(k), null, null, null, 0, null, 0, 0,
                reply?.id?.takeIf { it > 0 } ?: 0L, reply?.sender, reply?.let { U.preview(it).take(80) }, null, true, status = 1, stk = k)
        )
        tick.value++
        scope.launch { flushTexts() }
    }

    // ---------------- voice messages ----------------

    /** Where VoiceRecorder writes a new recording. */
    fun newRecordingFile(): File = File(mediaDir(), "rec_${System.nanoTime()}.m4a")

    /** Queues a recorded voice message (AAC in MP4) for the same encrypted upload as files. */
    fun sendVoice(convo: String, rec: File, durMs: Long, wave: List<Int>, reply: Msg?) {
        val localId = -System.nanoTime()
        val f = File(mediaDir(), "out_${-localId}")
        if (!rec.renameTo(f)) { rec.copyTo(f, overwrite = true); rec.delete() }
        val now = System.currentTimeMillis()
        val vm = Msg(localId, convo, me, true, now, "voice", "", null, "voice-$now.m4a", "audio/mp4", f.length(), Crypto.newFileKey(), 0, 0,
                reply?.id?.takeIf { it > 0 } ?: 0L, reply?.sender, reply?.let { U.preview(it).take(80) }, f.absolutePath, true,
                status = 1, dur = durMs, wave = wave)
        db.insert(vm)
        Lan.offer(vm)
        tick.value++
        scope.launch { flushFiles() }
    }

    private fun forwardJson(plain: JSONObject, m: Msg) {
        if (m.fwFrom != null) plain.put("f", JSONObject().put("u", m.fwFrom).put("n", m.fwName ?: ""))
    }

    /** Edits my text message; the old version is kept on the server encrypted for me only. */
    suspend fun editMessage(m: Msg, newText: String): String? = withContext(Dispatchers.IO) {
        try {
            val payload = encryptFor(m.convo, plainOf(m, newText).toString().toByteArray())
            val id = identity!!
            val prev = Crypto.encryptFor(id, me, m.convo, mapOf(me to id.pubB64), plainOf(m).toString().toByteArray())
            val at = Api.edit(m.id, payload, prev)
            db.setEdited(m.id, newText, at)
            tick.value++
            null
        } catch (e: Api.HttpError) {
            if (e.code == 403 && (e.message ?: "").contains("edit_window_passed")) "فقط تا ۴۸ ساعت بعد از ارسال می‌شود پیام را ویرایش کرد" else errText(e)
        } catch (e: Exception) { errText(e) }
    }

    suspend fun deleteForAll(m: Msg): String? = withContext(Dispatchers.IO) {
        try {
            Api.deleteForAll(m.id)
            db.delete(m.id)
            tick.value++
            null
        } catch (e: Exception) { errText(e) }
    }

    /** Earlier texts of my edited message, oldest first, with the time each was replaced. */
    suspend fun editHistory(m: Msg): List<Pair<String, Long>> = withContext(Dispatchers.IO) {
        try {
            Api.history(m.id).mapNotNull { (payload, ts) ->
                try {
                    val plain = JSONObject(String(Crypto.decryptFrom(identity!!, me, me, m.convo, null, payload), Charsets.UTF_8))
                    plain.optString("x", "") to ts
                } catch (e: Exception) { null }
            }
        } catch (e: Exception) { emptyList() }
    }

    /**
     * Forwards messages to other chats. Files are not uploaded again: the new message points to the same
     * file and carries its key. With hideSender the copy looks like my own message.
     */
    fun forward(msgs: List<Msg>, targets: List<String>, hideSender: Boolean) {
        val now = System.currentTimeMillis()
        var n = 0
        for (t in targets) for (m in msgs.sortedBy { it.ts }) {
            if (m.status != 0 || m.type == "call" || m.id <= 0) continue
            val origin = m.fwFrom ?: m.sender
            val originName = m.fwName ?: nameOf(m.sender)
            val fw = if (hideSender) null else origin
            val copy = Msg(
                -System.nanoTime(), t, me, true, now + n++, m.type, m.text, null, m.fileName, m.mime, m.size, m.fkey, m.w, m.h,
                0L, null, null, m.localPath?.takeIf { File(it).exists() }, true, status = 1,
                uploadId = m.fileId?.let { "f:$it" }, fwFrom = fw, fwName = if (fw != null) originName else null,
                dur = m.dur, wave = m.wave, loc = m.loc, stk = m.stk
            )
            if (m.type !in TEXTISH && m.fileId == null) continue
            db.insert(copy)
        }
        tick.value++
        flushAll()
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
    suspend fun sendUri(convo: String, uri: Uri, asImage: Boolean, reply: Msg?, compress: Boolean = false): String? = withContext(Dispatchers.IO) {
        var staged: File? = null
        try {
            if (asImage && compress && app.contentResolver.getType(uri) != "image/gif") {
                val localId = -System.nanoTime()
                val f = File(mediaDir(), "out_${-localId}")
                staged = f
                if (compressPhoto(app, uri, f)) {
                    val dim = imageSizeOf(f.absolutePath)
                    if (dim != null) {
                        val base = U.fileName(app, uri).substringBeforeLast('.').ifBlank { "photo" }
                        val fm = Msg(localId, convo, me, true, System.currentTimeMillis(), "image", "", null, "$base.jpg", "image/jpeg", f.length(),
                                Crypto.newFileKey(), dim.first, dim.second,
                                reply?.id?.takeIf { it > 0 } ?: 0L, reply?.sender, reply?.let { U.preview(it).take(80) },
                                f.absolutePath, true, status = 1)
                        db.insert(fm)
                        Lan.offer(fm)
                        tick.value++
                        scope.launch { flushFiles() }
                        return@withContext null
                    }
                }
                f.delete(); staged = null // could not compress: fall back to sending the original
            }
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
            val fm = Msg(localId, convo, me, true, System.currentTimeMillis(), type, "", null, name, mime, size,
                    Crypto.newFileKey(), w, h,
                    reply?.id?.takeIf { it > 0 } ?: 0L, reply?.sender, reply?.let { U.preview(it).take(80) },
                    f.absolutePath, true, status = 1)
            db.insert(fm)
            Lan.offer(fm)
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
                if (m.type !in TEXTISH || Api.token == null) continue
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
        val (id, ts) = Api.send(m.convo, encryptFor(m.convo, plainOf(m).toString().toByteArray()), null)
        db.insert(m.copy(id = id, ts = ts, status = 0, uploadId = null, read = true))
        db.delete(m.id)
        tick.value++
    }

    private suspend fun flushFiles() {
        if (Api.token == null) return
        fileLock.withLock {
            for (m in db.outbox()) {
                if (m.type in TEXTISH || Api.token == null) continue
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
        // a forwarded file is already on the server ("f:" upload id), so it needs no local copy
        val known = m.uploadId?.startsWith("f:") == true
        val f = m.localPath?.let { File(it) }
        if (!known && (f == null || !f.exists())) throw UserError("فایل محلی پیدا نشد")
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
            val src = f!!
            setProgress(m.id, off.toFloat() / total)
            val plainBuf = ByteArray(Crypto.FILE_CHUNK)
            val block = ByteArray(Crypto.CIPHER_CHUNK * 4)
            var resyncs = 0
            RandomAccessFile(src, "r").use { raf ->
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

        // 1.8: the transfer id of the direct Wi-Fi copy, so the receiver can use that instead of downloading
        val plainFile = plainOf(m.copy(fkey = fkey)).also { p -> Lan.idOf(m.id)?.let { p.put("lx", it) } }
        val (id, ts) = Api.send(m.convo, encryptFor(m.convo, plainFile.toString().toByteArray()), fileId)
        Lan.forget(m.id)
        val dest = File(mediaDir(), fileId!!)
        if (f != null && f.exists() && f.absolutePath != dest.absolutePath) {
            if (known) { if (!dest.exists()) f.copyTo(dest) } else if (!f.renameTo(dest)) { f.copyTo(dest, overwrite = true); f.delete() }
        }
        val path = dest.takeIf { it.exists() }?.absolutePath
        db.insert(m.copy(id = id, ts = ts, status = 0, uploadId = null, fileId = fileId, localPath = path, read = true))
        if (path != null) db.setLocalPath(id, path)
        db.delete(m.id)
        setProgress(m.id, null)
        tick.value++
    }

    // ---------------- direct transfer on the same Wi-Fi (1.8, see Lan.kt) ----------------

    /** inside media/ so the share / open-with provider can reach a file that came over Wi-Fi */
    fun lanDir(): File = File(mediaDir(), "lan").also { it.mkdirs() }
    /** transfer id -> (temporary message id, file) for files that came over Wi-Fi before the server message */
    private val lanDone = java.util.concurrent.ConcurrentHashMap<String, Pair<Long, File>>()
    /** transfer id -> the server message, when that came first */
    private val lanReal = java.util.concurrent.ConcurrentHashMap<String, Msg>()

    /** A file arrived directly over the local network: shown at once, the server copy's message replaces it later. */
    fun lanArrived(from: String, meta: JSONObject, x: String, file: File) {
        lanReal.remove(x)?.let { real -> lanAttach(real, file); return }
        val t = meta.optString("t", "file")
        val voice = t == "file" && meta.optInt("v", 0) == 1
        val wf = meta.optJSONArray("wf")
        val id = -System.nanoTime()
        db.insert(
            Msg(id, from, from, false, System.currentTimeMillis(), if (voice) "voice" else if (t == "image") "image" else "file", "",
                null, meta.optString("n", "file"), meta.optString("m").ifEmpty { null }, meta.optLong("s", file.length()),
                meta.optString("fk"), meta.optInt("w", 0), meta.optInt("h", 0), 0L, null, null, file.absolutePath,
                appVisible && currentConvo == from,
                dur = if (voice) meta.optLong("d", 0).coerceAtLeast(0) else 0,
                wave = if (voice && wf != null) (0 until minOf(wf.length(), 100)).map { wf.optInt(it).coerceIn(0, 31) } else emptyList())
        )
        lanDone[x] = id to file
        tick.value++
    }

    private fun lanAttach(real: Msg, file: File) {
        val fid = real.fileId ?: return
        val dest = File(mediaDir(), fid)
        if (dest.exists()) file.delete() else if (!file.renameTo(dest)) { file.copyTo(dest, overwrite = true); file.delete() }
        db.setLocalPath(real.id, dest.absolutePath)
        tick.value++
    }

    /** The server message of a file sent over Wi-Fi too: it takes the file (no download), the temporary message goes. */
    private fun lanServerMessage(x: String, real: Msg) {
        val d = lanDone.remove(x)
        if (d == null) { lanReal[x] = real; return }
        db.delete(d.first)
        lanAttach(real, d.second)
    }

    // ---------------- downloading ----------------

    /** Continues the downloads the network cut off (called when the network is back and every few seconds). */
    fun resumeDownloads() {
        for (m in waitingDownloads.value.values) if (!progress.value.containsKey(m.id)) scope.launch { downloadMedia(m) }
    }

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
                    // a short drop is bridged here; a longer one hands over to resumeDownloads() (same .part file)
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
            waitingDownloads.value = waitingDownloads.value - m.id
            tick.value++
            dest.absolutePath
        } catch (e: Exception) {
            waitingDownloads.value = if (isTransient(e) && Api.token != null) waitingDownloads.value + (m.id to m) else waitingDownloads.value - m.id
            null
        } finally {
            setProgress(m.id, null)
        }
    }
}
