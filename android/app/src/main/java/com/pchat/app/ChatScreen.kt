package com.pchat.app

import androidx.activity.compose.BackHandler
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.interaction.collectIsPressedAsState
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.platform.LocalSoftwareKeyboardController
import androidx.compose.ui.text.TextRange
import androidx.compose.ui.text.input.TextFieldValue
import android.content.Context
import android.content.Intent
import android.widget.Toast
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.gestures.detectTransformGestures
import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.IntrinsicSize
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.consumeWindowInsets
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.automirrored.filled.Send
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.Call
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.Lock
import androidx.compose.material.icons.filled.Search
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.derivedStateOf
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.produceState
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.ImageBitmap
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalClipboardManager
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalLayoutDirection
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextDirection
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.LayoutDirection
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import androidx.core.content.FileProvider
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import java.io.File

private fun openFile(ctx: Context, path: String, mime: String?) {
    try {
        val uri = FileProvider.getUriForFile(ctx, ctx.packageName + ".fileprovider", File(path))
        val i = Intent(Intent.ACTION_VIEW).setDataAndType(uri, mime ?: "*/*").addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
        ctx.startActivity(i)
    } catch (e: Exception) {
        Toast.makeText(ctx, "برنامه‌ای برای باز کردن این فایل پیدا نشد", Toast.LENGTH_SHORT).show()
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun ChatScreen(convo: String, onBack: () -> Unit) {
    val scope = rememberCoroutineScope()
    val tick by Engine.tick.collectAsState()
    val users by Engine.users.collectAsState()
    val groups by Engine.groups.collectAsState()
    val typing by Engine.typing.collectAsState()
    val progress by Engine.progress.collectAsState()
    val failures by Engine.failures.collectAsState()
    val pins by Engine.pins.collectAsState()
    var limit by remember(convo) { mutableStateOf(400) }
    var searching by remember(convo) { mutableStateOf(false) }
    var query by remember(convo) { mutableStateOf("") }
    val allMsgs = remember(tick, convo, limit) { Engine.db.messages(convo, limit) }
    val results = remember(tick, convo, query, searching) {
        if (searching && query.isNotBlank()) Engine.db.search(convo, query.trim()) else null
    }
    val msgs = results ?: allMsgs
    var now by remember { mutableStateOf(System.currentTimeMillis()) }
    var text by remember { mutableStateOf("") }
    var field by remember { mutableStateOf(TextFieldValue("")) }
    var emojiOpen by remember { mutableStateOf(false) }
    val keyboard = LocalSoftwareKeyboardController.current
    val inputFocus = remember { FocusRequester() }
    val inputTouch = remember { MutableInteractionSource() }
    val inputPressed by inputTouch.collectIsPressedAsState()
    LaunchedEffect(inputPressed) { if (inputPressed) emojiOpen = false }
    BackHandler(enabled = emojiOpen) { emojiOpen = false }
    var replyTo by remember { mutableStateOf<Msg?>(null) }
    var viewer by remember { mutableStateOf<String?>(null) }
    var showKeys by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }
    var attachMenu by remember { mutableStateOf(false) }
    var sending by remember { mutableStateOf(false) }
    var jumpTo by remember { mutableStateOf<Long?>(null) }
    var missed by remember { mutableStateOf(0) }
    var keyWarn by remember(tick, convo) { mutableStateOf(!Engine.isGroup(convo) && Engine.db.keyChanged(convo)) }
    val listState = rememberLazyListState()
    val isGroup = Engine.isGroup(convo)
    val startCall = rememberCallStarter()
    val atBottom by remember { derivedStateOf { listState.firstVisibleItemIndex <= 1 } }

    DisposableEffect(convo) {
        Engine.currentConvo = convo
        Engine.openConvo(convo)
        onDispose { Engine.currentConvo = null }
    }
    LaunchedEffect(tick) { Engine.markReadSilently(convo) }
    LaunchedEffect(Unit) { while (true) { delay(1000); now = System.currentTimeMillis() } }
    LaunchedEffect(text) { if (text.isNotEmpty()) Engine.sendTyping(convo) }

    val rowsList = remember(msgs) {
        val out = ArrayList<Any>()
        var lastDay = -1L
        for (m in msgs) {
            val d = U.dayKey(m.ts)
            if (d != lastDay) { out.add(U.day(m.ts)); lastDay = d }
            out.add(m)
        }
        out.reversed()
    }
    val lastId = allMsgs.lastOrNull()?.id
    LaunchedEffect(lastId) {
        val last = allMsgs.lastOrNull()
        if (last != null && (last.mine || listState.firstVisibleItemIndex <= 2)) listState.animateScrollToItem(0)
        else if (last != null && !last.mine && last.type != "call") missed++
    }
    LaunchedEffect(atBottom) { if (atBottom) missed = 0 }
    LaunchedEffect(jumpTo, rowsList.size) {
        val target = jumpTo ?: return@LaunchedEffect
        val idx = rowsList.indexOfFirst { it is Msg && it.id == target }
        if (idx >= 0) { listState.animateScrollToItem(idx); jumpTo = null }
        else if (limit < 100000 && results == null) limit = 100000
        else jumpTo = null
    }

    val pickImage = rememberLauncherForActivityResult(ActivityResultContracts.GetContent()) { uri ->
        if (uri != null) scope.launch {
            sending = true
            error = Engine.sendUri(convo, uri, true, replyTo)
            if (error == null) replyTo = null
            sending = false
        }
    }
    val pickFile = rememberLauncherForActivityResult(ActivityResultContracts.GetContent()) { uri ->
        if (uri != null) scope.launch {
            sending = true
            error = Engine.sendUri(convo, uri, false, replyTo)
            if (error == null) replyTo = null
            sending = false
        }
    }

    val peer = users.firstOrNull { it.username == convo }
    val group = groups.firstOrNull { it.key == convo }
    val subtitle = when {
        isGroup -> {
            val members = group?.members ?: emptyList()
            "${members.size} عضو، ${members.count { m -> users.firstOrNull { it.username == m }?.online == true }} آنلاین"
        }
        (typing[convo] ?: 0L) > now - 4000 -> "در حال نوشتن…"
        peer?.online == true -> "آنلاین"
        else -> "آفلاین"
    }
    var showProfile by remember { mutableStateOf(false) }
    val canSend = isGroup || peer == null || peer.dm || allMsgs.any { !it.mine }
    val pinnedId = pins[convo]
    val pinnedMsg = remember(pinnedId, tick) { pinnedId?.let { Engine.db.get(it) } }

    Scaffold(
        topBar = {
            TopAppBar(
                navigationIcon = {
                    IconButton(onClick = { if (searching) { searching = false; query = "" } else onBack() }) {
                        Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = "بازگشت")
                    }
                },
                title = {
                    if (searching) {
                        OutlinedTextField(
                            value = query, onValueChange = { query = it }, singleLine = true,
                            placeholder = { Text("جستجو در این گفتگو…") }, modifier = Modifier.fillMaxWidth()
                        )
                    } else {
                        Row(verticalAlignment = Alignment.CenterVertically, modifier = Modifier.clickable(enabled = !isGroup) { showProfile = true }) {
                            Avatar(convo, false, 38)
                            Spacer(Modifier.width(10.dp))
                            Column {
                                Text(Engine.titleOf(convo), fontWeight = FontWeight.Bold, fontSize = 17.sp, maxLines = 1, overflow = TextOverflow.Ellipsis)
                                Text(subtitle, fontSize = 12.sp, color = MaterialTheme.colorScheme.onSurface.copy(alpha = 0.6f))
                            }
                        }
                    }
                },
                actions = {
                    if (searching) {
                        IconButton(onClick = { searching = false; query = "" }) { Icon(Icons.Default.Close, contentDescription = "بستن جستجو") }
                    } else {
                        IconButton(onClick = { searching = true }) { Icon(Icons.Default.Search, contentDescription = "جستجو") }
                        if (!isGroup) {
                            IconButton(onClick = { startCall(convo, false) }) { Icon(Icons.Default.Call, contentDescription = "تماس صوتی") }
                            IconButton(onClick = { startCall(convo, true) }) { Text("📹", fontSize = 20.sp) }
                        }
                        IconButton(onClick = { showKeys = true }) { Icon(Icons.Default.Lock, contentDescription = "امنیت") }
                    }
                }
            )
        }
    ) { pad ->
        Column(Modifier.padding(pad).consumeWindowInsets(pad).imePadding().fillMaxSize().background(MaterialTheme.colorScheme.surfaceVariant.copy(alpha = 0.35f))) {
            if (keyWarn) {
                Surface(color = MaterialTheme.colorScheme.errorContainer, modifier = Modifier.fillMaxWidth()) {
                    Row(Modifier.padding(10.dp), verticalAlignment = Alignment.CenterVertically) {
                        Text(
                            "کلید امنیتی ${Engine.nameOf(convo)} تغییر کرده است (شاید گوشی یا برنامه را عوض کرده). اثرانگشت را با خود او تأیید کنید.",
                            fontSize = 13.sp, modifier = Modifier.weight(1f)
                        )
                        TextButton(onClick = { Engine.db.clearKeyChanged(convo); keyWarn = false }) { Text("متوجه شدم") }
                    }
                }
            }
            if (pinnedId != null && !searching) {
                Surface(color = MaterialTheme.colorScheme.surface, modifier = Modifier.fillMaxWidth().clickable { jumpTo = pinnedId }) {
                    Row(Modifier.padding(start = 12.dp, top = 4.dp, bottom = 4.dp), verticalAlignment = Alignment.CenterVertically) {
                        Box(Modifier.width(3.dp).height(34.dp).background(MaterialTheme.colorScheme.primary))
                        Column(Modifier.weight(1f).padding(start = 8.dp)) {
                            Text("📌 پیام پین‌شده", fontSize = 12.sp, color = MaterialTheme.colorScheme.primary, fontWeight = FontWeight.Bold)
                            Text(pinnedMsg?.let { U.preview(it) } ?: "…", fontSize = 13.sp, maxLines = 1, overflow = TextOverflow.Ellipsis)
                        }
                        IconButton(onClick = { scope.launch { error = Engine.pinMessage(convo, null) } }) {
                            Icon(Icons.Default.Close, contentDescription = "برداشتن پین")
                        }
                    }
                }
            }
            if (results != null && results.isEmpty()) {
                Box(Modifier.weight(1f).fillMaxWidth(), contentAlignment = Alignment.Center) {
                    Text("چیزی پیدا نشد", color = MaterialTheme.colorScheme.onSurface.copy(alpha = 0.5f))
                }
            } else Box(Modifier.weight(1f).fillMaxWidth()) {
                CompositionLocalProvider(LocalLayoutDirection provides LayoutDirection.Ltr) {
                    LazyColumn(Modifier.fillMaxSize(), state = listState, reverseLayout = true) {
                        items(rowsList.size, key = { i -> val x = rowsList[i]; if (x is Msg) x.id else "d$x" }) { i ->
                            val it = rowsList[i]
                            if (it is Msg) {
                                Bubble(
                                    m = it, group = isGroup, progress = progress[it.id], failure = failures[it.id],
                                    pinned = pinnedId == it.id,
                                    onImage = { p -> viewer = p },
                                    onReply = { replyTo = it },
                                    onPin = { scope.launch { error = Engine.pinMessage(convo, if (pinnedId == it.id) null else it.id) } },
                                    onRetry = { Engine.retry(it) },
                                    onDelete = { Engine.deleteLocal(it) }
                                )
                            } else {
                                Box(Modifier.fillMaxWidth().padding(vertical = 8.dp), contentAlignment = Alignment.Center) {
                                    Text(
                                        it.toString(), fontSize = 12.sp, color = Color.White,
                                        modifier = Modifier.clip(RoundedCornerShape(12.dp)).background(Color.Black.copy(alpha = 0.35f)).padding(horizontal = 10.dp, vertical = 3.dp)
                                    )
                                }
                            }
                        }
                    }
                }
                if (!atBottom && results == null) {
                    Box(
                        Modifier.align(Alignment.BottomEnd).padding(14.dp).size(44.dp).clip(CircleShape)
                            .background(MaterialTheme.colorScheme.surface).clickable {
                                scope.launch { listState.animateScrollToItem(0) }
                            },
                        contentAlignment = Alignment.Center
                    ) {
                        Text("⬇", fontSize = 20.sp, color = MaterialTheme.colorScheme.primary)
                        if (missed > 0) {
                            Box(
                                Modifier.align(Alignment.TopEnd).clip(CircleShape).background(MaterialTheme.colorScheme.primary).padding(horizontal = 6.dp, vertical = 1.dp)
                            ) { Text(missed.toString(), color = Color.White, fontSize = 11.sp) }
                        }
                    }
                }
            }
            if (sending) {
                Text("در حال آماده‌سازی فایل…", fontSize = 12.sp, modifier = Modifier.padding(horizontal = 12.dp))
                LinearProgressIndicator(Modifier.fillMaxWidth())
            }
            error?.let {
                Text(it, color = MaterialTheme.colorScheme.error, fontSize = 13.sp, modifier = Modifier.padding(horizontal = 12.dp, vertical = 4.dp).clickable { error = null })
            }
            replyTo?.let { r ->
                Surface(color = MaterialTheme.colorScheme.surface, modifier = Modifier.fillMaxWidth()) {
                    Row(Modifier.padding(horizontal = 12.dp, vertical = 6.dp), verticalAlignment = Alignment.CenterVertically) {
                        Box(Modifier.width(3.dp).height(34.dp).background(MaterialTheme.colorScheme.primary))
                        Column(Modifier.weight(1f).padding(start = 8.dp)) {
                            Text("پاسخ به ${Engine.nameOf(r.sender)}", fontSize = 12.sp, color = MaterialTheme.colorScheme.primary, fontWeight = FontWeight.Bold)
                            Text(U.preview(r), fontSize = 13.sp, maxLines = 1, overflow = TextOverflow.Ellipsis)
                        }
                        IconButton(onClick = { replyTo = null }) { Icon(Icons.Default.Close, contentDescription = "لغو") }
                    }
                }
            }
            if (!canSend) {
                Surface(color = MaterialTheme.colorScheme.surface, modifier = Modifier.fillMaxWidth()) {
                    Text(
                        "شما اجازه‌ی شروع گفتگو با این کاربر را ندارید؛ فقط می‌توانید به پیام‌های او پاسخ دهید.",
                        fontSize = 13.sp, modifier = Modifier.padding(14.dp), color = MaterialTheme.colorScheme.onSurface.copy(alpha = 0.6f)
                    )
                }
            } else Surface(color = MaterialTheme.colorScheme.surface, modifier = Modifier.fillMaxWidth()) {
              Column {
                Row(Modifier.padding(horizontal = 6.dp, vertical = 6.dp), verticalAlignment = Alignment.Bottom) {
                    Box {
                        IconButton(onClick = { attachMenu = true }) { Icon(Icons.Default.Add, contentDescription = "پیوست") }
                        DropdownMenu(expanded = attachMenu, onDismissRequest = { attachMenu = false }) {
                            DropdownMenuItem(text = { Text("🖼  عکس (بدون فشرده‌سازی)") }, onClick = { attachMenu = false; pickImage.launch("image/*") })
                            DropdownMenuItem(text = { Text("📎  فایل") }, onClick = { attachMenu = false; pickFile.launch("*/*") })
                        }
                    }
                    IconButton(onClick = {
                        if (emojiOpen) { emojiOpen = false; inputFocus.requestFocus(); keyboard?.show() }
                        else { keyboard?.hide(); emojiOpen = true }
                    }) { Text(if (emojiOpen) "⌨️" else "😊", fontSize = 22.sp) }
                    OutlinedTextField(
                        // keep the cursor/selection so emoji go where the cursor is; `text` stays the source of truth
                        value = if (field.text == text) field else TextFieldValue(text, TextRange(text.length)),
                        onValueChange = { if (it.text.length <= 4000) { field = it; text = it.text } },
                        placeholder = { Text("پیام…") }, interactionSource = inputTouch,
                        shape = RoundedCornerShape(22.dp), maxLines = 5, modifier = Modifier.weight(1f).focusRequester(inputFocus)
                    )
                    IconButton(
                        enabled = text.isNotBlank(),
                        onClick = {
                            val t = text.trim()
                            val r = replyTo
                            text = ""; replyTo = null
                            Engine.sendText(convo, t, r)
                        }
                    ) { Icon(Icons.AutoMirrored.Filled.Send, contentDescription = "ارسال", tint = if (text.isNotBlank()) MaterialTheme.colorScheme.primary else Color.Gray) }
                }
                if (emojiOpen) EmojiPanel { e ->
                    val cur = if (field.text == text) field else TextFieldValue(text, TextRange(text.length))
                    val a = minOf(cur.selection.start, cur.selection.end).coerceIn(0, text.length)
                    val b = maxOf(cur.selection.start, cur.selection.end).coerceIn(0, text.length)
                    val t = text.substring(0, a) + e + text.substring(b)
                    if (t.length <= 4000) { text = t; field = TextFieldValue(t, TextRange(a + e.length)) }
                }
              }
            }
        }
    }

    viewer?.let { ImageViewer(it) { viewer = null } }
    if (showProfile) ContactProfileDialog(convo) { showProfile = false }
    if (showKeys) KeysDialog(if (isGroup) (group?.members ?: users.map { it.username }).filter { it != Engine.me } else listOf(convo)) { showKeys = false }
}

@Composable
private fun ProgressBar(p: Float, modifier: Modifier = Modifier) {
    Box(modifier.height(4.dp).clip(RoundedCornerShape(2.dp)).background(Color.Gray.copy(alpha = 0.3f))) {
        Box(Modifier.fillMaxHeight().fillMaxWidth(p.coerceIn(0.02f, 1f)).background(MaterialTheme.colorScheme.primary))
    }
}

@OptIn(ExperimentalFoundationApi::class)
@Composable
fun Bubble(
    m: Msg, group: Boolean, progress: Float?, failure: String?, pinned: Boolean,
    onImage: (String) -> Unit, onReply: () -> Unit, onPin: () -> Unit, onRetry: () -> Unit, onDelete: () -> Unit
) {
    val ctx = LocalContext.current
    val scope = rememberCoroutineScope()
    val clipboard = LocalClipboardManager.current
    val dark = isSystemInDarkTheme()
    val bg = if (m.mine) (if (dark) Color(0xFF2B5278) else Color(0xFFEFFDDE)) else (if (dark) Color(0xFF182533) else Color.White)
    val fg = if (dark) Color(0xFFF5F5F5) else Color(0xFF111111)
    val sub = fg.copy(alpha = 0.55f)
    var menu by remember { mutableStateOf(false) }
    val autoImage = m.type == "image" && m.localPath == null && m.fileId != null && m.size <= 25L * 1024 * 1024
    val bigEmoji = remember(m.text, m.type, m.replyId) { m.type == "text" && m.replyId == 0L && Emoji.onlyEmojiCount(m.text) > 0 }

    LaunchedEffect(m.id, m.localPath) {
        if (autoImage) Engine.downloadMedia(m)
    }

    Row(
        Modifier.fillMaxWidth().padding(horizontal = 8.dp, vertical = 2.dp),
        horizontalArrangement = if (m.mine) Arrangement.End else Arrangement.Start
    ) {
        Box {
            Surface(
                color = if (bigEmoji) Color.Transparent else bg,
                shape = RoundedCornerShape(topStart = 14.dp, topEnd = 14.dp, bottomStart = if (m.mine) 14.dp else 3.dp, bottomEnd = if (m.mine) 3.dp else 14.dp),
                shadowElevation = if (bigEmoji) 0.dp else 1.dp,
                modifier = Modifier.widthIn(max = 300.dp).combinedClickable(onClick = {}, onLongClick = { if (m.type != "call") menu = true })
            ) {
                Column(Modifier.padding(horizontal = 10.dp, vertical = 6.dp)) {
                    if (group && !m.mine) {
                        Text(Engine.nameOf(m.sender), color = U.colorFor(m.sender), fontWeight = FontWeight.Bold, fontSize = 13.sp)
                    }
                    if (m.replyId != 0L) {
                        Row(Modifier.padding(vertical = 3.dp).height(IntrinsicSize.Min)) {
                            Box(Modifier.width(3.dp).fillMaxHeight().background(MaterialTheme.colorScheme.primary))
                            Column(Modifier.padding(start = 6.dp)) {
                                Text(Engine.nameOf(m.replyUser ?: ""), color = MaterialTheme.colorScheme.primary, fontWeight = FontWeight.Bold, fontSize = 12.sp)
                                Text(m.replyText ?: "", color = sub, fontSize = 12.sp, maxLines = 1, overflow = TextOverflow.Ellipsis)
                            }
                        }
                    }
                    when (m.type) {
                        "image" -> {
                            ImageContent(m, progress, autoImage, onImage)
                            if (m.status == 1 && progress != null) ProgressBar(progress, Modifier.width(240.dp).padding(top = 4.dp))
                        }
                        "file" -> {
                            val ext = (m.fileName ?: "").substringAfterLast('.', "FILE")
                            Row(verticalAlignment = Alignment.CenterVertically) {
                                Box(Modifier.size(44.dp).clip(CircleShape).background(MaterialTheme.colorScheme.primary), contentAlignment = Alignment.Center) {
                                    Text(ext.take(4).uppercase(), color = Color.White, fontSize = 11.sp, fontWeight = FontWeight.Bold)
                                }
                                Column(Modifier.padding(horizontal = 8.dp)) {
                                    Text(m.fileName ?: "file", color = fg, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.widthIn(max = 170.dp), fontSize = 14.sp)
                                    Text(U.size(m.size), color = sub, fontSize = 12.sp)
                                }
                                if (m.status == 0) {
                                    if (progress != null) {
                                        Text("${(progress * 100).toInt()}٪", color = sub, fontSize = 12.sp)
                                    } else {
                                        TextButton(onClick = {
                                            scope.launch {
                                                val p = Engine.downloadMedia(m)
                                                if (p != null) openFile(ctx, p, m.mime)
                                                else Toast.makeText(ctx, "دریافت فایل ناموفق بود (دوباره بزنید تا ادامه یابد)", Toast.LENGTH_SHORT).show()
                                            }
                                        }) { Text(if (m.localPath != null) "باز کردن" else "دانلود") }
                                    }
                                }
                            }
                            if (progress != null) ProgressBar(progress, Modifier.fillMaxWidth().padding(top = 4.dp))
                        }
                        "call" -> Text(m.text, color = sub, fontSize = 14.sp)
                        else -> if (bigEmoji) BigEmoji(m.text, m.id) else Text(m.text, color = fg, fontSize = 16.sp, style = TextStyle(textDirection = TextDirection.Content))
                    }
                    if (m.status == 2) {
                        Text(failure ?: "ارسال نشد", color = MaterialTheme.colorScheme.error, fontSize = 12.sp)
                        TextButton(onClick = onRetry) { Text("تلاش دوباره") }
                    }
                    Row(Modifier.align(Alignment.End), verticalAlignment = Alignment.CenterVertically) {
                        if (pinned) Text("📌 ", fontSize = 11.sp)
                        Text(U.time(m.ts), color = sub, fontSize = 11.sp)
                        if (m.mine && m.type != "call") {
                            when (m.status) {
                                1 -> Text(" 🕓", color = sub, fontSize = 11.sp)
                                2 -> Text(" ⚠", color = MaterialTheme.colorScheme.error, fontSize = 11.sp)
                                else -> Text(" ✓", color = MaterialTheme.colorScheme.primary, fontSize = 11.sp)
                            }
                        }
                    }
                }
            }
            DropdownMenu(expanded = menu, onDismissRequest = { menu = false }) {
                if (m.status == 0) DropdownMenuItem(text = { Text("پاسخ") }, onClick = { menu = false; onReply() })
                if (m.type == "text") DropdownMenuItem(text = { Text("کپی") }, onClick = { menu = false; clipboard.setText(AnnotatedString(m.text)) })
                if (m.status == 0 && m.id > 0) DropdownMenuItem(text = { Text(if (pinned) "برداشتن پین" else "پین کردن") }, onClick = { menu = false; onPin() })
                if (m.status == 2) DropdownMenuItem(text = { Text("تلاش دوباره") }, onClick = { menu = false; onRetry() })
                DropdownMenuItem(
                    text = { Text(if (m.status != 0) "لغو ارسال" else "حذف (فقط برای من)") },
                    onClick = { menu = false; onDelete() }
                )
            }
        }
    }
}

@Composable
private fun ImageContent(m: Msg, progress: Float?, auto: Boolean, onImage: (String) -> Unit) {
    val scope = rememberCoroutineScope()
    val bmp by produceState<ImageBitmap?>(null, m.localPath) {
        value = m.localPath?.let { p -> withContext(Dispatchers.IO) { decodeSampled(p, 900) } }
    }
    val ratio = if (m.w > 0 && m.h > 0) (m.w.toFloat() / m.h).coerceIn(0.5f, 2f) else 1f
    Box(
        Modifier.width(240.dp).aspectRatio(ratio).clip(RoundedCornerShape(8.dp))
            .background(Color.Gray.copy(alpha = 0.25f))
            .clickable(enabled = m.localPath != null || (!auto && m.fileId != null && progress == null)) {
                if (m.localPath != null) onImage(m.localPath) else scope.launch { Engine.downloadMedia(m) }
            },
        contentAlignment = Alignment.Center
    ) {
        val b = bmp
        if (b != null) Image(b, contentDescription = null, modifier = Modifier.fillMaxSize(), contentScale = ContentScale.Crop)
        else if (m.localPath == null && !auto && progress == null) Text("⬇ ${U.size(m.size)}", color = Color.White, fontSize = 14.sp)
        else Column(horizontalAlignment = Alignment.CenterHorizontally) {
            CircularProgressIndicator(Modifier.size(28.dp), strokeWidth = 2.dp)
            if (progress != null) Text("${(progress * 100).toInt()}٪", fontSize = 12.sp, color = Color.White)
        }
    }
}

@Composable
fun ImageViewer(path: String, onClose: () -> Unit) {
    Dialog(onDismissRequest = onClose, properties = DialogProperties(usePlatformDefaultWidth = false)) {
        var scale by remember { mutableStateOf(1f) }
        var off by remember { mutableStateOf(Offset.Zero) }
        val bmp by produceState<ImageBitmap?>(null, path) { value = withContext(Dispatchers.IO) { decodeSampled(path, 2000) } }
        Box(
            Modifier.fillMaxSize().background(Color.Black).pointerInput(Unit) {
                detectTransformGestures { _, pan, zoom, _ ->
                    scale = (scale * zoom).coerceIn(1f, 5f)
                    off = if (scale > 1f) off + pan else Offset.Zero
                }
            },
            contentAlignment = Alignment.Center
        ) {
            val b = bmp
            if (b != null) {
                Image(
                    b, contentDescription = null, contentScale = ContentScale.Fit,
                    modifier = Modifier.fillMaxSize().graphicsLayer(scaleX = scale, scaleY = scale, translationX = off.x, translationY = off.y)
                )
            } else CircularProgressIndicator(color = Color.White)
            IconButton(onClick = onClose, modifier = Modifier.align(Alignment.TopEnd).padding(16.dp)) {
                Icon(Icons.Default.Close, contentDescription = "بستن", tint = Color.White)
            }
        }
    }
}
