package com.pchat.app

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

/** Ask another user (by exact username) to connect; once they accept, both can chat. */
@Composable
fun AddContactDialog(onClose: () -> Unit) {
    val scope = rememberCoroutineScope()
    var name by remember { mutableStateOf("") }
    var busy by remember { mutableStateOf(false) }
    var msg by remember { mutableStateOf<String?>(null) }
    AlertDialog(
        onDismissRequest = onClose,
        title = { Text("افزودن مخاطب") },
        text = {
            Column {
                Text("نام کاربری دقیق شخص را وارد کنید. بعد از اینکه او درخواست را بپذیرد، می‌توانید با هم گفتگو کنید.", fontSize = 13.sp)
                Spacer(Modifier.height(10.dp))
                OutlinedTextField(
                    value = name, onValueChange = { name = it.trim().lowercase().take(20) }, singleLine = true,
                    label = { Text("نام کاربری") }, modifier = Modifier.fillMaxWidth(),
                    keyboardOptions = KeyboardOptions(capitalization = KeyboardCapitalization.None, keyboardType = KeyboardType.Ascii)
                )
                if (busy) CircularProgressIndicator(Modifier.padding(top = 8.dp).size(22.dp), strokeWidth = 2.dp)
                msg?.let { Text(it, fontSize = 13.sp, modifier = Modifier.padding(top = 8.dp)) }
            }
        },
        confirmButton = {
            TextButton(enabled = name.length >= 2 && !busy, onClick = {
                busy = true; msg = null
                scope.launch {
                    val (err, result) = Engine.contactAction("request", name)
                    busy = false
                    msg = err ?: if (result == "connected") "متصل شدید؛ $name هم برای شما درخواست فرستاده بود." else "درخواست برای $name فرستاده شد."
                }
            }) { Text("ارسال درخواست") }
        },
        dismissButton = { TextButton(onClick = onClose) { Text("بستن") } }
    )
}

/** Incoming requests (accept / decline) and my own pending requests (cancel). */
@Composable
fun RequestsDialog(onClose: () -> Unit) {
    val scope = rememberCoroutineScope()
    val incoming by Engine.incomingRequests.collectAsState()
    val outgoing by Engine.outgoingRequests.collectAsState()
    var msg by remember { mutableStateOf<String?>(null) }
    var busy by remember { mutableStateOf(false) }
    fun act(what: String, user: String, accept: Boolean = false) {
        busy = true; msg = null
        scope.launch { msg = Engine.contactAction(what, user, accept).first; busy = false }
    }
    AlertDialog(
        onDismissRequest = onClose,
        title = { Text("درخواست‌های اتصال") },
        confirmButton = { TextButton(onClick = onClose) { Text("بستن") } },
        text = {
            LazyColumn {
                item { Text("درخواست‌های رسیده", fontWeight = FontWeight.Bold, color = MaterialTheme.colorScheme.primary) }
                if (incoming.isEmpty()) item { Text("درخواستی ندارید", fontSize = 13.sp, modifier = Modifier.padding(vertical = 6.dp)) }
                items(incoming, key = { "in:" + it.username }) { r ->
                    Column(Modifier.padding(vertical = 6.dp)) {
                        Text(r.displayName?.let { "$it (${r.username})" } ?: r.username, fontWeight = FontWeight.SemiBold)
                        Text("می‌خواهد با شما در ارتباط باشد", fontSize = 12.sp, color = MaterialTheme.colorScheme.onSurface.copy(alpha = 0.6f))
                        Row {
                            TextButton(enabled = !busy, onClick = { act("respond", r.username, true) }) { Text("پذیرفتن") }
                            TextButton(enabled = !busy, onClick = { act("respond", r.username, false) }) { Text("رد کردن", color = MaterialTheme.colorScheme.error) }
                        }
                    }
                }
                if (outgoing.isNotEmpty()) {
                    item { Spacer(Modifier.height(8.dp)); Text("درخواست‌های من", fontWeight = FontWeight.Bold, color = MaterialTheme.colorScheme.primary) }
                    items(outgoing, key = { "out:" + it.username }) { r ->
                        Row(Modifier.fillMaxWidth().padding(vertical = 4.dp), verticalAlignment = Alignment.CenterVertically) {
                            Column(Modifier.weight(1f)) {
                                Text(r.username, fontWeight = FontWeight.SemiBold)
                                Text(if (r.status == "declined") "رد شد" else "در انتظار پاسخ", fontSize = 12.sp, color = MaterialTheme.colorScheme.onSurface.copy(alpha = 0.6f))
                            }
                            Spacer(Modifier.width(8.dp))
                            TextButton(enabled = !busy, onClick = { act("cancel", r.username) }) { Text(if (r.status == "declined") "حذف" else "لغو") }
                        }
                    }
                }
                msg?.let { m -> item { Text(m, fontSize = 13.sp, color = MaterialTheme.colorScheme.error, modifier = Modifier.padding(top = 8.dp)) } }
            }
        }
    )
}
