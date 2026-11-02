package com.pchat.app

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.withContext
import org.json.JSONObject
import org.webrtc.PeerConnection
import org.webrtc.RTCStats
import org.webrtc.RTCStatsReport
import kotlin.coroutines.resume

/*
 * Call diagnostics (1.7, TEST FEATURE). Shown only to the users listed in the admin panel (default
 * "mostafa"; /api/me says diag=true). During a call: ping (round-trip time of the media path), jitter,
 * loss, bitrate, codec and whether the call goes directly or through the server's TURN relay, read from
 * WebRTC's own statistics every second. «مسیر» asks the server for traceroute to both people of the call.
 *
 * To remove: empty the list in the panel (instant, no app update), or revert the commit that added this file.
 */

private suspend fun statsOf(pc: PeerConnection): RTCStatsReport? = suspendCancellableCoroutine { c ->
    try { pc.getStats { r -> if (c.isActive) c.resume(r) } } catch (e: Exception) { if (c.isActive) c.resume(null) }
}

private fun num(v: Any?): Double? = (v as? Number)?.toDouble()
private fun ms(sec: Double?) = if (sec == null || sec.isNaN()) "–" else "${Math.round(sec * 1000)} ms"
private fun kbps(k: Double?) = when { k == null -> "–"; k >= 1000 -> "%.1f Mb/s".format(k / 1000); else -> "${Math.round(k)} kb/s" }
private val TYPE = mapOf("host" to "local", "srflx" to "public", "prflx" to "public", "relay" to "TURN relay")

private class Prev(val id: String, val t: Long, val rx: Double, val tx: Double)

/** One sample of the call's statistics as display lines (the first one is the ping). */
private fun describe(rep: RTCStatsReport, prev: Prev?): Pair<List<String>, Prev?> {
    val all = rep.statsMap
    fun at(id: Any?): RTCStats? = (id as? String)?.let { all[it] }
    var pair = all.values.firstOrNull { it.type == "transport" && it.members["selectedCandidatePairId"] != null }
        ?.let { at(it.members["selectedCandidatePairId"]) }
    if (pair == null) pair = all.values.firstOrNull { it.type == "candidate-pair" && it.members["state"] == "succeeded" && it.members["nominated"] == true }
    val m = pair?.members
    val loc = m?.let { at(it["localCandidateId"])?.members }
    val rem = m?.let { at(it["remoteCandidateId"])?.members }
    var jitter: Double? = null; var lost = 0.0; var recv = 0.0; var codec = ""; var video = ""
    for (s in all.values) {
        if (s.type != "inbound-rtp") continue
        val k = s.members["kind"] ?: s.members["mediaType"]
        if (k == "audio") {
            jitter = num(s.members["jitter"]); lost += num(s.members["packetsLost"]) ?: 0.0; recv += num(s.members["packetsReceived"]) ?: 0.0
            (at(s.members["codecId"])?.members?.get("mimeType") as? String)?.let { codec = it.substringAfter('/') }
        }
        if (k == "video") {
            val w = num(s.members["frameWidth"]); val h = num(s.members["frameHeight"]); val fps = num(s.members["framesPerSecond"])
            if (w != null && h != null) video = "${w.toInt()}×${h.toInt()}" + (fps?.let { " @${it.toInt()}fps" } ?: "")
        }
    }
    val now = System.currentTimeMillis()
    var down: Double? = null; var up: Double? = null
    val rx = num(m?.get("bytesReceived")) ?: 0.0; val tx = num(m?.get("bytesSent")) ?: 0.0
    if (pair != null && prev != null && prev.id == pair.id) {
        val dt = (now - prev.t) / 1000.0
        if (dt > 0) { down = (rx - prev.rx) * 8 / 1000 / dt; up = (tx - prev.tx) * 8 / 1000 / dt }
    }
    val relay = loc?.get("candidateType") == "relay" || rem?.get("candidateType") == "relay"
    fun addr(c: Map<String, Any>?) = if (c == null) "–" else
        "${c["address"] ?: c["ip"] ?: "?"}:${c["port"]} (${(c["candidateType"] as? String)?.let { TYPE[it] } ?: c["candidateType"]}, ${c["protocol"] ?: ""})"
    val loss = if (recv + lost > 0) "%.1f%%".format(100 * lost / (recv + lost)) else "–"
    val lines = listOf(
        "ping " + ms(num(m?.get("currentRoundTripTime"))),
        "jitter ${ms(jitter)} · loss $loss",
        "↓ ${kbps(down)} ↑ ${kbps(up)}" + (if (codec.isNotEmpty()) " · $codec" else "") + (if (video.isNotEmpty()) " · $video" else ""),
        if (pair == null) "connecting…" else if (relay) "via Sepan TURN server" else "direct (peer to peer)",
        "me   " + addr(loc),
        "peer " + addr(rem)
    )
    return lines to (pair?.let { Prev(it.id, now, rx, tx) } ?: prev)
}

private fun traceText(o: JSONObject): List<String> {
    val out = mutableListOf("server → me / server → peer" + (o.optString("server").takeIf { it.isNotEmpty() }?.let { " (server $it)" } ?: ""))
    for ((label, key) in listOf("server → me" to "me", "server → peer" to "peer")) {
        val t = o.optJSONObject(key) ?: continue
        val err = t.optString("error")
        if (err.isNotEmpty()) {
            out += "$label: " + when (err) { "no_traceroute" -> "traceroute is not installed on the server"; "offline" -> "not connected"; else -> err }
            continue
        }
        val hops = t.optJSONArray("hops")
        val n = hops?.length() ?: 0
        out += "$label ${t.optString("ip")} — $n hops (${t.optString("tool")})"
        for (i in 0 until n) {
            val h = hops!!.getJSONObject(i)
            val ip = if (h.isNull("ip")) "*" else h.optString("ip")
            val ms = if (h.isNull("ms")) "" else "  ${h.optDouble("ms")} ms"
            out += "  ${h.optInt("n")}. $ip$ms"
        }
    }
    return out
}

/** The diagnostics box in the call screen. */
@Composable
fun DiagOverlay(peer: String, modifier: Modifier = Modifier) {
    val scope = rememberCoroutineScope()
    var lines by remember { mutableStateOf(listOf("connecting…")) }
    var route by remember(peer) { mutableStateOf<List<String>>(emptyList()) }
    var tracing by remember { mutableStateOf(false) }
    LaunchedEffect(peer) {
        var prev: Prev? = null
        while (true) {
            val pc = CallManager.peerConnection
            val rep = if (pc != null) try { statsOf(pc) } catch (e: Exception) { null } else null
            if (rep != null) { val (l, p) = describe(rep, prev); lines = l; prev = p }
            delay(1000)
        }
    }
    Column(
        modifier.widthIn(max = 300.dp).heightIn(max = 420.dp).clip(RoundedCornerShape(10.dp))
            .background(Color(0xB3000000)).padding(8.dp).verticalScroll(rememberScrollState())
    ) {
        lines.forEachIndexed { i, l ->
            Text(l, color = if (i == 0) Color(0xFF7CFC9A) else Color.White, fontSize = if (i == 0) 15.sp else 11.sp,
                fontWeight = if (i == 0) FontWeight.Bold else FontWeight.Normal, fontFamily = FontFamily.Monospace)
        }
        Text(
            if (tracing) "tracing… (up to ~40 s)" else "مسیر (traceroute)",
            color = Color(0xFF8CC8FF), fontSize = 13.sp,
            modifier = Modifier.padding(vertical = 6.dp).clickable(enabled = !tracing) {
                tracing = true
                scope.launch {
                    route = try {
                        traceText(withContext(Dispatchers.IO) { Api.diagTrace(peer) })
                    } catch (e: Api.HttpError) {
                        listOf("trace failed: " + (e.error.ifEmpty { e.code.toString() }))
                    } catch (e: Exception) {
                        listOf("trace failed: " + (e.message ?: e.javaClass.simpleName))
                    }
                    tracing = false
                }
            }
        )
        route.forEach { Text(it, color = Color.White, fontSize = 11.sp, fontFamily = FontFamily.Monospace) }
    }
}
