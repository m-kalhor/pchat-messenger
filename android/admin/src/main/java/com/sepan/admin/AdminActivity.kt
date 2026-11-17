package com.sepan.admin

import android.annotation.SuppressLint
import android.app.Activity
import android.app.AlertDialog
import android.app.KeyguardManager
import android.app.ProgressDialog
import android.content.ActivityNotFoundException
import android.content.Intent
import android.graphics.Color
import android.graphics.Typeface
import android.hardware.biometrics.BiometricManager
import android.hardware.biometrics.BiometricPrompt
import android.net.Uri
import android.net.http.SslError
import android.os.Build
import android.os.Bundle
import android.os.CancellationSignal
import android.os.SystemClock
import android.provider.Settings
import android.security.keystore.KeyPermanentlyInvalidatedException
import android.security.keystore.UserNotAuthenticatedException
import android.util.Base64
import android.view.Gravity
import android.view.View
import android.view.ViewGroup
import android.view.WindowManager
import android.webkit.CookieManager
import android.webkit.JavascriptInterface
import android.webkit.SslErrorHandler
import android.webkit.URLUtil
import android.webkit.ValueCallback
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.Button
import android.widget.FrameLayout
import android.widget.LinearLayout
import android.widget.TextView
import android.widget.Toast
import androidx.core.content.FileProvider
import androidx.core.content.pm.PackageInfoCompat
import org.json.JSONObject
import java.io.File
import java.io.IOException
import java.net.URLDecoder
import java.security.InvalidKeyException
import java.security.UnrecoverableKeyException

/**
 * «سپن مدیر»: the admin panel in a WebView.
 *  - First time: the normal panel sign-in (password + authenticator code). Right after it the app offers to
 *    pair this phone: a Keystore key is made and its public half registered on the server.
 *  - Then: opening the app asks for the fingerprint / screen lock, signs the server's challenge with the key
 *    and opens the panel. Back from the background after LOCK_AFTER_MS asks again.
 *  - The panel page talks to the app through window.SepanAdmin (paired / unlock / loggedIn / loggedOut).
 */
class AdminActivity : Activity() {
    private lateinit var web: WebView
    private lateinit var lock: LinearLayout
    private lateinit var status: TextView
    private lateinit var unlockBtn: Button
    private lateinit var passBtn: Button

    private val prefs by lazy { getSharedPreferences("admin", MODE_PRIVATE) }
    private var deviceId: String?
        get() = prefs.getString("device_id", null)
        set(v) { prefs.edit().putString("device_id", v).apply() }

    @Volatile private var busy = false
    private var passwordMode = false // the user chose «ورود با رمز» on the lock screen
    private var pageLoaded = false
    private var stoppedAt = 0L
    private var updateOffered = false
    private var fileCallback: ValueCallback<Array<Uri>>? = null

    private val paired get() = deviceId != null && DeviceKey.exists()

    companion object {
        private const val REQ_CONFIRM = 11
        private const val REQ_FILE = 12
        private const val LOCK_AFTER_MS = 2 * 60_000L
        private const val BG = "#0F1720"
    }

    // ---------------------------------------------------------------- UI

    @SuppressLint("SetJavaScriptEnabled", "JavascriptInterface")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        // no screenshots / no preview in the recent-apps list: it is the admin panel
        window.setFlags(WindowManager.LayoutParams.FLAG_SECURE, WindowManager.LayoutParams.FLAG_SECURE)
        window.statusBarColor = Color.parseColor("#17212B")
        window.navigationBarColor = Color.parseColor("#17212B")
        Net.init(this)

        web = WebView(this)
        web.setBackgroundColor(Color.parseColor(BG))
        web.settings.apply {
            javaScriptEnabled = true
            domStorageEnabled = true
            allowFileAccess = false
            allowContentAccess = false
            setSupportMultipleWindows(false)
            userAgentString = "$userAgentString SepanAdmin/${versionName()}"
        }
        WebView.setWebContentsDebuggingEnabled(false)
        CookieManager.getInstance().setAcceptCookie(true)
        web.addJavascriptInterface(Bridge(), "SepanAdmin")
        web.webViewClient = object : WebViewClient() {
            override fun onReceivedSslError(view: WebView, handler: SslErrorHandler, error: SslError) {
                if (error.url.startsWith(Net.BASE) && Net.isPinned(error.certificate)) handler.proceed() else handler.cancel()
            }
            override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
                val u = request.url.toString()
                return !u.startsWith(Net.BASE + "/") // nothing but our own panel opens inside the app
            }
            override fun onPageFinished(view: WebView, url: String) { pageLoaded = true }
            override fun onReceivedError(view: WebView, request: WebResourceRequest, error: android.webkit.WebResourceError) {
                if (request.isForMainFrame) showLock("سرور در دسترس نیست. اینترنت را بررسی کنید و دوباره بزنید.", retry = true)
            }
        }
        web.webChromeClient = object : WebChromeClient() {
            override fun onShowFileChooser(view: WebView, cb: ValueCallback<Array<Uri>>, params: FileChooserParams): Boolean {
                fileCallback?.onReceiveValue(null)
                fileCallback = cb
                return try { startActivityForResult(params.createIntent(), REQ_FILE); true }
                catch (e: ActivityNotFoundException) { fileCallback = null; false }
            }
        }
        web.setDownloadListener { url, _, disposition, mime, _ -> download(url, disposition, mime) }

        lock = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            gravity = Gravity.CENTER
            setBackgroundColor(Color.parseColor(BG))
            setPadding(dp(32), dp(32), dp(32), dp(32))
            isClickable = true
        }
        val icon = TextView(this).apply { text = "🛡"; textSize = 56f; gravity = Gravity.CENTER }
        val title = TextView(this).apply {
            text = "سپن مدیر"; textSize = 24f; setTextColor(Color.WHITE); gravity = Gravity.CENTER
            setTypeface(typeface, Typeface.BOLD); setPadding(0, dp(8), 0, dp(4))
        }
        status = TextView(this).apply {
            textSize = 15f; setTextColor(Color.parseColor("#8AA0B5")); gravity = Gravity.CENTER; setPadding(0, dp(8), 0, dp(24))
        }
        unlockBtn = button("🔓  ورود با اثر انگشت یا قفل گوشی", "#3390EC") { passwordMode = false; unlock() }
        passBtn = button("ورود با رمز پنل", "#2C3B4C") { passwordMode = true; hideLock(); loadPanel(true) }
        lock.addView(icon); lock.addView(title); lock.addView(status)
        lock.addView(unlockBtn, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, dp(52)))
        lock.addView(View(this), LinearLayout.LayoutParams(1, dp(12)))
        lock.addView(passBtn, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, dp(52)))

        val root = FrameLayout(this)
        root.addView(web, FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))
        root.addView(lock, FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))
        setContentView(root)

        if (paired) { showLock(""); unlock() } else { hideLock(); loadPanel(false) }
    }

    private fun button(label: String, color: String, onClick: () -> Unit) = Button(this).apply {
        text = label; textSize = 16f; setTextColor(Color.WHITE); setAllCaps(false)
        background = android.graphics.drawable.GradientDrawable().apply { setColor(Color.parseColor(color)); cornerRadius = dp(10).toFloat() }
        setOnClickListener { onClick() }
    }

    private fun dp(v: Int) = (v * resources.displayMetrics.density).toInt()

    private fun versionName(): String = try { packageManager.getPackageInfo(packageName, 0).versionName ?: "" } catch (e: Exception) { "" }
    private fun versionCode(): Long = try { PackageInfoCompat.getLongVersionCode(packageManager.getPackageInfo(packageName, 0)) } catch (e: Exception) { 0L }

    private fun showLock(msg: String, retry: Boolean = false) {
        lock.visibility = View.VISIBLE
        status.text = msg
        unlockBtn.visibility = if (paired) View.VISIBLE else View.GONE
        unlockBtn.text = if (retry && !paired) "تلاش دوباره" else "🔓  ورود با اثر انگشت یا قفل گوشی"
        if (retry && !paired) { unlockBtn.visibility = View.VISIBLE; unlockBtn.setOnClickListener { hideLock(); loadPanel(true) } }
        else unlockBtn.setOnClickListener { passwordMode = false; unlock() }
        passBtn.visibility = if (paired) View.VISIBLE else View.GONE
    }

    private fun hideLock() { lock.visibility = View.GONE }

    private fun loadPanel(force: Boolean) {
        if (force || !pageLoaded) web.loadUrl(Net.BASE + "/") else web.reload()
    }

    override fun onBackPressed() { moveTaskToBack(true) }

    override fun onStop() {
        super.onStop()
        stoppedAt = SystemClock.elapsedRealtime()
    }

    override fun onStart() {
        super.onStart()
        // back after a while: the fingerprint again, with a new session (the old cookie is dropped)
        if (stoppedAt > 0 && paired && !passwordMode && SystemClock.elapsedRealtime() - stoppedAt > LOCK_AFTER_MS && !busy) {
            CookieManager.getInstance().removeAllCookies(null)
            web.loadUrl("about:blank"); pageLoaded = false
            showLock(""); unlock()
        }
        stoppedAt = 0
    }

    // ---------------------------------------------------------------- the page's bridge

    inner class Bridge {
        @JavascriptInterface fun paired(): Boolean = paired && !passwordMode
        @JavascriptInterface fun unlock() { runOnUiThread { if (!busy) { showLock(""); this@AdminActivity.unlock() } } }
        @JavascriptInterface fun loggedIn() { runOnUiThread { afterPasswordLogin() } }
        /** «ثبت همین گوشی» in «حساب مدیر», also after «نه، با رمز» was chosen once */
        @JavascriptInterface fun pairNow() { runOnUiThread { prefs.edit().remove("pair_declined").apply(); afterPasswordLogin() } }
        @JavascriptInterface fun loggedOut() {
            runOnUiThread {
                CookieManager.getInstance().removeAllCookies(null)
                passwordMode = false
                if (paired) { web.loadUrl("about:blank"); pageLoaded = false; showLock("پنل قفل شد.") } else loadPanel(true)
            }
        }
    }

    private fun panelCookie(): String? =
        CookieManager.getInstance().getCookie(Net.BASE)?.split(';')?.map { it.trim() }?.firstOrNull { it.startsWith("adm=") }

    // ---------------------------------------------------------------- pairing (after a password sign-in)

    private fun afterPasswordLogin() {
        checkUpdate()
        if (paired) return
        if (prefs.getBoolean("pair_declined", false)) return
        val kg = getSystemService(KeyguardManager::class.java)
        if (kg == null || !kg.isDeviceSecure) {
            AlertDialog.Builder(this).setTitle("ورود بدون رمز")
                .setMessage("برای اینکه دفعه‌های بعد فقط با اثر انگشت یا قفل گوشی وارد پنل شوید، اول برای گوشی قفل صفحه (PIN، الگو یا رمز) بگذارید و دوباره وارد شوید.")
                .setPositiveButton("تنظیمات قفل") { _, _ -> try { startActivity(Intent(Settings.ACTION_SECURITY_SETTINGS)) } catch (e: Exception) { } }
                .setNegativeButton("بعداً", null).show()
            return
        }
        AlertDialog.Builder(this).setTitle("ثبت این گوشی")
            .setMessage("این گوشی به‌عنوان دستگاه مدیر ثبت شود؟\n\nاز این به بعد پنل با اثر انگشت یا قفل گوشی باز می‌شود و رمز لازم نیست. اگر ۹۰ روز استفاده نشود خودبه‌خود باطل می‌شود و در «حساب مدیر» هم می‌توانید حذفش کنید.")
            .setPositiveButton("ثبت گوشی") { _, _ -> pair() }
            .setNegativeButton("نه، با رمز") { _, _ -> prefs.edit().putBoolean("pair_declined", true).apply() }
            .show()
    }

    private fun pair() {
        val cookie = panelCookie() ?: return toast("نشست پنل پیدا نشد؛ دوباره وارد شوید")
        Thread {
            val err: String? = try {
                val s = Net.call("GET", "/admin/api/session", cookie = cookie)
                if (!s.ok) "نشست پنل تمام شده؛ دوباره وارد شوید"
                else if (!s.json.optBoolean("can_pair")) "برای ثبت گوشی دوباره با رمز وارد شوید"
                else {
                    val pub = DeviceKey.create()
                    val name = (Build.MANUFACTURER.replaceFirstChar { it.uppercase() } + " " + Build.MODEL).trim()
                    val r = Net.call("POST", "/admin/api/devices/pair", JSONObject().put("name", name).put("pubkey", pub), cookie, s.json.optString("csrf"))
                    if (r.ok) { deviceId = r.json.getString("id"); passwordMode = false; null }
                    else { DeviceKey.delete(); errorText(r.error) }
                }
            } catch (e: IOException) { DeviceKey.delete(); "سرور در دسترس نیست" }
            catch (e: Exception) { DeviceKey.delete(); "ساخت کلید امن روی این گوشی ممکن نشد (" + e.javaClass.simpleName + ")" }
            runOnUiThread {
                if (err == null) {
                    prefs.edit().remove("pair_declined").apply()
                    toast("✓ این گوشی ثبت شد. دفعهٔ بعد با اثر انگشت وارد می‌شوید.")
                    web.reload()
                } else AlertDialog.Builder(this).setTitle("ثبت گوشی").setMessage(err).setPositiveButton("باشه", null).show()
            }
        }.start()
    }

    // ---------------------------------------------------------------- unlock (fingerprint / screen lock + signature)

    private fun unlock() {
        if (busy) return
        if (!paired) { hideLock(); loadPanel(true); return }
        busy = true
        status.text = ""
        authenticate { ok ->
            if (!ok) { busy = false; status.text = "برای ورود، اثر انگشت یا قفل گوشی لازم است."; return@authenticate }
            signIn(fallbackDone = false)
        }
    }

    /** Asks the phone's own lock (fingerprint, face where it is strong, PIN / pattern / password). */
    private var confirmCb: ((Boolean) -> Unit)? = null
    private fun authenticate(cb: (Boolean) -> Unit) {
        if (Build.VERSION.SDK_INT >= 29) {
            val b = BiometricPrompt.Builder(this)
                .setTitle("سپن مدیر")
                .setSubtitle("ورود به پنل مدیریت")
            if (Build.VERSION.SDK_INT >= 30) b.setAllowedAuthenticators(BiometricManager.Authenticators.BIOMETRIC_STRONG or BiometricManager.Authenticators.DEVICE_CREDENTIAL)
            else @Suppress("DEPRECATION") b.setDeviceCredentialAllowed(true)
            b.build().authenticate(CancellationSignal(), mainExecutor, object : BiometricPrompt.AuthenticationCallback() {
                override fun onAuthenticationSucceeded(result: BiometricPrompt.AuthenticationResult?) { cb(true) }
                override fun onAuthenticationError(errorCode: Int, errString: CharSequence?) { cb(false) }
            })
        } else confirmCredential(cb)
    }

    /** The system screen-lock check (also the fallback when a weak biometric did not unlock the key). */
    private fun confirmCredential(cb: (Boolean) -> Unit) {
        val kg = getSystemService(KeyguardManager::class.java)
        @Suppress("DEPRECATION")
        val i = kg?.createConfirmDeviceCredentialIntent("سپن مدیر", "ورود به پنل مدیریت")
        if (i == null) { cb(false); return }
        confirmCb = cb
        startActivityForResult(i, REQ_CONFIRM)
    }

    private fun signIn(fallbackDone: Boolean) {
        val id = deviceId ?: run { busy = false; return }
        status.text = "در حال ورود…"
        Thread {
            var result: String? = null // null = signed in
            var needFallback = false
            var forget = false
            try {
                val ch = Net.call("POST", "/admin/api/device/challenge", JSONObject().put("id", id))
                if (!ch.ok) { result = errorText(ch.error, ch.json.optInt("wait")); forget = ch.error == "device_unknown" }
                else {
                    val nonce = ch.json.getString("nonce")
                    val sig = DeviceKey.sign("sepan-admin-login:$id:$nonce")
                    val r = Net.call("POST", "/admin/api/device/login", JSONObject().put("id", id).put("nonce", nonce).put("sig", sig))
                    if (!r.ok) { result = errorText(r.error, r.json.optInt("wait")); forget = r.error == "device_unknown" }
                    else {
                        val token = r.setCookie?.split(';')?.firstOrNull()?.trim()
                        if (token == null || !token.startsWith("adm=")) result = "پاسخ سرور نامعتبر بود"
                        else {
                            val cm = CookieManager.getInstance()
                            cm.setCookie(Net.BASE, "$token; Path=/; Secure; HttpOnly; SameSite=Strict")
                            cm.flush()
                        }
                    }
                }
            } catch (e: UserNotAuthenticatedException) { needFallback = true }
            catch (e: KeyPermanentlyInvalidatedException) { forget = true; result = "قفل صفحهٔ گوشی عوض شده؛ یک بار با رمز وارد شوید و گوشی را دوباره ثبت کنید." }
            catch (e: InvalidKeyException) { forget = true; result = "کلید امن این گوشی دیگر قابل استفاده نیست؛ با رمز وارد شوید و دوباره ثبت کنید." }
            catch (e: UnrecoverableKeyException) { forget = true; result = "کلید امن این گوشی پیدا نشد؛ با رمز وارد شوید و دوباره ثبت کنید." }
            catch (e: IOException) { result = "سرور در دسترس نیست. اینترنت را بررسی کنید و دوباره بزنید." }
            catch (e: Exception) { result = "ورود ناموفق بود (" + e.javaClass.simpleName + ")" }
            runOnUiThread {
                if (needFallback) {
                    if (fallbackDone) { busy = false; status.text = "تأیید قفل گوشی انجام نشد." }
                    else confirmCredential { ok -> if (ok) signIn(true) else { busy = false; status.text = "برای ورود، قفل گوشی لازم است." } }
                    return@runOnUiThread
                }
                busy = false
                if (forget) {
                    deviceId = null; DeviceKey.delete()
                    if (result == "این گوشی دیگر ثبت نیست") result = "این گوشی دیگر در دستگاه‌های مدیر نیست (حذف شده یا ۹۰ روز استفاده نشده). با رمز وارد شوید و دوباره ثبت کنید."
                }
                if (result == null) {
                    passwordMode = false
                    hideLock(); loadPanel(true)
                    checkUpdate()
                } else if (forget) {
                    AlertDialog.Builder(this).setTitle("سپن مدیر").setMessage(result).setPositiveButton("باشه", null).show()
                    hideLock(); loadPanel(true)
                } else showLock(result!!)
            }
        }.start()
    }

    private fun errorText(e: String, wait: Int = 0): String = when (e) {
        "rate_limited" -> "تلاش زیاد؛ " + (if (wait > 0) "${(wait + 59) / 60} دقیقه" else "کمی") + " صبر کنید."
        "device_unknown" -> "این گوشی دیگر ثبت نیست"
        "bad_signature" -> "امضای گوشی پذیرفته نشد. دوباره تلاش کنید."
        "too_many_devices" -> "حداکثر ۱۰ گوشی؛ یکی را در «حساب مدیر» حذف کنید."
        "pair_needs_fresh_login" -> "برای ثبت گوشی دوباره با رمز وارد شوید."
        "device_exists" -> "این گوشی قبلاً ثبت شده است."
        "" -> "خطای سرور"
        else -> e
    }

    override fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?) {
        super.onActivityResult(requestCode, resultCode, data)
        when (requestCode) {
            REQ_CONFIRM -> { val cb = confirmCb; confirmCb = null; cb?.invoke(resultCode == RESULT_OK) }
            REQ_FILE -> { fileCallback?.onReceiveValue(WebChromeClient.FileChooserParams.parseResult(resultCode, data)); fileCallback = null }
        }
    }

    // ---------------------------------------------------------------- downloads (backups, CSV) and app updates

    private fun shareDir() = File(cacheDir, "share").apply { mkdirs() }

    private fun download(url: String, disposition: String?, mime: String?) {
        val name = URLUtil.guessFileName(url, disposition, mime).replace(Regex("[^\\w.\\-]"), "_")
        if (url.startsWith("data:")) {
            // the usage tab's CSV is made in the page as a data: link
            try {
                val comma = url.indexOf(',')
                val meta = url.substring(5, comma)
                val payload = url.substring(comma + 1)
                val bytes = if (meta.endsWith(";base64")) Base64.decode(payload, Base64.DEFAULT) else URLDecoder.decode(payload, "UTF-8").toByteArray()
                val f = File(shareDir(), if (name.endsWith(".bin")) "sepan-usage.csv" else name)
                f.writeBytes(bytes)
                share(f, mime ?: "text/csv")
            } catch (e: Exception) { toast("فایل ساخته نشد") }
            return
        }
        if (!url.startsWith(Net.BASE + "/")) return
        val path = url.removePrefix(Net.BASE)
        if (path.startsWith("/admin/api/adminapp/download")) { downloadUpdate(null); return }
        val cookie = panelCookie()
        val f = File(shareDir(), name)
        toast("در حال دانلود…")
        Thread {
            val ok = try { Net.download(path, cookie, f) { _, _ -> }; true } catch (e: Exception) { false }
            runOnUiThread { if (ok) share(f, mime ?: "application/octet-stream") else toast("دانلود ناموفق بود") }
        }.start()
    }

    private fun share(f: File, mime: String) {
        val uri = FileProvider.getUriForFile(this, "$packageName.fileprovider", f)
        val i = Intent(Intent.ACTION_SEND).setType(mime).putExtra(Intent.EXTRA_STREAM, uri).addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
        try { startActivity(Intent.createChooser(i, "ذخیره یا ارسال " + f.name)) } catch (e: Exception) { toast("برنامه‌ای برای ذخیره پیدا نشد") }
    }

    /** A newer «سپن مدیر» APK on the server is offered once per app start (never forced). */
    private fun checkUpdate() {
        if (updateOffered) return
        val cookie = panelCookie() ?: return
        Thread {
            val app = try { Net.call("GET", "/admin/api/adminapp", cookie = cookie).json.optJSONObject("app") } catch (e: Exception) { null }
            val code = app?.optLong("code", 0L) ?: 0L
            if (app == null || code <= versionCode()) return@Thread
            runOnUiThread {
                if (updateOffered || isFinishing) return@runOnUiThread
                updateOffered = true
                AlertDialog.Builder(this).setTitle("نسخهٔ تازهٔ سپن مدیر")
                    .setMessage("نسخهٔ " + app.optString("name") + " آماده است (" + (app.optLong("size") / 1024 / 1024) + " مگابایت). به‌روز شود؟")
                    .setPositiveButton("به‌روزرسانی") { _, _ -> downloadUpdate(app.optString("name")) }
                    .setNegativeButton("بعداً", null).show()
            }
        }.start()
    }

    @Suppress("DEPRECATION")
    private fun downloadUpdate(name: String?) {
        if (!packageManager.canRequestPackageInstalls()) {
            AlertDialog.Builder(this).setTitle("اجازهٔ نصب")
                .setMessage("یک بار اجازه دهید «سپن مدیر» نسخهٔ تازهٔ خودش را نصب کند، بعد برگردید و دوباره بزنید.")
                .setPositiveButton("تنظیمات") { _, _ -> try { startActivity(Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES, Uri.parse("package:$packageName"))) } catch (e: Exception) { } }
                .setNegativeButton("بعداً", null).show()
            return
        }
        val cookie = panelCookie()
        val f = File(shareDir(), "sepan-admin.apk")
        val pd = ProgressDialog(this).apply {
            setTitle("دانلود سپن مدیر" + (if (name.isNullOrEmpty()) "" else " $name")); setProgressStyle(ProgressDialog.STYLE_HORIZONTAL)
            max = 100; setCancelable(false); show()
        }
        Thread {
            val ok = try {
                Net.download("/admin/api/adminapp/download", cookie, f) { d, t -> if (t > 0) runOnUiThread { pd.progress = (100 * d / t).toInt() } }
                true
            } catch (e: Exception) { false }
            runOnUiThread {
                pd.dismiss()
                if (!ok) { toast("دانلود ناموفق بود"); return@runOnUiThread }
                val uri = FileProvider.getUriForFile(this, "$packageName.fileprovider", f)
                val i = Intent(Intent.ACTION_VIEW).setDataAndType(uri, "application/vnd.android.package-archive")
                    .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_ACTIVITY_NEW_TASK)
                try { startActivity(i) } catch (e: Exception) { toast("نصب‌کننده باز نشد") }
            }
        }.start()
    }

    private fun toast(s: String) { Toast.makeText(this, s, Toast.LENGTH_LONG).show() }
}
