package com.pchat.app

import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.platform.LocalHapticFeedback
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.tween
import androidx.compose.animation.core.LinearEasing
import androidx.compose.animation.core.RepeatMode
import androidx.compose.ui.draw.scale
import androidx.compose.ui.draw.alpha
import androidx.compose.foundation.border
import androidx.compose.material3.Icon
import androidx.compose.ui.graphics.compositeOver
import androidx.compose.foundation.layout.width
import android.Manifest
import android.content.Context
import android.os.Build
import android.content.pm.PackageManager
import android.widget.Toast
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.Image
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.runtime.produceState
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.ImageBitmap
import androidx.compose.ui.graphics.lerp
import androidx.compose.ui.layout.ContentScale
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalConfiguration
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.viewinterop.AndroidView
import androidx.core.content.ContextCompat
import kotlinx.coroutines.delay
import org.webrtc.RendererCommon
import org.webrtc.SurfaceViewRenderer
import org.webrtc.VideoTrack

private fun granted(ctx: Context, p: String) =
    ContextCompat.checkSelfPermission(ctx, p) == PackageManager.PERMISSION_GRANTED

/** Returns a function (peer, video) that asks for mic/camera permission if needed and then starts the call. */
@Composable
fun rememberCallStarter(): (String, Boolean) -> Unit {
    val ctx = LocalContext.current
    var pending by remember { mutableStateOf<Pair<String, Boolean>?>(null) }
    val launcher = rememberLauncherForActivityResult(ActivityResultContracts.RequestMultiplePermissions()) { _ ->
        val p = pending
        pending = null
        if (p != null) {
            if (granted(ctx, Manifest.permission.RECORD_AUDIO)) {
                val cam = granted(ctx, Manifest.permission.CAMERA)
                if (p.second && !cam) Toast.makeText(ctx, "دسترسی دوربین داده نشد؛ تماس صوتی برقرار می‌شود", Toast.LENGTH_LONG).show()
                CallManager.startCall(p.first, p.second && cam)
            } else {
                Toast.makeText(ctx, "برای تماس باید اجازه میکروفون بدهید", Toast.LENGTH_LONG).show()
            }
        }
    }
    return { peer, video ->
        val need = ArrayList<String>()
        if (!granted(ctx, Manifest.permission.RECORD_AUDIO)) need.add(Manifest.permission.RECORD_AUDIO)
        if (video && !granted(ctx, Manifest.permission.CAMERA)) need.add(Manifest.permission.CAMERA)
        if (Build.VERSION.SDK_INT >= 31 && !Prefs.btAsked && !granted(ctx, Manifest.permission.BLUETOOTH_CONNECT)) {
            Prefs.btAsked = true // asked once (1.9: Bluetooth headsets); the call works without it too
            need.add(Manifest.permission.BLUETOOTH_CONNECT)
        }
        if (need.isEmpty()) {
            CallManager.startCall(peer, video)
        } else {
            pending = Pair(peer, video)
            launcher.launch(need.toTypedArray())
        }
    }
}

@Composable
private fun rememberAcceptHandler(video: Boolean): () -> Unit {
    val ctx = LocalContext.current
    val launcher = rememberLauncherForActivityResult(ActivityResultContracts.RequestMultiplePermissions()) { _ ->
        if (granted(ctx, Manifest.permission.RECORD_AUDIO)) CallManager.accept()
        else {
            Toast.makeText(ctx, "برای پاسخ باید اجازه میکروفون بدهید", Toast.LENGTH_LONG).show()
            CallManager.decline()
        }
    }
    return {
        val need = ArrayList<String>()
        if (!granted(ctx, Manifest.permission.RECORD_AUDIO)) need.add(Manifest.permission.RECORD_AUDIO)
        if (video && !granted(ctx, Manifest.permission.CAMERA)) need.add(Manifest.permission.CAMERA)
        if (Build.VERSION.SDK_INT >= 31 && !Prefs.btAsked && !granted(ctx, Manifest.permission.BLUETOOTH_CONNECT)) {
            Prefs.btAsked = true // asked once (1.9: Bluetooth headsets); the call works without it too
            need.add(Manifest.permission.BLUETOOTH_CONNECT)
        }
        if (need.isEmpty()) CallManager.accept() else launcher.launch(need.toTypedArray())
    }
}

@Composable
fun VideoView(track: VideoTrack?, mirror: Boolean, overlay: Boolean, modifier: Modifier) {
    val ctx = LocalContext.current
    val view = remember {
        SurfaceViewRenderer(ctx).apply {
            init(CallManager.egl.eglBaseContext, null)
            setEnableHardwareScaler(true)
            setScalingType(RendererCommon.ScalingType.SCALE_ASPECT_FILL)
            if (overlay) setZOrderMediaOverlay(true)
        }
    }
    DisposableEffect(track) {
        track?.addSink(view)
        onDispose { try { track?.removeSink(view) } catch (e: Exception) { } }
    }
    DisposableEffect(Unit) {
        onDispose { try { view.release() } catch (e: Exception) { } }
    }
    AndroidView(factory = { view }, update = { it.setMirror(mirror) }, modifier = modifier)
}

/** 1.28: a round call button with a real icon; [pulse] = rings that keep spreading out (the «پاسخ» button) */
@Composable
fun RoundBtn(icon: ImageVector, caption: String, bg: Color, size: Int = 68, pulse: Boolean = false, onClick: () -> Unit) {
    val haptic = LocalHapticFeedback.current
    Column(horizontalAlignment = Alignment.CenterHorizontally) {
        Box(contentAlignment = Alignment.Center) {
            if (pulse) {
                val t = rememberInfiniteTransition(label = "ring")
                for (i in 0..1) {
                    val k by t.animateFloat(0f, 1f, infiniteRepeatable(tween(1800, delayMillis = i * 900, easing = LinearEasing), RepeatMode.Restart), label = "r$i")
                    Box(Modifier.size(size.dp).scale(1f + 0.7f * k).alpha(1f - k).border(2.dp, bg, CircleShape))
                }
            }
            Box(
                Modifier.size(size.dp).clip(CircleShape).background(bg).clickable { Ui.tick(haptic); onClick() },
                contentAlignment = Alignment.Center
            ) { Icon(icon, contentDescription = caption, tint = Color.White, modifier = Modifier.size((size * 0.42f).dp)) }
        }
        Spacer(Modifier.height(6.dp))
        Text(caption, fontSize = 12.sp, color = Color.White.copy(alpha = 0.85f), maxLines = 1)
    }
}

/** 1.28: the see-through panel the call buttons sit on, readable on any photo or video */
@Composable
fun CallPanel(modifier: Modifier, content: @Composable () -> Unit) {
    Row(
        modifier.clip(RoundedCornerShape(30.dp)).background(Color(0xFF141C24).copy(alpha = 0.42f)).padding(horizontal = 14.dp, vertical = 14.dp),
        horizontalArrangement = Arrangement.spacedBy(16.dp), verticalAlignment = Alignment.Top
    ) { content() }
}

@Composable
fun CallScreen() {
    val s by CallManager.state.collectAsState()
    val remote by CallManager.remoteTrack.collectAsState()
    val local by CallManager.localTrack.collectAsState()
    var now by remember { mutableStateOf(System.currentTimeMillis()) }
    LaunchedEffect(Unit) { while (true) { delay(1000); now = System.currentTimeMillis() } }
    val accept = rememberAcceptHandler(s.video)
    SystemBars.DarkWhileShown()

    val status = when (s.phase) {
        CallPhase.INCOMING -> if (s.video) "تماس تصویری ورودی" else "تماس صوتی ورودی"
        // 1.26: the other side is on another call
        CallPhase.OUTGOING -> when (s.busy) {
            1 -> "در حال مکالمه است"
            2 -> {
                val sec = ((now - s.waitFrom) / 1000).toInt().coerceAtLeast(0)
                "در انتظار… %02d:%02d".format(sec / 60, sec % 60)
            }
            else -> "در حال زنگ زدن…"
        }
        CallPhase.CONNECTING -> "در حال اتصال…"
        CallPhase.ACTIVE -> {
            val sec = ((now - s.startedAt) / 1000).toInt().coerceAtLeast(0)
            "%02d:%02d".format(sec / 60, sec % 60)
        }
        else -> ""
    }
    val remoteVideo = s.video && remote != null && s.phase == CallPhase.ACTIVE
    // 1.8: tap the small picture to swap it with the big one (like Telegram); tap again to swap back
    var swapped by remember(s.callId) { mutableStateOf(false) }
    val showLocal = s.video && local != null && s.phase != CallPhase.INCOMING
    val swap = swapped && remoteVideo && showLocal

    Box(Modifier.fillMaxSize().background(Color(0xFF101820))) {
        if (remoteVideo) {
            // the two views stay where they are; only the pictures they show change places
            VideoView(if (swap) local else remote, swap && s.front, false, Modifier.fillMaxSize())
        } else {
            // 1.27: the other person's photo fills the screen (or their colour and initial, without a photo)
            CallBackdrop(s.peer)
        }
        Column(
            Modifier.align(Alignment.TopCenter).statusBarsPadding().padding(top = 28.dp),
            horizontalAlignment = Alignment.CenterHorizontally
        ) {
            Text(Engine.nameOf(s.peer), color = Color.White, fontSize = 24.sp, fontWeight = FontWeight.Bold)
            // 1.28: «در حال زنگ زدن» / «در حال اتصال» with moving dots
            if (status.endsWith("…") && !status.startsWith("در انتظار")) Row(verticalAlignment = Alignment.CenterVertically) {
                Text(status.removeSuffix("…"), color = Color.White.copy(alpha = 0.8f), fontSize = 15.sp)
                Spacer(Modifier.width(5.dp)); TypingDots(Color.White, 5)
            } else Text(U.faDigits(status), color = Color.White.copy(alpha = 0.8f), fontSize = 15.sp)
            // 1.15: a short note when a chosen path could not be reached (the path itself is in the 🔀 panel)
            if (s.phase == CallPhase.OUTGOING && s.busy != 0) {
                Text(
                    if (s.busy == 1) "اگر منتظر بمانید، وقتی مکالمه‌اش تمام شد تماس خودکار برقرار می‌شود"
                    else "وقتی مکالمه‌اش تمام شد، تماس خودکار برقرار می‌شود",
                    color = Color(0xFFFFCC80), fontSize = 13.sp, textAlign = TextAlign.Center,
                    modifier = Modifier.padding(horizontal = 32.dp, vertical = 6.dp)
                )
            }
            if (s.canRoute && s.phase == CallPhase.ACTIVE && s.routeNote.isNotEmpty()) Text(s.routeNote, color = Color(0xFFFFCC80), fontSize = 13.sp)
        }
        if (showLocal) {
            val small = Modifier.align(Alignment.TopEnd).statusBarsPadding().padding(16.dp).size(width = 110.dp, height = 150.dp).clip(RoundedCornerShape(12.dp))
            VideoView(if (swap) remote else local, !swap && s.front, true, small)
            if (remoteVideo) Box(small.clickable { swapped = !swapped })
        }
        val red = Color(0xFFE53935)
        val glass = Color(0x33FFFFFF)
        val acc = Look.callAccent
        CallPanel(Modifier.align(Alignment.BottomCenter).navigationBarsPadding().padding(start = 10.dp, end = 10.dp, bottom = 28.dp)) {
            if (s.phase == CallPhase.INCOMING) {
                RoundBtn(SIcons.callEnd, "رد", red) { CallManager.decline() }
                Spacer(Modifier.width(28.dp))
                RoundBtn(if (s.video) SIcons.video else SIcons.call, "پاسخ", Color(0xFF43A047), pulse = true) { accept() }
            } else if (s.phase == CallPhase.OUTGOING && s.busy == 1) {
                RoundBtn(SIcons.callEnd, "قطع", red) { CallManager.hangup() }
                RoundBtn(SIcons.hourglass, "منتظر می‌مانم", acc) { CallManager.waitForPeer() }
            } else if (s.phase == CallPhase.OUTGOING && s.busy == 2) {
                RoundBtn(SIcons.callEnd, "لغو انتظار", red) { CallManager.hangup() }
            } else {
                val many = s.video && local != null
                val sz = if (many) 54 else 68
                RoundBtn(if (s.muted) SIcons.micOff else SIcons.mic, "بی‌صدا", if (s.muted) Color.White.copy(alpha = 0.9f).compositeOver(Color(0xFF5C6B7A)) else glass, sz) { CallManager.toggleMute() }
                // 1.9: with a Bluetooth headset the button cycles phone → speaker → headset
                val (ico, cap) = when (s.route) {
                    AudioRoute.BLUETOOTH -> SIcons.bluetooth to "بلوتوث"
                    AudioRoute.SPEAKER -> SIcons.speaker to "بلندگو"
                    AudioRoute.EARPIECE -> (if (s.bt) SIcons.ear else SIcons.speaker) to (if (s.bt) "گوشی" else "بلندگو")
                }
                RoundBtn(ico, cap, if (s.route != AudioRoute.EARPIECE) acc else glass, sz) { CallManager.toggleSpeaker() }
                if (many) {
                    RoundBtn(if (s.camOff) SIcons.videoOff else SIcons.video, "دوربین", if (s.camOff) Color(0xFF5C6B7A) else glass, sz) { CallManager.toggleCamera() }
                    RoundBtn(SIcons.flipCamera, "چرخش", glass, sz) { CallManager.switchCamera() }
                }
                RoundBtn(SIcons.callEnd, "قطع", red, sz) { CallManager.hangup() }
            }
        }
        // 1.19: «افزودن نفر» turns this voice call into a group call (the other side moves over by itself)
        val gcfg by GroupCall.cfg.collectAsState()
        var adding by remember(s.callId) { mutableStateOf(false) }
        if (gcfg.on && !s.video && s.phase == CallPhase.ACTIVE) {
            Box(
                Modifier.align(Alignment.TopEnd).statusBarsPadding().padding(end = 12.dp, top = 24.dp).clip(RoundedCornerShape(18.dp))
                    .background(Color(0x33FFFFFF)).clickable { adding = true }.padding(horizontal = 12.dp, vertical = 8.dp)
            ) { Icon(SIcons.personAdd, contentDescription = "افزودن به تماس", tint = Color.White) }
        }
        if (adding) PeoplePicker(PickReq("افزودن به تماس", callablePeople().filter { it != s.peer }, "زنگ بزن", maxVoice() - 2) { users ->
            if (CallManager.state.value.phase == CallPhase.ACTIVE) CallManager.upgradeToGroup(users)
        }) { adding = false }
        // 1.15: path menu (users the admin allowed): خودکار / مستقیم / از طریق سرور › UDP, TCP, TLS
        if (s.canRoute && s.phase == CallPhase.ACTIVE) RouteMenu(s, Modifier.align(Alignment.CenterEnd).padding(end = 12.dp))
        // 1.7 test feature: ping and route for the admins listed in the panel (see Diag.kt)
        val diagOn by Engine.diag.collectAsState()
        if (diagOn && s.phase != CallPhase.INCOMING && s.phase != CallPhase.IDLE) {
            // 1.9: the eye button shows / hides the text over the video; the choice is remembered
            val showText by Prefs.diagText.collectAsState()
            if (showText) DiagOverlay(s.peer, Modifier.align(Alignment.CenterStart).statusBarsPadding().padding(start = 8.dp, top = 90.dp))
            Box(
                Modifier.align(Alignment.TopStart).statusBarsPadding().padding(start = 8.dp, top = 20.dp).size(48.dp).padding(4.dp).clip(CircleShape)
                    .background(if (showText) Look.callAccent.copy(alpha = 0.4f) else Color(0x33FFFFFF)).clickable { Prefs.setDiagText(!showText) },
                contentAlignment = Alignment.Center
            ) { Icon(if (showText) SIcons.eye else SIcons.eyeOff, contentDescription = "متن آزمایشی", tint = Color.White, modifier = Modifier.size(20.dp)) }
        }
    }
}

/**
 * 1.15: the 🔀 button and its two-level path panel. Like the ping eye, the button shows / hides the panel and
 * the choice is remembered. The panel is at most a third of the screen wide and see-through, so it covers
 * little of a video call.
 */
@Composable
private fun RouteMenu(s: CallState, modifier: Modifier) {
    val ctx = LocalContext.current
    val shown by Prefs.routePanel.collectAsState()
    var level by remember(s.callId) { mutableStateOf("top") } // "top" | "server"
    val maxW = (LocalConfiguration.current.screenWidthDp / 3).dp
    Column(modifier, horizontalAlignment = Alignment.End) {
        Box(
            Modifier.size(48.dp).padding(4.dp).clip(CircleShape)
                .background(if (shown && s.peerRoute) Look.callAccent.copy(alpha = 0.4f) else Color(0x33FFFFFF))
                .clickable {
                    if (!s.peerRoute) Toast.makeText(ctx, "طرف مقابل نسخهٔ قدیمی ${BuildConfig.APP_NAME} را دارد؛ تغییر مسیر ممکن نیست", Toast.LENGTH_SHORT).show()
                    else Prefs.setRoutePanel(!shown)
                },
            contentAlignment = Alignment.Center
        ) { Icon(SIcons.route, contentDescription = "مسیر تماس", tint = if (s.peerRoute) Color.White else Color.White.copy(alpha = 0.4f), modifier = Modifier.size(20.dp)) }
        if (shown && s.peerRoute) {
            Spacer(Modifier.height(6.dp))
            Column(Modifier.widthIn(max = maxW).clip(RoundedCornerShape(10.dp)).background(Color(0x8010202F)).padding(4.dp)) {
                val head = if (s.routing) "در حال تغییر…" else s.path.ifEmpty { "مسیر اتصال" }
                Text(head, color = Color.White.copy(alpha = 0.7f), fontSize = 11.sp, modifier = Modifier.padding(horizontal = 8.dp, vertical = 3.dp))
                fun pick(m: String) { level = "top"; CallManager.setRoute(m) }
                val ok = !s.routing
                if (level == "server") {
                    RouteItem("→ سرور", false, true) { level = "top" }
                    RouteItem("UDP", s.netMode == "udp", ok && "udp" in s.netModes) { pick("udp") }
                    RouteItem("TCP", s.netMode == "tcp", ok && "tcp" in s.netModes) { pick("tcp") }
                    RouteItem("TLS", s.netMode == "tls", ok && "tls" in s.netModes) { pick("tls") }
                } else {
                    RouteItem("خودکار", s.netMode == "auto", ok) { pick("auto") }
                    RouteItem("مستقیم", s.netMode == "direct", ok && "direct" in s.netModes) { pick("direct") }
                    RouteItem("سرور ‹", s.netMode in listOf("udp", "tcp", "tls"), ok) { level = "server" }
                }
            }
        }
    }
}

@Composable
private fun RouteItem(label: String, cur: Boolean, enabled: Boolean, onClick: () -> Unit) {
    Text(
        (if (cur) "✓ " else "") + label,
        color = if (!enabled) Color.White.copy(alpha = 0.35f) else if (cur) Color(0xFF64B5F6) else Color.White,
        fontSize = 13.sp, maxLines = 1,
        modifier = Modifier.fillMaxWidth().clip(RoundedCornerShape(8.dp)).clickable(enabled = enabled, onClick = onClick)
            .padding(horizontal = 8.dp, vertical = 7.dp)
    )
}

/**
 * 1.27: the full-screen picture behind a one-to-one call: the other person's profile photo (cropped to fill),
 * or without one their colour with the first letter of their name. Dark shades at the top and bottom keep the
 * name, the status and the buttons readable on any photo.
 */
@Composable
private fun CallBackdrop(peer: String) {
    val users by Engine.users.collectAsState()
    val ver = users.firstOrNull { it.username == peer }?.avatarVer ?: 0
    val bmp by produceState<ImageBitmap?>(null, peer, ver) { value = if (ver <= 0) null else Engine.avatarBitmap(peer, ver) }
    Box(Modifier.fillMaxSize()) {
        val b = bmp
        if (b != null) {
            Image(b, contentDescription = null, modifier = Modifier.fillMaxSize(), contentScale = ContentScale.Crop)
        } else {
            val c = U.colorFor(peer)
            Box(
                Modifier.fillMaxSize().background(Brush.verticalGradient(listOf(lerp(c, Color.White, 0.12f), lerp(c, Color.Black, 0.55f)))),
                contentAlignment = Alignment.Center
            ) {
                Text(Engine.nameOf(peer).take(1).uppercase(), color = Color.White.copy(alpha = 0.9f), fontSize = 150.sp, fontWeight = FontWeight.Bold)
            }
        }
        Box(
            Modifier.align(Alignment.TopCenter).fillMaxWidth().fillMaxHeight(0.32f)
                .background(Brush.verticalGradient(listOf(Color.Black.copy(alpha = 0.6f), Color.Transparent)))
        )
        Box(
            Modifier.align(Alignment.BottomCenter).fillMaxWidth().fillMaxHeight(0.4f)
                .background(Brush.verticalGradient(listOf(Color.Transparent, Color.Black.copy(alpha = 0.7f))))
        )
    }
}
