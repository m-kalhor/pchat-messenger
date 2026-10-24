package com.pchat.app

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Checkbox
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateListOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.produceState
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp

/** Pick one or more chats to forward to, like Telegram; «پنهان کردن فرستنده» sends a plain copy. */
@Composable
fun ForwardDialog(count: Int, onClose: () -> Unit, onSend: (targets: List<String>, hideSender: Boolean) -> Unit) {
    val targets = remember {
        val canDm = Engine.users.value.filter { it.dm }.map { it.username }.toSet()
        Engine.summaries().map { it.convo }.filter { Engine.isGroup(it) || it in canDm }
    }
    val picked = remember { mutableStateListOf<String>() }
    var hide by remember { mutableStateOf(false) }
    var query by remember { mutableStateOf("") }
    val shown = targets.filter { query.isBlank() || Engine.titleOf(it).contains(query.trim(), ignoreCase = true) || it.contains(query.trim().lowercase()) }
    AlertDialog(
        onDismissRequest = onClose,
        title = { Text(if (count == 1) "فوروارد پیام" else "فوروارد $count پیام") },
        text = {
            Column {
                OutlinedTextField(value = query, onValueChange = { query = it }, singleLine = true, placeholder = { Text("جستجو…") }, modifier = Modifier.fillMaxWidth())
                LazyColumn(Modifier.heightIn(max = 340.dp).padding(top = 6.dp)) {
                    items(shown, key = { it }) { c ->
                        Row(
                            Modifier.fillMaxWidth().clickable { if (c in picked) picked.remove(c) else picked.add(c) }.padding(vertical = 4.dp),
                            verticalAlignment = Alignment.CenterVertically
                        ) {
                            Checkbox(checked = c in picked, onCheckedChange = { if (it) picked.add(c) else picked.remove(c) })
                            Avatar(c, false, 34)
                            Spacer(Modifier.width(8.dp))
                            Text(Engine.titleOf(c), maxLines = 1, overflow = TextOverflow.Ellipsis)
                        }
                    }
                }
                HorizontalDivider(Modifier.padding(vertical = 4.dp))
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Column(Modifier.weight(1f)) {
                        Text("پنهان کردن فرستنده", fontSize = 15.sp)
                        Text("پیام بدون «فوروارد از …» فرستاده می‌شود", fontSize = 12.sp, color = MaterialTheme.colorScheme.onSurface.copy(alpha = 0.6f))
                    }
                    Switch(checked = hide, onCheckedChange = { hide = it })
                }
            }
        },
        confirmButton = { TextButton(enabled = picked.isNotEmpty(), onClick = { onSend(picked.toList(), hide) }) { Text("ارسال") } },
        dismissButton = { TextButton(onClick = onClose) { Text("انصراف") } }
    )
}

/** «اطلاعات پیام»: full send and edit date; for my own messages also the earlier versions (only I can see them). */
@Composable
fun MessageInfoDialog(m: Msg, onClose: () -> Unit) {
    val history by produceState<List<Pair<String, Long>>?>(null, m.id, m.edited) {
        value = if (m.mine && m.edited > 0) Engine.editHistory(m) else emptyList()
    }
    AlertDialog(
        onDismissRequest = onClose,
        title = { Text("اطلاعات پیام") },
        text = {
            Column(Modifier.verticalScroll(rememberScrollState()), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                Text("ارسال: " + U.fullDate(m.ts), fontSize = 14.sp)
                if (m.edited > 0) Text("آخرین ویرایش: " + U.fullDate(m.edited), fontSize = 14.sp)
                if (m.fwFrom != null) Text("فوروارد از: " + (m.fwName?.takeIf { it.isNotBlank() } ?: m.fwFrom), fontSize = 14.sp)
                val h = history
                if (m.mine && m.edited > 0) {
                    HorizontalDivider(Modifier.padding(vertical = 4.dp))
                    Text("نسخه‌های قبلی (فقط شما می‌بینید)", fontWeight = FontWeight.SemiBold, fontSize = 14.sp)
                    when {
                        h == null -> Text("در حال دریافت…", fontSize = 13.sp)
                        h.isEmpty() -> Text("نسخهٔ قبلی‌ای ذخیره نشده", fontSize = 13.sp)
                        else -> h.asReversed().forEach { (text, ts) ->
                            Column(Modifier.padding(vertical = 2.dp)) {
                                Text(text, fontSize = 14.sp)
                                Text("تا " + U.fullDate(ts), fontSize = 11.sp, color = MaterialTheme.colorScheme.onSurface.copy(alpha = 0.6f))
                            }
                        }
                    }
                }
            }
        },
        confirmButton = { TextButton(onClick = onClose) { Text("بستن") } }
    )
}
