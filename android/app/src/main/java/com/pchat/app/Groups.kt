package com.pchat.app

import android.content.Intent
import android.widget.Toast
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Checkbox
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Surface
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
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
import androidx.compose.ui.platform.LocalClipboardManager
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import kotlinx.coroutines.launch
import org.json.JSONArray
import org.json.JSONObject

/**
 * 1.20: groups users make themselves (Telegram-like). A user may own a few groups (3 by default, admin
 * panel); they add people they are connected to, or share an invite link. Owner and admins manage the group.
 */

/** Connected contacts that can be added to a group directly. */
private fun addableContacts(except: Collection<String> = emptyList()): List<String> =
    Engine.users.value.filter { it.dm && it.req == null && it.username != Engine.me && it.username !in except }
        .map { it.username }.sortedBy { Engine.nameOf(it) }

/** Checkbox list of people; returns through onDone (null = cancelled). */
@Composable
fun PickPeopleDialog(title: String, names: List<String>, okLabel: String, allowEmpty: Boolean, max: Int = 0, onDone: (List<String>?) -> Unit) {
    val picked = remember { mutableStateListOf<String>() }
    var q by remember { mutableStateOf("") }
    val ctx = LocalContext.current
    AlertDialog(
        onDismissRequest = { onDone(null) },
        title = { Text(title) },
        text = {
            Column {
                OutlinedTextField(q, { q = it }, singleLine = true, placeholder = { Text("جستجو…") }, modifier = Modifier.fillMaxWidth())
                Spacer(Modifier.height(6.dp))
                val shown = names.filter { q.isBlank() || Engine.nameOf(it).contains(q, true) || it.contains(q.lowercase()) }
                if (names.isEmpty()) Text("مخاطب متصلی برای افزودن ندارید؛ بعداً لینک دعوت بفرستید.", fontSize = 13.sp)
                LazyColumn(Modifier.heightIn(max = 360.dp)) {
                    items(shown, key = { it }) { u ->
                        Row(
                            Modifier.fillMaxWidth().clickable {
                                if (u in picked) picked.remove(u)
                                else if (max > 0 && picked.size >= max) Toast.makeText(ctx, "حداکثر $max نفر", Toast.LENGTH_SHORT).show()
                                else picked.add(u)
                            }.padding(vertical = 4.dp),
                            verticalAlignment = Alignment.CenterVertically
                        ) {
                            Checkbox(checked = u in picked, onCheckedChange = null)
                            Spacer(Modifier.width(6.dp))
                            Avatar(u, false, 34)
                            Spacer(Modifier.width(8.dp))
                            Column {
                                Text(Engine.nameOf(u), maxLines = 1, overflow = TextOverflow.Ellipsis)
                                Text("@$u", fontSize = 12.sp, color = MaterialTheme.colorScheme.onSurface.copy(alpha = 0.55f))
                            }
                        }
                    }
                }
            }
        },
        confirmButton = { TextButton(enabled = allowEmpty || picked.isNotEmpty(), onClick = { onDone(picked.toList()) }) { Text(okLabel) } },
        dismissButton = { TextButton(onClick = { onDone(null) }) { Text("انصراف") } }
    )
}

/** Name and description of a group (new, or editing an existing one). */
@Composable
private fun GroupNameDialog(title: String, okLabel: String, name0: String, about0: String, w: String = "گروه", onDone: (Pair<String, String>?) -> Unit) {
    var name by remember { mutableStateOf(name0) }
    var about by remember { mutableStateOf(about0) }
    AlertDialog(
        onDismissRequest = { onDone(null) },
        title = { Text(title) },
        text = {
            Column {
                OutlinedTextField(name, { if (it.length <= 40) name = it }, singleLine = true, label = { Text("نام $w") }, modifier = Modifier.fillMaxWidth())
                Spacer(Modifier.height(8.dp))
                OutlinedTextField(about, { if (it.length <= 255) about = it }, label = { Text("توضیح (اختیاری)") }, minLines = 2, maxLines = 5, modifier = Modifier.fillMaxWidth())
            }
        },
        confirmButton = { TextButton(enabled = name.isNotBlank(), onClick = { onDone(name.trim() to about.trim()) }) { Text(okLabel) } },
        dismissButton = { TextButton(onClick = { onDone(null) }) { Text("انصراف") } }
    )
}

/** «گروه تازه»: name and description, then members from the connected contacts. */
@Composable
fun NewGroupDialog(onClose: () -> Unit, onOpen: (String) -> Unit, chan: Boolean = false) {
    val w = if (chan) "کانال" else "گروه"
    val ctx = LocalContext.current
    val scope = rememberCoroutineScope()
    val cfg by Engine.ugCfg.collectAsState()
    var info by remember { mutableStateOf<Pair<String, String>?>(null) }
    var busy by remember { mutableStateOf(false) }
    if (chan && !cfg.chanOn) {
        AlertDialog(
            onDismissRequest = onClose, title = { Text("کانال تازه") },
            text = { Text("ساختن کانال را مدیر سرور هنوز روشن نکرده است.") },
            confirmButton = { TextButton(onClick = onClose) { Text("باشه") } }
        )
        return
    }
    if (cfg.owned >= cfg.limit) {
        AlertDialog(
            onDismissRequest = onClose, title = { Text("$w تازه") },
            text = { Text(if (cfg.limit > 0) "به حداکثر ${cfg.limit} گروه و کانالی که می‌توانید بسازید رسیده‌اید. برای ساختن $w تازه، یکی از گروه‌ها و کانال‌هایتان را حذف کنید یا به عضو دیگری بسپارید." else "مدیر سرور ساختن گروه را برای شما بسته است.") },
            confirmButton = { TextButton(onClick = onClose) { Text("باشه") } }
        )
        return
    }
    val i = info
    if (i == null) GroupNameDialog("$w تازه (${cfg.owned + 1} از ${cfg.limit})", "بعدی", "", "", w) { r -> if (r == null) onClose() else { info = r } }
    else if (!busy) PickPeopleDialog("اعضای «${i.first}»", addableContacts(), "ساختن $w", allowEmpty = true, max = ((if (chan) cfg.chanMax else cfg.maxMembers) - 1).coerceAtLeast(0)) { picked ->
        if (picked == null) { onClose(); return@PickPeopleDialog }
        busy = true
        scope.launch {
            val (r, err) = Engine.groupOp {
                Api.ugroupOp("/create", JSONObject().put("name", i.first).put("about", i.second).put("members", JSONArray(picked)).apply { if (chan) put("kind", "chan") })
            }
            busy = false
            if (err != null) { Toast.makeText(ctx, err, Toast.LENGTH_LONG).show(); onClose() }
            else { onClose(); r?.optJSONObject("group")?.optString("key")?.let { onOpen(it) } }
        }
    }
}

/** «پیوستن با لینک دعوت»: paste the link (or open it), see the group, join. */
@Composable
fun JoinGroupDialog(initial: String?, onClose: () -> Unit, onOpen: (String) -> Unit) {
    val scope = rememberCoroutineScope()
    var text by remember { mutableStateOf(initial ?: "") }
    var preview by remember { mutableStateOf<JSONObject?>(null) }
    var token by remember { mutableStateOf<String?>(null) }
    var busy by remember { mutableStateOf(false) }
    var err by remember { mutableStateOf<String?>(null) }
    fun look(t: String) {
        busy = true; err = null
        scope.launch {
            val (p, e) = Engine.joinPreview(t)
            busy = false
            if (p == null) err = e
            else if (p.optBoolean("member")) { onClose(); onOpen(p.getString("key")) }
            else { token = t; preview = p }
        }
    }
    LaunchedEffect(Unit) { initial?.let { Engine.inviteToken(it) }?.let { look(it) } }
    val p = preview
    AlertDialog(
        onDismissRequest = onClose,
        title = { Text(if (p == null) "پیوستن با لینک دعوت" else if (p.optString("kind") == "chan") "پیوستن به کانال" else "پیوستن به گروه") },
        text = {
            Column(horizontalAlignment = Alignment.CenterHorizontally, modifier = Modifier.fillMaxWidth()) {
                if (p == null) {
                    OutlinedTextField(text, { text = it; err = null }, singleLine = true, placeholder = { Text("لینک دعوت را اینجا بگذارید") }, modifier = Modifier.fillMaxWidth())
                } else {
                    Text(if (p.optString("kind") == "chan") "📢" else "👥", fontSize = 40.sp)
                    Text(p.optString("name"), fontWeight = FontWeight.Bold, fontSize = 18.sp, textAlign = TextAlign.Center)
                    Text("${p.optInt("count")} عضو", fontSize = 13.sp, color = MaterialTheme.colorScheme.onSurface.copy(alpha = 0.6f))
                    val about = p.optString("about")
                    if (about.isNotBlank()) { Spacer(Modifier.height(8.dp)); Text(about, fontSize = 14.sp, textAlign = TextAlign.Center) }
                }
                err?.let { Spacer(Modifier.height(6.dp)); Text(it, color = MaterialTheme.colorScheme.error, fontSize = 13.sp) }
            }
        },
        confirmButton = {
            TextButton(enabled = !busy, onClick = {
                if (p == null) {
                    val t = Engine.inviteToken(text)
                    if (t == null) err = "این لینک دعوت درست نیست" else look(t)
                } else {
                    busy = true
                    scope.launch {
                        val (r, e) = Engine.groupOp { Api.joinGroup(token!!) }
                        busy = false
                        if (e != null) err = e
                        else { onClose(); r?.optJSONObject("group")?.optString("key")?.let { onOpen(it) } }
                    }
                }
            }) { Text(if (p == null) "ادامه" else "پیوستن") }
        },
        dismissButton = { TextButton(onClick = onClose) { Text("انصراف") } }
    )
}

/** Full-screen info of a group a user made: description, members with roles, invite link, owner/admin tools. */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun GroupInfoScreen(convo: String, onClose: () -> Unit, onOpenUser: (String) -> Unit, onLeft: () -> Unit) {
    val ctx = LocalContext.current
    val scope = rememberCoroutineScope()
    val clipboard = LocalClipboardManager.current
    val groups by Engine.groups.collectAsState()
    val users by Engine.users.collectAsState()
    val g = groups.firstOrNull { it.key == convo }
    var details by remember { mutableStateOf<JSONObject?>(null) }
    var reload by remember { mutableStateOf(0) }
    var editing by remember { mutableStateOf(false) }
    var adding by remember { mutableStateOf(false) }
    var memberMenu by remember { mutableStateOf<String?>(null) }
    var confirm by remember { mutableStateOf<Triple<String, String, () -> Unit>?>(null) }
    var photoMenu by remember { mutableStateOf(false) }
    LaunchedEffect(g?.id, g?.members?.size, g?.invite, reload) { if (g != null) details = Engine.groupDetails(g.id) }
    fun op(okText: String? = null, after: () -> Unit = {}, block: () -> JSONObject) {
        scope.launch {
            val (_, err) = Engine.groupOp(block)
            if (err != null) Toast.makeText(ctx, err, Toast.LENGTH_LONG).show()
            else { okText?.let { Toast.makeText(ctx, it, Toast.LENGTH_SHORT).show() }; reload++; after() }
        }
    }
    val pickPhoto = rememberLauncherForActivityResult(ActivityResultContracts.GetContent()) { uri ->
        if (uri != null && g != null) scope.launch { Engine.saveGroupAvatar(g.id, uri)?.let { Toast.makeText(ctx, it, Toast.LENGTH_LONG).show() } }
    }

    Dialog(onDismissRequest = onClose, properties = DialogProperties(usePlatformDefaultWidth = false)) {
        Surface(Modifier.fillMaxSize()) {
            Scaffold(topBar = {
                TopAppBar(
                    colors = Look.barColors(),
                    navigationIcon = { IconButton(onClick = onClose) { Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = "بازگشت") } },
                    title = { Text(if (g?.isChan == true) "کانال" else "گروه") }
                )
            }) { pad ->
                if (g == null) {
                    Box(Modifier.padding(pad).fillMaxSize(), contentAlignment = Alignment.Center) { Text("عضو این گروه یا کانال نیستید") }
                    return@Scaffold
                }
                val chan = g.isChan
                val w = if (chan) "کانال" else "گروه"
                val manage = g.manages && !g.frozen
                val own = g.role == "owner" && !g.frozen
                val roles = HashMap<String, String>()
                details?.optJSONArray("roles")?.let { a -> for (k in 0 until a.length()) a.getJSONObject(k).let { roles[it.getString("username")] = it.getString("role") } }
                for (a in g.admins) if (a !in roles) roles[a] = if (a == g.owner) "owner" else "admin"
                val rank = { u: String -> when (roles[u]) { "owner" -> 0; "admin" -> 1; else -> 2 } }
                val members = g.members.sortedWith(compareBy<String>({ rank(it) }, { Engine.nameOf(it) }))
                val link = details?.optString("invite_link")?.takeIf { it.isNotBlank() && it != "null" }
                LazyColumn(Modifier.padding(pad).fillMaxSize()) {
                    item {
                        Column(Modifier.fillMaxWidth().padding(16.dp), horizontalAlignment = Alignment.CenterHorizontally) {
                            Box(Modifier.clip(CircleShape).clickable(enabled = manage) { photoMenu = true }) { Avatar(convo, false, 96) }
                            DropdownMenu(expanded = photoMenu, onDismissRequest = { photoMenu = false }) {
                                DropdownMenuItem(text = { Text("انتخاب عکس $w") }, onClick = { photoMenu = false; pickPhoto.launch("image/*") })
                                if (g.avatarVer > 0) DropdownMenuItem(text = { Text("حذف عکس", color = MaterialTheme.colorScheme.error) }, onClick = { photoMenu = false; op { Api.deleteGroupAvatar(g.id) } })
                            }
                            Spacer(Modifier.height(10.dp))
                            Text(g.name, fontWeight = FontWeight.Bold, fontSize = 20.sp, textAlign = TextAlign.Center)
                            Text("${if (chan) maxOf(g.count, g.members.size) else g.members.size} عضو" + if (g.frozen) " · معلق" else "", fontSize = 13.sp, color = MaterialTheme.colorScheme.onSurface.copy(alpha = 0.6f))
                            if (g.about.isNotBlank()) { Spacer(Modifier.height(8.dp)); Text(g.about, fontSize = 14.sp, textAlign = TextAlign.Center) }
                        }
                    }
                    if (manage) {
                        item { Section("مدیریت $w") }
                        item { ActionRow("✏️ نام و توضیح $w") { editing = true } }
                        item { ActionRow("🖼 عکس $w") { photoMenu = true } }
                        item { ActionRow("➕ افزودن عضو از مخاطبان") { adding = true } }
                        item { Section("لینک دعوت") }
                        if (link == null) item { ActionRow("🔗 ساختن لینک دعوت", "هر کس لینک را داشته باشد می‌تواند عضو شود") { op { Api.ugroupOp("/${g.id}/invite") } } }
                        else item {
                            Column(Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 6.dp)) {
                                Text("‎" + link, fontSize = 13.sp, color = MaterialTheme.colorScheme.primary)
                                Row {
                                    TextButton(onClick = { clipboard.setText(AnnotatedString(link)); Toast.makeText(ctx, "لینک کپی شد", Toast.LENGTH_SHORT).show() }) { Text("کپی") }
                                    TextButton(onClick = {
                                        val send = Intent(Intent.ACTION_SEND).setType("text/plain").putExtra(Intent.EXTRA_TEXT, "دعوت به $w «${g.name}» در ${BuildConfig.APP_NAME}:\n$link")
                                        ctx.startActivity(Intent.createChooser(send, "فرستادن لینک دعوت"))
                                    }) { Text("اشتراک") }
                                    TextButton(onClick = { op("لینک تازه ساخته شد؛ لینک قبلی دیگر کار نمی‌کند") { Api.ugroupOp("/${g.id}/invite") } }) { Text("لینک تازه") }
                                    TextButton(onClick = { op("لینک باطل شد") { Api.ugroupOp("/${g.id}/invite", JSONObject().put("revoke", true)) } }) { Text("باطل", color = MaterialTheme.colorScheme.error) }
                                }
                            }
                        }
                    }
                    if (own) {
                        item { Section("تنظیمات مالک") }
                        if (chan) item { GSwitchRow("امضای نویسنده زیر هر پست", g.sign) { v -> op { Api.ugroupOp("/${g.id}/edit", JSONObject().put("sign", v)) } } }
                        else {
                            item { GSwitchRow("فقط مدیران پیام بفرستند", g.adminsOnly) { v -> op { Api.ugroupOp("/${g.id}/edit", JSONObject().put("admins_only", v)) } } }
                            item { GSwitchRow("تماس گروهی در این گروه", g.callOn) { v -> op { Api.ugroupOp("/${g.id}/edit", JSONObject().put("call_on", v)) } } }
                        }
                    }
                    item { Section(if (chan && !g.manages) "مدیران کانال" else "اعضا (${g.members.size})") }
                    items(members, key = { it }) { u ->
                        Box {
                            Row(
                                Modifier.fillMaxWidth().clickable { memberMenu = u }.padding(horizontal = 14.dp, vertical = 8.dp),
                                verticalAlignment = Alignment.CenterVertically
                            ) {
                                Avatar(u, users.firstOrNull { it.username == u }?.online == true, 42)
                                Spacer(Modifier.width(12.dp))
                                Column(Modifier.weight(1f)) {
                                    Text(if (u == Engine.me) "شما" else Engine.nameOf(u), fontWeight = FontWeight.SemiBold, maxLines = 1, overflow = TextOverflow.Ellipsis)
                                    Text("@$u", fontSize = 12.sp, color = MaterialTheme.colorScheme.onSurface.copy(alpha = 0.55f))
                                }
                                when (roles[u]) {
                                    "owner" -> Text("مالک", fontSize = 12.sp, color = MaterialTheme.colorScheme.primary)
                                    "admin" -> Text("مدیر", fontSize = 12.sp, color = MaterialTheme.colorScheme.primary)
                                }
                            }
                            val r = roles[u] ?: "member"
                            DropdownMenu(expanded = memberMenu == u, onDismissRequest = { memberMenu = null }) {
                                if (u != Engine.me) DropdownMenuItem(text = { Text("💬 پیام") }, onClick = { memberMenu = null; onOpenUser(u) })
                                if (own && u != Engine.me && r == "member") DropdownMenuItem(text = { Text("⭐ مدیر $w شود") }, onClick = {
                                    memberMenu = null; op { Api.ugroupOp("/${g.id}/role", JSONObject().put("user", u).put("role", "admin")) }
                                })
                                if (own && u != Engine.me && r == "admin") DropdownMenuItem(text = { Text("برداشتن مدیری") }, onClick = {
                                    memberMenu = null; op { Api.ugroupOp("/${g.id}/role", JSONObject().put("user", u).put("role", "member")) }
                                })
                                if (own && u != Engine.me) DropdownMenuItem(text = { Text("👑 مالکیت $w به او برسد") }, onClick = {
                                    memberMenu = null
                                    confirm = Triple("انتقال مالکیت", "مالکیت «${g.name}» به ${Engine.nameOf(u)} برسد؟ شما مدیر $w می‌مانید.") {
                                        op("مالکیت منتقل شد") { Api.ugroupOp("/${g.id}/transfer", JSONObject().put("user", u)) }
                                    }
                                })
                                if (manage && u != Engine.me && r != "owner" && (own || r == "member")) DropdownMenuItem(
                                    text = { Text("بیرون کردن از $w", color = MaterialTheme.colorScheme.error) },
                                    onClick = {
                                        memberMenu = null
                                        confirm = Triple("بیرون کردن", "${Engine.nameOf(u)} از $w بیرون شود؟ با لینک دعوت برنمی‌گردد؛ فقط مدیران می‌توانند دوباره اضافه‌اش کنند.") {
                                            op { Api.ugroupOp("/${g.id}/remove", JSONObject().put("user", u)) }
                                        }
                                    }
                                )
                            }
                        }
                    }
                    item {
                        Column(Modifier.fillMaxWidth().padding(16.dp), horizontalAlignment = Alignment.CenterHorizontally) {
                            OutlinedButton(onClick = {
                                confirm = Triple(
                                    "ترک $w",
                                    if (g.role == "owner") "شما مالک $w هستید. اگر بروید، مالکیت به قدیمی‌ترین مدیر می‌رسد (اگر مدیری نباشد $w معلق می‌شود)." else "از «${g.name}» بیرون می‌روید."
                                ) { op(after = onLeft) { Api.ugroupOp("/${g.id}/leave") } }
                            }) { Text("ترک $w", color = MaterialTheme.colorScheme.error) }
                            if (g.role == "owner") {
                                Spacer(Modifier.height(8.dp))
                                OutlinedButton(onClick = {
                                    confirm = Triple("حذف $w", "«${g.name}» و همهٔ پیام‌هایش برای همهٔ اعضا پاک می‌شود. این کار برگشت ندارد.") {
                                        op(after = onLeft) { Api.ugroupOp("/${g.id}/delete") }
                                    }
                                }) { Text("حذف $w", color = MaterialTheme.colorScheme.error) }
                            }
                        }
                    }
                }
                if (editing) GroupNameDialog("ویرایش $w", "ذخیره", g.name, g.about, w) { r ->
                    editing = false
                    if (r != null) op { Api.ugroupOp("/${g.id}/edit", JSONObject().put("name", r.first).put("about", r.second)) }
                }
                if (adding) PickPeopleDialog("افزودن عضو", addableContacts(g.members), "افزودن", allowEmpty = false) { picked ->
                    adding = false
                    if (!picked.isNullOrEmpty()) op("اضافه شد") { Api.ugroupOp("/${g.id}/add", JSONObject().put("users", JSONArray(picked))) }
                }
                confirm?.let { (t, body, action) ->
                    AlertDialog(
                        onDismissRequest = { confirm = null },
                        title = { Text(t) }, text = { Text(body) },
                        confirmButton = { TextButton(onClick = { confirm = null; action() }) { Text(t, color = MaterialTheme.colorScheme.error) } },
                        dismissButton = { TextButton(onClick = { confirm = null }) { Text("انصراف") } }
                    )
                }
            }
        }
    }
}

@Composable
private fun Section(t: String) {
    Text(t, fontWeight = FontWeight.Bold, fontSize = 14.sp, color = MaterialTheme.colorScheme.primary, modifier = Modifier.fillMaxWidth().padding(start = 16.dp, end = 16.dp, top = 14.dp, bottom = 4.dp))
}

@Composable
private fun ActionRow(t: String, sub: String? = null, onClick: () -> Unit) {
    Column(Modifier.fillMaxWidth().clickable(onClick = onClick).padding(horizontal = 16.dp, vertical = 12.dp)) {
        Text(t, fontSize = 15.sp)
        if (sub != null) Text(sub, fontSize = 12.sp, color = MaterialTheme.colorScheme.onSurface.copy(alpha = 0.55f))
    }
    HorizontalDivider(color = MaterialTheme.colorScheme.onSurface.copy(alpha = 0.06f))
}

@Composable
private fun GSwitchRow(t: String, on: Boolean, onChange: (Boolean) -> Unit) {
    Row(Modifier.fillMaxWidth().clickable { onChange(!on) }.padding(horizontal = 16.dp, vertical = 6.dp), verticalAlignment = Alignment.CenterVertically) {
        Text(t, fontSize = 15.sp, modifier = Modifier.weight(1f))
        Switch(checked = on, onCheckedChange = onChange)
    }
}
