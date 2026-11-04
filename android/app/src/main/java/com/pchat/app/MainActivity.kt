package com.pchat.app

import android.Manifest
import android.app.Activity
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.PowerManager
import android.provider.Settings
import android.view.WindowManager
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
import androidx.compose.runtime.DisposableEffect
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

    override fun onStart() { super.onStart(); Engine.appVisible = true; Engine.setActive(true); AppLock.onAppStart(); Engine.refreshDirectory() }
    override fun onStop() { super.onStop(); Engine.appVisible = false; Engine.setActive(false); VoicePlayer.stop(); AppLock.onAppStop() }
}

@Composable
fun PChatTheme(content: @Composable () -> Unit) {
    val theme by Prefs.theme.collectAsState()
    val dark = when (theme) { Prefs.THEME_LIGHT -> false; Prefs.THEME_DARK -> true; else -> isSystemInDarkTheme() }
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
    val keyStep by Engine.keyStep.collectAsState()
    var convo by remember { mutableStateOf<String?>(null) }
    var settings by remember { mutableStateOf(false) }
    var askBattery by remember { mutableStateOf(false) }

    var updateOffer by remember { mutableStateOf<AppUpdate?>(null) }
    val notifPerm = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { }
    val call by CallManager.state.collectAsState()
    val locked by AppLock.locked.collectAsState()

    // show over the lock screen only while a call is ringing / running
    LaunchedEffect(call.phase) {
        val act = ctx as? Activity
        if (act != null && Build.VERSION.SDK_INT >= 27) {
            act.setShowWhenLocked(call.phase != CallPhase.IDLE)
            act.setTurnScreenOn(call.phase == CallPhase.INCOMING)
        }
        // never let the screen time out during a call (a video call used to go black)
        if (act != null) {
            if (call.phase != CallPhase.IDLE) act.window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
            else act.window.clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        }
    }

    // voice call held to the ear: switch the screen off with the proximity sensor, like Telegram
    val earpiece = call.phase != CallPhase.IDLE && call.phase != CallPhase.INCOMING && !call.video && call.route == AudioRoute.EARPIECE
    DisposableEffect(earpiece) {
        val pm = ctx.getSystemService(PowerManager::class.java)
        val lock = if (earpiece && pm.isWakeLockLevelSupported(PowerManager.PROXIMITY_SCREEN_OFF_WAKE_LOCK))
            pm.newWakeLock(PowerManager.PROXIMITY_SCREEN_OFF_WAKE_LOCK, "pchat:proximity").apply { setReferenceCounted(false); acquire(4 * 3600 * 1000L) }
        else null
        onDispose { try { lock?.release(PowerManager.RELEASE_FLAG_WAIT_FOR_NO_PROXIMITY) } catch (e: Exception) { } }
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
            // 1.9: a newer APK on the server is offered each time the app is opened (never forced)
            Updater.cleanup(ctx)
            updateOffer = Updater.check(ctx)
        } else {
            convo = null
            settings = false
            ctx.stopService(Intent(ctx, MessengerService::class.java))
        }
    }
    BackHandler(enabled = convo != null && call.phase == CallPhase.IDLE) { convo = null }
    BackHandler(enabled = settings && convo == null && call.phase == CallPhase.IDLE) { settings = false }

    val ks = keyStep
    if (!logged) {
        LoginScreen()
    } else if (call.phase != CallPhase.IDLE) {
        CallScreen()
    } else if (locked) {
        LockScreen()
    } else if (ks != null) {
        KeyScreen(ks, onLogout = { Engine.logout() })
    } else {
        val c = convo
        if (c == null && settings) SettingsScreen(onBack = { settings = false }, onLogout = { settings = false; Engine.logout() })
        else if (c == null) ChatListScreen(onOpen = { convo = it }, onSettings = { settings = true }, onLogout = { Engine.logout() })
        else ChatScreen(c, onBack = { convo = null }, onOpenUser = { convo = it })
    }

    val offer = updateOffer
    if (offer != null && logged && !askBattery && call.phase == CallPhase.IDLE && !locked && ks == null) {
        UpdateDialog(offer) { updateOffer = null }
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
