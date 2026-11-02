package com.pchat.app

import android.Manifest
import android.content.Context
import android.content.pm.PackageManager
import android.widget.Toast
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
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
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
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

@Composable
private fun RoundBtn(label: String, caption: String, bg: Color, onClick: () -> Unit) {
    Column(horizontalAlignment = Alignment.CenterHorizontally) {
        Box(
            Modifier.size(62.dp).clip(CircleShape).background(bg).clickable(onClick = onClick),
            contentAlignment = Alignment.Center
        ) { Text(label, fontSize = 26.sp, color = Color.White) }
        Spacer(Modifier.height(4.dp))
        Text(caption, fontSize = 12.sp, color = Color.White.copy(alpha = 0.8f))
    }
}

@Composable
fun CallScreen() {
    val s by CallManager.state.collectAsState()
    val remote by CallManager.remoteTrack.collectAsState()
    val local by CallManager.localTrack.collectAsState()
    var now by remember { mutableStateOf(System.currentTimeMillis()) }
    LaunchedEffect(Unit) { while (true) { delay(1000); now = System.currentTimeMillis() } }
    val accept = rememberAcceptHandler(s.video)

    val status = when (s.phase) {
        CallPhase.INCOMING -> if (s.video) "تماس تصویری ورودی" else "تماس صوتی ورودی"
        CallPhase.OUTGOING -> "در حال زنگ زدن…"
        CallPhase.CONNECTING -> "در حال اتصال…"
        CallPhase.ACTIVE -> {
            val sec = ((now - s.startedAt) / 1000).toInt().coerceAtLeast(0)
            "%02d:%02d".format(sec / 60, sec % 60)
        }
        else -> ""
    }
    val remoteVideo = s.video && remote != null && s.phase == CallPhase.ACTIVE

    Box(Modifier.fillMaxSize().background(Color(0xFF101820))) {
        if (remoteVideo) {
            VideoView(remote, false, false, Modifier.fillMaxSize())
        } else {
            Column(Modifier.align(Alignment.Center), horizontalAlignment = Alignment.CenterHorizontally) {
                Avatar(s.peer, false, 120)
            }
        }
        Column(
            Modifier.align(Alignment.TopCenter).statusBarsPadding().padding(top = 28.dp),
            horizontalAlignment = Alignment.CenterHorizontally
        ) {
            Text(Engine.nameOf(s.peer), color = Color.White, fontSize = 24.sp, fontWeight = FontWeight.Bold)
            Text(status, color = Color.White.copy(alpha = 0.75f), fontSize = 15.sp)
        }
        if (s.video && local != null && s.phase != CallPhase.INCOMING) {
            VideoView(
                local, s.front, true,
                Modifier.align(Alignment.TopEnd).statusBarsPadding().padding(16.dp).size(width = 110.dp, height = 150.dp).clip(RoundedCornerShape(12.dp))
            )
        }
        Row(
            Modifier.align(Alignment.BottomCenter).navigationBarsPadding().padding(bottom = 36.dp),
            horizontalArrangement = Arrangement.spacedBy(18.dp)
        ) {
            if (s.phase == CallPhase.INCOMING) {
                RoundBtn("✖", "رد", Color(0xFFE53935)) { CallManager.decline() }
                RoundBtn("📞", "پاسخ", Color(0xFF43A047)) { accept() }
            } else {
                RoundBtn(if (s.muted) "🔇" else "🎤", "بی‌صدا", if (s.muted) Color(0xFF5C6B7A) else Color(0x33FFFFFF)) { CallManager.toggleMute() }
                RoundBtn(if (s.speaker) "🔊" else "🔈", "بلندگو", if (s.speaker) Color(0xFF3390EC) else Color(0x33FFFFFF)) { CallManager.toggleSpeaker() }
                if (s.video && local != null) {
                    RoundBtn(if (s.camOff) "🚫" else "📷", "دوربین", if (s.camOff) Color(0xFF5C6B7A) else Color(0x33FFFFFF)) { CallManager.toggleCamera() }
                    RoundBtn("🔄", "چرخش", Color(0x33FFFFFF)) { CallManager.switchCamera() }
                }
                RoundBtn("✖", "قطع", Color(0xFFE53935)) { CallManager.hangup() }
            }
        }
        // 1.7 test feature: ping and route for the admins listed in the panel (see Diag.kt)
        val diagOn by Engine.diag.collectAsState()
        if (diagOn && s.phase != CallPhase.INCOMING && s.phase != CallPhase.IDLE) {
            DiagOverlay(s.peer, Modifier.align(Alignment.CenterStart).statusBarsPadding().padding(start = 8.dp, top = 90.dp))
        }
    }
}
