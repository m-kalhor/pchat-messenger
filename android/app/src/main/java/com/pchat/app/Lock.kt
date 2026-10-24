package com.pchat.app

import android.app.Activity
import android.content.Context
import android.hardware.biometrics.BiometricManager
import android.hardware.biometrics.BiometricPrompt
import android.os.Build
import android.os.CancellationSignal
import android.os.SystemClock
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import java.security.MessageDigest
import java.security.SecureRandom

/** App lock with a 4-6 digit PIN and, on Android 10+, the fingerprint. */
object AppLock {
    val locked = MutableStateFlow(false)
    private var backgroundAt = 0L
    private var fails = 0
    private var blockedUntil = 0L

    private val p get() = Engine.prefs
    val enabled: Boolean get() = p.getString("lock_hash", null) != null
    /** lock after the app was in the background this long (0 = immediately) */
    var timeoutMs: Long
        get() = p.getLong("lock_after", 60_000L)
        set(v) { p.edit().putLong("lock_after", v).apply() }
    var useBiometric: Boolean
        get() = p.getBoolean("lock_bio", true)
        set(v) { p.edit().putBoolean("lock_bio", v).apply() }

    private fun hash(pin: String, salt: String): String =
        MessageDigest.getInstance("SHA-256").digest((salt + ":" + pin).toByteArray()).joinToString("") { "%02x".format(it) }

    fun setPin(pin: String) {
        val salt = ByteArray(16).also { SecureRandom().nextBytes(it) }.joinToString("") { "%02x".format(it) }
        p.edit().putString("lock_salt", salt).putString("lock_hash", hash(pin, salt)).apply()
    }
    fun disable() { p.edit().remove("lock_hash").remove("lock_salt").apply(); locked.value = false }
    fun check(pin: String): Boolean {
        val salt = p.getString("lock_salt", null) ?: return false
        return MessageDigest.isEqual(hash(pin, salt).toByteArray(), (p.getString("lock_hash", "") ?: "").toByteArray())
    }

    /** Wrong PINs slow down: after 5 misses, 30 seconds of waiting. Returns ms to wait, or 0. */
    fun waitMs(): Long = (blockedUntil - SystemClock.elapsedRealtime()).coerceAtLeast(0)

    fun tryUnlock(pin: String): Boolean {
        if (waitMs() > 0) return false
        if (check(pin)) { fails = 0; locked.value = false; return true }
        if (++fails >= 5) { fails = 0; blockedUntil = SystemClock.elapsedRealtime() + 30_000 }
        return false
    }

    fun onAppStart() {
        if (enabled && (backgroundAt == 0L || SystemClock.elapsedRealtime() - backgroundAt >= timeoutMs)) locked.value = true
    }
    fun onAppStop() { backgroundAt = SystemClock.elapsedRealtime() }

    fun biometricAvailable(ctx: Context): Boolean =
        Build.VERSION.SDK_INT >= 29 &&
            ctx.getSystemService(BiometricManager::class.java)?.canAuthenticate() == BiometricManager.BIOMETRIC_SUCCESS

    fun askBiometric(act: Activity) {
        if (Build.VERSION.SDK_INT < 29) return
        val exec = act.mainExecutor
        BiometricPrompt.Builder(act)
            .setTitle("باز کردن قفل سپن")
            .setNegativeButton("استفاده از رمز", exec) { _, _ -> }
            .build()
            .authenticate(CancellationSignal(), exec, object : BiometricPrompt.AuthenticationCallback() {
                override fun onAuthenticationSucceeded(result: BiometricPrompt.AuthenticationResult?) { fails = 0; locked.value = false }
            })
    }
}

/** Full-screen PIN pad shown while the app is locked. */
@Composable
fun LockScreen() {
    val ctx = LocalContext.current
    var pin by remember { mutableStateOf("") }
    var err by remember { mutableStateOf<String?>(null) }
    val bio = AppLock.useBiometric && AppLock.biometricAvailable(ctx)
    LaunchedEffect(Unit) { if (bio) (ctx as? Activity)?.let { AppLock.askBiometric(it) } }
    LaunchedEffect(err) { if (err != null) { delay(2500); err = null } }

    fun press(d: String) {
        if (pin.length >= 6) return
        pin += d
        if (pin.length >= 4 && AppLock.check(pin)) { AppLock.tryUnlock(pin); pin = "" }
    }
    fun submit() {
        val wait = AppLock.waitMs()
        if (wait > 0) { err = "چند لحظه صبر کنید (${wait / 1000 + 1} ثانیه)"; pin = ""; return }
        if (!AppLock.tryUnlock(pin)) err = "رمز اشتباه است"
        pin = ""
    }

    Surface(color = MaterialTheme.colorScheme.background, modifier = Modifier.fillMaxSize()) {
        Column(Modifier.fillMaxSize().padding(24.dp), horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.Center) {
            Text("🔒", fontSize = 42.sp)
            Spacer(Modifier.height(8.dp))
            Text("سپن قفل است", fontWeight = FontWeight.Bold, fontSize = 20.sp)
            Text("رمز قفل برنامه را وارد کنید", fontSize = 13.sp, color = MaterialTheme.colorScheme.onSurface.copy(alpha = 0.6f))
            Spacer(Modifier.height(18.dp))
            Row(horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                repeat(maxOf(4, pin.length)) { i ->
                    Box(Modifier.size(14.dp).clip(CircleShape).background(
                        if (i < pin.length) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.onSurface.copy(alpha = 0.2f)))
                }
            }
            Text(err ?: " ", color = MaterialTheme.colorScheme.error, fontSize = 13.sp, modifier = Modifier.padding(top = 10.dp))
            Spacer(Modifier.height(12.dp))
            // keypad laid out left-to-right like a phone dialer
            androidx.compose.runtime.CompositionLocalProvider(androidx.compose.ui.platform.LocalLayoutDirection provides androidx.compose.ui.unit.LayoutDirection.Ltr) {
                Column(horizontalAlignment = Alignment.CenterHorizontally) {
                    for (row in listOf(listOf("1", "2", "3"), listOf("4", "5", "6"), listOf("7", "8", "9"), listOf("⌫", "0", "✓"))) {
                        Row {
                            for (k in row) {
                                Box(
                                    Modifier.padding(8.dp).size(68.dp).clip(CircleShape)
                                        .background(MaterialTheme.colorScheme.onSurface.copy(alpha = 0.06f))
                                        .clickable {
                                            when (k) { "⌫" -> pin = pin.dropLast(1); "✓" -> submit(); else -> press(k) }
                                        },
                                    contentAlignment = Alignment.Center
                                ) { Text(k, fontSize = 24.sp) }
                            }
                        }
                    }
                }
            }
            if (bio) TextButton(onClick = { (ctx as? Activity)?.let { AppLock.askBiometric(it) } }) { Text("استفاده از اثرانگشت") }
        }
    }
}
