package com.pchat.app

import android.os.Handler
import android.os.Looper
import android.widget.Toast
import kotlinx.coroutines.Job
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.suspendCancellableCoroutine
import org.json.JSONArray
import org.json.JSONObject
import org.webrtc.AudioSource
import org.webrtc.AudioTrack
import org.webrtc.DataChannel
import org.webrtc.IceCandidate
import org.webrtc.MediaConstraints
import org.webrtc.MediaStream
import org.webrtc.PeerConnection
import org.webrtc.RTCStatsReport
import org.webrtc.RtpTransceiver
import org.webrtc.SessionDescription
import java.util.concurrent.ConcurrentHashMap
import kotlin.coroutines.resume
import kotlin.coroutines.resumeWithException

/** One person in a group call (server view). */
data class GPart(val u: String, val muted: Boolean, val hand: Long, val joined: Long)

/** A group call "room" as the server sends it (see server/src/gcall.js, view()). */
data class GRoom(
    val id: String, val group: String?, val title: String, val host: String, val video: Boolean, val started: Long,
    val parts: List<GPart>, val ringing: List<String>, val members: List<String>, val keys: Map<String, String>, val max: Int
) {
    fun has(u: String) = parts.any { it.u == u }
    /** The chat this call belongs to: the group, or (a call without a group) the person who started it. */
    fun convo(me: String): String = group ?: if (host != me) host else (parts.map { it.u } + members).firstOrNull { it != me } ?: host
}

/** Admin panel settings (card «تماس گروهی»), from /api/me and /api/gcall. */
data class GCfg(val on: Boolean = false, val video: Boolean = false, val maxVoice: Int = 8, val maxVideo: Int = 4)

enum class GPhase { IDLE, INCOMING, JOINING, ACTIVE }

data class GReact(val from: String, val emoji: String, val t: Long)

data class GState(
    val phase: GPhase = GPhase.IDLE,
    val room: GRoom? = null,
    val by: String = "",
    val muted: Boolean = false,
    val hand: Boolean = false,
    val joinedAt: Long = 0L,
    val route: AudioRoute = AudioRoute.SPEAKER,
    val bt: Boolean = false,
    /** username -> 0..1, who is speaking */
    val levels: Map<String, Float> = emptyMap(),
    val reacts: List<GReact> = emptyList()
)

fun parseRoom(o: JSONObject): GRoom {
    val pa = o.optJSONArray("parts") ?: JSONArray()
    val parts = (0 until pa.length()).map {
        val p = pa.getJSONObject(it)
        GPart(p.getString("u"), p.optBoolean("muted"), p.optLong("hand"), p.optLong("joined"))
    }
    fun strs(a: JSONArray?) = if (a == null) emptyList() else (0 until a.length()).map { a.getString(it) }
    val k = o.optJSONObject("keys")
    val keys = HashMap<String, String>()
    if (k != null) for (n in k.keys()) keys[n] = k.getString(n)
    return GRoom(
        o.getString("id"), if (o.isNull("group")) null else o.optString("group").ifEmpty { null }, o.optString("title", ""),
        o.optString("host", ""), o.optBoolean("video"), o.optLong("started"), parts, strs(o.optJSONArray("ringing")),
        strs(o.optJSONArray("members")), keys, o.optInt("max", 8)
    )
}

fun parseGCfg(o: JSONObject?): GCfg =
    if (o == null) GCfg() else GCfg(o.optBoolean("on"), o.optBoolean("video"), o.optInt("max_voice", 8), o.optInt("max_video", 4))

/**
 * 1.19: group voice calls (mesh), compatible with the web app's groupcall.mjs.
 * The server keeps the room (who is in, who rings, hands, mutes) and relays the signalling; every pair of
 * participants has its own WebRTC connection, and the SDP / ICE between them is end-to-end encrypted with
 * the pair's keys. The newcomer sends the offers; the people already in the call answer. All connections
 * share one microphone track.
 */
object GroupCall {
    val state = MutableStateFlow(GState())
    /** Every running call I may join (the green «پیوستن» bars), by id. */
    val rooms = MutableStateFlow<Map<String, GRoom>>(emptyMap())
    val cfg = MutableStateFlow(GCfg())
    /** username -> 0..2 playback volume (per person, like Telegram); 1 = normal. */
    val volume = MutableStateFlow<Map<String, Float>>(emptyMap())

    private class Peer(val pc: PeerConnection) {
        val ice = ArrayList<IceCandidate>()
        @Volatile var remoteSet = false
        @Volatile var track: AudioTrack? = null
    }

    private val main = Handler(Looper.getMainLooper())
    private val peers = ConcurrentHashMap<String, Peer>()
    private val lock = Any()
    private var asrc: AudioSource? = null
    private var atrack: AudioTrack? = null
    private var turn: TurnInfo? = null
    private var ringTask: Runnable? = null
    private var ringbackTask: Runnable? = null
    private var levelJob: Job? = null
    /** Signalling is handled strictly in arrival order, one message at a time. */
    private val queue = Channel<suspend () -> Unit>(Channel.UNLIMITED)
    private var worker: Job? = null

    private val me get() = Engine.me
    fun busy(): Boolean = state.value.phase == GPhase.ACTIVE || state.value.phase == GPhase.JOINING
    fun active(): Boolean = state.value.phase != GPhase.IDLE
    fun roomOf(convo: String): GRoom? = rooms.value.values.firstOrNull { it.group == convo }

    private fun post(block: suspend () -> Unit) {
        synchronized(lock) {
            if (worker == null) worker = Engine.scope.launch { for (b in queue) { try { b() } catch (e: Exception) { } } }
        }
        queue.trySend(block)
    }

    private fun toast(t: String) { if (t.isNotEmpty()) main.post { Toast.makeText(Engine.app, t, Toast.LENGTH_LONG).show() } }

    private fun set(f: (GState) -> GState) { synchronized(lock) { state.value = f(state.value) } }

    // ------------------------------------------------------------ actions

    /** From a group chat ([group]; [ring] = who rings in a big group) or with chosen people ([users]). */
    fun start(group: String?, users: List<String>?, ring: List<String>?) {
        if (busy() || CallManager.state.value.phase != CallPhase.IDLE) { toast("اول تماس فعلی را تمام کنید"); return }
        set { GState(GPhase.JOINING) }
        Engine.scope.launch {
            try {
                prepare()
                val b = JSONObject()
                if (group != null) b.put("group", group)
                if (users != null) b.put("users", JSONArray(users))
                if (ring != null) b.put("ring", JSONArray(ring))
                val r = parseRoom(Api.gcall("start", b).getJSONObject("room"))
                enter(r)
                CallTones.play(CallTones.Tone.RINGBACK)
                val t = Runnable { if (state.value.room?.let { it.parts.size <= 1 } == true) CallTones.stop() }
                ringbackTask = t
                main.postDelayed(t, 45_000L)
            } catch (e: Api.HttpError) {
                val running = try { JSONObject(e.message ?: "").optJSONObject("room") } catch (x: Exception) { null }
                if (e.error == "gcall_running" && running != null) {
                    val r = parseRoom(running)
                    rooms.value = rooms.value + (r.id to r)
                    doJoin(r.id, prepared = true)
                } else { abort(); toast(errText(e)) }
            } catch (e: Exception) { abort(); toast(errText(e)) }
        }
    }

    fun join(id: String) {
        if (busy() || CallManager.state.value.phase != CallPhase.IDLE) { toast("اول تماس فعلی را تمام کنید"); return }
        stopRinging()
        set { it.copy(phase = GPhase.JOINING) }
        Engine.scope.launch { doJoin(id, prepared = false) }
    }

    private fun doJoin(id: String, prepared: Boolean) {
        try {
            if (!prepared) prepare()
            val r = parseRoom(Api.gcall("join", JSONObject().put("id", id)).getJSONObject("room"))
            enter(r)
            // the newcomer calls everyone already in the call
            for (p in r.parts) if (p.u != me) { val u = p.u; post { offerTo(u) } }
        } catch (e: Exception) {
            abort()
            toast(errText(e))
        }
    }

    fun accept() { state.value.room?.let { join(it.id) } }

    fun decline() {
        val s = state.value
        if (s.phase != GPhase.INCOMING || s.room == null) return
        val id = s.room.id
        stopRinging()
        Engine.scope.launch { try { Api.gcall("decline", JSONObject().put("id", id)) } catch (e: Exception) { } }
        set { GState() }
    }

    fun leave(note: String = "") {
        val s = state.value
        val r = s.room ?: return
        if (s.phase == GPhase.IDLE) return
        Engine.scope.launch { try { Api.gcall("leave", JSONObject().put("id", r.id)) } catch (e: Exception) { } }
        finish(note)
    }

    fun toggleMute() {
        val m = !state.value.muted
        atrack?.setEnabled(!m)
        set { it.copy(muted = m) }
        act(JSONObject().put("muted", m))
    }

    fun toggleHand() {
        val h = !state.value.hand
        set { it.copy(hand = h) }
        act(JSONObject().put("hand", h))
    }

    fun react(emoji: String) = act(JSONObject().put("react", emoji))

    private fun act(b: JSONObject) {
        val r = state.value.room ?: return
        Engine.scope.launch {
            try { update(parseRoom(Api.gcall("act", b.put("id", r.id)).getJSONObject("room"))) } catch (e: Exception) { toast(errText(e)) }
        }
    }

    fun invite(users: List<String>) {
        val r = state.value.room ?: return
        if (users.isEmpty()) return
        Engine.scope.launch {
            try { update(parseRoom(Api.gcall("invite", JSONObject().put("id", r.id).put("users", JSONArray(users))).getJSONObject("room"))) }
            catch (e: Exception) { toast(errText(e)) }
        }
    }

    /** Only the one who started the call: [action] "mute" or "remove". */
    fun host(u: String, action: String) {
        val r = state.value.room ?: return
        Engine.scope.launch {
            try { update(parseRoom(Api.gcall("host", JSONObject().put("id", r.id).put("user", u).put("action", action)).getJSONObject("room"))) }
            catch (e: Exception) { toast(errText(e)) }
        }
    }

    fun setVolume(u: String, v: Float) {
        volume.value = volume.value + (u to v)
        try { peers[u]?.track?.setVolume(v.toDouble()) } catch (e: Exception) { }
    }

    fun toggleSpeaker() = AudioRouter.cycle()

    /** My 1:1 call became this room (I added people from the call screen). */
    fun adopt(r: GRoom) {
        set { GState(GPhase.JOINING) }
        Engine.scope.launch {
            try { prepare(); enter(r) } catch (e: Exception) {
                abort(); toast(errText(e))
                try { Api.gcall("leave", JSONObject().put("id", r.id)) } catch (x: Exception) { }
            }
        }
    }

    // ------------------------------------------------------------ room state

    /** TURN, call audio route and the shared microphone track, before talking to the server. */
    private fun prepare() {
        turn = Api.turn()
        AudioRouter.start(Engine.app, true) { route, bt -> synchronized(lock) { if (state.value.phase != GPhase.IDLE) state.value = state.value.copy(route = route, bt = bt) } }
        val f = CallManager.ensureFactory()
        synchronized(lock) {
            if (atrack == null) {
                val s = f.createAudioSource(MediaConstraints())
                asrc = s
                atrack = f.createAudioTrack("ga0", s)
            }
        }
    }

    private fun enter(r: GRoom) {
        set { it.copy(phase = GPhase.ACTIVE, room = r, muted = false, hand = false, joinedAt = System.currentTimeMillis(), levels = emptyMap(), reacts = emptyList()) }
        rooms.value = rooms.value + (r.id to r)
        Engine.cancelCallNotification()
        CallManager.startCallService(false)
        startLevels()
    }

    private fun update(r: GRoom) {
        rooms.value = rooms.value + (r.id to r)
        val s = state.value
        if (s.room?.id != r.id) return
        set { it.copy(room = r) }
        if (s.phase == GPhase.ACTIVE) {
            if (r.parts.size > 1) { CallTones.stop(); ringbackTask?.let { main.removeCallbacks(it) } }
            for (u in peers.keys.toList()) if (!r.has(u)) post { dropPeer(u) }
            if (!r.has(me)) finish("شما از تماس بیرون رفتید")
        }
    }

    private fun finish(note: String) {
        val s = state.value
        if (s.phase == GPhase.IDLE) return
        val was = s.phase == GPhase.ACTIVE
        val r = s.room
        set { GState() }
        stopRinging()
        ringbackTask?.let { main.removeCallbacks(it) }
        stopLevels()
        CallTones.stop()
        cleanup()
        if (was && r != null) {
            val sec = ((System.currentTimeMillis() - s.joinedAt) / 1000).toInt()
            Engine.addCallLog(r.convo(me), "📞 تماس گروهی — %02d:%02d".format(sec / 60, sec % 60), r.host == me)
            CallTones.play(CallTones.Tone.END)
            main.postDelayed({ if (!active() && CallManager.state.value.phase == CallPhase.IDLE) AudioRouter.stop() }, CallTones.durationMs(CallTones.Tone.END) + 300L)
        } else if (CallManager.state.value.phase == CallPhase.IDLE) AudioRouter.stop()
        if (CallManager.state.value.phase == CallPhase.IDLE) CallManager.stopCallService()
        toast(note)
    }

    /** Closes every connection and the microphone (in the background: WebRTC may block for a moment). */
    private fun cleanup() {
        val list = peers.values.toList()
        peers.clear()
        val (t, src) = synchronized(lock) { Pair(atrack, asrc).also { atrack = null; asrc = null } }
        Engine.scope.launch {
            for (p in list) { try { p.pc.dispose() } catch (e: Exception) { } }
            try { t?.dispose() } catch (e: Exception) { }
            try { src?.dispose() } catch (e: Exception) { }
        }
    }

    /** Joining / starting failed: back to idle, and give back the call audio if no 1:1 call holds it. */
    private fun abort() {
        cleanup()
        set { GState() }
        CallTones.stop()
        if (CallManager.state.value.phase == CallPhase.IDLE) { AudioRouter.stop(); CallManager.stopCallService() }
    }

    private fun stopRinging() {
        ringTask?.let { main.removeCallbacks(it) }
        ringTask = null
        CallManager.stopRing()
        Engine.cancelCallNotification()
    }

    private fun missed(r: GRoom) {
        stopRinging()
        Engine.addCallLog(r.convo(me), "📞 تماس گروهی از دست رفته", false)
        set { GState() }
    }

    /** After (re)connecting: which calls are running, and is mine still on? */
    fun refresh() {
        Engine.scope.launch {
            try {
                val o = Api.gcallList()
                cfg.value = parseGCfg(o.optJSONObject("cfg"))
                val a = o.optJSONArray("rooms") ?: JSONArray()
                val list = (0 until a.length()).map { parseRoom(a.getJSONObject(it)) }
                rooms.value = list.associateBy { it.id }
                val s = state.value
                val mine = s.room ?: return@launch
                val now = rooms.value[mine.id]
                if (now == null && s.phase == GPhase.INCOMING) missed(mine)
                else if (now == null && s.phase == GPhase.ACTIVE) finish("تماس گروهی پایان یافت")
                else if (now != null) update(now)
            } catch (e: Exception) { }
        }
    }

    /** Live events from the server (see Engine.handleEvent). */
    fun onEvent(ev: String, o: JSONObject) {
        when (ev) {
            "gcall" -> {
                val r = parseRoom(o.getJSONObject("room"))
                if (o.optBoolean("ring") && state.value.phase == GPhase.IDLE && CallManager.state.value.phase == CallPhase.IDLE && !r.has(me)) {
                    rooms.value = rooms.value + (r.id to r)
                    val by = o.optString("by", r.host)
                    set { GState(GPhase.INCOMING, r, by) }
                    CallManager.startRing()
                    Engine.postGroupCallNotification(r.title.ifEmpty { Engine.nameOf(r.host) }, by)
                    val t = Runnable { val s = state.value; if (s.phase == GPhase.INCOMING && s.room?.id == r.id) missed(r) }
                    ringTask = t
                    main.postDelayed(t, 45_000L)
                } else update(r)
            }
            "gcall_end" -> {
                val id = o.optString("id")
                rooms.value = rooms.value - id
                val s = state.value
                val mine = s.room
                if (mine != null && mine.id == id) { if (s.phase == GPhase.INCOMING) missed(mine) else finish("") }
            }
            "gsig" -> {
                val id = o.optString("id"); val from = o.optString("from"); val kind = o.optString("kind"); val payload = o.optString("payload")
                post { onSig(id, from, kind, payload) }
            }
            "gcall_react" -> {
                if (state.value.room?.id != o.optString("id")) return
                val now = System.currentTimeMillis()
                set { it.copy(reacts = it.reacts.filter { x -> now - x.t < 3000 } + GReact(o.optString("from"), o.optString("emoji"), now)) }
                main.postDelayed({ val t = System.currentTimeMillis(); set { it.copy(reacts = it.reacts.filter { x -> t - x.t < 3000 }) } }, 3100L)
            }
            "gcall_host" -> {
                if (state.value.room?.id != o.optString("id")) return
                val by = Engine.nameOf(o.optString("by"))
                when (o.optString("action")) {
                    "mute" -> { atrack?.setEnabled(false); set { it.copy(muted = true) }; toast("$by صدای شما را بست؛ هر وقت خواستید خودتان باز کنید") }
                    "remove" -> finish("$by شما را از تماس بیرون برد")
                }
            }
        }
    }

    // ------------------------------------------------------------ WebRTC mesh

    private fun send(u: String, kind: String, body: JSONObject) {
        val r = state.value.room ?: return
        val pub = r.keys[u] ?: return
        try {
            val payload = Engine.encryptTo(u, pub, body.toString().toByteArray())
            Api.gcall("sig", JSONObject().put("id", r.id).put("to", u).put("kind", kind).put("payload", payload))
        } catch (e: Exception) { }
    }

    private fun peer(u: String): Peer {
        peers[u]?.let { return it }
        val t = turn ?: throw IllegalStateException("no turn")
        val servers = listOf(PeerConnection.IceServer.builder(t.urls).setUsername(t.user).setPassword(t.cred).createIceServer())
        val cfg = PeerConnection.RTCConfiguration(servers).apply {
            iceTransportsType = if (t.policy == "relay") PeerConnection.IceTransportsType.RELAY else PeerConnection.IceTransportsType.ALL
            sdpSemantics = PeerConnection.SdpSemantics.UNIFIED_PLAN
            continualGatheringPolicy = PeerConnection.ContinualGatheringPolicy.GATHER_CONTINUALLY
            bundlePolicy = PeerConnection.BundlePolicy.MAXBUNDLE
            rtcpMuxPolicy = PeerConnection.RtcpMuxPolicy.REQUIRE
        }
        val holder = arrayOfNulls<Peer>(1)
        val pc = CallManager.ensureFactory().createPeerConnection(cfg, observer(u, holder)) ?: throw IllegalStateException("PeerConnection")
        val p = Peer(pc)
        holder[0] = p
        atrack?.let { pc.addTrack(it, listOf("g0")) }
        peers[u] = p
        return p
    }

    private fun observer(u: String, holder: Array<Peer?>) = object : PeerConnection.Observer {
        override fun onIceCandidate(c: IceCandidate) {
            post { send(u, "ice", JSONObject().put("cand", c.sdp).put("mid", c.sdpMid).put("idx", c.sdpMLineIndex)) }
        }
        override fun onConnectionChange(s: PeerConnection.PeerConnectionState) {
            if (s != PeerConnection.PeerConnectionState.FAILED) return
            post {
                val p = holder[0]
                val r = state.value.room
                if (p != null && peers[u] === p && r != null && r.has(u) && state.value.phase == GPhase.ACTIVE) {
                    // try again once from scratch; the side with the smaller name makes the new offer
                    dropPeer(u)
                    if (me < u) offerTo(u)
                }
            }
        }
        override fun onTrack(transceiver: RtpTransceiver) {
            val tr = transceiver.receiver.track()
            if (tr is AudioTrack) {
                holder[0]?.track = tr
                try { tr.setVolume((volume.value[u] ?: 1f).toDouble()) } catch (e: Exception) { }
            }
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

    private suspend fun offerTo(u: String) {
        if (state.value.phase != GPhase.ACTIVE) return
        try {
            val p = peer(u)
            val o = create(p.pc, true)
            setDesc(p.pc, o, true)
            send(u, "offer", JSONObject().put("sdp", o.description))
        } catch (e: Exception) { }
    }

    private fun dropPeer(u: String) {
        val p = peers.remove(u) ?: return
        Engine.scope.launch { try { p.pc.dispose() } catch (e: Exception) { } }
        set { it.copy(levels = it.levels - u) }
    }

    private suspend fun onSig(id: String, u: String, kind: String, payload: String) {
        val s = state.value
        val r = s.room ?: return
        if (r.id != id || s.phase != GPhase.ACTIVE) return
        if (kind == "bye") { dropPeer(u); return }
        val plain = Engine.decryptWith(u, r.keys[u], payload) ?: return
        val j = try { JSONObject(plain) } catch (e: Exception) { return }
        try {
            when (kind) {
                "offer" -> {
                    peers[u]?.let { old ->
                        val pc = old.pc
                        val bad = try {
                            pc.signalingState() != PeerConnection.SignalingState.STABLE || pc.remoteDescription != null ||
                                pc.connectionState() == PeerConnection.PeerConnectionState.FAILED || pc.connectionState() == PeerConnection.PeerConnectionState.CLOSED
                        } catch (e: Exception) { true }
                        if (bad) dropPeer(u)
                    }
                    val p = peer(u)
                    setDesc(p.pc, SessionDescription(SessionDescription.Type.OFFER, j.optString("sdp")), false)
                    p.remoteSet = true
                    flush(p)
                    val a = create(p.pc, false)
                    setDesc(p.pc, a, true)
                    send(u, "answer", JSONObject().put("sdp", a.description))
                }
                "answer" -> {
                    val p = peers[u] ?: return
                    setDesc(p.pc, SessionDescription(SessionDescription.Type.ANSWER, j.optString("sdp")), false)
                    p.remoteSet = true
                    flush(p)
                }
                "ice" -> {
                    val c = IceCandidate(j.optString("mid"), j.optInt("idx"), j.optString("cand"))
                    val p = peers[u] ?: peer(u)
                    if (p.remoteSet) p.pc.addIceCandidate(c) else synchronized(p.ice) { p.ice.add(c) }
                }
            }
        } catch (e: Exception) { }
    }

    private fun flush(p: Peer) {
        val list = synchronized(p.ice) { p.ice.toList().also { p.ice.clear() } }
        for (c in list) try { p.pc.addIceCandidate(c) } catch (e: Exception) { }
    }

    private suspend fun create(pc: PeerConnection, offer: Boolean): SessionDescription = suspendCancellableCoroutine { c ->
        val obs = object : SdpAdapter() {
            override fun onCreateSuccess(d: SessionDescription?) { if (c.isActive) c.resume(d!!) }
            override fun onCreateFailure(e: String?) { if (c.isActive) c.resumeWithException(IllegalStateException("sdp: $e")) }
        }
        if (offer) pc.createOffer(obs, MediaConstraints()) else pc.createAnswer(obs, MediaConstraints())
    }

    private suspend fun setDesc(pc: PeerConnection, d: SessionDescription, local: Boolean) = suspendCancellableCoroutine<Unit> { c ->
        val obs = object : SdpAdapter() {
            override fun onSetSuccess() { if (c.isActive) c.resume(Unit) }
            override fun onSetFailure(e: String?) { if (c.isActive) c.resumeWithException(IllegalStateException("set: $e")) }
        }
        if (local) pc.setLocalDescription(obs, d) else pc.setRemoteDescription(obs, d)
    }

    private suspend fun stats(pc: PeerConnection): RTCStatsReport? = suspendCancellableCoroutine { c ->
        try { pc.getStats { r -> if (c.isActive) c.resume(r) } } catch (e: Exception) { if (c.isActive) c.resume(null) }
    }

    /** Who is speaking: the audio level of every connection, twice a second. */
    private fun startLevels() {
        stopLevels()
        levelJob = Engine.scope.launch {
            while (true) {
                delay(500)
                if (state.value.phase != GPhase.ACTIVE) break
                val lv = HashMap<String, Float>()
                for ((u, p) in peers) {
                    val rep = try { stats(p.pc) } catch (e: Exception) { null } ?: continue
                    for (st in rep.statsMap.values) {
                        val kind = st.members["kind"] ?: st.members["mediaType"]
                        val level = (st.members["audioLevel"] as? Number)?.toFloat() ?: continue
                        if (kind != "audio") continue
                        if (st.type == "inbound-rtp") lv[u] = level
                        else if (st.type == "media-source") lv[me] = maxOf(lv[me] ?: 0f, level)
                    }
                }
                if (state.value.muted) lv[me] = 0f
                set { if (it.phase == GPhase.ACTIVE) it.copy(levels = lv) else it }
            }
        }
    }

    private fun stopLevels() { levelJob?.cancel(); levelJob = null }

    private val ERRS = mapOf(
        "gcall_off" to "تماس گروهی در این سرور خاموش است", "gcall_off_here" to "تماس گروهی در این گروه خاموش است",
        "gcall_full" to "تماس پر است", "gcall_busy" to "الان تماس‌های گروهی زیادی در جریان است؛ کمی بعد دوباره امتحان کنید",
        "not_invited" to "شما به این تماس دعوت نشده‌اید", "no_such_call" to "این تماس تمام شده است",
        "not_allowed" to "فقط با مخاطبان خودتان می‌توانید تماس بگیرید", "too_many" to "تعداد نفرات بیش از حد مجاز است",
        "gcall_video_off" to "تماس تصویری گروهی هنوز فعال نیست", "no_users" to "کسی انتخاب نشده",
        "not_host" to "فقط شروع‌کنندهٔ تماس این کار را می‌تواند بکند", "no_such_user" to "این کاربر پیدا نشد"
    )

    fun errText(e: Exception): String = when (e) {
        is Api.HttpError -> ERRS[e.error] ?: "خطا در تماس گروهی (${e.code})"
        else -> "خطا در تماس گروهی؛ اتصال را بررسی کنید"
    }
}
