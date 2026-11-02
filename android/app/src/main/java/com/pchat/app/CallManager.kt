package com.pchat.app

import android.Manifest
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.media.AudioManager
import android.media.Ringtone
import android.media.RingtoneManager
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.widget.Toast
import androidx.core.content.ContextCompat
import kotlinx.coroutines.Dispatchers
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
    val front: Boolean = true,
    val startedAt: Long = 0L,
    val note: String = ""
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
    private var timeoutTask: Runnable? = null
    private var disconnectTask: Runnable? = null

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
        synchronized(lock) {
            if (state.value.phase != CallPhase.IDLE) return
            state.value = CallState(CallPhase.OUTGOING, peer, video, id, incoming = false, speaker = video, note = "در حال برقراری تماس…")
        }
        Engine.scope.launch {
            try {
                turnInfo = fetchTurn()
                val f = ensureFactory()
                setupAudioMode(video)
                startCallService(video && hasCamera())
                val p = createPeer(f, video)
                val offer = createOffer(p)
                setLocal(p, offer)
                val delivered = sendSignal(peer, "sig_invite", JSONObject().put("callId", id).put("video", video).put("sdp", offer.description))
                if (!delivered) { endCall("کاربر الان آنلاین نیست", false); return@launch }
                armTimeout(45_000L, "پاسخی داده نشد")
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
                sendSignal(s.peer, "sig_accept", JSONObject().put("callId", s.callId).put("sdp", ans.description))
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

    fun toggleSpeaker() {
        val s = state.value
        val on = !s.speaker
        app.getSystemService(AudioManager::class.java).isSpeakerphoneOn = on
        state.value = s.copy(speaker = on)
    }

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
            "sig_invite" -> onInvite(from, callId, j.optBoolean("video"), j.optString("sdp"))
            "sig_accept" -> onAccepted(from, callId, j.optString("sdp"))
            "sig_ice" -> onRemoteIce(callId, IceCandidate(j.optString("mid"), j.optInt("idx"), j.optString("cand")))
            "sig_reject" -> if (matches(from, callId)) {
                endCall(if (j.optString("reason") == "busy") "طرف مقابل در تماس دیگری است" else "تماس رد شد", false)
            }
            "sig_hangup" -> if (matches(from, callId)) endCall("تماس پایان یافت", false)
        }
    }

    private fun matches(from: String, callId: String): Boolean {
        val s = state.value
        return s.phase != CallPhase.IDLE && s.peer == from && s.callId == callId
    }

    private fun onInvite(from: String, callId: String, video: Boolean, sdp: String) {
        if (callId.isEmpty() || sdp.isEmpty()) return
        val busy = synchronized(lock) {
            if (state.value.phase != CallPhase.IDLE) true
            else {
                offerSdp = sdp
                state.value = CallState(CallPhase.INCOMING, from, video, callId, incoming = true, speaker = video, note = "تماس ورودی")
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

    private fun onAccepted(from: String, callId: String, sdp: String) {
        val p = synchronized(lock) {
            if (!matches(from, callId) || state.value.phase != CallPhase.OUTGOING) return
            pc
        } ?: return
        cancelTimeout()
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

    private fun fetchTurn(): TurnInfo {
        turnInfo?.let { if (it.expiresAt > System.currentTimeMillis() + 600_000L) return it }
        return Api.turn()
    }

    private fun hasCamera() = ContextCompat.checkSelfPermission(app, Manifest.permission.CAMERA) == PackageManager.PERMISSION_GRANTED

    private fun createPeer(f: PeerConnectionFactory, video: Boolean): PeerConnection {
        val t = turnInfo!!
        val servers = listOf(PeerConnection.IceServer.builder(t.urls).setUsername(t.user).setPassword(t.cred).createIceServer())
        val cfg = PeerConnection.RTCConfiguration(servers).apply {
            sdpSemantics = PeerConnection.SdpSemantics.UNIFIED_PLAN
            continualGatheringPolicy = PeerConnection.ContinualGatheringPolicy.GATHER_CONTINUALLY
            bundlePolicy = PeerConnection.BundlePolicy.MAXBUNDLE
            rtcpMuxPolicy = PeerConnection.RtcpMuxPolicy.REQUIRE
        }
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
                }
                PeerConnection.PeerConnectionState.DISCONNECTED -> {
                    val r = Runnable { endCall("اتصال قطع شد", true) }
                    disconnectTask = r
                    main.postDelayed(r, 10_000L)
                }
                PeerConnection.PeerConnectionState.FAILED -> endCall("اتصال برقرار نشد", true)
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

    private suspend fun createOffer(p: PeerConnection): SessionDescription = suspendCancellableCoroutine { c ->
        p.createOffer(object : SdpAdapter() {
            override fun onCreateSuccess(d: SessionDescription?) { c.resume(d!!) }
            override fun onCreateFailure(e: String?) { c.resumeWithException(IllegalStateException("offer: $e")) }
        }, MediaConstraints())
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

    fun endCall(note: String, sendHangup: Boolean) {
        val snap = synchronized(lock) {
            val cur = state.value
            if (cur.phase == CallPhase.IDLE) return
            state.value = CallState()
            pendingIce.clear()
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

        try {
            val am = app.getSystemService(AudioManager::class.java)
            am.mode = AudioManager.MODE_NORMAL
            am.isSpeakerphoneOn = false
        } catch (e: Exception) { }
        try { app.stopService(Intent(app, CallService::class.java)) } catch (e: Exception) { }
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
        val am = app.getSystemService(AudioManager::class.java)
        am.mode = AudioManager.MODE_IN_COMMUNICATION
        am.isSpeakerphoneOn = speaker
    }

    private fun startCallService(video: Boolean) {
        ContextCompat.startForegroundService(app, Intent(app, CallService::class.java).putExtra("video", video))
    }

    private fun armTimeout(ms: Long, note: String) {
        cancelTimeout()
        val r = Runnable {
            val ph = state.value.phase
            if (ph == CallPhase.OUTGOING || ph == CallPhase.INCOMING) endCall(note, true)
        }
        timeoutTask = r
        main.postDelayed(r, ms)
    }

    private fun cancelTimeout() { timeoutTask?.let { main.removeCallbacks(it) }; timeoutTask = null }

    private fun startRing() {
        try {
            val r = RingtoneManager.getRingtone(app, RingtoneManager.getDefaultUri(RingtoneManager.TYPE_RINGTONE))
            if (Build.VERSION.SDK_INT >= 28) r.isLooping = true
            r.play()
            ringtone = r
        } catch (e: Exception) { }
    }

    private fun stopRing() {
        try { ringtone?.stop() } catch (e: Exception) { }
        ringtone = null
    }
}
