package com.pchat.app

import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.clickable
import androidx.compose.foundation.combinedClickable
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
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
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
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import android.widget.Toast
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.ui.platform.LocalContext

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

/**
 * Sign-in by mobile number: an SMS code, or (SMS down / no internet) a code from another signed-in
 * device of the user or from the admin. Username + password stays as a second way while the admin allows it.
 */
@Composable
fun LoginScreen() {
    val scope = rememberCoroutineScope()
    var cfgSms by remember { mutableStateOf(true) }
    var cfgPassword by remember { mutableStateOf(true) }
    var byPassword by remember { mutableStateOf(false) }
    var codeStep by remember { mutableStateOf(false) }
    var phone by remember { mutableStateOf("") }
    var code by remember { mutableStateOf("") }
    var user by remember { mutableStateOf("") }
    var pass by remember { mutableStateOf("") }
    var busy by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }
    var info by remember { mutableStateOf<String?>(null) }
    var wait by remember { mutableStateOf(0) }
    LaunchedEffect(Unit) {
        Engine.authConfig()?.let { c ->
            cfgSms = c.optBoolean("sms", true)
            cfgPassword = c.optBoolean("password", true)
            if (!cfgSms) { codeStep = true; info = "کد ۶ رقمی را که روی دستگاه دیگرتان (تنظیمات › ورود دستگاه تازه) یا از مدیر گرفته‌اید وارد کنید." }
        }
    }
    LaunchedEffect(wait) { if (wait > 0) { delay(1000); wait-- } }

    fun sendSms() {
        if (phone.isBlank()) { error = "شمارهٔ موبایل را وارد کنید"; return }
        busy = true; error = null
        scope.launch {
            val (err, w) = Engine.requestSms(phone)
            busy = false
            when {
                err == null -> { codeStep = true; wait = w; info = "کد ۵ رقمی به ${phone.trim()} پیامک شد." }
                w > 0 -> { codeStep = true; wait = w; error = err }
                err == SMS_DOWN -> { codeStep = true; error = err }
                else -> error = err
            }
        }
    }
    val link: @Composable (String, () -> Unit) -> Unit = { text, onClick ->
        TextButton(onClick = { error = null; onClick() }, enabled = !busy) { Text(text, fontSize = 14.sp) }
    }

    Column(
        Modifier.fillMaxSize().background(MaterialTheme.colorScheme.background).verticalScroll(rememberScrollState()).padding(28.dp),
        verticalArrangement = Arrangement.Center,
        horizontalAlignment = Alignment.CenterHorizontally
    ) {
        Spacer(Modifier.height(24.dp))
        Box(Modifier.size(96.dp).clip(CircleShape).background(MaterialTheme.colorScheme.primary), contentAlignment = Alignment.Center) {
            Text("✉", color = Color.White, fontSize = 44.sp)
        }
        Spacer(Modifier.height(20.dp))
        Text("ورود به سپن", fontSize = 22.sp, fontWeight = FontWeight.Bold, color = MaterialTheme.colorScheme.onBackground)
        Spacer(Modifier.height(6.dp))
        Text(
            if (byPassword) "نام کاربری و رمز را مدیر سرور به شما داده است" else "با شمارهٔ موبایلی که مدیر برای شما ثبت کرده",
            fontSize = 13.sp, color = MaterialTheme.colorScheme.onBackground.copy(alpha = 0.6f)
        )
        Spacer(Modifier.height(24.dp))
        if (byPassword) {
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
        } else {
            OutlinedTextField(
                value = phone, onValueChange = { phone = it }, singleLine = true, label = { Text("شمارهٔ موبایل") },
                keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Phone),
                modifier = Modifier.fillMaxWidth()
            )
            if (codeStep) {
                Spacer(Modifier.height(12.dp))
                OutlinedTextField(
                    value = code, onValueChange = { v -> code = v.filter { it.isDigit() }.take(8) }, singleLine = true, label = { Text("کد") },
                    keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.NumberPassword),
                    modifier = Modifier.fillMaxWidth()
                )
            }
            info?.let {
                Spacer(Modifier.height(8.dp))
                Text(it, fontSize = 13.sp, color = MaterialTheme.colorScheme.onBackground.copy(alpha = 0.7f), textAlign = TextAlign.Center)
            }
        }
        error?.let {
            Spacer(Modifier.height(10.dp))
            Text(it, color = MaterialTheme.colorScheme.error, fontSize = 13.sp, textAlign = TextAlign.Center)
        }
        Spacer(Modifier.height(20.dp))
        val sendStep = !byPassword && !codeStep
        Button(
            onClick = {
                if (sendStep) sendSms()
                else {
                    busy = true; error = null
                    scope.launch {
                        error = if (byPassword) Engine.login(user, pass) else Engine.codeLogin(phone, code)
                        busy = false
                    }
                }
            },
            enabled = !busy && when {
                byPassword -> user.isNotBlank() && pass.isNotEmpty()
                sendStep -> phone.isNotBlank()
                else -> phone.isNotBlank() && code.length >= 5
            },
            modifier = Modifier.fillMaxWidth().height(50.dp)
        ) {
            if (busy) CircularProgressIndicator(Modifier.size(22.dp), color = Color.White, strokeWidth = 2.dp)
            else Text(if (sendStep) "ارسال کد پیامکی" else "ورود")
        }
        Spacer(Modifier.height(8.dp))
        if (!byPassword) {
            if (codeStep && cfgSms) {
                TextButton(onClick = { sendSms() }, enabled = !busy && wait <= 0) {
                    Text(if (wait > 0) "ارسال دوباره ($wait)" else "ارسال دوباره", fontSize = 14.sp)
                }
                link("پیامک نرسید؟") {
                    info = "اگر پیامک نمی‌رسد، روی دستگاه دیگری که واردش هستید «تنظیمات › ورود دستگاه تازه» را بزنید و کد ۶ رقمی آن را همین‌جا وارد کنید، یا از مدیر سرور «کد ورود» بخواهید."
                }
                link("تغییر شماره") { codeStep = false; code = ""; info = null }
            }
            if (!codeStep) link("کد را دارم (از دستگاه دیگر یا مدیر)") {
                codeStep = true
                info = "کد ۶ رقمی را که روی دستگاه دیگرتان (تنظیمات › ورود دستگاه تازه) یا از مدیر گرفته‌اید وارد کنید."
            }
            if (cfgPassword) link("ورود با نام کاربری و رمز") { byPassword = true }
        } else if (cfgSms || !cfgPassword) {
            link("ورود با شمارهٔ موبایل") { byPassword = false }
        }
        Spacer(Modifier.height(24.dp))
    }
}

@OptIn(ExperimentalMaterial3Api::class, ExperimentalFoundationApi::class)
@Composable
fun ChatListScreen(onOpen: (String) -> Unit, onSettings: () -> Unit, onLogout: () -> Unit) {
    val ctx = LocalContext.current
    val tick by Engine.tick.collectAsState()
    val users by Engine.users.collectAsState()
    val connected by Engine.connected.collectAsState()
    val chatTick by Prefs.chatTick.collectAsState()
    val receipts by Engine.receipts.collectAsState()
    val hideSeen by Engine.hideSeen.collectAsState()
    val typing by Engine.typing.collectAsState()
    val gtyping by Engine.gtyping.collectAsState()
    var now by remember { mutableStateOf(System.currentTimeMillis()) }
    LaunchedEffect(typing, gtyping) { now = System.currentTimeMillis(); delay(4600); now = System.currentTimeMillis() }
    val pinned = remember(chatTick) { Prefs.pinnedChats() }
    val rows = remember(tick, users, pinned) {
        val all = Engine.summaries()
        pinned.mapNotNull { p -> all.firstOrNull { it.convo == p } } + all.filter { it.convo !in pinned }
    }
    var rowMenu by remember { mutableStateOf<String?>(null) }
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
                val isPinned = r.convo in pinned
                val draft = remember(chatTick, r.convo) { Prefs.draft(r.convo) }
                val group = Engine.isGroup(r.convo)
                val typers = if (group) Engine.typingIn(r.convo, now) else emptyList()
                val typingNow = if (group) typers.isNotEmpty() else now - (typing[r.convo] ?: 0L) < 4500
                Box {
                Row(
                    Modifier.fillMaxWidth().combinedClickable(onClick = { onOpen(r.convo) }, onLongClick = { rowMenu = r.convo })
                        .padding(horizontal = 14.dp, vertical = 10.dp),
                    verticalAlignment = Alignment.CenterVertically
                ) {
                    Avatar(r.convo, online)
                    Spacer(Modifier.width(12.dp))
                    Column(Modifier.weight(1f)) {
                        Row(verticalAlignment = Alignment.CenterVertically) {
                            Text(Engine.titleOf(r.convo), fontWeight = FontWeight.SemiBold, fontSize = 16.sp, modifier = Modifier.weight(1f),
                                maxLines = 1, overflow = TextOverflow.Ellipsis)
                            val last = r.last
                            val t = last?.let { Engine.tickOf(it, receipts).also { hideSeen } }
                            if (t != null) Text(
                                if (t == "seen") "✓✓ " else "✓ ", fontSize = 12.sp, fontWeight = FontWeight.Bold,
                                color = if (t == "sent") MaterialTheme.colorScheme.onSurface.copy(alpha = 0.45f) else MaterialTheme.colorScheme.primary
                            )
                            last?.let { Text(U.time(it.ts), fontSize = 12.sp, color = MaterialTheme.colorScheme.onSurface.copy(alpha = 0.5f)) }
                        }
                        Row(verticalAlignment = Alignment.CenterVertically) {
                            val dim = MaterialTheme.colorScheme.onSurface.copy(alpha = 0.6f)
                            when {
                                typingNow -> Text(
                                    if (group) (if (typers.size == 1) Engine.nameOf(typers[0]) else "${typers.size} نفر") + " در حال نوشتن…" else "در حال نوشتن…",
                                    maxLines = 1, overflow = TextOverflow.Ellipsis, fontSize = 14.sp, color = MaterialTheme.colorScheme.primary, modifier = Modifier.weight(1f)
                                )
                                draft.isNotBlank() -> Row(Modifier.weight(1f)) {
                                    Text("پیش‌نویس: ", fontSize = 14.sp, color = MaterialTheme.colorScheme.error)
                                    Text(draft.replace('\n', ' '), maxLines = 1, overflow = TextOverflow.Ellipsis, fontSize = 14.sp, color = dim)
                                }
                                else -> {
                                    val prev = r.last?.let { (if (group && !it.mine) Engine.nameOf(it.sender) + ": " else if (it.mine) "شما: " else "") + U.preview(it) } ?: "هنوز پیامی نیست"
                                    Text(prev, maxLines = 1, overflow = TextOverflow.Ellipsis, fontSize = 14.sp, color = dim, modifier = Modifier.weight(1f))
                                }
                            }
                            if (isPinned && r.unread == 0) Text("📌", fontSize = 13.sp, modifier = Modifier.padding(start = 6.dp))
                            if (r.unread > 0) {
                                Box(Modifier.padding(start = 8.dp).clip(CircleShape).background(MaterialTheme.colorScheme.primary).padding(horizontal = 7.dp, vertical = 2.dp)) {
                                    Text(r.unread.toString(), color = Color.White, fontSize = 12.sp)
                                }
                            }
                        }
                    }
                }
                DropdownMenu(expanded = rowMenu == r.convo, onDismissRequest = { rowMenu = null }) {
                    DropdownMenuItem(text = { Text(if (isPinned) "برداشتن سنجاق" else "سنجاق به بالای فهرست") }, onClick = {
                        rowMenu = null
                        if (!Prefs.togglePinned(r.convo)) Toast.makeText(ctx, "حداکثر ${Prefs.MAX_PINNED} گفتگو را می‌شود سنجاق کرد", Toast.LENGTH_SHORT).show()
                    })
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
