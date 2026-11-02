package com.pchat.app

import android.Manifest
import android.content.pm.PackageManager
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.ui.platform.LocalContext
import androidx.core.content.ContextCompat
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardCapitalization
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import kotlinx.coroutines.launch

/**
 * Write to anyone by exact @username (1.7: a message request until they accept), find someone by mobile
 * number, or find the members among the phone's contacts (the numbers are only matched on the server,
 * never kept).
 */
@Composable
fun AddContactDialog(onClose: () -> Unit, onOpen: (String) -> Unit = {}) {
    val scope = rememberCoroutineScope()
    val ctx = LocalContext.current
    var name by remember { mutableStateOf("") }
    var busy by remember { mutableStateOf(false) }
    var msg by remember { mutableStateOf<String?>(null) }
    var found by remember { mutableStateOf<List<Engine.Found>?>(null) }
    var sent by remember { mutableStateOf(setOf<String>()) }

    /** Opens the chat with a member (a stranger is found first; then it is a message request). */
    fun message(user: String) {
        busy = true; msg = null
        scope.launch {
            val (u, err) = Engine.findUser(user)
            busy = false
            if (u != null) { onClose(); onOpen(u) } else msg = err
        }
    }
    fun request(user: String) {
        busy = true; msg = null
        scope.launch {
            val (err, result) = Engine.contactAction("request", user)
            busy = false
            if (err == null) sent = sent + user
            msg = err ?: if (result == "connected") "متصل شدید؛ $user هم برای شما درخواست فرستاده بود." else "درخواست برای $user فرستاده شد."
        }
    }
    fun scanContacts() {
        busy = true; msg = null
        scope.launch {
            val nums = withContext(Dispatchers.IO) { try { Engine.phoneContacts() } catch (e: Exception) { emptyList() } }
            if (nums.isEmpty()) { busy = false; msg = "شماره‌ای در مخاطبان گوشی پیدا نشد."; return@launch }
            val (list, err) = Engine.lookup(nums)
            busy = false
            if (err != null) msg = err
            else { found = list; if (list.isNullOrEmpty()) msg = "هیچ‌کدام از مخاطبان گوشی (یا کسی که پیدا شدن با شماره را روشن گذاشته) در سپن نیست." }
        }
    }
    val permission = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { ok ->
        if (ok) scanContacts() else msg = "بدون اجازهٔ دسترسی به مخاطبان نمی‌شود آن‌ها را جستجو کرد."
    }
    val isPhone = name.isNotEmpty() && name.all { it.isDigit() || it == '+' || it in '۰'..'۹' || it == ' ' }
    val uname = name.removePrefix("@")

    AlertDialog(
        onDismissRequest = onClose,
        title = { Text("افزودن مخاطب") },
        text = {
            LazyColumn {
                item {
                    Text("نام کاربری (مثل @mostafa) یا شمارهٔ موبایل شخص را وارد کنید. به کسی که در مخاطبانتان نیست هم می‌شود پیام داد؛ تا وقتی بپذیرد، پیام‌ها در «درخواست‌ها»ی او می‌مانند.", fontSize = 13.sp)
                    Spacer(Modifier.height(10.dp))
                    OutlinedTextField(
                        value = name, onValueChange = { name = it.trim().lowercase().take(21) }, singleLine = true,
                        label = { Text("@نام‌کاربری یا شمارهٔ موبایل") }, modifier = Modifier.fillMaxWidth(),
                        keyboardOptions = KeyboardOptions(capitalization = KeyboardCapitalization.None, keyboardType = KeyboardType.Ascii)
                    )
                    TextButton(enabled = !busy, onClick = {
                        val granted = ContextCompat.checkSelfPermission(ctx, Manifest.permission.READ_CONTACTS) == PackageManager.PERMISSION_GRANTED
                        if (granted) scanContacts() else permission.launch(Manifest.permission.READ_CONTACTS)
                    }) { Text("پیدا کردن از مخاطبان گوشی") }
                    if (busy) CircularProgressIndicator(Modifier.padding(top = 4.dp).size(22.dp), strokeWidth = 2.dp)
                    msg?.let { Text(it, fontSize = 13.sp, modifier = Modifier.padding(top = 8.dp)) }
                }
                found?.let { list ->
                    if (list.isNotEmpty()) item {
                        Text("در سپن هستند", fontWeight = FontWeight.Bold, color = MaterialTheme.colorScheme.primary, modifier = Modifier.padding(top = 10.dp))
                    }
                    items(list, key = { "f:" + it.username }) { f ->
                        Row(Modifier.fillMaxWidth().padding(vertical = 4.dp), verticalAlignment = Alignment.CenterVertically) {
                            Column(Modifier.weight(1f)) {
                                Text(f.name ?: f.displayName ?: f.username, fontWeight = FontWeight.SemiBold)
                                Text(listOfNotNull(f.displayName?.takeIf { it != f.name }, f.username).joinToString(" · "), fontSize = 12.sp,
                                    color = MaterialTheme.colorScheme.onSurface.copy(alpha = 0.6f))
                            }
                            when {
                                f.connected -> TextButton(enabled = !busy, onClick = { message(f.username) }) { Text("گفتگو") }
                                f.username in sent -> Text("فرستاده شد", fontSize = 12.sp)
                                else -> Row {
                                    TextButton(enabled = !busy, onClick = { message(f.username) }) { Text("پیام") }
                                    TextButton(enabled = !busy, onClick = { request(f.username) }) { Text("درخواست") }
                                }
                            }
                        }
                    }
                }
            }
        },
        confirmButton = {
            TextButton(enabled = uname.length >= 2 && !busy, onClick = {
                if (!isPhone) { message(uname); return@TextButton }
                busy = true; msg = null
                scope.launch {
                    val (list, err) = Engine.lookup(listOf(name to null))
                    busy = false
                    when {
                        err != null -> msg = err
                        list.isNullOrEmpty() -> msg = "کسی با این شماره در سپن پیدا نشد (یا پیدا شدن با شماره را خاموش کرده)."
                        else -> found = list
                    }
                }
            }) { Text(if (isPhone) "جستجو" else "پیام دادن") }
        },
        dismissButton = { TextButton(onClick = onClose) { Text("بستن") } }
    )
}

/**
 * Message and connection requests (1.7): new ones (read the messages, accept, decline, block), the ones I
 * declined (can still be accepted), the people I blocked (unblock) and my own (cancel; a decline is not shown).
 */
@Composable
fun RequestsDialog(onClose: () -> Unit, onOpen: (String) -> Unit = {}) {
    val scope = rememberCoroutineScope()
    val incoming by Engine.incomingRequests.collectAsState()
    val declined by Engine.declinedRequests.collectAsState()
    val blocked by Engine.blockedRequests.collectAsState()
    val outgoing by Engine.outgoingRequests.collectAsState()
    var msg by remember { mutableStateOf<String?>(null) }
    var busy by remember { mutableStateOf(false) }
    fun act(what: String, user: String, accept: Boolean = false) {
        busy = true; msg = null
        scope.launch { msg = Engine.contactAction(what, user, accept).first; busy = false }
    }
    val dim = MaterialTheme.colorScheme.onSurface.copy(alpha = 0.6f)
    fun detail(r: ContactRequest) = listOfNotNull(
        if (r.msgs > 0) "${r.msgs} پیام" else null,
        if (r.calls > 0) "📞 ${r.calls} تماس بی‌پاسخ" else null
    ).joinToString(" · ").ifEmpty { "می‌خواهد با شما در ارتباط باشد" }
    @Composable
    fun head(t: String) = Text(t, fontWeight = FontWeight.Bold, color = MaterialTheme.colorScheme.primary, modifier = Modifier.padding(top = 8.dp))
    AlertDialog(
        onDismissRequest = onClose,
        title = { Text("درخواست‌ها") },
        confirmButton = { TextButton(onClick = onClose) { Text("بستن") } },
        text = {
            LazyColumn {
                item { head("درخواست‌های تازه") }
                if (incoming.isEmpty()) item { Text("درخواستی ندارید", fontSize = 13.sp, modifier = Modifier.padding(vertical = 6.dp)) }
                items(incoming, key = { "in:" + it.username }) { r ->
                    Column(Modifier.padding(vertical = 6.dp)) {
                        Text(r.displayName?.let { "$it (@${r.username})" } ?: "@" + r.username, fontWeight = FontWeight.SemiBold)
                        Text(detail(r), fontSize = 12.sp, color = dim)
                        Row {
                            if (r.msgs > 0) TextButton(enabled = !busy, onClick = { onClose(); onOpen(r.username) }) { Text("دیدن پیام‌ها") }
                            TextButton(enabled = !busy, onClick = { act("respond", r.username, true) }) { Text("پذیرفتن") }
                            TextButton(enabled = !busy, onClick = { act("respond", r.username, false) }) { Text("رد") }
                            TextButton(enabled = !busy, onClick = { act("block", r.username) }) { Text("مسدود", color = MaterialTheme.colorScheme.error) }
                        }
                    }
                }
                if (declined.isNotEmpty()) {
                    item { head("رد شده‌ها (هنوز می‌شود پذیرفت)") }
                    items(declined, key = { "de:" + it.username }) { r ->
                        Column(Modifier.padding(vertical = 4.dp)) {
                            Text(r.displayName?.let { "$it (@${r.username})" } ?: "@" + r.username, fontWeight = FontWeight.SemiBold)
                            Text(detail(r), fontSize = 12.sp, color = dim)
                            Row {
                                if (r.msgs > 0) TextButton(enabled = !busy, onClick = { onClose(); onOpen(r.username) }) { Text("دیدن پیام‌ها") }
                                TextButton(enabled = !busy, onClick = { act("respond", r.username, true) }) { Text("پذیرفتن") }
                                TextButton(enabled = !busy, onClick = { act("block", r.username) }) { Text("مسدود", color = MaterialTheme.colorScheme.error) }
                            }
                        }
                    }
                }
                if (blocked.isNotEmpty()) {
                    item { head("مسدود شده‌ها") }
                    items(blocked, key = { "bl:" + it.username }) { r ->
                        Row(Modifier.fillMaxWidth().padding(vertical = 4.dp), verticalAlignment = Alignment.CenterVertically) {
                            Text(r.displayName?.let { "$it (@${r.username})" } ?: "@" + r.username, fontWeight = FontWeight.SemiBold, modifier = Modifier.weight(1f))
                            TextButton(enabled = !busy, onClick = { act("unblock", r.username) }) { Text("رفع مسدودی") }
                        }
                    }
                }
                if (outgoing.isNotEmpty()) {
                    item { head("فرستاده‌شده") }
                    items(outgoing, key = { "out:" + it.username }) { r ->
                        Row(Modifier.fillMaxWidth().padding(vertical = 4.dp), verticalAlignment = Alignment.CenterVertically) {
                            Column(Modifier.weight(1f)) {
                                Text("@" + r.username, fontWeight = FontWeight.SemiBold)
                                Text("در انتظار پذیرفتن" + if (r.msgs > 0) " · ${r.msgs} پیام" else "", fontSize = 12.sp, color = dim)
                            }
                            Spacer(Modifier.width(8.dp))
                            TextButton(enabled = !busy, onClick = { act("cancel", r.username) }) { Text("لغو") }
                        }
                    }
                }
                msg?.let { m -> item { Text(m, fontSize = 13.sp, color = MaterialTheme.colorScheme.error, modifier = Modifier.padding(top = 8.dp)) } }
            }
        }
    )
}
