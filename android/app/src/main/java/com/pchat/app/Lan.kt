package com.pchat.app

import android.content.Context
import android.net.ConnectivityManager
import android.net.NetworkCapabilities
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.withTimeoutOrNull
import org.json.JSONObject
import org.webrtc.DataChannel
import org.webrtc.IceCandidate
import org.webrtc.MediaConstraints
import org.webrtc.MediaStream
import org.webrtc.PeerConnection
import org.webrtc.SessionDescription
import java.io.BufferedInputStream
import java.io.DataInputStream
import java.io.File
import java.io.FileInputStream
import java.io.FileOutputStream
import java.io.RandomAccessFile
import java.nio.ByteBuffer
import java.security.SecureRandom
import java.util.concurrent.ConcurrentHashMap
import kotlin.coroutines.resume
import kotlin.coroutines.resumeWithException

/**
 * Direct file transfer on the same Wi-Fi (1.8), the same protocol as the web app (server/src/web/lan.mjs).
 *
 * When I send a file in a private chat to a contact, Sepan also offers it over a WebRTC data channel with
 * NO STUN/TURN servers: only local addresses are offered, so it connects only when both phones are on the
 * same local network. The normal upload to the server goes on at the same time. The receiver shows the
 * file as soon as it arrived; the server message carries the same transfer id ("lx") and takes the file
 * over, so nothing is downloaded twice. The data channel carries the same encrypted chunks as the server
 * upload; the signalling (with the file key) goes end-to-end encrypted through the server as "sig_lan".
 */
object Lan {
    private const val MIN_SIZE = 64 * 1024L
    private const val CONNECT_MS = 8000L
    private const val FRAME = 16 * 1024
    private const val HIGH = 4L * 1024 * 1024

    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    private class Session(val pc: PeerConnection, val peer: String) {
        @Volatile var answered = false
        var timer: Job? = null
        var dc: DataChannel? = null
    }
    private val sending = ConcurrentHashMap<String, Session>()
    private val receiving = ConcurrentHashMap<String, Session>()
    /** local message id of a queued file -> its transfer id (goes into the server message as "lx") */
    private val ids = ConcurrentHashMap<Long, String>()

    fun idOf(localId: Long): String? = ids[localId]
    fun forget(localId: Long) { ids.remove(localId) }

    private fun rid(): String = ByteArray(12).also { SecureRandom().nextBytes(it) }.joinToString("") { "%02x".format(it) }

    /** On Wi-Fi or Ethernet (no point trying a local path on mobile data). */
    private fun onLocalNetwork(): Boolean = try {
        val cm = Engine.app.getSystemService(Context.CONNECTIVITY_SERVICE) as ConnectivityManager
        val c = cm.getNetworkCapabilities(cm.activeNetwork)
        c != null && (c.hasTransport(NetworkCapabilities.TRANSPORT_WIFI) || c.hasTransport(NetworkCapabilities.TRANSPORT_ETHERNET))
    } catch (e: Exception) { false }

    private fun signal(peer: String, o: JSONObject): Boolean = try {
        Api.signal(peer, "sig_lan", Engine.encryptFor(peer, o.toString().toByteArray()))
    } catch (e: Exception) { false }

    private fun close(map: ConcurrentHashMap<String, Session>, x: String) {
        val s = map.remove(x) ?: return
        s.timer?.cancel()
        try { s.dc?.close() } catch (e: Exception) { }
        try { s.pc.close() } catch (e: Exception) { }
    }

    // ---------------- WebRTC helpers ----------------

    private class Peer(val onChannel: (DataChannel) -> Unit) : PeerConnection.Observer {
        val gathered = CompletableDeferred<Unit>()
        override fun onIceGatheringChange(s: PeerConnection.IceGatheringState) { if (s == PeerConnection.IceGatheringState.COMPLETE) gathered.complete(Unit) }
        override fun onDataChannel(d: DataChannel) { onChannel(d) }
        override fun onSignalingChange(s: PeerConnection.SignalingState) {}
        override fun onIceConnectionChange(s: PeerConnection.IceConnectionState) {}
        override fun onIceConnectionReceivingChange(b: Boolean) {}
        override fun onIceCandidate(c: IceCandidate) {}
        override fun onIceCandidatesRemoved(c: Array<out IceCandidate>) {}
        override fun onAddStream(s: MediaStream) {}
        override fun onRemoveStream(s: MediaStream) {}
        override fun onRenegotiationNeeded() {}
    }

    private fun newPeer(obs: Peer): PeerConnection {
        val cfg = PeerConnection.RTCConfiguration(emptyList()).apply {
            sdpSemantics = PeerConnection.SdpSemantics.UNIFIED_PLAN
        }
        return CallManager.ensureFactory().createPeerConnection(cfg, obs) ?: throw IllegalStateException("no peer connection")
    }

    private suspend fun create(pc: PeerConnection, offer: Boolean): SessionDescription = suspendCancellableCoroutine { c ->
        val o = object : SdpAdapter() {
            override fun onCreateSuccess(d: SessionDescription?) { if (d != null) c.resume(d) else c.resumeWithException(IllegalStateException("sdp")) }
            override fun onCreateFailure(e: String?) { c.resumeWithException(IllegalStateException("sdp: $e")) }
        }
        if (offer) pc.createOffer(o, MediaConstraints()) else pc.createAnswer(o, MediaConstraints())
    }

    private suspend fun set(pc: PeerConnection, d: SessionDescription, local: Boolean) = suspendCancellableCoroutine<Unit> { c ->
        val o = object : SdpAdapter() {
            override fun onSetSuccess() { c.resume(Unit) }
            override fun onSetFailure(e: String?) { c.resumeWithException(IllegalStateException("set: $e")) }
        }
        if (local) pc.setLocalDescription(o, d) else pc.setRemoteDescription(o, d)
    }

    /** Local candidates only, all in the SDP (no trickle), like the web app. */
    private suspend fun localSdp(pc: PeerConnection, obs: Peer, offer: Boolean): String {
        set(pc, create(pc, offer), true)
        withTimeoutOrNull(2500) { obs.gathered.await() }
        return pc.localDescription?.description ?: throw IllegalStateException("no sdp")
    }

    // ---------------- sender ----------------

    /** Called for a file I just queued for upload: gives it a transfer id and tries the direct path. */
    fun offer(m: Msg) {
        val path = m.localPath ?: return
        val fk = m.fkey ?: return
        if (Engine.isGroup(m.convo) || m.size < MIN_SIZE || Engine.reqOf(m.convo) != null || !Crypto.isChunked(fk)) return
        if (!onLocalNetwork()) return
        val x = rid()
        ids[m.id] = x
        scope.launch {
            try { start(m, File(path), fk, x) } catch (e: Exception) { close(sending, x) }
        }
    }

    private suspend fun start(m: Msg, file: File, fk: String, x: String) {
        val obs = Peer {}
        val pc = newPeer(obs)
        val s = Session(pc, m.convo)
        sending[x] = s
        s.timer = scope.launch { delay(CONNECT_MS); close(sending, x) }
        val dc = pc.createDataChannel("f", DataChannel.Init().apply { ordered = true })
        s.dc = dc
        dc.registerObserver(object : DataChannel.Observer {
            override fun onBufferedAmountChange(previous: Long) {}
            override fun onMessage(buffer: DataChannel.Buffer) {}
            override fun onStateChange() {
                when (dc.state()) {
                    DataChannel.State.OPEN -> { s.timer?.cancel(); scope.launch { try { pump(m, file, fk, dc, x) } catch (e: Exception) { close(sending, x) } } }
                    DataChannel.State.CLOSED -> close(sending, x)
                    else -> {}
                }
            }
        })
        val meta = JSONObject().put("t", if (m.type == "voice") "file" else m.type).put("n", m.fileName ?: "file")
            .put("m", m.mime ?: "application/octet-stream").put("s", m.size).put("fk", fk).put("w", m.w).put("h", m.h)
        if (m.type == "voice") meta.put("v", 1).put("d", m.dur).put("wf", org.json.JSONArray(m.wave))
        val sdp = localSdp(pc, obs, true)
        if (!signal(m.convo, JSONObject().put("t", "offer").put("x", x).put("sdp", sdp).put("meta", meta))) close(sending, x)
    }

    private fun onAnswer(from: String, j: JSONObject) {
        val s = sending[j.optString("x")] ?: return
        if (s.peer != from || s.answered) return // another device of theirs answered first
        val sdp = j.optString("sdp").ifEmpty { return }
        s.answered = true
        scope.launch {
            try { set(s.pc, SessionDescription(SessionDescription.Type.ANSWER, sdp), false) } catch (e: Exception) { close(sending, j.optString("x")) }
        }
    }

    private suspend fun pump(m: Msg, file: File, fk: String, dc: DataChannel, x: String) {
        val n = Crypto.chunkCount(m.size)
        val plain = ByteArray(Crypto.FILE_CHUNK)
        RandomAccessFile(file, "r").use { raf ->
            for (i in 0 until n) {
                val start = i.toLong() * Crypto.FILE_CHUNK
                val len = minOf(Crypto.FILE_CHUNK.toLong(), m.size - start).toInt().coerceAtLeast(0)
                raf.seek(start)
                raf.readFully(plain, 0, len)
                val sealed = Crypto.sealChunk(fk, i, i == n - 1, plain, len)
                var p = 0
                while (p < sealed.size) {
                    if (dc.state() != DataChannel.State.OPEN) throw IllegalStateException("closed")
                    while (dc.bufferedAmount() > HIGH) delay(15)
                    val e = minOf(sealed.size, p + FRAME)
                    if (!dc.send(DataChannel.Buffer(ByteBuffer.wrap(sealed.copyOfRange(p, e)), true))) throw IllegalStateException("send")
                    p = e
                }
            }
        }
        dc.send(DataChannel.Buffer(ByteBuffer.wrap("done".toByteArray()), false))
        // the receiver closes the channel when it has everything; do not keep the connection forever
        scope.launch { delay(120_000); close(sending, x) }
    }

    // ---------------- receiver ----------------

    private fun onOffer(from: String, j: JSONObject) {
        val x = j.optString("x")
        val sdp = j.optString("sdp")
        val meta = j.optJSONObject("meta") ?: return
        val fk = meta.optString("fk")
        val size = meta.optLong("s", 0)
        // only from my contacts, never from a message request, only on Wi-Fi; nothing silly
        if (x.isEmpty() || sdp.isEmpty() || fk.isEmpty() || !Crypto.isChunked(fk) || size <= 0 || size > Config.MAX_FILE_BYTES) return
        if (Engine.reqOf(from) != null || receiving.containsKey(x) || !onLocalNetwork()) return
        scope.launch {
            try {
                lateinit var s: Session
                val obs = Peer { ch ->
                    s.dc = ch
                    s.timer?.cancel()
                    s.timer = scope.launch { delay(30 * 60_000L); close(receiving, x) }
                    take(from, x, meta, fk, size, ch)
                }
                val pc = newPeer(obs)
                s = Session(pc, from)
                receiving[x] = s
                s.timer = scope.launch { delay(CONNECT_MS); close(receiving, x) }
                set(pc, SessionDescription(SessionDescription.Type.OFFER, sdp), false)
                val answer = localSdp(pc, obs, false)
                signal(from, JSONObject().put("t", "answer").put("x", x).put("sdp", answer))
            } catch (e: Exception) { close(receiving, x) }
        }
    }

    private fun take(from: String, x: String, meta: JSONObject, fk: String, size: Long, dc: DataChannel) {
        val total = Crypto.cipherSize(size)
        val part = File(Engine.lanDir(), "$x.part")
        part.delete()
        val os = FileOutputStream(part)
        var got = 0L
        var failed = false
        dc.registerObserver(object : DataChannel.Observer {
            override fun onBufferedAmountChange(previous: Long) {}
            override fun onStateChange() {
                if (dc.state() == DataChannel.State.CLOSED && receiving.containsKey(x)) { try { os.close() } catch (e: Exception) { }; part.delete(); close(receiving, x) }
            }
            override fun onMessage(buffer: DataChannel.Buffer) {
                if (failed) return
                val bytes = ByteArray(buffer.data.remaining())
                buffer.data.get(bytes)
                if (!buffer.binary) {
                    if (String(bytes) != "done") return
                    try { os.close() } catch (e: Exception) { }
                    if (got != total) { part.delete(); close(receiving, x); return }
                    scope.launch {
                        try {
                            val out = File(Engine.lanDir(), x)
                            decrypt(part, out, fk, size)
                            part.delete()
                            Engine.lanArrived(from, meta, x, out)
                        } catch (e: Exception) { part.delete() }
                        close(receiving, x)
                    }
                    return
                }
                got += bytes.size
                if (got > total) { failed = true; try { os.close() } catch (e: Exception) { }; part.delete(); scope.launch { close(receiving, x) }; return }
                try { os.write(bytes) } catch (e: Exception) { failed = true; part.delete(); scope.launch { close(receiving, x) } }
            }
        })
    }

    private fun decrypt(part: File, out: File, fk: String, size: Long) {
        val total = Crypto.cipherSize(size)
        val n = Crypto.chunkCount(size)
        DataInputStream(BufferedInputStream(FileInputStream(part), 256 * 1024)).use { input ->
            FileOutputStream(out).use { os ->
                val inb = ByteArray(Crypto.CIPHER_CHUNK)
                for (i in 0 until n) {
                    val last = i == n - 1
                    val clen = if (last) (total - i.toLong() * Crypto.CIPHER_CHUNK).toInt() else Crypto.CIPHER_CHUNK
                    input.readFully(inb, 0, clen)
                    os.write(Crypto.openChunk(fk, i, last, inb, clen))
                }
            }
        }
    }

    /** A sig_lan signal (end-to-end encrypted like call signals). */
    fun onSignal(from: String, payload: String) {
        val j = try { JSONObject(Engine.decryptSignal(from, payload) ?: return) } catch (e: Exception) { return }
        val x = j.optString("x").ifEmpty { return }
        when (j.optString("t")) {
            "offer" -> onOffer(from, j)
            "answer" -> onAnswer(from, j)
            "bye" -> { close(sending, x); close(receiving, x) }
        }
    }
}
