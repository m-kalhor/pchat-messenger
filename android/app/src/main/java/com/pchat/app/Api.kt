package com.pchat.app

import android.content.Context
import okhttp3.Call
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONArray
import org.json.JSONObject
import java.io.IOException
import java.io.InputStream
import java.security.KeyStore
import java.security.cert.CertificateFactory
import java.util.concurrent.TimeUnit
import javax.net.ssl.SSLContext
import javax.net.ssl.TrustManagerFactory
import javax.net.ssl.X509TrustManager

data class UserInfo(
    val username: String, val pubkey: String?, val online: Boolean,
    val displayName: String? = null, val avatarVer: Int = 0, val dm: Boolean = true, val bio: String? = null,
    /** when they were last online (null = online now, unknown or hidden) */
    val lastSeen: Long? = null,
    /** "last seen" is hidden between us (either side hides it); then only [recently] (within 3 days) is known */
    val hidden: Boolean = false, val recently: Boolean = false
)
data class ContactRequest(val username: String, val displayName: String?, val status: String, val ts: Long)
data class GroupInfo(val key: String, val name: String, val members: List<String>)
class TurnInfo(val urls: List<String>, val user: String, val cred: String, val expiresAt: Long)
class PatchResult(val offset: Long, val done: Boolean, val fileId: String?)

fun parseUsers(raw: String): List<UserInfo> {
    val arr = JSONArray(raw)
    return (0 until arr.length()).map {
        val o = arr.getJSONObject(it)
        UserInfo(
            o.getString("username"), if (o.isNull("pubkey")) null else o.getString("pubkey"), o.getBoolean("online"),
            if (o.isNull("display_name")) null else o.getString("display_name"), o.optInt("avatar_ver", 0), o.optBoolean("dm", true),
            if (o.isNull("bio")) null else o.optString("bio", "").ifEmpty { null },
            if (o.isNull("last_seen")) null else o.optLong("last_seen").takeIf { it > 0 },
            o.optBoolean("hidden", false), o.optBoolean("recently", false)
        )
    }
}

fun parseGroups(raw: String): List<GroupInfo> {
    val arr = JSONArray(raw)
    return (0 until arr.length()).map {
        val o = arr.getJSONObject(it)
        val m = o.getJSONArray("members")
        GroupInfo(o.getString("key"), o.getString("name"), (0 until m.length()).map { i -> m.getString(i) })
    }
}

object Api {
    class HttpError(val code: Int, msg: String) : IOException(msg) {
        /** The server's error code ({"error": "..."}), or "" when the body is not JSON. */
        val error: String get() = try { JSONObject(message ?: "").optString("error") } catch (e: Exception) { "" }
        val wait: Int get() = try { JSONObject(message ?: "").optInt("wait", 60) } catch (e: Exception) { 60 }
    }

    private lateinit var client: OkHttpClient
    private lateinit var streamClient: OkHttpClient
    @Volatile var token: String? = null
    @Volatile private var streamCall: Call? = null

    private val JSON = "application/json".toMediaType()
    private val BIN = "application/octet-stream".toMediaType()

    /** Trusts ONLY the server certificate bundled in res/raw/server_cert.pem (certificate pinning). */
    fun init(ctx: Context) {
        val cert = ctx.resources.openRawResource(R.raw.server_cert).use {
            CertificateFactory.getInstance("X.509").generateCertificate(it)
        }
        val ks = KeyStore.getInstance(KeyStore.getDefaultType()).apply {
            load(null, null)
            setCertificateEntry("server", cert)
        }
        val tmf = TrustManagerFactory.getInstance(TrustManagerFactory.getDefaultAlgorithm()).apply { init(ks) }
        val tm = tmf.trustManagers.first { it is X509TrustManager } as X509TrustManager
        val ssl = SSLContext.getInstance("TLS").apply { init(null, arrayOf(tm), null) }
        client = OkHttpClient.Builder()
            .sslSocketFactory(ssl.socketFactory, tm)
            .connectTimeout(15, TimeUnit.SECONDS)
            .readTimeout(60, TimeUnit.SECONDS)
            .writeTimeout(120, TimeUnit.SECONDS)
            .retryOnConnectionFailure(true)
            .build()
        streamClient = client.newBuilder().readTimeout(45, TimeUnit.SECONDS).build()
    }

    private fun req(path: String): Request.Builder {
        val b = Request.Builder().url(Config.BASE + path)
        token?.let { b.header("Authorization", "Bearer $it") }
        return b
    }

    private fun exec(r: Request): String {
        client.newCall(r).execute().use { resp ->
            val body = resp.body?.string() ?: ""
            if (!resp.isSuccessful) throw HttpError(resp.code, body)
            return body
        }
    }

    /** Returns {token, username, key_backup (object or null)}. */
    fun login(user: String, pass: String, pub: String): JSONObject {
        val body = JSONObject().put("username", user).put("password", pass).put("pubkey", pub).toString()
        val r = Request.Builder().url(Config.BASE + "/api/login").post(body.toRequestBody(JSON)).build()
        return JSONObject(exec(r))
    }

    private fun postPublic(path: String, body: JSONObject): String =
        exec(Request.Builder().url(Config.BASE + path).post(body.toString().toRequestBody(JSON)).build())

    /** What the login screen offers: {sms, password, apk}. */
    fun authConfig(): JSONObject = JSONObject(exec(Request.Builder().url(Config.BASE + "/api/auth/config").get().build()))

    /** Asks for a login code by SMS. */
    fun smsCode(phone: String) { postPublic("/api/auth/sms", JSONObject().put("phone", phone)) }

    /** Signs in with a one-time code (SMS, another device, or the admin); same answer as login(). */
    fun codeLogin(phone: String, code: String, pub: String?): JSONObject {
        val b = JSONObject().put("phone", phone).put("code", code).put("device", "Android")
        if (pub != null) b.put("pubkey", pub)
        return JSONObject(postPublic("/api/auth/code", b))
    }

    /** A one-time code for signing in on another device: {code, ttl, phone}. */
    fun deviceCode(): JSONObject = JSONObject(exec(req("/api/auth/devicecode").post("{}".toRequestBody(JSON)).build()))

    /** Sends an SMS code that stands in for the login password when the key backup changes. */
    fun reauthSms() { exec(req("/api/auth/reauth").post("{}".toRequestBody(JSON)).build()) }

    /** Stores the password-encrypted identity key on the server (also makes its pub the account's key). */
    fun uploadKeyBackup(kb: JSONObject, pass: String) {
        val body = JSONObject().put("key_backup", kb).put("password", pass).toString()
        exec(req("/api/keybackup").post(body.toRequestBody(JSON)).build())
    }

    fun keyBackup(): JSONObject? = JSONObject(exec(req("/api/keybackup").get().build())).optJSONObject("key_backup")

    fun logout(t: String?) {
        if (t == null) return
        val r = Request.Builder().url(Config.BASE + "/api/logout").header("Authorization", "Bearer $t")
            .post("{}".toRequestBody(JSON)).build()
        exec(r)
    }

    /** incoming = people asking me; outgoing = my own requests (status pending/declined). */
    fun contactRequests(): Pair<List<ContactRequest>, List<ContactRequest>> {
        val o = JSONObject(exec(req("/api/contacts/requests").get().build()))
        fun list(k: String) = o.getJSONArray(k).let { a ->
            (0 until a.length()).map { i ->
                val r = a.getJSONObject(i)
                ContactRequest(r.getString("username"), if (r.isNull("display_name")) null else r.optString("display_name", "").ifEmpty { null },
                    r.optString("status", "pending"), r.optLong("ts"))
            }
        }
        return list("incoming") to list("outgoing")
    }

    /** what = request | respond | cancel | remove. Returns the server's result ("sent", "connected" or "ok"). */
    fun contactAction(what: String, username: String, accept: Boolean = false): String {
        val body = JSONObject().put("username", username).put("accept", accept).toString()
        return JSONObject(exec(req("/api/contacts/$what").post(body.toRequestBody(JSON)).build())).optString("result", "ok")
    }

    fun usersRaw(): String = exec(req("/api/users").get().build())
    fun groupsRaw(): String = exec(req("/api/groups").get().build())

    fun setProfile(name: String, bio: String) {
        exec(req("/api/profile").post(JSONObject().put("display_name", name).put("bio", bio).toString().toRequestBody(JSON)).build())
    }

    /** Removes the profile photo. Returns the new (non-positive) avatar version. */
    fun deleteAvatar(): Int = JSONObject(exec(req("/api/avatar").delete().build())).getInt("avatar_ver")

    /** body must be a WebP no larger than 512x512. Returns the new avatar version. */
    fun uploadAvatar(webp: ByteArray): Int =
        JSONObject(exec(req("/api/avatar").post(webp.toRequestBody("image/webp".toMediaType())).build())).getInt("avatar_ver")

    fun downloadAvatar(user: String): ByteArray {
        client.newCall(req("/api/avatar/$user").get().build()).execute().use { resp ->
            if (!resp.isSuccessful) throw HttpError(resp.code, "avatar")
            return resp.body!!.bytes()
        }
    }

    fun pin(target: String, messageId: Long?) {
        val b = JSONObject().put("target", target).put("messageId", if (messageId == null) JSONObject.NULL else messageId)
        exec(req("/api/pin").post(b.toString().toRequestBody(JSON)).build())
    }

    fun send(target: String, payload: String, fileId: String?): Pair<Long, Long> {
        val b = JSONObject().put("target", target).put("kind", "msg").put("payload", payload)
        if (fileId != null) b.put("fileId", fileId)
        val o = JSONObject(exec(req("/api/send").post(b.toString().toRequestBody(JSON)).build()))
        return Pair(o.getLong("id"), o.getLong("ts"))
    }

    /** Replaces the text of my message; prev = the old version encrypted for me only (edit history). Returns the edit time. */
    fun edit(id: Long, payload: String, prev: String?): Long {
        val b = JSONObject().put("id", id).put("payload", payload)
        if (prev != null) b.put("prev", prev)
        return JSONObject(exec(req("/api/edit").post(b.toString().toRequestBody(JSON)).build())).getLong("edited")
    }

    /** Deletes my message for everyone. */
    fun deleteForAll(id: Long) {
        exec(req("/api/delete").post(JSONObject().put("id", id).toString().toRequestBody(JSON)).build())
    }

    /** Earlier versions of my edited message: (payload encrypted for me only, time it was replaced). */
    fun history(id: Long): List<Pair<String, Long>> {
        val a = JSONObject(exec(req("/api/history?id=$id").get().build())).getJSONArray("versions")
        return (0 until a.length()).map { a.getJSONObject(it).let { v -> v.getString("payload") to v.getLong("ts") } }
    }

    /** {hide_seen, hide_last_seen, ...} of my account. */
    fun me(): JSONObject = JSONObject(exec(req("/api/me").get().build()))

    /** Saves my privacy switches; returns the stored values. */
    fun privacy(hideSeen: Boolean, hideLastSeen: Boolean): JSONObject {
        val b = JSONObject().put("hide_seen", hideSeen).put("hide_last_seen", hideLastSeen)
        return JSONObject(exec(req("/api/privacy").post(b.toString().toRequestBody(JSON)).build()))
    }

    /** This device's app came to the screen (active) or left it. */
    fun presence(dev: String, active: Boolean) {
        exec(req("/api/presence").post(JSONObject().put("dev", dev).put("active", active).toString().toRequestBody(JSON)).build())
    }

    /** Delivered / seen watermarks: target -> (delivered, seen). */
    fun receipts(items: Map<String, Pair<Long, Long>>) {
        val arr = JSONArray()
        for ((t, v) in items) arr.put(JSONObject().put("target", t).put("delivered", v.first).put("seen", v.second))
        exec(req("/api/receipts").post(JSONObject().put("items", arr).toString().toRequestBody(JSON)).build())
    }

    /** "typing…" in a group. */
    fun typing(target: String) {
        exec(req("/api/typing").post(JSONObject().put("target", target).toString().toRequestBody(JSON)).build())
    }

    /** Sets my reaction to a message; null removes it. */
    fun react(id: Long, emoji: String?) {
        val b = JSONObject().put("id", id).put("emoji", emoji ?: JSONObject.NULL)
        exec(req("/api/react").post(b.toString().toRequestBody(JSON)).build())
    }

    /** Returns true if the other side was online and received the signal. */
    fun signal(target: String, kind: String, payload: String): Boolean {
        val b = JSONObject().put("target", target).put("kind", kind).put("payload", payload)
        return JSONObject(exec(req("/api/send").post(b.toString().toRequestBody(JSON)).build())).optBoolean("delivered", false)
    }

    fun turn(): TurnInfo {
        val o = JSONObject(exec(req("/api/turn").get().build()))
        val arr = o.getJSONArray("urls")
        return TurnInfo(
            (0 until arr.length()).map { arr.getString(it) },
            o.getString("username"), o.getString("credential"),
            System.currentTimeMillis() + o.getLong("ttl") * 1000
        )
    }

    // ---------------- resumable chunked upload ----------------

    fun createUpload(size: Long): String =
        JSONObject(exec(req("/api/uploads").post(JSONObject().put("size", size).toString().toRequestBody(JSON)).build())).getString("uploadId")

    /** Current server-side offset of an upload. Throws HttpError(404) if the session is gone. */
    fun uploadStatus(id: String): Long = JSONObject(exec(req("/api/uploads/$id").get().build())).getLong("offset")

    fun patchUpload(id: String, offset: Long, data: ByteArray, len: Int): PatchResult {
        val r = req("/api/uploads/$id")
            .header("Upload-Offset", offset.toString())
            .patch(data.toRequestBody(BIN, 0, len)).build()
        val o = JSONObject(exec(r))
        return PatchResult(o.getLong("offset"), o.optBoolean("done", false), if (o.has("fileId")) o.getString("fileId") else null)
    }

    // ---------------- downloads ----------------

    /** Legacy: whole file in memory (messages from older app versions, max ~25 MB). */
    fun download(id: String): ByteArray {
        client.newCall(req("/api/file/$id").get().build()).execute().use { resp ->
            if (!resp.isSuccessful) throw HttpError(resp.code, "download")
            return resp.body!!.bytes()
        }
    }

    /** Streams the file starting at byte [start] (HTTP Range) so interrupted downloads can resume. */
    fun downloadRange(id: String, start: Long, block: (InputStream) -> Unit) {
        val b = req("/api/file/$id").get()
        if (start > 0) b.header("Range", "bytes=$start-")
        client.newCall(b.build()).execute().use { resp ->
            if (resp.code != 200 && resp.code != 206) throw HttpError(resp.code, "download")
            block(resp.body!!.byteStream())
        }
    }

    fun cancelStream() { streamCall?.cancel() }

    /** Blocks while connected. Server sends a ping every 15 s, so a 45 s read timeout detects dead links. */
    /** csince / rsince = last edit-delete / reaction number seen (-1 = none yet: the server only reports the current number). */
    /** dev identifies this phone; active = the app is on screen (others see "online" only then). */
    fun stream(since: Long, csince: Long, rsince: Long, dev: String, active: Boolean, onOpen: () -> Unit, onEvent: (String, String) -> Unit) {
        val q = "since=$since&csince=$csince&rsince=$rsince&dev=$dev&active=${if (active) 1 else 0}"
        val call = streamClient.newCall(req("/api/events?$q").header("Accept", "text/event-stream").get().build())
        streamCall = call
        call.execute().use { resp ->
            if (!resp.isSuccessful) throw HttpError(resp.code, "stream")
            onOpen()
            val src = resp.body!!.source()
            var event = "message"
            val data = StringBuilder()
            while (true) {
                val line = src.readUtf8Line() ?: break
                when {
                    line.isEmpty() -> {
                        if (data.isNotEmpty()) onEvent(event, data.toString())
                        event = "message"
                        data.setLength(0)
                    }
                    line.startsWith(":") -> {}
                    line.startsWith("event:") -> event = line.substring(6).trim()
                    line.startsWith("data:") -> {
                        if (data.isNotEmpty()) data.append('\n')
                        data.append(line.substring(5).trimStart())
                    }
                }
            }
        }
    }
}
