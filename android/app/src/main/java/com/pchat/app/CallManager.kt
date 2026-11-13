package com.pchat.app

import android.Manifest
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.media.AudioAttributes
import android.media.AudioManager
import android.media.Ringtone
import android.media.RingtoneManager
import android.os.Build
import android.os.VibrationEffect
import android.os.Vibrator
import android.os.VibratorManager
import android.os.Handler
import android.os.Looper
import android.widget.Toast
import androidx.core.content.ContextCompat
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.suspendCancellableCoroutine
import org.json.JSONObject
import org.webrtc.AudioSource
import org.webrtc.AudioTrack
import org.webrtc.Camera2Enumerator
import org.webrtc.CameraVideoCapturer
import org.webrtc.DefaultVideoDecoderFactory
import org.webrtc.DefaultVideoEncoderFactory
import org.webrtc.EglBase
import org.webrtc.IceCandidate
import org.webrtc.MediaConstraints
import org.webrtc.MediaStream
import org.webrtc.PeerConnection
import org.webrtc.PeerConnectionFactory
import org.webrtc.RTCStatsReport
import org.webrtc.RtpTransceiver
import org.webrtc.SdpObserver
import org.webrtc.SessionDescription
import org.webrtc.SurfaceTextureHelper
import org.webrtc.VideoSource
import org.webrtc.VideoTrack
import org.webrtc.DataChannel
import org.webrtc.audio.JavaAudioDeviceModule
import java.util.UUID
import kotlin.coroutines.resume
import kotlin.coroutines.resumeWithException

enum class CallPhase { IDLE, OUTGOING, INCOMING, CONNECTING, ACTIVE }

data class CallState(
    val phase: CallPhase = CallPhase.IDLE,
    val peer: String = "",
    val video: Boolean = false,
    val callId: String = "",
    val incoming: Boolean = false,
    val muted: Boolean = false,
    val camOff: Boolean = false,
    val speaker: Boolean = false,
    val route: AudioRoute = AudioRoute.EARPIECE,
    val bt: Boolean = false,
    val front: Boolean = true,
    val startedAt: Long = 0L,
    val note: String = "",
    // 1.15: call path chosen by the user (only users the admin ticked in the panel, column «مسیر تماس»)
    val canRoute: Boolean = false,     // this user may choose (from /api/turn)
    val peerRoute: Boolean = false,    // the other app understands it (1.15 or newer)
    val netMode: String = "auto",      // auto | direct | udp | tcp | tls
    val netModes: List<String> = emptyList(), // the modes this server offers
    val routing: Boolean = false,      // a path change is under way
    val path: String = "",             // the path in use now, e.g. «مستقیم · UDP»
    val routeNote: String = ""
)

open class SdpAdapter : SdpObserver {
    override fun onCreateSuccess(d: SessionDescription?) {}
    override fun onSetSuccess() {}
    override fun onCreateFailure(e: String?) {}
    override fun onSetFailure(e: String?) {}
}

/**
 * 1-to-1 voice/video calls over WebRTC (DTLS-SRTP media, our own TURN server for relaying).
 * Signalling goes through the messenger server as live-only "sig_*" messages whose content is end-to-end encrypted.
 */
object CallManager {
    val state = MutableStateFlow(CallState())
    val remoteTrack = MutableStateFlow<VideoTrack?>(null)
    val localTrack = MutableStateFlow<VideoTrack?>(null)

    lateinit var egl: EglBase
    private lateinit var app: Context
    private val lock = Any()
    private val main = Handler(Looper.getMainLooper())

    private var factory: PeerConnectionFactory? = null
    private var pc: PeerConnection? = null
    /** The live peer connection (the admins' call diagnostics read its stats), or null. */
    val peerConnection: PeerConnection? get() = pc
    private var audioSource: AudioSource? = null
    private var audioTrack: AudioTrack? = null
    private var videoSource: VideoSource? = null
    private var localVideo: VideoTrack? = null
    private var capturer: CameraVideoCapturer? = null
    private var helper: SurfaceTextureHelper? = null
    private var turnInfo: TurnInfo? = null
    private var offerSdp: String? = null
    private val pendingIce = ArrayList<Pair<String, IceCandidate>>()
    private var remoteSet = false
    private var ringtone: Ringtone? = null
    private var vibrator: Vibrator? = null
    private var builtinRing = false
    private var timeoutTask: Runnable? = null
    private var disconnectTask: Runnable? = null
    // 1.10.1: switch a bad direct call to the server relay (admin panel «تنظیمات تماس», mode «خودکار»)
    private var rtcConfig: PeerConnection.RTCConfiguration? = null
    private var peerRelay = false   // the other app understands sig_relay / sig_reoffer / sig_reanswer
    private var switching = false
    private var relayed = false
    private var iceHold = false
    private val heldIce = ArrayList<IceCandidate>()
    private var watchJob: Job? = null
    // 1.15: user-chosen call path
    private var guardJob: Job? = null
    @Volatile private var guardUntil = 0L
    private var pathJob: Job? = null
    private var peerPref = "auto"
    val ROUTE_NAMES = linkedMapOf("auto" to "خودکار", "direct" to "مستقیم (UDP)", "udp" to "سرور · UDP", "tcp" to "سرور · TCP", "tls" to "سرور · TLS")

    private class Res(
        val pc: PeerConnection?, val at: AudioTrack?, val asrc: AudioSource?, val lv: VideoTrack?,
        val vs: VideoSource?, val cap: CameraVideoCapturer?, val hp: SurfaceTextureHelper?
    )

    fun init(ctx: Context) {
        app = ctx.applicationContext
        egl = EglBase.create()
    }

    // ------------------------------------------------------------ public actions

    fun startCall(peer: String, video: Boolean) {
        val id = UUID.randomUUID().toString().take(12)
        // 1.9.2: someone who never logged in has no key yet, so the invite cannot be encrypted.
        // Say so up front instead of starting (and instantly tearing down) a call.
        if (Engine.users.value.firstOrNull { it.username == peer }?.pubkey.isNullOrEmpty()) {
            main.post { Toast.makeText(app, "این کاربر هنوز وارد سپن نشده؛ بعد از اولین ورودش می‌توانید با او تماس بگیرید", Toast.LENGTH_LONG).show() }
            return
        }
        synchronized(lock) {
            if (state.value.phase != CallPhase.IDLE) return
            state.value = CallState(CallPhase.OUTGOING, peer, video, id, incoming = false, speaker = video, note = "در حال برقراری تماس…")
        }
        CallTones.stop()
        Engine.scope.launch {
            try {
                turnInfo = fetchTurn()
                val f = ensureFactory()
                setupAudioMode(video)
                val p = createPeer(f, video)
                val offer = createOffer(p)
                setLocal(p, offer)
                val delivered = sendSignal(peer, "sig_invite", JSONObject().put("callId", id).put("video", video).put("sdp", offer.description).put("relay", 1).put("route", 1))
                if (!delivered) { endCall("کاربر الان آنلاین نیست", false, CallTones.Tone.UNREACHABLE); return@launch }
                // 1.9.2: the foreground service starts only once the invite really reached the peer.
                // Starting it earlier and stopping it a few ms later (peer offline) crashed the app with
                // ForegroundServiceDidNotStartInTimeException.
                if (state.value.phase == CallPhase.IDLE) return@launch
                startCallService(video && hasCamera())
                // 1.13: the caller hears the ringback tone until the other side answers
                if (state.value.phase == CallPhase.OUTGOING && state.value.callId == id) CallTones.play(CallTones.Tone.RINGBACK)
                armTimeout(45_000L, "پاسخی داده نشد", CallTones.Tone.UNREACHABLE)
            } catch (e: Api.HttpError) {
                // 1.7: someone who has not accepted my message request: the call is only noted on the request
                endCall(if (e.error == "not_connected") "تماس بعد از پذیرفتن درخواست ممکن است؛ تماس شما به او خبر داده شد" else "خطا در برقراری تماس (${e.code})", false)
            } catch (e: Exception) {
                endCall("خطا در برقراری تماس: " + (e.message ?: ""), false)
            }
        }
    }

    fun accept() {
        val s = synchronized(lock) { state.value }
        if (s.phase != CallPhase.INCOMING) return
        val offer = offerSdp ?: return
        stopRing(); cancelTimeout(); Engine.cancelCallNotification()
        state.value = s.copy(phase = CallPhase.CONNECTING, note = "در حال اتصال…")
        Engine.scope.launch {
            try {
                turnInfo = fetchTurn()
                val f = ensureFactory()
                setupAudioMode(s.speaker)
                startCallService(s.video && hasCamera())
                val p = createPeer(f, s.video)
                setRemote(p, SessionDescription(SessionDescription.Type.OFFER, offer))
                synchronized(lock) { remoteSet = true }
                flushIce(s.callId)
                val ans = createAnswer(p)
                setLocal(p, ans)
                val pref = if (state.value.canRoute) Prefs.callRoute.value else "auto"
                sendSignal(s.peer, "sig_accept", JSONObject().put("callId", s.callId).put("sdp", ans.description).put("relay", 1).put("route", 1).put("route_pref", pref))
            } catch (e: Exception) {
                endCall("خطا در اتصال تماس", true)
            }
        }
    }

    fun decline() { endCall("", true) }
    fun hangup() { endCall("", true) }

    fun toggleMute() {
        val s = state.value
        val m = !s.muted
        audioTrack?.setEnabled(!m)
        state.value = s.copy(muted = m)
    }

    fun toggleCamera() {
        val s = state.value
        val off = !s.camOff
        localVideo?.setEnabled(!off)
        state.value = s.copy(camOff = off)
    }

    /** 1.9: the audio button cycles earpiece → speaker → Bluetooth headset (see AudioRouter). */
    fun toggleSpeaker() { AudioRouter.cycle() }

    fun switchCamera() {
        capturer?.switchCamera(null)
        state.value = state.value.copy(front = !state.value.front)
    }

    // ------------------------------------------------------------ incoming signals

    fun onSignal(from: String, kind: String, enc: String) {
        val plain = Engine.decryptSignal(from, enc) ?: return
        val j = try { JSONObject(plain) } catch (e: Exception) { return }
        val callId = j.optString("callId")
        when (kind) {
            "sig_invite" -> onInvite(from, callId, j.optBoolean("video"), j.optString("sdp"), j.optInt("relay") == 1, j.optInt("route") == 1)
            "sig_accept" -> onAccepted(from, callId, j.optString("sdp"), j.optInt("relay") == 1, j.optInt("route") == 1, j.optString("route_pref", "auto"))
            "sig_route" -> { val m = j.optString("mode"); if (matches(from, callId) && !state.value.incoming && ROUTE_NAMES.containsKey(m)) Engine.scope.launch { restartTo(m, null) } }
            "sig_relay" -> if (matches(from, callId) && !state.value.incoming) Engine.scope.launch { switchToRelay() }
            "sig_reoffer" -> if (matches(from, callId)) Engine.scope.launch {
                val m = j.optString("mode").takeIf { ROUTE_NAMES.containsKey(it) }
                onReoffer(callId, j.optString("sdp"), m, j.optString("failed").takeIf { ROUTE_NAMES.containsKey(it) })
            }
            "sig_reanswer" -> if (matches(from, callId)) onReanswer(callId, j.optString("sdp"))
            "sig_ice" -> onRemoteIce(callId, IceCandidate(j.optString("mid"), j.optInt("idx"), j.optString("cand")))
            "sig_reject" -> if (matches(from, callId)) {
                endCall(if (j.optString("reason") == "busy") "طرف مقابل در تماس دیگری است" else "تماس رد شد", false, CallTones.Tone.BUSY)
            }
            "sig_hangup" -> if (matches(from, callId)) endCall("تماس پایان یافت", false)
        }
    }

    private fun matches(from: String, callId: String): Boolean {
        val s = state.value
        return s.phase != CallPhase.IDLE && s.peer == from && s.callId == callId
    }

    private fun onInvite(from: String, callId: String, video: Boolean, sdp: String, relay: Boolean, route: Boolean) {
        if (callId.isEmpty() || sdp.isEmpty()) return
        val busy = synchronized(lock) {
            if (state.value.phase != CallPhase.IDLE) true
            else {
                offerSdp = sdp
                peerRelay = relay
                state.value = CallState(CallPhase.INCOMING, from, video, callId, incoming = true, speaker = video, note = "تماس ورودی", peerRoute = route)
                false
            }
        }
        if (busy) {
            Engine.scope.launch {
                try { sendSignal(from, "sig_reject", JSONObject().put("callId", callId).put("reason", "busy")) } catch (e: Exception) { }
            }
            return
        }
        startRing()
        Engine.postCallNotification(from, video)
        armTimeout(45_000L, "تماس بی‌پاسخ ماند")
    }

    private fun onAccepted(from: String, callId: String, sdp: String, relay: Boolean, route: Boolean, pref: String) {
        val p = synchronized(lock) {
            if (!matches(from, callId) || state.value.phase != CallPhase.OUTGOING) return
            peerRelay = relay
            peerPref = if (ROUTE_NAMES.containsKey(pref)) pref else "auto"
            state.value = state.value.copy(peerRoute = route)
            pc
        } ?: return
        cancelTimeout()
        CallTones.stop()
        state.value = state.value.copy(phase = CallPhase.CONNECTING, note = "در حال اتصال…")
        Engine.scope.launch {
            try {
                setRemote(p, SessionDescription(SessionDescription.Type.ANSWER, sdp))
                synchronized(lock) { remoteSet = true }
                flushIce(callId)
            } catch (e: Exception) {
                endCall("خطا در اتصال تماس", true)
            }
        }
    }

    private fun onRemoteIce(callId: String, c: IceCandidate) {
        val (p, ready) = synchronized(lock) { Pair(pc, remoteSet && state.value.callId == callId) }
        if (p != null && ready) {
            p.addIceCandidate(c)
        } else {
            synchronized(lock) { pendingIce.add(Pair(callId, c)) }
        }
    }

    private fun flushIce(callId: String) {
        val p = pc ?: return
        val list = synchronized(lock) {
            val l = pendingIce.filter { it.first == callId }.map { it.second }
            pendingIce.removeAll { it.first == callId }
            l
        }
        for (c in list) p.addIceCandidate(c)
    }

    // ------------------------------------------------------------ WebRTC plumbing

    @Synchronized
    /** Also used by Lan.kt (direct file transfer on the same Wi-Fi). */
    internal fun ensureFactory(): PeerConnectionFactory {
        factory?.let { return it }
        PeerConnectionFactory.initialize(PeerConnectionFactory.InitializationOptions.builder(app).createInitializationOptions())
        val adm = JavaAudioDeviceModule.builder(app)
            .setUseHardwareAcousticEchoCanceler(true)
            .setUseHardwareNoiseSuppressor(true)
            .createAudioDeviceModule()
        val f = PeerConnectionFactory.builder()
            .setAudioDeviceModule(adm)
            .setVideoEncoderFactory(DefaultVideoEncoderFactory(egl.eglBaseContext, true, true))
            .setVideoDecoderFactory(DefaultVideoDecoderFactory(egl.eglBaseContext))
            .createPeerConnectionFactory()
        factory = f
        return f
    }

    /** 1.10.1: asked for every call so a change in the admin panel works at once; the last answer if offline. */
    private fun fetchTurn(): TurnInfo = try { Api.turn() } catch (e: Exception) {
        turnInfo?.takeIf { it.expiresAt > System.currentTimeMillis() + 600_000L } ?: throw e
    }

    private fun hasCamera() = ContextCompat.checkSelfPermission(app, Manifest.permission.CAMERA) == PackageManager.PERMISSION_GRANTED

    private fun createPeer(f: PeerConnectionFactory, video: Boolean): PeerConnection {
        val t = turnInfo!!
        val servers = listOf(PeerConnection.IceServer.builder(t.urls).setUsername(t.user).setPassword(t.cred).createIceServer())
        synchronized(lock) { switching = false; relayed = t.policy == "relay"; iceHold = false; heldIce.clear() }
        val cfg = PeerConnection.RTCConfiguration(servers).apply {
            // «همیشه از طریق سرور» in the admin panel: only relay candidates from the start
            iceTransportsType = if (relayed) PeerConnection.IceTransportsType.RELAY else PeerConnection.IceTransportsType.ALL
            sdpSemantics = PeerConnection.SdpSemantics.UNIFIED_PLAN
            continualGatheringPolicy = PeerConnection.ContinualGatheringPolicy.GATHER_CONTINUALLY
            bundlePolicy = PeerConnection.BundlePolicy.MAXBUNDLE
            rtcpMuxPolicy = PeerConnection.RtcpMuxPolicy.REQUIRE
        }
        rtcConfig = cfg
        val modes = ROUTE_NAMES.keys.filter { urlsFor(it).isNotEmpty() }
        synchronized(lock) { state.value = state.value.copy(canRoute = t.userRoute, netModes = modes, netMode = "auto", routing = false, path = "") }
        val p = f.createPeerConnection(cfg, observer) ?: throw IllegalStateException("PeerConnection ساخته نشد")
        val asrc = f.createAudioSource(MediaConstraints())
        val at = f.createAudioTrack("a0", asrc)
        p.addTrack(at, listOf("s0"))
        audioSource = asrc
        audioTrack = at
        if (video && hasCamera()) startVideo(f, p)
        synchronized(lock) { pc = p; remoteSet = false }
        return p
    }

    private fun startVideo(f: PeerConnectionFactory, p: PeerConnection) {
        val e = Camera2Enumerator(app)
        val names = e.deviceNames
        val name = names.firstOrNull { e.isFrontFacing(it) } ?: names.firstOrNull() ?: return
        val cap = e.createCapturer(name, null) ?: return
        val hp = SurfaceTextureHelper.create("capture", egl.eglBaseContext)
        val vs = f.createVideoSource(false)
        cap.initialize(hp, app, vs.capturerObserver)
        cap.startCapture(640, 480, 24)
        val vt = f.createVideoTrack("v0", vs)
        p.addTrack(vt, listOf("s0"))
        helper = hp; videoSource = vs; capturer = cap; localVideo = vt
        localTrack.value = vt
    }

    private val observer = object : PeerConnection.Observer {
        override fun onIceCandidate(c: IceCandidate) {
            val callId = state.value.callId
            val peer = state.value.peer
            if (callId.isEmpty()) return
            synchronized(lock) { if (iceHold) { heldIce.add(c); return } }
            Engine.scope.launch {
                try {
                    sendSignal(peer, "sig_ice", JSONObject().put("callId", callId).put("mid", c.sdpMid).put("idx", c.sdpMLineIndex).put("cand", c.sdp))
                } catch (e: Exception) { }
            }
        }

        override fun onConnectionChange(s: PeerConnection.PeerConnectionState) {
            when (s) {
                PeerConnection.PeerConnectionState.CONNECTED -> {
                    cancelTimeout()
                    disconnectTask?.let { main.removeCallbacks(it) }
                    synchronized(lock) {
                        val cur = state.value
                        if (cur.phase != CallPhase.IDLE) {
                            state.value = cur.copy(phase = CallPhase.ACTIVE, startedAt = if (cur.startedAt == 0L) System.currentTimeMillis() else cur.startedAt, note = "")
                        }
                    }
                    limitVideo()
                    startWatch()
                    startPath()
                    applyPref()
                }
                PeerConnection.PeerConnectionState.DISCONNECTED -> {
                    disconnectTask?.let { main.removeCallbacks(it) }
                    val r = object : Runnable {
                        override fun run() {
                            // 1.15: a path change is being tried; it falls back by itself (see armGuard)
                            if (System.currentTimeMillis() < guardUntil) { main.postDelayed(this, 3000L); return }
                            if (pc?.connectionState() != PeerConnection.PeerConnectionState.CONNECTED) endCall("اتصال قطع شد", true)
                        }
                    }
                    disconnectTask = r
                    main.postDelayed(r, 10_000L)
                }
                PeerConnection.PeerConnectionState.FAILED -> if (System.currentTimeMillis() >= guardUntil) endCall("اتصال برقرار نشد", true)
                else -> {}
            }
        }

        override fun onTrack(transceiver: RtpTransceiver) {
            val tr = transceiver.receiver.track()
            if (tr is VideoTrack) remoteTrack.value = tr
        }

        override fun onSignalingChange(s: PeerConnection.SignalingState) {}
        override fun onIceConnectionChange(s: PeerConnection.IceConnectionState) {}
        override fun onIceConnectionReceivingChange(b: Boolean) {}
        override fun onIceGatheringChange(s: PeerConnection.IceGatheringState) {}
        override fun onIceCandidatesRemoved(c: Array<out IceCandidate>) {}
        override fun onAddStream(s: MediaStream) {}
        override fun onRemoveStream(s: MediaStream) {}
        override fun onDataChannel(d: DataChannel) {}
        override fun onRenegotiationNeeded() {}
    }

    private suspend fun createOffer(p: PeerConnection, iceRestart: Boolean = false): SessionDescription = suspendCancellableCoroutine { c ->
        val mc = MediaConstraints()
        if (iceRestart) mc.mandatory.add(MediaConstraints.KeyValuePair("IceRestart", "true"))
        p.createOffer(object : SdpAdapter() {
            override fun onCreateSuccess(d: SessionDescription?) { c.resume(d!!) }
            override fun onCreateFailure(e: String?) { c.resumeWithException(IllegalStateException("offer: $e")) }
        }, mc)
    }

    // ------------------------------------------------------------ 1.10.1: relay switch, video cap

    /** Caps the video this phone sends (admin panel, 0 = no cap) and gives the audio priority on a weak network. */
    private fun limitVideo() {
        val p = pc ?: return
        val kbps = turnInfo?.videoKbps ?: 0
        for (sender in p.senders) {
            val kind = try { sender.track()?.kind() } catch (e: Exception) { null } ?: continue
            try {
                val prm = sender.parameters
                val enc = prm.encodings.firstOrNull() ?: continue
                if (kind == "video" && kbps > 0) enc.maxBitrateBps = kbps * 1000
                if (kind == "audio") enc.bitratePriority = 4.0 // "high" in WebRTC's priority scale
                sender.setParameters(prm)
            } catch (e: Exception) { }
        }
    }

    private suspend fun stats(p: PeerConnection): RTCStatsReport? = suspendCancellableCoroutine { c ->
        try { p.getStats { r -> if (c.isActive) c.resume(r) } } catch (e: Exception) { if (c.isActive) c.resume(null) }
    }

    private fun num(v: Any?): Double = (v as? Number)?.toDouble() ?: 0.0

    /** Every 2 s in «خودکار» mode: ~6 s of ping or packet loss over the panel's limits on a direct path -> relay. */
    private fun startWatch() {
        val t = turnInfo ?: return
        synchronized(lock) {
            if (watchJob != null || t.policy != "auto" || relayed || !peerRelay || state.value.netMode != "auto") return
            watchJob = Engine.scope.launch {
                var bad = 0; var n = 0; var prevLost = -1.0; var prevRecv = -1.0
                while (true) {
                    delay(2000)
                    val p = pc ?: break
                    if (relayed) break
                    if (switching || state.value.phase != CallPhase.ACTIVE) continue
                    val all = stats(p)?.statsMap ?: continue
                    var pair = all.values.firstOrNull { it.type == "transport" && it.members["selectedCandidatePairId"] != null }
                        ?.let { all[it.members["selectedCandidatePairId"] as? String] }
                    if (pair == null) pair = all.values.firstOrNull { it.type == "candidate-pair" && it.members["state"] == "succeeded" && it.members["nominated"] == true }
                    if (pair == null) continue
                    val lc = all[pair.members["localCandidateId"] as? String]?.members
                    val rc = all[pair.members["remoteCandidateId"] as? String]?.members
                    if (lc?.get("candidateType") == "relay" || rc?.get("candidateType") == "relay") { relayed = true; break }
                    var lost = 0.0; var recv = 0.0
                    for (s in all.values) if (s.type == "inbound-rtp" && (s.members["kind"] ?: s.members["mediaType"]) == "audio") {
                        lost += num(s.members["packetsLost"]); recv += num(s.members["packetsReceived"])
                    }
                    val rtt = num(pair.members["currentRoundTripTime"]) * 1000
                    var loss = 0.0
                    if (prevRecv >= 0) { val dl = lost - prevLost; val dr = recv - prevRecv; if (dl + dr > 0) loss = 100 * maxOf(0.0, dl) / (dl + dr) }
                    prevLost = lost; prevRecv = recv
                    if (++n < 2) continue // the first seconds after connecting are often rough
                    bad = if (rtt > t.switchRtt || loss > t.switchLoss) bad + 1 else 0
                    if (bad >= 3) {
                        val s = state.value
                        synchronized(lock) { watchJob = null }
                        if (s.incoming) { try { sendSignal(s.peer, "sig_relay", JSONObject().put("callId", s.callId)) } catch (e: Exception) { } }
                        else switchToRelay()
                        return@launch
                    }
                }
                synchronized(lock) { watchJob = null }
            }
        }
    }

    private fun stopWatch() { synchronized(lock) { watchJob?.cancel(); watchJob = null } }

    private fun releaseIce() {
        val s = state.value
        val list = synchronized(lock) { iceHold = false; heldIce.toList().also { heldIce.clear() } }
        for (c in list) {
            try { sendSignal(s.peer, "sig_ice", JSONObject().put("callId", s.callId).put("mid", c.sdpMid).put("idx", c.sdpMLineIndex).put("cand", c.sdp)) } catch (e: Exception) { }
        }
    }

    private fun relayOnly(p: PeerConnection) {
        val cfg = rtcConfig ?: return
        cfg.iceTransportsType = PeerConnection.IceTransportsType.RELAY
        p.setConfiguration(cfg)
    }

    /** The caller restarts ICE with relay candidates only; the call goes on over the old path meanwhile. */
    private suspend fun switchToRelay() {
        val s = state.value
        val p = synchronized(lock) {
            if (switching || relayed || s.incoming || s.phase == CallPhase.IDLE) return
            switching = true
            pc
        } ?: return
        if (watchJob != null) stopWatch()
        try {
            relayOnly(p)
            synchronized(lock) { iceHold = true; heldIce.clear(); remoteSet = false }
            val offer = createOffer(p, iceRestart = true)
            setLocal(p, offer)
            sendSignal(s.peer, "sig_reoffer", JSONObject().put("callId", s.callId).put("sdp", offer.description))
            releaseIce()
            relayed = true
        } catch (e: Exception) {
            synchronized(lock) { iceHold = false; remoteSet = true }
        } finally { synchronized(lock) { switching = false } }
    }

    private suspend fun onReoffer(callId: String, sdp: String, mode: String?, failed: String?) {
        val p = pc ?: return
        if (sdp.isEmpty()) return
        stopWatch()
        synchronized(lock) { switching = true }
        val s = state.value
        try {
            // 1.15: the path the caller chose; an older app (no mode) only ever switches to the relay
            if (mode != null) applyConfig(p, mode) else relayOnly(p)
            synchronized(lock) { remoteSet = false }
            setRemote(p, SessionDescription(SessionDescription.Type.OFFER, sdp))
            synchronized(lock) { remoteSet = true; iceHold = true; heldIce.clear() }
            flushIce(callId)
            val ans = createAnswer(p)
            setLocal(p, ans)
            sendSignal(s.peer, "sig_reanswer", JSONObject().put("callId", callId).put("sdp", ans.description))
            releaseIce()
            if (mode != null) {
                applyMode(mode); armGuard(mode, null)
                if (failed != null) showRouteNote("«${ROUTE_NAMES[failed]}» برقرار نشد؛ تماس روی مسیر قبلی ماند")
            } else relayed = true
        } catch (e: Exception) {
            synchronized(lock) { iceHold = false; remoteSet = true }
        } finally { synchronized(lock) { switching = false } }
    }

    // ------------------------------------------------------------ 1.15: the user picks the call path

    /** The ICE server URLs for a path: direct = STUN only; udp/tcp/tls = that one TURN URL; auto = all. */
    private fun urlsFor(mode: String): List<String> {
        val u = turnInfo?.urls ?: return emptyList()
        return when (mode) {
            "direct" -> u.filter { it.startsWith("stun:") }
            "udp" -> u.filter { it.startsWith("turn:") && it.contains("transport=udp") }
            "tcp" -> u.filter { it.startsWith("turn:") && it.contains("transport=tcp") }
            "tls" -> u.filter { it.startsWith("turns:") }
            else -> u
        }
    }

    private fun applyConfig(p: PeerConnection, mode: String) {
        val cfg = rtcConfig ?: return
        val t = turnInfo ?: return
        val urls = urlsFor(mode)
        cfg.iceServers = if (urls.isEmpty()) emptyList() else listOf(PeerConnection.IceServer.builder(urls).setUsername(t.user).setPassword(t.cred).createIceServer())
        val relay = when (mode) { "auto" -> t.policy == "relay"; "direct" -> false; else -> true }
        cfg.iceTransportsType = if (relay) PeerConnection.IceTransportsType.RELAY else PeerConnection.IceTransportsType.ALL
        p.setConfiguration(cfg)
    }

    private fun applyMode(mode: String) {
        relayed = when (mode) { "auto" -> turnInfo?.policy == "relay"; "direct" -> false; else -> true }
        guardUntil = System.currentTimeMillis() + 20_000L
        synchronized(lock) { val s = state.value; if (s.phase != CallPhase.IDLE) state.value = s.copy(netMode = mode, routing = true) }
    }

    /** Called by the call screen. The caller restarts ICE itself; the callee asks the caller to. */
    fun setRoute(mode: String) {
        val s = state.value
        if (pc == null || s.phase != CallPhase.ACTIVE || !s.canRoute || !s.peerRoute || s.routing || switching) return
        if (!ROUTE_NAMES.containsKey(mode) || mode !in s.netModes || mode == s.netMode) return
        if (s.incoming) {
            synchronized(lock) { state.value = state.value.copy(routing = true) }
            guardUntil = System.currentTimeMillis() + 20_000L
            armGuard(mode, null)
            Engine.scope.launch { try { sendSignal(s.peer, "sig_route", JSONObject().put("callId", s.callId).put("mode", mode)) } catch (e: Exception) { } }
        } else Engine.scope.launch { restartTo(mode, null) }
    }

    /** After connecting: the caller switches to the caller's default path, or else to the callee's. */
    private fun applyPref() {
        val s = state.value
        if (s.incoming || !s.peerRoute) return
        val mine = if (s.canRoute) Prefs.callRoute.value else "auto"
        val want = if (mine != "auto") mine else peerPref
        if (want == "auto" || want !in s.netModes) return
        Engine.scope.launch {
            delay(1500)
            val c = state.value
            if (c.phase == CallPhase.ACTIVE && c.callId == s.callId && c.netMode == "auto") restartTo(want, null)
        }
    }

    /** ICE restart onto another path; the call goes on over the old path meanwhile. failed: the path given up on. */
    private suspend fun restartTo(mode: String, failed: String?) {
        val s = state.value
        val p = synchronized(lock) {
            if (switching || s.incoming || s.phase == CallPhase.IDLE) return
            switching = true
            pc
        } ?: run { synchronized(lock) { switching = false }; return }
        stopWatch()
        val before = s.netMode
        try {
            applyConfig(p, mode)
            synchronized(lock) { iceHold = true; heldIce.clear(); remoteSet = false }
            val offer = createOffer(p, iceRestart = true)
            setLocal(p, offer)
            val body = JSONObject().put("callId", s.callId).put("sdp", offer.description).put("mode", mode)
            if (failed != null) body.put("failed", failed)
            sendSignal(s.peer, "sig_reoffer", body)
            releaseIce()
            applyMode(mode)
            armGuard(mode, if (failed != null) null else before)
        } catch (e: Exception) {
            synchronized(lock) { iceHold = false; remoteSet = true; val c = state.value; if (c.phase != CallPhase.IDLE) state.value = c.copy(routing = false) }
        } finally { synchronized(lock) { switching = false } }
    }

    private class Sel(val lc: Map<String, Any>?, val rc: Map<String, Any>?)

    private suspend fun selected(p: PeerConnection): Sel? {
        val all = stats(p)?.statsMap ?: return null
        var pair = all.values.firstOrNull { it.type == "transport" && it.members["selectedCandidatePairId"] != null }
            ?.let { all[it.members["selectedCandidatePairId"] as? String] }
        if (pair == null) pair = all.values.firstOrNull { it.type == "candidate-pair" && it.members["state"] == "succeeded" && it.members["nominated"] == true }
        if (pair == null) return null
        return Sel(all[pair.members["localCandidateId"] as? String]?.members, all[pair.members["remoteCandidateId"] as? String]?.members)
    }

    /** Whether the selected candidate pair is on the wanted path. */
    private fun onPath(mode: String, sel: Sel): Boolean {
        val lRelay = sel.lc?.get("candidateType") == "relay"
        val relay = lRelay || sel.rc?.get("candidateType") == "relay"
        return when (mode) {
            "auto" -> true
            "direct" -> !relay
            else -> relay && (!lRelay || sel.lc?.get("relayProtocol").let { it == null || it == mode })
        }
    }

    /**
     * Waits up to 12 s for the new path. back: the path to return to if it doesn't come up (only the side that
     * restarted ICE has it); without it a path that never comes up ends the call like before.
     */
    private fun armGuard(mode: String, back: String?) {
        guardJob?.cancel()
        guardJob = Engine.scope.launch {
            val t0 = System.currentTimeMillis()
            while (true) {
                delay(1500)
                val p = pc ?: return@launch
                val st = state.value
                if (st.phase == CallPhase.IDLE) return@launch
                val sel = if (p.connectionState() == PeerConnection.PeerConnectionState.CONNECTED) selected(p) else null
                if (sel != null && onPath(st.netMode, sel)) {
                    guardUntil = 0L
                    synchronized(lock) { val c = state.value; if (c.phase != CallPhase.IDLE) state.value = c.copy(routing = false) }
                    updatePath(); startWatch()
                    return@launch
                }
                if (System.currentTimeMillis() - t0 < 12_000L) continue
                if (back != null && !st.incoming) {
                    showRouteNote("«${ROUTE_NAMES[mode]}» برقرار نشد؛ تماس روی مسیر قبلی ماند")
                    Engine.scope.launch { restartTo(back, mode) }
                } else {
                    guardUntil = 0L
                    synchronized(lock) { val c = state.value; if (c.phase != CallPhase.IDLE) state.value = c.copy(routing = false) }
                    if (p.connectionState() == PeerConnection.PeerConnectionState.FAILED) endCall("اتصال برقرار نشد", true)
                }
                return@launch
            }
        }
    }

    private fun showRouteNote(n: String) {
        synchronized(lock) { val c = state.value; if (c.phase != CallPhase.IDLE) state.value = c.copy(routeNote = n) }
        Engine.scope.launch {
            delay(5000)
            synchronized(lock) { val c = state.value; if (c.routeNote == n) state.value = c.copy(routeNote = "") }
        }
    }

    /** The path in use, for the call screen (users allowed to choose only). */
    private suspend fun updatePath() {
        val st = state.value
        if (!st.canRoute) return
        val p = pc ?: return
        val sel = selected(p) ?: return
        val lc = sel.lc ?: return
        val path = when {
            lc["candidateType"] == "relay" -> "سرور · " + (lc["relayProtocol"] as? String ?: "udp").uppercase()
            sel.rc?.get("candidateType") == "relay" -> "سرور" + (if (st.netMode in listOf("udp", "tcp", "tls")) " · " + st.netMode.uppercase() else "")
            else -> "مستقیم · " + (lc["protocol"] as? String ?: "udp").uppercase()
        }
        synchronized(lock) { val c = state.value; if (c.phase != CallPhase.IDLE && c.path != path) state.value = c.copy(path = path) }
    }

    private fun startPath() {
        pathJob?.cancel()
        if (!state.value.canRoute) return
        pathJob = Engine.scope.launch { while (true) { updatePath(); delay(3000) } }
    }

    private fun onReanswer(callId: String, sdp: String) {
        val p = pc ?: return
        if (sdp.isEmpty()) return
        Engine.scope.launch {
            try { setRemote(p, SessionDescription(SessionDescription.Type.ANSWER, sdp)) } catch (e: Exception) { }
            synchronized(lock) { remoteSet = true }
            flushIce(callId)
        }
    }

    private suspend fun createAnswer(p: PeerConnection): SessionDescription = suspendCancellableCoroutine { c ->
        p.createAnswer(object : SdpAdapter() {
            override fun onCreateSuccess(d: SessionDescription?) { c.resume(d!!) }
            override fun onCreateFailure(e: String?) { c.resumeWithException(IllegalStateException("answer: $e")) }
        }, MediaConstraints())
    }

    private suspend fun setLocal(p: PeerConnection, d: SessionDescription) = suspendCancellableCoroutine<Unit> { c ->
        p.setLocalDescription(object : SdpAdapter() {
            override fun onSetSuccess() { c.resume(Unit) }
            override fun onSetFailure(e: String?) { c.resumeWithException(IllegalStateException("setLocal: $e")) }
        }, d)
    }

    private suspend fun setRemote(p: PeerConnection, d: SessionDescription) = suspendCancellableCoroutine<Unit> { c ->
        p.setRemoteDescription(object : SdpAdapter() {
            override fun onSetSuccess() { c.resume(Unit) }
            override fun onSetFailure(e: String?) { c.resumeWithException(IllegalStateException("setRemote: $e")) }
        }, d)
    }

    private fun sendSignal(peer: String, kind: String, body: JSONObject): Boolean {
        val payload = Engine.encryptFor(peer, body.toString().toByteArray())
        return Api.signal(peer, kind, payload)
    }

    // ------------------------------------------------------------ end of call / helpers

    /**
     * [tone]: 1.13 tone to play as the call ends (busy, unreachable…). Left null, a call that was connected
     * ends with the short end tone and one that never connected ends silently.
     */
    fun endCall(note: String, sendHangup: Boolean, tone: CallTones.Tone? = null) {
        val snap = synchronized(lock) {
            val cur = state.value
            if (cur.phase == CallPhase.IDLE) return
            state.value = CallState()
            pendingIce.clear()
            watchJob?.cancel(); watchJob = null
            iceHold = false; heldIce.clear(); switching = false; relayed = false; peerRelay = false; rtcConfig = null
            guardJob?.cancel(); guardJob = null; guardUntil = 0L; pathJob?.cancel(); pathJob = null; peerPref = "auto"
            remoteSet = false
            offerSdp = null
            val r = Res(pc, audioTrack, audioSource, localVideo, videoSource, capturer, helper)
            pc = null; audioTrack = null; audioSource = null; localVideo = null; videoSource = null; capturer = null; helper = null
            Pair(cur, r)
        }
        val cur = snap.first
        val res = snap.second
        cancelTimeout()
        disconnectTask?.let { main.removeCallbacks(it) }
        stopRing()
        CallTones.stop()
        Engine.cancelCallNotification()
        localTrack.value = null
        remoteTrack.value = null

        if (sendHangup) {
            val kind = if (cur.phase == CallPhase.INCOMING) "sig_reject" else "sig_hangup"
            Engine.scope.launch {
                try { sendSignal(cur.peer, kind, JSONObject().put("callId", cur.callId)) } catch (e: Exception) { }
            }
        }

        // call log in the chat
        val kindText = if (cur.video) "تصویری" else "صوتی"
        val text = if (cur.startedAt > 0L) {
            val sec = ((System.currentTimeMillis() - cur.startedAt) / 1000).toInt()
            "📞 تماس $kindText — %02d:%02d".format(sec / 60, sec % 60)
        } else if (cur.incoming) "📞 تماس $kindText بی‌پاسخ" else "📞 تماس $kindText لغو شد / بی‌پاسخ"
        Engine.addCallLog(cur.peer, text, !cur.incoming)

        val endTone = tone ?: if (cur.startedAt > 0L) CallTones.Tone.END else null
        if (endTone != null) {
            // keep the call audio route until the tone has played, unless a new call took it over meanwhile
            CallTones.play(endTone)
            main.postDelayed({ if (state.value.phase == CallPhase.IDLE) AudioRouter.stop() }, CallTones.durationMs(endTone) + 300L)
        } else AudioRouter.stop()
        stopCallService()
        if (note.isNotEmpty()) main.post { Toast.makeText(app, note, Toast.LENGTH_SHORT).show() }

        Engine.scope.launch(Dispatchers.Default) {
            delay(600) // let the UI detach its video renderers first
            try { res.cap?.stopCapture() } catch (e: Exception) { }
            try { res.pc?.close() } catch (e: Exception) { }
            try { res.pc?.dispose() } catch (e: Exception) { }
            try { res.lv?.dispose() } catch (e: Exception) { }
            try { res.vs?.dispose() } catch (e: Exception) { }
            try { res.cap?.dispose() } catch (e: Exception) { }
            try { res.hp?.dispose() } catch (e: Exception) { }
            try { res.at?.dispose() } catch (e: Exception) { }
            try { res.asrc?.dispose() } catch (e: Exception) { }
        }
    }

    private fun setupAudioMode(speaker: Boolean) {
        AudioRouter.start(app, speaker) { route, bt ->
            synchronized(lock) {
                val s = state.value
                if (s.phase != CallPhase.IDLE) state.value = s.copy(route = route, bt = bt, speaker = route == AudioRoute.SPEAKER)
            }
        }
    }

    private fun startCallService(video: Boolean) {
        try {
            ContextCompat.startForegroundService(app, Intent(app, CallService::class.java).putExtra("video", video))
        } catch (e: Exception) { }
    }

    /**
     * Stopping a service started with startForegroundService() before it reached startForeground()
     * makes Android kill the app. If it is not in the foreground yet, leave it alone: CallService
     * notices the call is already over right after startForeground() and stops itself.
     */
    private fun stopCallService() {
        if (!CallService.foreground) return
        try { app.stopService(Intent(app, CallService::class.java)) } catch (e: Exception) { }
    }

    private fun armTimeout(ms: Long, note: String, tone: CallTones.Tone? = null) {
        cancelTimeout()
        val r = Runnable {
            val ph = state.value.phase
            if (ph == CallPhase.OUTGOING || ph == CallPhase.INCOMING) endCall(note, true, tone)
        }
        timeoutTask = r
        main.postDelayed(r, ms)
    }

    private fun cancelTimeout() { timeoutTask?.let { main.removeCallbacks(it) }; timeoutTask = null }

    /**
     * 1.13: incoming call ring. Follows the phone's ringer mode (silent: nothing, vibrate: vibration only,
     * normal: ringtone + vibration). Plays the phone's own chosen ringtone; only a phone without one gets
     * the built-in Sepan ring.
     */
    private fun startRing() {
        stopRing()
        val am = try { app.getSystemService(AudioManager::class.java) } catch (e: Exception) { null }
        val mode = try { am?.ringerMode ?: AudioManager.RINGER_MODE_NORMAL } catch (e: Exception) { AudioManager.RINGER_MODE_NORMAL }
        if (mode != AudioManager.RINGER_MODE_SILENT) startVibrate()
        if (mode != AudioManager.RINGER_MODE_NORMAL) return
        // 1.13.2: play the phone's own chosen ringtone through Ringtone, exactly like before 1.13. The system
        // player opens it (it may sit in the phone's media that this app can't read itself), so only if the
        // phone gives us no ringtone at all do we fall back to the built-in ring.
        try {
            val r = RingtoneManager.getRingtone(app, RingtoneManager.getDefaultUri(RingtoneManager.TYPE_RINGTONE))
            if (r != null) {
                if (Build.VERSION.SDK_INT >= 28) r.isLooping = true
                r.play()
                ringtone = r
                return
            }
        } catch (e: Exception) { }
        builtinRing = true
        CallTones.play(CallTones.Tone.RING, AudioAttributes.USAGE_NOTIFICATION_RINGTONE)
    }

    private fun startVibrate() {
        try {
            val v = if (Build.VERSION.SDK_INT >= 31) app.getSystemService(VibratorManager::class.java)?.defaultVibrator
                else @Suppress("DEPRECATION") app.getSystemService(Vibrator::class.java)
            if (v == null || !v.hasVibrator()) return
            val attrs = AudioAttributes.Builder().setUsage(AudioAttributes.USAGE_NOTIFICATION_RINGTONE).build()
            @Suppress("DEPRECATION") v.vibrate(VibrationEffect.createWaveform(longArrayOf(0, 800, 1200), 0), attrs)
            vibrator = v
        } catch (e: Exception) { }
    }

    private fun stopRing() {
        try { ringtone?.stop() } catch (e: Exception) { }
        ringtone = null
        try { vibrator?.cancel() } catch (e: Exception) { }
        vibrator = null
        if (builtinRing) { builtinRing = false; CallTones.stop() }
    }
}
