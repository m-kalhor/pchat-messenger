package com.pchat.app

import android.widget.Toast
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Delete
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Checkbox
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Surface
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateListOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import kotlinx.coroutines.launch
import java.util.Calendar

// ---------------------------------------------------------------- 1.29: scheduled send

private fun dayName(dayStart: Long, i: Int): String = when (i) {
    0 -> "امروز"
    1 -> "فردا"
    else -> android.icu.text.SimpleDateFormat("EEEE d MMMM", android.icu.util.ULocale("fa_IR@calendar=persian")).format(java.util.Date(dayStart))
}

private fun startOfDay(ts: Long): Long = Calendar.getInstance().apply {
    timeInMillis = ts; set(Calendar.HOUR_OF_DAY, 0); set(Calendar.MINUTE, 0); set(Calendar.SECOND, 0); set(Calendar.MILLISECOND, 0)
}.timeInMillis

/** Picks a day (up to [maxDays] ahead), an hour and a minute. Quick choices first, like Telegram. */
@Composable
fun SchedulePickerDialog(maxDays: Int, initial: Long? = null, title: String = "ارسال زمان‌دار", onClose: () -> Unit, onPick: (Long) -> Unit) {
    val now = System.currentTimeMillis()
    val start = initial?.takeIf { it > now } ?: (now + 3600_000L)
    val c0 = Calendar.getInstance().apply { timeInMillis = start }
    val today = startOfDay(now)
    var day by remember { mutableStateOf(((startOfDay(start) - today) / 86_400_000L).toInt().coerceIn(0, maxDays)) }
    var hour by remember { mutableStateOf(c0.get(Calendar.HOUR_OF_DAY)) }
    var minute by remember { mutableStateOf((c0.get(Calendar.MINUTE) / 5) * 5) }
    var dayMenu by remember { mutableStateOf(false) }
    var hourMenu by remember { mutableStateOf(false) }
    var minMenu by remember { mutableStateOf(false) }
    val ctx = LocalContext.current
    fun at(d: Int, h: Int, m: Int): Long = Calendar.getInstance().apply {
        timeInMillis = today; add(Calendar.DAY_OF_YEAR, d); set(Calendar.HOUR_OF_DAY, h); set(Calendar.MINUTE, m)
    }.timeInMillis
    fun pick(t: Long) {
        if (t < System.currentTimeMillis() + 30_000L) { Toast.makeText(ctx, "این زمان گذشته است", Toast.LENGTH_SHORT).show(); return }
        onPick(t)
    }
    val quick = listOf(
        "یک ساعت دیگر" to (now + 3600_000L),
        "امشب ساعت ۲۱" to at(0, 21, 0),
        "فردا ساعت ۹ صبح" to at(1, 9, 0),
    ).filter { it.second > now + 60_000L }
    AlertDialog(
        onDismissRequest = onClose,
        title = { Text(title) },
        text = {
            Column {
                quick.forEach { (label, t) ->
                    Row(Modifier.fillMaxWidth().clip(RoundedCornerShape(10.dp)).clickable { pick(t) }.padding(vertical = 10.dp, horizontal = 6.dp),
                        verticalAlignment = Alignment.CenterVertically) {
                        Icon(SIcons.clock, null, tint = MaterialTheme.colorScheme.primary, modifier = Modifier.size(20.dp))
                        Spacer(Modifier.width(10.dp))
                        Text(label, modifier = Modifier.weight(1f))
                        Text(U.listTime(t).let { if (U.dayKey(t) == U.dayKey(now)) it else U.time(t) }, fontSize = 13.sp, color = MaterialTheme.colorScheme.onSurface.copy(alpha = 0.55f))
                    }
                }
                HorizontalDivider(Modifier.padding(vertical = 8.dp))
                Text("یا زمان دلخواه:", fontSize = 13.sp, color = MaterialTheme.colorScheme.onSurface.copy(alpha = 0.6f))
                Spacer(Modifier.width(4.dp))
                Box {
                    OutlinedButton(onClick = { dayMenu = true }, modifier = Modifier.fillMaxWidth().padding(top = 6.dp)) { Text(dayName(at(day, 0, 0), day)) }
                    DropdownMenu(expanded = dayMenu, onDismissRequest = { dayMenu = false }, modifier = Modifier.heightIn(max = 320.dp)) {
                        for (i in 0..maxDays) DropdownMenuItem(text = { Text(dayName(at(i, 0, 0), i)) }, onClick = { day = i; dayMenu = false })
                    }
                }
                Row(Modifier.fillMaxWidth().padding(top = 6.dp), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    // hour and minute read left to right like a clock
                    Box(Modifier.weight(1f)) {
                        OutlinedButton(onClick = { minMenu = true }, modifier = Modifier.fillMaxWidth()) { Text("دقیقه " + U.faDigits("%02d".format(minute))) }
                        DropdownMenu(expanded = minMenu, onDismissRequest = { minMenu = false }, modifier = Modifier.heightIn(max = 320.dp)) {
                            for (m in 0..55 step 5) DropdownMenuItem(text = { Text(U.faDigits("%02d".format(m))) }, onClick = { minute = m; minMenu = false })
                        }
                    }
                    Box(Modifier.weight(1f)) {
                        OutlinedButton(onClick = { hourMenu = true }, modifier = Modifier.fillMaxWidth()) { Text("ساعت " + U.faDigits("%02d".format(hour))) }
                        DropdownMenu(expanded = hourMenu, onDismissRequest = { hourMenu = false }, modifier = Modifier.heightIn(max = 320.dp)) {
                            for (h in 0..23) DropdownMenuItem(text = { Text(U.faDigits("%02d".format(h))) }, onClick = { hour = h; hourMenu = false })
                        }
                    }
                }
            }
        },
        confirmButton = { TextButton(onClick = { pick(at(day, hour, minute)) }) { Text("تنظیم") } },
        dismissButton = { TextButton(onClick = onClose) { Text("انصراف") } }
    )
}

/** The messages waiting to go out in one chat: send now, change the time, or delete. */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun ScheduledSheet(convo: String, onClose: () -> Unit) {
    val all by Engine.scheduled.collectAsState()
    val list = Engine.scheduledIn(convo, all).sortedBy { it.at }
    val feats by Engine.feats.collectAsState()
    val scope = rememberCoroutineScope()
    val ctx = LocalContext.current
    var moving by remember { mutableStateOf<Engine.Sched?>(null) }
    var menuFor by remember { mutableStateOf<Long?>(null) }
    fun run(s: Engine.Sched, what: String, at: Long? = null) = scope.launch {
        Engine.scheduledAction(s, what, at)?.let { Toast.makeText(ctx, it, Toast.LENGTH_LONG).show() }
    }
    moving?.let { s ->
        SchedulePickerDialog(feats.schedDays, s.at, "تغییر زمان ارسال", onClose = { moving = null }) { t -> moving = null; run(s, "move", t) }
    }
    ModalBottomSheet(onDismissRequest = onClose) {
        Column(Modifier.padding(horizontal = 16.dp).padding(bottom = 24.dp)) {
            Text("پیام‌های زمان‌دار", fontWeight = FontWeight.Bold, fontSize = 17.sp)
            Text("روی سرور می‌مانند و سر وقت فرستاده می‌شوند، حتی اگر گوشی خاموش باشد.", fontSize = 13.sp,
                color = MaterialTheme.colorScheme.onSurface.copy(alpha = 0.6f), modifier = Modifier.padding(vertical = 6.dp))
            if (list.isEmpty()) Text("پیامی در صف نیست", modifier = Modifier.padding(vertical = 16.dp))
            LazyColumn(Modifier.heightIn(max = 460.dp)) {
                items(list, key = { it.id }) { s ->
                    Box {
                        Row(Modifier.fillMaxWidth().clickable { menuFor = s.id }.padding(vertical = 10.dp), verticalAlignment = Alignment.CenterVertically) {
                            Icon(if (s.failed != null) SIcons.error else SIcons.clock, null, tint = if (s.failed != null) MaterialTheme.colorScheme.error else MaterialTheme.colorScheme.primary)
                            Spacer(Modifier.width(10.dp))
                            Column(Modifier.weight(1f)) {
                                Text(s.text, maxLines = 2, overflow = TextOverflow.Ellipsis)
                                Text(
                                    U.faDigits(U.fullDate(s.at)) + (if (s.silent) " · بی‌صدا" else ""),
                                    fontSize = 12.sp, color = MaterialTheme.colorScheme.onSurface.copy(alpha = 0.55f)
                                )
                                s.failed?.let { Text(Engine.schedFailText(it), fontSize = 12.sp, color = MaterialTheme.colorScheme.error) }
                            }
                            Icon(SIcons.more, null, tint = MaterialTheme.colorScheme.onSurface.copy(alpha = 0.5f))
                        }
                        DropdownMenu(expanded = menuFor == s.id, onDismissRequest = { menuFor = null }) {
                            DropdownMenuItem(leadingIcon = { Icon(SIcons.send, null) }, text = { Text("همین حالا بفرست") }, onClick = { menuFor = null; run(s, "now") })
                            DropdownMenuItem(leadingIcon = { Icon(SIcons.schedule, null) }, text = { Text("تغییر زمان") }, onClick = { menuFor = null; moving = s })
                            DropdownMenuItem(leadingIcon = { Icon(Icons.Default.Delete, null, tint = MaterialTheme.colorScheme.error) },
                                text = { Text("حذف", color = MaterialTheme.colorScheme.error) }, onClick = { menuFor = null; run(s, "delete") })
                        }
                    }
                    HorizontalDivider(color = MaterialTheme.colorScheme.onSurface.copy(alpha = 0.06f))
                }
            }
        }
    }
}

// ---------------------------------------------------------------- 1.29: @mentions

/**
 * The «@» word being typed at the end of [text] (after a space or at the start), or null.
 * Returns the part typed after «@».
 */
fun mentionQuery(text: String): String? {
    val at = text.lastIndexOf('@')
    if (at < 0) return null
    if (at > 0 && !text[at - 1].isWhitespace()) return null
    val q = text.substring(at + 1)
    if (q.any { it.isWhitespace() } || q.length > 32) return null
    return q
}

/** Replaces the «@…» being typed with the chosen username and a space. */
fun applyMention(text: String, username: String): String = text.substring(0, text.lastIndexOf('@')) + "@" + username + " "

@Composable
fun MentionPopup(convo: String, query: String, onPick: (String) -> Unit) {
    val users by Engine.users.collectAsState()
    val list = remember(convo, query, users) {
        val l = Engine.mentionCandidates(convo, query)
        if (Engine.canMentionAll(convo) && ("همه".startsWith(query) || "all".startsWith(query.lowercase()))) listOf("همه") + l else l
    }
    if (list.isEmpty()) return
    Surface(tonalElevation = 3.dp, shadowElevation = 4.dp, shape = RoundedCornerShape(14.dp), modifier = Modifier.fillMaxWidth().padding(horizontal = 8.dp, vertical = 4.dp)) {
        LazyColumn(Modifier.heightIn(max = 220.dp)) {
            items(list, key = { it }) { u ->
                Row(Modifier.fillMaxWidth().clickable { onPick(u) }.padding(horizontal = 12.dp, vertical = 8.dp), verticalAlignment = Alignment.CenterVertically) {
                    if (u == "همه") {
                        Box(Modifier.size(34.dp).clip(RoundedCornerShape(17.dp)).background(MaterialTheme.colorScheme.primary), contentAlignment = Alignment.Center) {
                            Icon(SIcons.group, null, tint = Color.White, modifier = Modifier.size(18.dp))
                        }
                        Spacer(Modifier.width(10.dp))
                        Column { Text("همه", fontWeight = FontWeight.SemiBold); Text("خبر به همهٔ اعضا، حتی اگر گروه را بی‌صدا کرده باشند", fontSize = 12.sp, color = MaterialTheme.colorScheme.onSurface.copy(alpha = 0.55f)) }
                    } else {
                        Avatar(u, false, 34)
                        Spacer(Modifier.width(10.dp))
                        Column { Text(Engine.nameOf(u), fontWeight = FontWeight.SemiBold, maxLines = 1); Text("@$u", fontSize = 12.sp, color = MaterialTheme.colorScheme.onSurface.copy(alpha = 0.55f)) }
                    }
                }
            }
        }
    }
}

// ---------------------------------------------------------------- 1.29: chat folders

/** «پوشه‌ها»: the list of my folders, their order, and whether the tab strip shows. */
@Composable
fun FoldersDialog(onClose: () -> Unit) {
    val folders by ChatList.folders.collectAsState()
    val hide by ChatList.hideTabs.collectAsState()
    var editing by remember { mutableStateOf<Folder?>(null) }
    var creating by remember { mutableStateOf(false) }
    if (creating || editing != null) {
        FolderEditDialog(editing, emptyList(), onClose = { creating = false; editing = null })
        return
    }
    AlertDialog(
        onDismissRequest = onClose,
        title = { Text("پوشه‌های گفتگو") },
        text = {
            Column(Modifier.verticalScroll(rememberScrollState())) {
                Text("گفتگوها را در پوشه‌های خودتان بچینید. پوشه‌ها روی همهٔ دستگاه‌هایتان یکی است و فقط خودتان می‌بینید.",
                    fontSize = 13.sp, color = MaterialTheme.colorScheme.onSurface.copy(alpha = 0.6f))
                Spacer(Modifier.width(6.dp))
                folders.forEachIndexed { i, f ->
                    Row(Modifier.fillMaxWidth().clickable { editing = f }.padding(vertical = 6.dp), verticalAlignment = Alignment.CenterVertically) {
                        Icon(SIcons.folder, null, tint = MaterialTheme.colorScheme.primary)
                        Spacer(Modifier.width(10.dp))
                        Column(Modifier.weight(1f)) {
                            Text(f.name, fontWeight = FontWeight.SemiBold, maxLines = 1, overflow = TextOverflow.Ellipsis)
                            Text("${U.fa(f.convos.size)} گفتگو", fontSize = 12.sp, color = MaterialTheme.colorScheme.onSurface.copy(alpha = 0.55f))
                        }
                        if (i > 0) IconButton(onClick = { ChatList.moveFolder(f.id, -1) }) { Icon(SIcons.arrowUp, "بالاتر") }
                        if (i < folders.size - 1) IconButton(onClick = { ChatList.moveFolder(f.id, 1) }) { Icon(SIcons.arrowDown, "پایین‌تر") }
                        IconButton(onClick = { ChatList.deleteFolder(f.id) }) { Icon(Icons.Default.Delete, "حذف", tint = MaterialTheme.colorScheme.error) }
                    }
                }
                if (folders.size < ChatList.MAX_FOLDERS) TextButton(onClick = { creating = true }) { Text("+ پوشهٔ تازه") }
                HorizontalDivider(Modifier.padding(vertical = 6.dp))
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Text("نمایش زبانه‌ها بالای فهرست", modifier = Modifier.weight(1f))
                    Switch(checked = !hide, onCheckedChange = { ChatList.setHideTabs(!it) })
                }
            }
        },
        confirmButton = { TextButton(onClick = onClose) { Text("بستن") } }
    )
}

/** Makes or changes one folder: its name and the chats in it. */
@Composable
fun FolderEditDialog(folder: Folder?, preselect: List<String>, onClose: () -> Unit) {
    val ctx = LocalContext.current
    var name by remember { mutableStateOf(folder?.name ?: "") }
    val chosen = remember { mutableStateListOf<String>().apply { addAll(folder?.convos ?: preselect) } }
    val chats = remember { Engine.summaries().map { it.convo } }
    AlertDialog(
        onDismissRequest = onClose,
        title = { Text(if (folder == null) "پوشهٔ تازه" else "ویرایش پوشه") },
        text = {
            Column {
                OutlinedTextField(name, { if (it.length <= ChatList.MAX_NAME) name = it }, label = { Text("نام پوشه") }, singleLine = true, modifier = Modifier.fillMaxWidth())
                Text("گفتگوها (${U.fa(chosen.size)})", fontSize = 13.sp, modifier = Modifier.padding(top = 10.dp, bottom = 4.dp),
                    color = MaterialTheme.colorScheme.onSurface.copy(alpha = 0.6f))
                LazyColumn(Modifier.heightIn(max = 340.dp)) {
                    items(chats, key = { it }) { c ->
                        Row(Modifier.fillMaxWidth().clickable { if (c in chosen) chosen.remove(c) else chosen.add(c) }.padding(vertical = 4.dp),
                            verticalAlignment = Alignment.CenterVertically) {
                            Checkbox(checked = c in chosen, onCheckedChange = { if (it) chosen.add(c) else chosen.remove(c) })
                            Avatar(c, false, 32)
                            Spacer(Modifier.width(8.dp))
                            Text(Engine.titleOf(c), maxLines = 1, overflow = TextOverflow.Ellipsis)
                        }
                    }
                }
            }
        },
        confirmButton = {
            TextButton(onClick = {
                val err = ChatList.saveFolder(folder?.id, name, chosen.toList())
                if (err != null) Toast.makeText(ctx, err, Toast.LENGTH_SHORT).show() else onClose()
            }) { Text("ذخیره") }
        },
        dismissButton = { TextButton(onClick = onClose) { Text("انصراف") } }
    )
}

/** From a chat's long-press menu: which of my folders it is in. */
@Composable
fun FolderPickDialog(convo: String, onClose: () -> Unit) {
    val folders by ChatList.folders.collectAsState()
    var creating by remember { mutableStateOf(false) }
    if (creating) { FolderEditDialog(null, listOf(convo), onClose = { creating = false }); return }
    AlertDialog(
        onDismissRequest = onClose,
        title = { Text("افزودن به پوشه") },
        text = {
            Column(Modifier.verticalScroll(rememberScrollState())) {
                if (folders.isEmpty()) Text("هنوز پوشه‌ای نساخته‌اید.", modifier = Modifier.padding(bottom = 6.dp))
                folders.forEach { f ->
                    Row(Modifier.fillMaxWidth().clickable { ChatList.toggleIn(f.id, convo) }.padding(vertical = 2.dp), verticalAlignment = Alignment.CenterVertically) {
                        Checkbox(checked = convo in f.convos, onCheckedChange = { ChatList.toggleIn(f.id, convo) })
                        Text(f.name)
                    }
                }
                if (folders.size < ChatList.MAX_FOLDERS) TextButton(onClick = { creating = true }) { Text("+ پوشهٔ تازه") }
            }
        },
        confirmButton = { TextButton(onClick = onClose) { Text("بستن") } }
    )
}
