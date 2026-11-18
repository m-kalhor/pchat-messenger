package com.sepan.admin

import android.content.Context
import android.net.http.SslCertificate
import android.os.Build
import org.json.JSONObject
import java.io.File
import java.io.IOException
import java.net.HttpURLConnection
import java.net.URL
import java.security.KeyStore
import java.security.cert.CertificateFactory
import java.security.cert.X509Certificate
import javax.net.ssl.HttpsURLConnection
import javax.net.ssl.SSLContext
import javax.net.ssl.SSLSocketFactory
import javax.net.ssl.TrustManagerFactory

/** Calls to the admin panel API. Trusts ONLY the server certificate in res/raw/server_cert.pem (pinning). */
object Net {
    val BASE = "https://" + BuildConfig.SERVER_HOST + ":" + BuildConfig.ADMIN_PORT

    private lateinit var ssl: SSLSocketFactory
    private lateinit var pinned: X509Certificate

    class Resp(val code: Int, val json: JSONObject, val setCookie: String?) {
        val ok get() = code in 200..299
        val error: String get() = json.optString("error")
    }

    fun init(ctx: Context) {
        if (::ssl.isInitialized) return
        pinned = ctx.resources.openRawResource(R.raw.server_cert).use {
            CertificateFactory.getInstance("X.509").generateCertificate(it) as X509Certificate
        }
        val ks = KeyStore.getInstance(KeyStore.getDefaultType()).apply {
            load(null, null)
            setCertificateEntry("server", pinned)
        }
        val tmf = TrustManagerFactory.getInstance(TrustManagerFactory.getDefaultAlgorithm()).apply { init(ks) }
        ssl = SSLContext.getInstance("TLS").apply { init(null, tmf.trustManagers, null) }.socketFactory
    }

    /** The WebView asks about the self-signed certificate: allowed only when it is exactly the pinned one. */
    fun isPinned(c: SslCertificate?): Boolean {
        if (c == null) return false
        val der: ByteArray? = if (Build.VERSION.SDK_INT >= 29) {
            try { c.x509Certificate?.encoded } catch (e: Exception) { null }
        } else {
            SslCertificate.saveState(c)?.getByteArray("x509-certificate")
        }
        return der != null && der.contentEquals(pinned.encoded)
    }

    private fun open(path: String, cookie: String?): HttpsURLConnection {
        val c = URL(BASE + path).openConnection() as HttpsURLConnection
        c.sslSocketFactory = ssl
        c.connectTimeout = 15000
        c.readTimeout = 30000
        c.instanceFollowRedirects = false
        c.useCaches = false
        if (!cookie.isNullOrEmpty()) c.setRequestProperty("Cookie", cookie)
        return c
    }

    /** One JSON request; throws IOException only when the server cannot be reached. */
    fun call(method: String, path: String, body: JSONObject? = null, cookie: String? = null, csrf: String? = null): Resp {
        val c = open(path, cookie)
        try {
            c.requestMethod = method
            if (csrf != null) c.setRequestProperty("X-CSRF", csrf)
            if (body != null) {
                val b = body.toString().toByteArray()
                c.doOutput = true
                c.setRequestProperty("Content-Type", "application/json")
                c.setFixedLengthStreamingMode(b.size)
                c.outputStream.use { it.write(b) }
            }
            val code = c.responseCode
            val stream = if (code >= 400) c.errorStream else c.inputStream
            val text = stream?.use { it.readBytes().toString(Charsets.UTF_8) } ?: ""
            val json = try { JSONObject(text) } catch (e: Exception) { JSONObject() }
            return Resp(code, json, c.getHeaderField("Set-Cookie"))
        } finally { c.disconnect() }
    }

    /** Downloads path (with the panel cookie) into f; progress(done, total). */
    fun download(path: String, cookie: String?, f: File, progress: (Long, Long) -> Unit) {
        val c = open(path, cookie)
        try {
            c.readTimeout = 60000
            if (c.responseCode != HttpURLConnection.HTTP_OK) throw IOException("HTTP " + c.responseCode)
            val total = c.contentLengthLong
            f.parentFile?.mkdirs()
            c.inputStream.use { inp ->
                f.outputStream().use { out ->
                    val buf = ByteArray(64 * 1024)
                    var done = 0L
                    while (true) {
                        val n = inp.read(buf)
                        if (n < 0) break
                        out.write(buf, 0, n)
                        done += n
                        progress(done, total)
                    }
                }
            }
        } finally { c.disconnect() }
    }
}
