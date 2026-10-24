package com.pchat.app

import android.Manifest
import android.app.Activity
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.PowerManager
import android.provider.Settings
import androidx.activity.ComponentActivity
import androidx.activity.compose.BackHandler
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.MutableState
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalLayoutDirection
import androidx.compose.ui.unit.LayoutDirection
import androidx.core.content.ContextCompat

class MainActivity : ComponentActivity() {
    private val deepLink = mutableStateOf<String?>(null)

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()
        Engine.init(this)
        deepLink.value = intent.getStringExtra("convo")
        setContent { PChatTheme { App(deepLink) } }
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        deepLink.value = intent.getStringExtra("convo")
    }

    override fun onStart() { super.onStart(); Engine.appVisible = true }
    override fun onStop() { super.onStop(); Engine.appVisible = false }
}

@Composable
fun PChatTheme(content: @Composable () -> Unit) {
    val dark = isSystemInDarkTheme()
    val scheme = if (dark) {
        darkColorScheme(primary = Color(0xFF5EB5F7), background = Color(0xFF0E1621), surface = Color(0xFF17212B), surfaceVariant = Color(0xFF0E1621))
    } else {
        lightColorScheme(primary = Color(0xFF3390EC), background = Color.White, surface = Color.White, surfaceVariant = Color(0xFFDDE6EE))
    }
    MaterialTheme(colorScheme = scheme) {
        CompositionLocalProvider(LocalLayoutDirection provides LayoutDirection.Rtl) { content() }
    }
}

@Composable
fun App(deepLink: MutableState<String?>) {
    val ctx = LocalContext.current
    val logged by Engine.loggedIn.collectAsState()
    var convo by remember { mutableStateOf<String?>(null) }
    var askBattery by remember { mutableStateOf(false) }

    val notifPerm = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { }
    val call by CallManager.state.collectAsState()

    // show over the lock screen only while a call is ringing / running
    LaunchedEffect(call.phase) {
        val act = ctx as? Activity
        if (act != null && Build.VERSION.SDK_INT >= 27) {
            act.setShowWhenLocked(call.phase != CallPhase.IDLE)
            act.setTurnScreenOn(call.phase == CallPhase.INCOMING)
        }
    }

    LaunchedEffect(deepLink.value) {
        deepLink.value?.let { convo = it; deepLink.value = null }
    }
    LaunchedEffect(logged) {
        if (logged) {
            ContextCompat.startForegroundService(ctx, Intent(ctx, MessengerService::class.java))
            if (Build.VERSION.SDK_INT >= 33) notifPerm.launch(Manifest.permission.POST_NOTIFICATIONS)
            val pm = ctx.getSystemService(PowerManager::class.java)
            if (!pm.isIgnoringBatteryOptimizations(ctx.packageName) && !Engine.prefs.getBoolean("battery_asked", false)) askBattery = true
        } else {
            convo = null
            ctx.stopService(Intent(ctx, MessengerService::class.java))
        }
    }
    BackHandler(enabled = convo != null && call.phase == CallPhase.IDLE) { convo = null }

    if (!logged) {
        LoginScreen()
    } else if (call.phase != CallPhase.IDLE) {
        CallScreen()
    } else {
        val c = convo
        if (c == null) ChatListScreen(onOpen = { convo = it }, onLogout = { Engine.logout() })
        else ChatScreen(c, onBack = { convo = null })
    }

    if (askBattery) {
        AlertDialog(
            onDismissRequest = { },
            title = { Text("دریافت پیام در پس‌زمینه") },
            text = {
                Text(
                    "چون از سرویس‌های پوش گوگل استفاده نمی‌کنیم، برای رسیدن پیام‌ها وقتی برنامه بسته است باید اجازه فعالیت در پس‌زمینه بدهید. " +
                        "در گوشی‌های شیائومی/سامسونگ/اوپو هم در تنظیمات برنامه، «شروع خودکار» و «بدون محدودیت باتری» را فعال کنید."
                )
            },
            confirmButton = {
                TextButton(onClick = {
                    Engine.prefs.edit().putBoolean("battery_asked", true).apply()
                    askBattery = false
                    try {
                        ctx.startActivity(Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS, Uri.parse("package:" + ctx.packageName)))
                    } catch (e: Exception) { }
                }) { Text("تنظیم") }
            },
            dismissButton = {
                TextButton(onClick = {
                    Engine.prefs.edit().putBoolean("battery_asked", true).apply()
                    askBattery = false
                }) { Text("بعداً") }
            }
        )
    }
}
