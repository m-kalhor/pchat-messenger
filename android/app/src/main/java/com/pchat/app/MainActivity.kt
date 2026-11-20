package com.pchat.app

import androidx.compose.animation.AnimatedContent
import androidx.compose.animation.togetherWith
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.slideInHorizontally
import androidx.compose.animation.slideOutHorizontally
import androidx.compose.animation.core.tween
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
import androidx.activity.SystemBarStyle
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
        if (intent.getBooleanExtra("update", false)) Updater.showAgain()
        setContent { PChatTheme { App(deepLink) } }
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        deepLink.value = intent.getStringExtra("convo")
        if (intent.getBooleanExtra("update", false)) Updater.showAgain()
    }

    override fun onStart() { super.onStart(); Engine.appVisible = true; Engine.setActive(true); AppLock.onAppStart(); Engine.refreshDirectory() }
    override fun onStop() { super.onStop(); Engine.appVisible = false; Engine.setActive(false); VoicePlayer.stop(); AppLock.onAppStop() }
}

/**
 * Which colour the system bar icons need. They follow the app's own theme (not the
 * phone's dark mode); screens with the blue header want white status-bar icons, and
 * full-screen dark screens in the main window (the call screen) want white icons on both bars.
 */
object SystemBars {
    val headerScreens = androidx.compose.runtime.mutableIntStateOf(0)
    val darkScreens = androidx.compose.runtime.mutableIntStateOf(0)

    @Composable
    fun HeaderShown() = Counted(headerScreens)

    @Composable
    fun DarkWhileShown() = Counted(darkScreens)

    @Composable
    private fun Counted(n: androidx.compose.runtime.MutableIntState) {
        DisposableEffect(Unit) {
            n.intValue++
            onDispose { n.intValue-- }
        }
    }
}

@Composable
fun PChatTheme(content: @Composable () -> Unit) {
    val theme by Prefs.theme.collectAsState()
    val dark = when (theme) { Prefs.THEME_LIGHT -> false; Prefs.THEME_DARK -> true; else -> isSystemInDarkTheme() }
    // 1.28: one main colour everywhere (bars, buttons, badges, links), chosen in Settings; Sepan blue by default
    val acc by Prefs.accent.collectAsState()
    val a = Look.accent(acc)
    val scheme = if (dark) {
        darkColorScheme(primary = a.dark, onPrimary = Color(0xFF0E1621), background = Color(0xFF0E1621), surface = Color(0xFF17212B), surfaceVariant = Color(0xFF0E1621),
            primaryContainer = a.dark.copy(alpha = 0.22f), onPrimaryContainer = Color.White, secondaryContainer = a.dark.copy(alpha = 0.22f), onSecondaryContainer = Color.White)
    } else {
        lightColorScheme(primary = a.light, background = Color.White, surface = Color.White, surfaceVariant = Color(0xFFDDE6EE),
            primaryContainer = a.light.copy(alpha = 0.14f), onPrimaryContainer = Color(0xFF0D2340), secondaryContainer = a.light.copy(alpha = 0.14f), onSecondaryContainer = Color(0xFF0D2340))
    }
    // light bars = dark icons (on a white background); dark bars = white icons
    val activity = LocalContext.current as? ComponentActivity
    val headerScreens by SystemBars.headerScreens
    val darkScreens by SystemBars.darkScreens
    val darkNav = dark || darkScreens > 0
    val darkStatus = darkNav || headerScreens > 0
    LaunchedEffect(darkStatus, darkNav, activity) {
        val clear = android.graphics.Color.TRANSPARENT
        activity?.enableEdgeToEdge(
            statusBarStyle = if (darkStatus) SystemBarStyle.dark(clear) else SystemBarStyle.light(clear, clear),
            navigationBarStyle = if (darkNav) SystemBarStyle.dark(clear) else SystemBarStyle.light(clear, clear)
        )
    }
    MaterialTheme(colorScheme = scheme, typography = remember { Look.typography() }) {
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

    val updateOffer by Updater.offer.collectAsState()
    val notifPerm = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { }
    val call by CallManager.state.collectAsState()
    val gcall by GroupCall.state.collectAsState()
    val gOn = gcall.phase != GPhase.IDLE
    val inCall = call.phase != CallPhase.IDLE || gOn
    val locked by AppLock.locked.collectAsState()

    // show over the lock screen only while a call is ringing / running
    LaunchedEffect(call.phase, gcall.phase) {
        val act = ctx as? Activity
        if (act != null && Build.VERSION.SDK_INT >= 27) {
            act.setShowWhenLocked(inCall)
            act.setTurnScreenOn(call.phase == CallPhase.INCOMING || gcall.phase == GPhase.INCOMING)
        }
        // never let the screen time out during a call (a video call used to go black)
        if (act != null) {
            if (inCall) act.window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
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
            Updater.checkWhatsNew(ctx) // 1.22.1
            Updater.check(ctx)?.let { Updater.offer.value = it }
        } else {
            convo = null
            settings = false
            ctx.stopService(Intent(ctx, MessengerService::class.java))
        }
    }
    BackHandler(enabled = convo != null && !inCall) { convo = null }
    BackHandler(enabled = settings && convo == null && !inCall) { settings = false }

    val ks = keyStep
    if (!logged) {
        LoginScreen()
    } else if (call.phase != CallPhase.IDLE) {
        CallScreen()
    } else if (gOn) {
        GroupCallScreen() // 1.19
    } else if (locked) {
        LockScreen()
    } else if (ks != null) {
        KeyScreen(ks, onLogout = { Engine.logout() })
    } else {
        // 1.28: screens slide in from the left (RTL: forward) and back out to the right; off when the phone's animations are off
        val target = convo?.let { "c:$it" } ?: if (settings) "settings" else "list"
        val still = remember { Ui.reduceMotion(ctx) }
        AnimatedContent(
            targetState = target, label = "screens",
            transitionSpec = {
                val depth = { k: String -> if (k == "list") 0 else 1 }
                val fwd = depth(targetState) > depth(initialState)
                val back = depth(targetState) < depth(initialState)
                if (still || (!fwd && !back)) fadeIn(tween(if (still) 0 else 150)) togetherWith fadeOut(tween(if (still) 0 else 150))
                else if (fwd) (slideInHorizontally(tween(260)) { -it } + fadeIn(tween(200))) togetherWith (slideOutHorizontally(tween(260)) { it / 4 } + fadeOut(tween(260)))
                else (slideInHorizontally(tween(260)) { -it / 4 } + fadeIn(tween(260))) togetherWith (slideOutHorizontally(tween(260)) { it } + fadeOut(tween(200)))
            }
        ) { t ->
            when {
                t == "settings" -> SettingsScreen(onBack = { settings = false }, onLogout = { settings = false; Engine.logout() })
                t == "list" -> ChatListScreen(onOpen = { convo = it }, onSettings = { settings = true }, onLogout = { Engine.logout() })
                else -> ChatScreen(t.removePrefix("c:"), onBack = { convo = null }, onOpenUser = { convo = it })
            }
        }
    }

    val offer = updateOffer
    if (offer != null && offer.code != Updater.dismissed && logged && !askBattery && !inCall && !locked && ks == null) {
        UpdateDialog(offer) { Updater.dismissed = offer.code; Updater.offer.value = null }
    }

    val news by Updater.whatsNew.collectAsState()
    news?.let { (name, notes) ->
        if (logged && offer == null && !askBattery && !inCall && !locked && ks == null) WhatsNewDialog(name, notes) { Updater.whatsNew.value = null }
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
