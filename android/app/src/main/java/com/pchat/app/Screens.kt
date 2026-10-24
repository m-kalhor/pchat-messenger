package com.pchat.app

import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.MoreVert
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.produceState
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.ImageBitmap
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardCapitalization
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import kotlinx.coroutines.launch

@Composable
fun Avatar(name: String, online: Boolean, size: Int = 48) {
    val group = Engine.isGroup(name)
    val users by Engine.users.collectAsState()
    val ver = if (group) 0 else (users.firstOrNull { it.username == name }?.avatarVer ?: 0)
    val bmp by produceState<ImageBitmap?>(null, name, ver) {
        value = if (ver > 0) Engine.avatarBitmap(name, ver) else null
    }
    Box(Modifier.size(size.dp)) {
        Box(
            Modifier.size(size.dp).clip(CircleShape).background(if (group) MaterialTheme.colorScheme.primary else U.colorFor(name)),
            contentAlignment = Alignment.Center
        ) {
            val b = bmp
            if (b != null) {
                Image(b, contentDescription = null, modifier = Modifier.fillMaxSize(), contentScale = ContentScale.Crop)
            } else {
                val label = if (group) "👥" else Engine.nameOf(name).take(1).uppercase()
                Text(label, color = Color.White, fontSize = (size * 0.42).sp, fontWeight = FontWeight.Bold)
            }
        }
        if (online) {
            Box(
                Modifier.align(Alignment.BottomEnd).size((size * 0.28).dp).clip(CircleShape)
                    .background(MaterialTheme.colorScheme.surface).padding(2.dp).clip(CircleShape).background(Color(0xFF4CD964))
            )
        }
    }
}

@Composable
fun LoginScreen() {
    val scope = rememberCoroutineScope()
    var user by remember { mutableStateOf("") }
    var pass by remember { mutableStateOf("") }
    var busy by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }

    Column(
        Modifier.fillMaxSize().background(MaterialTheme.colorScheme.background).padding(28.dp),
        verticalArrangement = Arrangement.Center,
        horizontalAlignment = Alignment.CenterHorizontally
    ) {
        Box(Modifier.size(96.dp).clip(CircleShape).background(MaterialTheme.colorScheme.primary), contentAlignment = Alignment.Center) {
            Text("✉", color = Color.White, fontSize = 44.sp)
        }
        Spacer(Modifier.height(20.dp))
        Text("ورود به سپن", fontSize = 22.sp, fontWeight = FontWeight.Bold, color = MaterialTheme.colorScheme.onBackground)
        Spacer(Modifier.height(6.dp))
        Text("نام کاربری و رمز را مدیر سرور به شما داده است", fontSize = 13.sp, color = MaterialTheme.colorScheme.onBackground.copy(alpha = 0.6f))
        Spacer(Modifier.height(24.dp))
        OutlinedTextField(
            value = user, onValueChange = { user = it }, singleLine = true, label = { Text("نام کاربری") },
            keyboardOptions = KeyboardOptions(capitalization = KeyboardCapitalization.None, keyboardType = KeyboardType.Ascii),
            modifier = Modifier.fillMaxWidth()
        )
        Spacer(Modifier.height(12.dp))
        OutlinedTextField(
            value = pass, onValueChange = { pass = it }, singleLine = true, label = { Text("رمز عبور") },
            visualTransformation = PasswordVisualTransformation(),
            keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Password),
            modifier = Modifier.fillMaxWidth()
        )
        error?.let {
            Spacer(Modifier.height(10.dp))
            Text(it, color = MaterialTheme.colorScheme.error, fontSize = 13.sp)
        }
        Spacer(Modifier.height(20.dp))
        Button(
            onClick = {
                busy = true; error = null
                scope.launch {
                    error = Engine.login(user, pass)
                    busy = false
                }
            },
            enabled = !busy && user.isNotBlank() && pass.isNotEmpty(),
            modifier = Modifier.fillMaxWidth().height(50.dp)
        ) {
            if (busy) CircularProgressIndicator(Modifier.size(22.dp), color = Color.White, strokeWidth = 2.dp) else Text("ورود")
        }
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun ChatListScreen(onOpen: (String) -> Unit, onSettings: () -> Unit, onLogout: () -> Unit) {
    val tick by Engine.tick.collectAsState()
    val users by Engine.users.collectAsState()
    val connected by Engine.connected.collectAsState()
    val rows = remember(tick, users) { Engine.summaries() }
    var menu by remember { mutableStateOf(false) }
    var addContact by remember { mutableStateOf(false) }
    var showRequests by remember { mutableStateOf(false) }
    val incoming by Engine.incomingRequests.collectAsState()

    Scaffold(
        topBar = {
            TopAppBar(
                title = {
                    Column {
                        Text("سپن", fontWeight = FontWeight.Bold)
                        Text(if (connected) "متصل" else "در حال اتصال…", fontSize = 12.sp, color = MaterialTheme.colorScheme.onSurface.copy(alpha = 0.6f))
                    }
                },
                actions = {
                    IconButton(onClick = { menu = true }) { Icon(Icons.Default.MoreVert, contentDescription = "منو") }
                    DropdownMenu(expanded = menu, onDismissRequest = { menu = false }) {
                        DropdownMenuItem(text = { Text("افزودن مخاطب") }, onClick = { menu = false; addContact = true })
                        DropdownMenuItem(text = { Text("درخواست‌های اتصال" + if (incoming.isNotEmpty()) " (${incoming.size})" else "") }, onClick = { menu = false; showRequests = true })
                        DropdownMenuItem(text = { Text("تنظیمات") }, onClick = { menu = false; onSettings() })
                        DropdownMenuItem(text = { Text("خروج از حساب") }, onClick = { menu = false; onLogout() })
                    }
                }
            )
        }
    ) { pad ->
        LazyColumn(Modifier.padding(pad).fillMaxSize()) {
            if (incoming.isNotEmpty()) item(key = "requests") {
                Row(
                    Modifier.fillMaxWidth().clickable { showRequests = true }.background(MaterialTheme.colorScheme.primary.copy(alpha = 0.12f))
                        .padding(horizontal = 16.dp, vertical = 12.dp),
                    verticalAlignment = Alignment.CenterVertically
                ) {
                    Text("👋", fontSize = 22.sp)
                    Spacer(Modifier.width(12.dp))
                    Text("${incoming.size} درخواست اتصال تازه", fontWeight = FontWeight.SemiBold, modifier = Modifier.weight(1f))
                    Text("مشاهده", color = MaterialTheme.colorScheme.primary)
                }
            }
            items(rows, key = { it.convo }) { r ->
              Column {
                val online = users.firstOrNull { it.username == r.convo }?.online ?: false
                Row(
                    Modifier.fillMaxWidth().clickable { onOpen(r.convo) }.padding(horizontal = 14.dp, vertical = 10.dp),
                    verticalAlignment = Alignment.CenterVertically
                ) {
                    Avatar(r.convo, online)
                    Spacer(Modifier.width(12.dp))
                    Column(Modifier.weight(1f)) {
                        Row(verticalAlignment = Alignment.CenterVertically) {
                            Text(Engine.titleOf(r.convo), fontWeight = FontWeight.SemiBold, fontSize = 16.sp, modifier = Modifier.weight(1f))
                            r.last?.let { Text(U.time(it.ts), fontSize = 12.sp, color = MaterialTheme.colorScheme.onSurface.copy(alpha = 0.5f)) }
                        }
                        Row(verticalAlignment = Alignment.CenterVertically) {
                            val prev = r.last?.let { (if (Engine.isGroup(r.convo) && !it.mine) Engine.nameOf(it.sender) + ": " else if (it.mine) "شما: " else "") + U.preview(it) } ?: "هنوز پیامی نیست"
                            Text(prev, maxLines = 1, overflow = TextOverflow.Ellipsis, fontSize = 14.sp,
                                color = MaterialTheme.colorScheme.onSurface.copy(alpha = 0.6f), modifier = Modifier.weight(1f))
                            if (r.unread > 0) {
                                Box(Modifier.padding(start = 8.dp).clip(CircleShape).background(MaterialTheme.colorScheme.primary).padding(horizontal = 7.dp, vertical = 2.dp)) {
                                    Text(r.unread.toString(), color = Color.White, fontSize = 12.sp)
                                }
                            }
                        }
                    }
                }
                HorizontalDivider(Modifier.padding(start = 74.dp), color = MaterialTheme.colorScheme.onSurface.copy(alpha = 0.08f))
              }
            }
        }
    }
    if (addContact) AddContactDialog { addContact = false }
    if (showRequests) RequestsDialog { showRequests = false }
}

/** Shows key fingerprints so users can verify each other out-of-band (protects against a malicious server swapping keys). */
@Composable
fun KeysDialog(contacts: List<String>, onClose: () -> Unit) {
    val users by Engine.users.collectAsState()
    AlertDialog(
        onDismissRequest = onClose,
        confirmButton = { TextButton(onClick = onClose) { Text("بستن") } },
        title = { Text("اثرانگشت امنیتی") },
        text = {
            LazyColumn {
                item {
                  Column {
                    Text(
                        "برای مطمئن شدن از اینکه پیام‌ها فقط بین شما و طرف مقابل رمزگشایی می‌شوند، اثرانگشت‌ها را حضوری یا از طریق یک راه مطمئن دیگر مقایسه کنید. هر دو باید دقیقاً یکی ببینید.",
                        fontSize = 13.sp
                    )
                    Spacer(Modifier.height(12.dp))
                    Text("اثرانگشت شما (${Engine.me})", fontWeight = FontWeight.Bold, fontSize = 13.sp)
                    Text(Crypto.fingerprint(Engine.identity!!.pubB64), fontSize = 14.sp, fontFamily = androidx.compose.ui.text.font.FontFamily.Monospace)
                    Spacer(Modifier.height(10.dp))
                  }
                }
                items(contacts) { c ->
                  Column {
                    val pub = users.firstOrNull { it.username == c }?.pubkey
                    Text(Engine.nameOf(c) + (if (Engine.nameOf(c) != c) " ($c)" else ""), fontWeight = FontWeight.Bold, fontSize = 13.sp)
                    Text(
                        if (pub != null) Crypto.fingerprint(pub) else "هنوز وارد نشده",
                        fontSize = 14.sp, fontFamily = androidx.compose.ui.text.font.FontFamily.Monospace
                    )
                    Spacer(Modifier.height(10.dp))
                  }
                }
            }
        }
    )
}
