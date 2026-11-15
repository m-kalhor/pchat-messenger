package com.pchat.app

import android.Manifest
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import android.net.Uri
import android.provider.Settings
import android.widget.Toast
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import androidx.core.content.ContextCompat
import androidx.core.content.FileProvider
import androidx.core.content.pm.PackageInfoCompat
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import java.io.File

/** A newer APK on the server. */
data class AppUpdate(val code: Long, val name: String, val size: Long)

/**
 * 1.9: in-app updates. The server reads the version of the APK the admin uploaded (/api/app/version);
 * a newer one is offered when the app opens (never forced: «بعداً» hides it until the app is opened
 * again) and from Settings. The APK is downloaded inside the app and handed to Android's installer.
 */
object Updater {
    /** download progress 0..1 while downloading, else null */
    val progress = MutableStateFlow<Float?>(null)

    /** 1.10.2: the update the app offers on screen; «بعداً» hides that version until the app is started again. */
    val offer = MutableStateFlow<AppUpdate?>(null)
    @Volatile var dismissed = 0L

    /**
     * 1.10.2: checks the server (on every (re)connection, so also right after a server upgrade, and when the
     * admin uploads a new APK). A newer version is offered on screen when the app is open; otherwise one
     * notification «نسخهٔ تازهٔ سپن آمده است» is shown, once per version.
     */
    suspend fun checkAndNotify(ctx: Context, visible: Boolean) {
        val u = check(ctx) ?: return
        offer.value = u
        if (visible) return
        val prefs = Engine.prefs
        if (prefs.getLong("update_notified", 0L) >= u.code) return
        if (Build.VERSION.SDK_INT >= 33 &&
            ContextCompat.checkSelfPermission(ctx, Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED
        ) return
        val i = Intent(ctx, MainActivity::class.java).putExtra("update", true)
            .apply { flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP }
        val pi = PendingIntent.getActivity(ctx, 7704, i, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
        val body = "نسخهٔ ${u.name} آماده است. برای به‌روزرسانی بزنید. پیام‌ها و تنظیمات پاک نمی‌شوند."
        val n = NotificationCompat.Builder(ctx, Prefs.messageChannel(ctx))
            .setSmallIcon(android.R.drawable.stat_sys_download_done)
            .setContentTitle("⬆️ نسخهٔ تازهٔ سپن آمده است")
            .setContentText(body)
            .setStyle(NotificationCompat.BigTextStyle().bigText(body))
            .setAutoCancel(true)
            .setContentIntent(pi)
            .build()
        try { NotificationManagerCompat.from(ctx).notify(7704, n) } catch (e: SecurityException) { return }
        prefs.edit().putLong("update_notified", u.code).apply()
    }

    /** The app was opened from the update notification: show the offer again even if «بعداً» was pressed. */
    fun showAgain() {
        dismissed = 0L
        try { NotificationManagerCompat.from(Engine.app).cancel(7704) } catch (e: Exception) { }
        Engine.scope.launch { check(Engine.app)?.let { offer.value = it } }
    }

    fun installedCode(ctx: Context): Long = try {
        PackageInfoCompat.getLongVersionCode(ctx.packageManager.getPackageInfo(ctx.packageName, 0))
    } catch (e: Exception) { 0L }

    fun installedName(ctx: Context): String = try {
        ctx.packageManager.getPackageInfo(ctx.packageName, 0).versionName ?: ""
    } catch (e: Exception) { "" }

    /** The newer version on the server, or null (none, older, or the server cannot be reached). */
    suspend fun check(ctx: Context): AppUpdate? = withContext(Dispatchers.IO) {
        try {
            val o = Api.appVersion()
            if (o.isNull("code")) return@withContext null
            val code = o.getLong("code")
            if (code > installedCode(ctx)) AppUpdate(code, o.optString("name", code.toString()), o.optLong("size", 0L)) else null
        } catch (e: Exception) { null }
    }

    private fun apkFile(ctx: Context) = File(File(ctx.filesDir, "media"), "sepan-update.apk")

    /** Downloads the APK; returns the file or throws. */
    suspend fun download(ctx: Context): File = withContext(Dispatchers.IO) {
        val f = apkFile(ctx)
        f.parentFile?.mkdirs()
        progress.value = 0f
        try {
            Api.downloadApk(f) { done, total -> if (total > 0) progress.value = done.toFloat() / total }
            f
        } catch (e: Exception) {
            f.delete(); throw e
        } finally { progress.value = null }
    }

    /** Android 8+ asks once per app for "install unknown apps"; true when it is already allowed. */
    fun canInstall(ctx: Context): Boolean = ctx.packageManager.canRequestPackageInstalls()

    fun openInstallPermission(ctx: Context) {
        try {
            ctx.startActivity(Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES, Uri.parse("package:" + ctx.packageName)).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
        } catch (e: Exception) { }
    }

    fun install(ctx: Context, f: File) {
        val uri = FileProvider.getUriForFile(ctx, ctx.packageName + ".fileprovider", f)
        val i = Intent(Intent.ACTION_VIEW).setDataAndType(uri, "application/vnd.android.package-archive")
            .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_ACTIVITY_NEW_TASK)
        ctx.startActivity(i)
    }

    /** Removes a downloaded APK once the new version runs. */
    fun cleanup(ctx: Context) { try { apkFile(ctx).delete() } catch (e: Exception) { } }
}

/** The update offer: «دانلود» downloads and opens the installer, «بعداً» just closes it. */
@Composable
fun UpdateDialog(u: AppUpdate, onClose: () -> Unit) {
    val ctx = LocalContext.current
    val scope = rememberCoroutineScope()
    val prog by Updater.progress.collectAsState()
    var file by remember { mutableStateOf<File?>(null) }
    var err by remember { mutableStateOf<String?>(null) }
    val busy = prog != null
    val install = {
        val f = file
        if (f != null) {
            if (!Updater.canInstall(ctx)) {
                Toast.makeText(ctx, "اجازهٔ «نصب برنامه‌های ناشناس» را برای سپن روشن کنید و برگردید، بعد «نصب» را بزنید", Toast.LENGTH_LONG).show()
                Updater.openInstallPermission(ctx)
            } else {
                try { Updater.install(ctx, f) } catch (e: Exception) { err = "صفحهٔ نصب باز نشد" }
            }
        }
    }
    AlertDialog(
        onDismissRequest = { if (!busy) onClose() },
        title = { Text("نسخهٔ تازهٔ سپن") },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                Text("نسخهٔ ${u.name} آماده است" + (if (u.size > 0) " (${U.size(u.size)})" else "") + ". نسخهٔ فعلی شما ${Updater.installedName(ctx)} است.", fontSize = 14.sp)
                Text("پیام‌ها و تنظیمات شما با به‌روزرسانی پاک نمی‌شوند.", fontSize = 12.sp, color = MaterialTheme.colorScheme.onSurface.copy(alpha = 0.6f))
                prog?.let {
                    LinearProgressIndicator(progress = { it }, modifier = Modifier.fillMaxWidth())
                    Text("${(it * 100).toInt()}٪", fontSize = 12.sp)
                }
                if (file != null && !busy) Text("دانلود تمام شد. «نصب» را بزنید.", fontSize = 13.sp)
                err?.let { Text(it, fontSize = 13.sp, color = MaterialTheme.colorScheme.error) }
            }
        },
        confirmButton = {
            if (file != null) TextButton(onClick = install) { Text("نصب") }
            else TextButton(enabled = !busy, onClick = {
                err = null
                scope.launch {
                    try { file = Updater.download(ctx); install() } catch (e: Exception) { err = "دانلود نشد؛ اتصال را بررسی کنید و دوباره بزنید" }
                }
            }) { Text("دانلود") }
        },
        dismissButton = { TextButton(enabled = !busy, onClick = onClose) { Text("بعداً") } }
    )
}

/** 1.9: Settings › «رمز ورود»: the current password (or an SMS code), then the new one twice. */
@Composable
fun ChangePasswordDialog(onClose: () -> Unit) {
    val ctx = LocalContext.current
    val scope = rememberCoroutineScope()
    var cur by remember { mutableStateOf("") }
    var p1 by remember { mutableStateOf("") }
    var p2 by remember { mutableStateOf("") }
    var busy by remember { mutableStateOf(false) }
    var sent by remember { mutableStateOf(false) }
    var msg by remember { mutableStateOf<String?>(null) }
    @Composable
    fun field(v: String, label: String, on: (String) -> Unit) = OutlinedTextField(
        value = v, onValueChange = on, singleLine = true, label = { Text(label) },
        visualTransformation = PasswordVisualTransformation(),
        keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Password), modifier = Modifier.fillMaxWidth()
    )
    AlertDialog(
        onDismissRequest = { if (!busy) onClose() },
        title = { Text("تغییر رمز ورود") },
        text = {
            Column(Modifier.verticalScroll(rememberScrollState()), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                field(cur, "رمز فعلی یا کد پیامکی") { cur = it }
                TextButton(enabled = !sent, onClick = {
                    sent = true
                    scope.launch {
                        val e = Engine.reauthSms()
                        Toast.makeText(ctx, e ?: "کد تأیید به موبایل شما پیامک شد", Toast.LENGTH_LONG).show()
                        if (e != null) sent = false
                    }
                }) { Text("رمز فعلی را نمی‌دانم: ارسال کد پیامکی", fontSize = 13.sp) }
                field(p1, "رمز تازه (دست‌کم ۸ نویسه)") { p1 = it }
                field(p2, "تکرار رمز تازه") { p2 = it }
                Text("بعد از تغییر، دستگاه‌های دیگرتان از حساب خارج می‌شوند و باید با رمز تازه وارد شوند.", fontSize = 12.sp,
                    color = MaterialTheme.colorScheme.onSurface.copy(alpha = 0.6f))
                msg?.let { Text(it, fontSize = 13.sp, color = MaterialTheme.colorScheme.error) }
            }
        },
        confirmButton = {
            TextButton(enabled = !busy, onClick = {
                msg = when {
                    cur.isEmpty() -> "رمز فعلی را وارد کنید"
                    p1.length < 8 -> "رمز تازه باید دست‌کم ۸ نویسه باشد"
                    p1 != p2 -> "رمز تازه و تکرار آن یکی نیستند"
                    else -> null
                }
                if (msg == null) {
                    busy = true
                    scope.launch {
                        msg = Engine.changePassword(cur, p1)
                        busy = false
                        if (msg == null) {
                            Toast.makeText(ctx, "رمز ورود عوض شد؛ دستگاه‌های دیگرتان از حساب خارج شدند", Toast.LENGTH_LONG).show()
                            onClose()
                        }
                    }
                }
            }) { Text("تغییر رمز") }
        },
        dismissButton = { TextButton(enabled = !busy, onClick = onClose) { Text("انصراف") } }
    )
}
