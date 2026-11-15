package com.pchat.app

import android.Manifest
import android.content.pm.PackageManager
import android.os.Build
import android.widget.Toast
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.grid.GridCells
import androidx.compose.foundation.lazy.grid.LazyVerticalGrid
import androidx.compose.foundation.lazy.grid.items
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Checkbox
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Slider
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
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
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.core.content.ContextCompat
import kotlinx.coroutines.delay

// ------------------------------------------------------------ helpers shared by the chat, the Calls tab and the call screens

/** People I can call: my contacts who have a key (they signed in at least once), no open message request. */
fun callablePeople(): List<String> =
    Engine.users.value.filter { it.dm && it.username != Engine.me && !it.pubkey.isNullOrEmpty() && it.req == null }.map { it.username }

fun maxVoice(): Int = GroupCall.cfg.value.maxVoice.coerceAtLeast(2)

/** Returns a function that runs [action] once the microphone permission is there (asks for it first if needed). */
@Composable
fun rememberMic(): (() -> Unit) -> Unit {
    val ctx = LocalContext.current
    var pending by remember { mutableStateOf<(() -> Unit)?>(null) }
    val launcher = rememberLauncherForActivityResult(ActivityResultContracts.RequestMultiplePermissions()) { _ ->
        val a = pending
        pending = null
        if (ContextCompat.checkSelfPermission(ctx, Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED) a?.invoke()
        else Toast.makeText(ctx, "برای تماس باید اجازه میکروفون بدهید", Toast.LENGTH_LONG).show()
    }
    return { action ->
        val need = ArrayList<String>()
        if (ContextCompat.checkSelfPermission(ctx, Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED) need.add(Manifest.permission.RECORD_AUDIO)
        if (Build.VERSION.SDK_INT >= 31 && !Prefs.btAsked && ContextCompat.checkSelfPermission(ctx, Manifest.permission.BLUETOOTH_CONNECT) != PackageManager.PERMISSION_GRANTED) {
            Prefs.btAsked = true
            need.add(Manifest.permission.BLUETOOTH_CONNECT)
        }
        if (need.isEmpty()) action() else { pending = action; launcher.launch(need.toTypedArray()) }
    }
}

class PickReq(val title: String, val names: List<String>, val action: String, val max: Int, val done: (List<String>) -> Unit)
class ConfirmReq(val title: String, val text: String, val action: String, val run: () -> Unit)

/** Group call buttons: the 📞 of a group chat and «تماس جدید» in the Calls tab. Show [GroupCallDialogs] next to it. */
class GroupCallActions {
    var pick by mutableStateOf<PickReq?>(null)
    var confirm by mutableStateOf<ConfirmReq?>(null)
    internal var mic: (() -> Unit) -> Unit = { it() }
    internal var call1: (String, Boolean) -> Unit = { _, _ -> }
    internal var toast: (String) -> Unit = { }

    /** Group chat 📞: join the running call, or start one (over 8 people: pick who rings, like WhatsApp). */
    fun groupCall(convo: String) {
        GroupCall.roomOf(convo)?.let { r -> mic { GroupCall.join(r.id) }; return }
        val g = Engine.groups.value.firstOrNull { it.key == convo } ?: return
        if (!GroupCall.cfg.value.on) { toast("تماس گروهی در این سرور خاموش است"); return }
        if (!g.call) { toast("تماس گروهی در این گروه خاموش است"); return }
        val others = g.members.filter { it != Engine.me }
        if (others.isEmpty()) { toast("کس دیگری در این گروه نیست"); return }
        if (others.size + 1 <= 8) {
            confirm = ConfirmReq("تماس صوتی گروهی", "گوشی ${U.fa(others.size)} عضو «${g.name}» زنگ می‌خورد.", "تماس") {
                mic { GroupCall.start(convo, null, null) }
            }
        } else {
            pick = PickReq("گوشی چه کسانی زنگ بخورد؟", others, "تماس", maxVoice() - 1) { ring -> mic { GroupCall.start(convo, null, ring) } }
        }
    }

    fun callOne(u: String) = call1(u, false)

    /** «تماس جدید»: one person = a normal call, more = a group call. */
    fun newCall() {
        pick = PickReq("تماس جدید", callablePeople(), "تماس صوتی", maxVoice() - 1) { users ->
            if (users.size == 1) call1(users[0], false)
            else if (!GroupCall.cfg.value.on) toast("تماس گروهی در این سرور خاموش است")
            else mic { GroupCall.start(null, users, null) }
        }
    }
}

@Composable
fun rememberGroupCallActions(): GroupCallActions {
    val ctx = LocalContext.current
    val a = remember { GroupCallActions() }
    a.mic = rememberMic()
    a.call1 = rememberCallStarter()
    a.toast = { Toast.makeText(ctx, it, Toast.LENGTH_SHORT).show() }
    GroupCallDialogs(a)
    return a
}

@Composable
private fun GroupCallDialogs(a: GroupCallActions) {
    a.confirm?.let { c ->
        AlertDialog(
            onDismissRequest = { a.confirm = null },
            title = { Text(c.title) },
            text = { Text(c.text) },
            confirmButton = { TextButton(onClick = { a.confirm = null; c.run() }) { Text(c.action) } },
            dismissButton = { TextButton(onClick = { a.confirm = null }) { Text("انصراف") } }
        )
    }
    a.pick?.let { p -> PeoplePicker(p) { a.pick = null } }
}

/** Multi-select list of people (at most [PickReq.max]). */
@Composable
fun PeoplePicker(p: PickReq, onClose: () -> Unit) {
    val ctx = LocalContext.current
    var chosen by remember(p) { mutableStateOf(listOf<String>()) }
    var q by remember(p) { mutableStateOf("") }
    val shown = p.names.filter { q.isBlank() || Engine.nameOf(it).contains(q, true) || it.contains(q, true) }
        .sortedBy { Engine.nameOf(it) }
    AlertDialog(
        onDismissRequest = onClose,
        title = { Text(p.title) },
        text = {
            Column {
                if (p.names.size > 6) OutlinedTextField(q, { q = it }, singleLine = true, placeholder = { Text("جستجو…") }, modifier = Modifier.fillMaxWidth())
                Text("${U.fa(chosen.size)} از حداکثر ${U.fa(p.max)} نفر", fontSize = 12.sp, color = MaterialTheme.colorScheme.onSurface.copy(alpha = 0.6f),
                    modifier = Modifier.padding(vertical = 4.dp))
                if (p.names.isEmpty()) Text("کسی برای انتخاب نیست", fontSize = 14.sp)
                LazyColumn(Modifier.heightIn(max = 380.dp)) {
                    items(shown, key = { it }) { u ->
                        val on = u in chosen
                        Row(
                            Modifier.fillMaxWidth().clickable {
                                chosen = if (on) chosen - u
                                else if (chosen.size >= p.max) { Toast.makeText(ctx, "حداکثر ${U.fa(p.max)} نفر", Toast.LENGTH_SHORT).show(); chosen }
                                else chosen + u
                            }.padding(vertical = 6.dp),
                            verticalAlignment = Alignment.CenterVertically
                        ) {
                            Avatar(u, false, 36)
                            Spacer(Modifier.width(10.dp))
                            Text(Engine.nameOf(u), modifier = Modifier.weight(1f), maxLines = 1, overflow = TextOverflow.Ellipsis)
                            Checkbox(checked = on, onCheckedChange = null)
                        }
                    }
                }
            }
        },
        confirmButton = {
            TextButton(enabled = chosen.isNotEmpty(), onClick = { val c = chosen; onClose(); p.done(c) }) { Text(p.action) }
        },
        dismissButton = { TextButton(onClick = onClose) { Text("انصراف") } }
    )
}

/** Green «پیوستن» bar on top of a group chat while a call runs there (like WhatsApp). */
@Composable
fun GroupCallBar(convo: String, onJoin: (String) -> Unit) {
    val rooms by GroupCall.rooms.collectAsState()
    val g by GroupCall.state.collectAsState()
    val r = rooms.values.firstOrNull { it.group == convo } ?: return
    if (g.room?.id == r.id && g.phase == GPhase.ACTIVE) return
    Row(
        Modifier.fillMaxWidth().background(Color(0xFF2E7D32)).clickable { onJoin(r.id) }.padding(horizontal = 14.dp, vertical = 9.dp),
        verticalAlignment = Alignment.CenterVertically
    ) {
        Text("📞", fontSize = 18.sp)
        Spacer(Modifier.width(10.dp))
        Text(
            "تماس گروهی در جریان · ${U.fa(r.parts.size)} نفر", color = Color.White, fontSize = 14.sp, fontWeight = FontWeight.SemiBold,
            modifier = Modifier.weight(1f), maxLines = 1, overflow = TextOverflow.Ellipsis
        )
        Text("پیوستن", color = Color.White, fontWeight = FontWeight.Bold)
    }
}

// ------------------------------------------------------------ chat list tabs and the Calls tab

@Composable
fun ChatCallTabs(tab: Int, onTab: (Int) -> Unit) {
    Row(Modifier.fillMaxWidth().background(MaterialTheme.colorScheme.surface)) {
        for ((i, label) in listOf("گفتگوها", "تماس‌ها").withIndex()) {
            val on = tab == i
            Column(Modifier.weight(1f).clickable { onTab(i) }, horizontalAlignment = Alignment.CenterHorizontally) {
                Text(
                    label, fontWeight = if (on) FontWeight.Bold else FontWeight.Normal, fontSize = 15.sp,
                    color = if (on) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.onSurface.copy(alpha = 0.6f),
                    modifier = Modifier.padding(vertical = 10.dp)
                )
                Box(Modifier.fillMaxWidth().height(3.dp).background(if (on) MaterialTheme.colorScheme.primary else Color.Transparent))
            }
        }
    }
}

@Composable
private fun SectionHeader(t: String) = Text(
    t, fontWeight = FontWeight.Bold, fontSize = 14.sp, color = MaterialTheme.colorScheme.primary,
    modifier = Modifier.fillMaxWidth().background(MaterialTheme.colorScheme.primary.copy(alpha = 0.06f)).padding(horizontal = 16.dp, vertical = 8.dp)
)

/** «تماس‌ها»: running group calls I may join, then the recent calls of every chat, and «تماس جدید». */
@Composable
fun CallsTab(onOpen: (String) -> Unit) {
    val tick by Engine.tick.collectAsState()
    val rooms by GroupCall.rooms.collectAsState()
    val g by GroupCall.state.collectAsState()
    val actions = rememberGroupCallActions()
    val mic = rememberMic()
    val logs = remember(tick) { Engine.db.callLogs(200) }
    val live = rooms.values.filter { !(g.room?.id == it.id && g.phase == GPhase.ACTIVE) }.sortedByDescending { it.started }
    val dim = MaterialTheme.colorScheme.onSurface.copy(alpha = 0.6f)
    Box(Modifier.fillMaxSize()) {
        LazyColumn(Modifier.fillMaxSize()) {
            if (live.isNotEmpty()) item(key = "live_h") { SectionHeader("تماس‌های در جریان") }
            items(live, key = { "live:" + it.id }) { r ->
                Row(Modifier.fillMaxWidth().padding(horizontal = 14.dp, vertical = 10.dp), verticalAlignment = Alignment.CenterVertically) {
                    Avatar(r.group ?: r.host, false, 44)
                    Spacer(Modifier.width(12.dp))
                    Column(Modifier.weight(1f)) {
                        Text(titleOf(r), fontWeight = FontWeight.SemiBold, maxLines = 1, overflow = TextOverflow.Ellipsis)
                        Text("تماس گروهی · ${U.fa(r.parts.size)} نفر", fontSize = 13.sp, color = dim)
                    }
                    TextButton(onClick = { mic { GroupCall.join(r.id) } }) { Text("پیوستن", color = Color(0xFF2E7D32), fontWeight = FontWeight.Bold) }
                }
            }
            item(key = "recent_h") { SectionHeader("اخیر") }
            if (logs.isEmpty()) item(key = "empty") {
                Text("هنوز تماسی نیست. با «📞+» تماس تازه بگیرید.", color = dim, modifier = Modifier.padding(20.dp))
            }
            items(logs, key = { "log:" + it.id }) { m ->
                val missed = m.text.contains("بی‌پاسخ") || m.text.contains("از دست رفته")
                val group = Engine.isGroup(m.convo)
                Row(
                    Modifier.fillMaxWidth().clickable { onOpen(m.convo) }.padding(horizontal = 14.dp, vertical = 8.dp),
                    verticalAlignment = Alignment.CenterVertically
                ) {
                    Avatar(m.convo, false, 44)
                    Spacer(Modifier.width(12.dp))
                    Column(Modifier.weight(1f)) {
                        Text(
                            Engine.titleOf(m.convo), fontWeight = FontWeight.SemiBold, maxLines = 1, overflow = TextOverflow.Ellipsis,
                            color = if (missed) MaterialTheme.colorScheme.error else MaterialTheme.colorScheme.onSurface
                        )
                        Text(
                            (if (m.mine) "↗ " else "↙ ") + m.text.removePrefix("📞 ") + " · " + U.fullDate(m.ts),
                            fontSize = 13.sp, color = dim, maxLines = 1, overflow = TextOverflow.Ellipsis
                        )
                    }
                    val can = if (group) GroupCall.cfg.value.on && Engine.groups.value.any { it.key == m.convo && it.call } else m.convo in callablePeople()
                    if (can) Text(
                        "📞", fontSize = 20.sp,
                        modifier = Modifier.clip(CircleShape).clickable { if (group) actions.groupCall(m.convo) else actions.callOne(m.convo) }.padding(8.dp)
                    )
                }
            }
        }
        Box(
            Modifier.align(Alignment.BottomEnd).navigationBarsPadding().padding(20.dp).size(58.dp).clip(CircleShape)
                .background(MaterialTheme.colorScheme.primary).clickable { actions.newCall() },
            contentAlignment = Alignment.Center
        ) { Text("📞+", color = Color.White, fontSize = 17.sp, maxLines = 1, softWrap = false) }
    }
}

// ------------------------------------------------------------ the call screen

@Composable
private fun GBtn(label: String, caption: String, bg: Color, onClick: () -> Unit) {
    Column(horizontalAlignment = Alignment.CenterHorizontally) {
        Box(
            Modifier.size(56.dp).clip(CircleShape).background(bg).clickable(onClick = onClick),
            contentAlignment = Alignment.Center
        ) { Text(label, fontSize = 24.sp, color = Color.White) }
        Spacer(Modifier.height(4.dp))
        Text(caption, fontSize = 11.sp, color = Color.White.copy(alpha = 0.8f), maxLines = 1)
    }
}

private val REACTIONS = listOf("👍", "❤️", "😂", "😮", "👏")

@Composable
fun GroupCallScreen() {
    val g by GroupCall.state.collectAsState()
    SystemBars.DarkWhileShown()
    Box(Modifier.fillMaxSize().background(Color(0xFF101820))) {
        val r = g.room
        if (r == null) {
            Column(Modifier.align(Alignment.Center), horizontalAlignment = Alignment.CenterHorizontally) {
                Text("تماس گروهی", color = Color.White, fontSize = 22.sp, fontWeight = FontWeight.Bold)
                Text("در حال پیوستن…", color = Color.White.copy(alpha = 0.75f))
            }
        } else if (g.phase == GPhase.INCOMING) GcIncoming(g, r) else GcActive(g, r)
    }
}

private fun titleOf(r: GRoom) = r.title.ifEmpty { if (r.host == Engine.me) "تماس گروهی" else Engine.nameOf(r.host) }

@Composable
private fun GcIncoming(g: GState, r: GRoom) {
    val mic = rememberMic()
    Box(Modifier.fillMaxSize()) {
        Column(Modifier.align(Alignment.Center).padding(24.dp), horizontalAlignment = Alignment.CenterHorizontally) {
            Avatar(r.group ?: r.host, false, 110)
            Spacer(Modifier.height(14.dp))
            Text(titleOf(r), color = Color.White, fontSize = 24.sp, fontWeight = FontWeight.Bold, textAlign = TextAlign.Center)
            Text("تماس صوتی گروهی از " + Engine.nameOf(g.by), color = Color.White.copy(alpha = 0.75f), fontSize = 15.sp)
            Spacer(Modifier.height(12.dp))
            Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) { for (p in r.parts.take(6)) Avatar(p.u, false, 34) }
        }
        Row(
            Modifier.align(Alignment.BottomCenter).navigationBarsPadding().padding(bottom = 40.dp),
            horizontalArrangement = Arrangement.spacedBy(48.dp)
        ) {
            GBtn("✖", "رد", Color(0xFFE53935)) { GroupCall.decline() }
            GBtn("📞", "پیوستن", Color(0xFF43A047)) { mic { GroupCall.accept() } }
        }
    }
}

@Composable
private fun GcActive(g: GState, r: GRoom) {
    val me = Engine.me
    var now by remember { mutableStateOf(System.currentTimeMillis()) }
    LaunchedEffect(Unit) { while (true) { delay(1000); now = System.currentTimeMillis() } }
    val host = r.host == me
    var person by remember { mutableStateOf<String?>(null) }
    var adding by remember { mutableStateOf(false) }
    var reactMenu by remember { mutableStateOf(false) }
    val sec = if (g.phase == GPhase.ACTIVE) ((now - g.joinedAt) / 1000).toInt().coerceAtLeast(0) else 0
    val ringing = r.ringing.filter { u -> !r.has(u) }
    val big = r.parts.size <= 4

    Column(Modifier.fillMaxSize().statusBarsPadding().navigationBarsPadding()) {
        Row(Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 12.dp), verticalAlignment = Alignment.CenterVertically) {
            Column(Modifier.weight(1f)) {
                Text(titleOf(r), color = Color.White, fontSize = 20.sp, fontWeight = FontWeight.Bold, maxLines = 1, overflow = TextOverflow.Ellipsis)
                val status = if (g.phase != GPhase.ACTIVE) "در حال پیوستن…"
                else "%d:%02d".format(sec / 60, sec % 60) + " · ${U.fa(r.parts.size)} نفر" +
                    (if (ringing.isNotEmpty()) " · در حال زنگ: " + ringing.joinToString("، ") { Engine.nameOf(it) } else "")
                Text(status, color = Color.White.copy(alpha = 0.7f), fontSize = 13.sp, maxLines = 2, overflow = TextOverflow.Ellipsis)
            }
            Box(
                Modifier.clip(RoundedCornerShape(18.dp)).background(Color(0x33FFFFFF)).clickable { adding = true }.padding(horizontal = 12.dp, vertical = 8.dp)
            ) { Text("👤+", color = Color.White, fontSize = 16.sp, maxLines = 1, softWrap = false) }
        }
        LazyVerticalGrid(
            columns = GridCells.Fixed(if (big) 2 else 3),
            modifier = Modifier.weight(1f).fillMaxWidth(),
            contentPadding = PaddingValues(10.dp),
            verticalArrangement = Arrangement.spacedBy(10.dp),
            horizontalArrangement = Arrangement.spacedBy(10.dp)
        ) {
            items(r.parts, key = { it.u }) { p ->
                val speaking = (g.levels[p.u] ?: 0f) > 0.03f && !p.muted
                val react = g.reacts.lastOrNull { it.from == p.u }
                val shape = RoundedCornerShape(14.dp)
                Box(
                    Modifier.fillMaxWidth().height(if (big) 170.dp else 130.dp).clip(shape).background(Color(0xFF1C2733))
                        .border(3.dp, if (speaking) Color(0xFF4CD964) else Color.Transparent, shape)
                        .clickable(enabled = p.u != me) { person = p.u },
                    contentAlignment = Alignment.Center
                ) {
                    Column(horizontalAlignment = Alignment.CenterHorizontally) {
                        Avatar(p.u, false, if (big) 72 else 54)
                        Spacer(Modifier.height(6.dp))
                        Text(
                            (if (p.u == me) "شما" else Engine.nameOf(p.u)) + (if (p.u == r.host) " ★" else ""),
                            color = Color.White, fontSize = 14.sp, maxLines = 1, overflow = TextOverflow.Ellipsis,
                            modifier = Modifier.padding(horizontal = 6.dp)
                        )
                        Text((if (p.muted) "🔇" else "") + (if (p.hand > 0) " ✋" else ""), fontSize = 14.sp)
                    }
                    if (react != null) Text(react.emoji, fontSize = 34.sp, modifier = Modifier.align(Alignment.TopEnd).padding(8.dp))
                }
            }
        }
        Row(Modifier.fillMaxWidth().padding(top = 8.dp, bottom = 24.dp), horizontalArrangement = Arrangement.SpaceEvenly) {
            GBtn(if (g.muted) "🔇" else "🎤", "میکروفون", if (g.muted) Color(0xFF5C6B7A) else Color(0x33FFFFFF)) { GroupCall.toggleMute() }
            val (ico, cap) = when (g.route) {
                AudioRoute.BLUETOOTH -> "🎧" to "بلوتوث"
                AudioRoute.SPEAKER -> "🔊" to "بلندگو"
                AudioRoute.EARPIECE -> (if (g.bt) "📱" else "🔈") to (if (g.bt) "گوشی" else "بلندگو")
            }
            GBtn(ico, cap, if (g.route != AudioRoute.EARPIECE) Color(0xFF3390EC) else Color(0x33FFFFFF)) { GroupCall.toggleSpeaker() }
            GBtn("✋", "دست", if (g.hand) Color(0xFFF9A825) else Color(0x33FFFFFF)) { GroupCall.toggleHand() }
            Box {
                GBtn("😀", "واکنش", Color(0x33FFFFFF)) { reactMenu = true }
                DropdownMenu(expanded = reactMenu, onDismissRequest = { reactMenu = false }) {
                    Row(Modifier.padding(horizontal = 8.dp)) {
                        for (e in REACTIONS) Text(e, fontSize = 28.sp, modifier = Modifier.clickable { reactMenu = false; GroupCall.react(e) }.padding(6.dp))
                    }
                }
            }
            GBtn("✖", "خروج", Color(0xFFE53935)) { GroupCall.leave() }
        }
    }

    person?.let { u -> PersonSheet(u, host) { person = null } }
    if (adding) {
        val inCall = (r.parts.map { it.u } + r.ringing).toSet()
        val gm = r.group?.let { k -> Engine.groups.value.firstOrNull { it.key == k }?.members } ?: emptyList()
        val names = (gm + callablePeople()).distinct().filter { it != me && it !in inCall }
        val free = r.max - r.parts.size
        if (free <= 0) AlertDialog(
            onDismissRequest = { adding = false },
            text = { Text("تماس پر است") },
            confirmButton = { TextButton(onClick = { adding = false }) { Text("باشه") } }
        ) else PeoplePicker(PickReq("افزودن به تماس", names, "زنگ بزن", free) { GroupCall.invite(it) }) { adding = false }
    }
}

/** Tap a person: their volume (only on this phone), and for the one who started the call: mute / remove. */
@Composable
private fun PersonSheet(u: String, host: Boolean, onClose: () -> Unit) {
    val vols by GroupCall.volume.collectAsState()
    var confirmRemove by remember { mutableStateOf(false) }
    AlertDialog(
        onDismissRequest = onClose,
        title = { Text(Engine.nameOf(u)) },
        text = {
            Column {
                val v = vols[u] ?: 1f
                Text("🔈 بلندی صدا: ${U.fa((v * 100).toInt())}٪", fontSize = 14.sp)
                Slider(value = v, onValueChange = { GroupCall.setVolume(u, it) }, valueRange = 0f..2f)
                if (host) {
                    TextButton(onClick = { GroupCall.host(u, "mute"); onClose() }) { Text("🔇 بستن صدای او برای همه") }
                    TextButton(onClick = { confirmRemove = true }) { Text("⛔ بیرون کردن از تماس", color = MaterialTheme.colorScheme.error) }
                }
            }
        },
        confirmButton = { TextButton(onClick = onClose) { Text("بستن") } }
    )
    if (confirmRemove) AlertDialog(
        onDismissRequest = { confirmRemove = false },
        title = { Text("بیرون کردن") },
        text = { Text(Engine.nameOf(u) + " از تماس بیرون برود؟") },
        confirmButton = { TextButton(onClick = { confirmRemove = false; GroupCall.host(u, "remove"); onClose() }) { Text("بیرون کردن", color = MaterialTheme.colorScheme.error) } },
        dismissButton = { TextButton(onClick = { confirmRemove = false }) { Text("انصراف") } }
    )
}
