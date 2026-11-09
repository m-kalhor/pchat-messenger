package com.pchat.app

import androidx.activity.compose.BackHandler
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.interaction.collectIsPressedAsState
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.platform.LocalSoftwareKeyboardController
import androidx.compose.ui.text.TextRange
import androidx.compose.ui.text.input.TextFieldValue
import android.Manifest
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.widget.Toast
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.gestures.awaitEachGesture
import androidx.compose.foundation.gestures.awaitFirstDown
import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.ui.geometry.CornerRadius
import androidx.compose.ui.geometry.Size
import androidx.core.content.ContextCompat
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.combinedClickable
import androidx.compose.material3.AlertDialog
import androidx.compose.runtime.mutableStateListOf
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
import androidx.compose.material3.OutlinedTextFieldDefaults
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
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.ui.text.LinkAnnotation
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.TextLinkStyles
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.withLink
import androidx.compose.ui.unit.TextUnit
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
import android.net.Uri
import androidx.compose.material3.Switch
import androidx.compose.foundation.layout.heightIn

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
fun ChatScreen(convo: String, onBack: () -> Unit, onOpenUser: (String) -> Unit = {}) {
    val scope = rememberCoroutineScope()
    val ctxForToast = LocalContext.current
    val tick by Engine.tick.collectAsState()
    val users by Engine.users.collectAsState()
    val groups by Engine.groups.collectAsState()
    val typing by Engine.typing.collectAsState()
    val progress by Engine.progress.collectAsState()
    val failures by Engine.failures.collectAsState()
    val pins by Engine.pins.collectAsState()
    val receipts by Engine.receipts.collectAsState()
    val gtyping by Engine.gtyping.collectAsState()
    val hideSeen by Engine.hideSeen.collectAsState()
    var limit by remember(convo) { mutableStateOf(400) }
    var searching by remember(convo) { mutableStateOf(false) }
    var query by remember(convo) { mutableStateOf("") }
    val allMsgs = remember(tick, convo, limit) { Engine.db.messages(convo, limit) }
    val results = remember(tick, convo, query, searching) {
        if (searching && query.isNotBlank()) Engine.db.search(convo, query.trim()) else null
    }
    val msgs = results ?: allMsgs
    var now by remember { mutableStateOf(System.currentTimeMillis()) }
    var text by remember(convo) { mutableStateOf(Prefs.draft(convo)) }
    var field by remember(convo) { mutableStateOf(TextFieldValue(text, TextRange(text.length))) }
    var emojiOpen by remember { mutableStateOf(false) }
    val keyboard = LocalSoftwareKeyboardController.current
    val inputFocus = remember { FocusRequester() }
    val inputTouch = remember { MutableInteractionSource() }
    val inputPressed by inputTouch.collectIsPressedAsState()
    LaunchedEffect(inputPressed) { if (inputPressed) emojiOpen = false }
    BackHandler(enabled = emojiOpen) { emojiOpen = false }
    var replyTo by remember { mutableStateOf<Msg?>(null) }
    var editing by remember(convo) { mutableStateOf<Msg?>(null) }
    val selected = remember(convo) { mutableStateListOf<Long>() }
    var forwarding by remember { mutableStateOf<List<Msg>?>(null) }
    var info by remember { mutableStateOf<Msg?>(null) }
    var deleteAll by remember { mutableStateOf<Msg?>(null) }
    BackHandler(enabled = selected.isNotEmpty()) { selected.clear() }
    BackHandler(enabled = editing != null) { editing = null; text = "" }
    var viewer by remember { mutableStateOf<Pair<String, Msg>?>(null) }
    val mediaActions = rememberMediaActions()
    var showKeys by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }
    var attachMenu by remember { mutableStateOf(false) }
    var sending by remember { mutableStateOf(false) }
    var jumpTo by remember { mutableStateOf<Long?>(null) }
    var missed by remember { mutableStateOf(0) }
    var keyWarn by remember(tick, convo) { mutableStateOf(!Engine.isGroup(convo) && Engine.db.keyChanged(convo)) }
    val listState = rememberLazyListState()
    val isGroup = Engine.isGroup(convo)
    val startCall0 = rememberCallStarter()
    // 1.7: a message request I have not accepted yet: no calls from here (and theirs do not ring)
    val startCall: (String, Boolean) -> Unit = { c, v ->
        val r = Engine.reqOf(c)
        if (r == "in" || r == "declined") Toast.makeText(ctxForToast, "اول درخواست را بپذیرید", Toast.LENGTH_SHORT).show() else startCall0(c, v)
    }
    // @username in a message: open that chat (a stranger is found first, then it is a message request)
    val openMention: (String) -> Unit = { name ->
        if (name == Engine.me) Unit
        else if (Engine.users.value.any { it.username == name && (it.dm || it.req != null) }) onOpenUser(name)
        else scope.launch {
            val (u, err) = Engine.findUser(name)
            if (u != null) onOpenUser(u) else Toast.makeText(ctxForToast, err ?: "پیدا نشد", Toast.LENGTH_LONG).show()
        }
    }
    val reqState = remember(users, convo) { Engine.reqOf(convo) }
    val incomingReqs by Engine.incomingRequests.collectAsState()
    val declinedReqs by Engine.declinedRequests.collectAsState()
    val atBottom by remember { derivedStateOf { listState.firstVisibleItemIndex <= 1 } }

    DisposableEffect(convo) {
        Engine.currentConvo = convo
        Engine.openConvo(convo)
        onDispose { Engine.currentConvo = null }
    }
    LaunchedEffect(tick) { Engine.markReadSilently(convo) }
    LaunchedEffect(Unit) { while (true) { delay(1000); now = System.currentTimeMillis() } }
    // the unsent text stays as a draft («پیش‌نویس» in the chat list)
    val draftNow by rememberUpdatedState(if (editing == null) text else null)
    LaunchedEffect(text, editing) { if (editing == null) { delay(400); Prefs.setDraft(convo, text) } }
    DisposableEffect(convo) { onDispose { draftNow?.let { Prefs.setDraft(convo, it) } } }

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

    // ---- photos: from the gallery or the camera, then a preview with a «compress» switch (remembered) ----
    var pendingPhoto by remember { mutableStateOf<Uri?>(null) }
    var pendingCam by remember { mutableStateOf<File?>(null) } // temp camera file, deleted once sent/cancelled
    var camFile by remember { mutableStateOf<File?>(null) }
    val pickImage = rememberLauncherForActivityResult(ActivityResultContracts.GetContent()) { uri ->
        if (uri != null) { pendingCam = null; pendingPhoto = uri }
    }
    val takePhoto = rememberLauncherForActivityResult(ActivityResultContracts.TakePicture()) { ok ->
        val f = camFile
        camFile = null
        if (ok && f != null && f.length() > 0) { pendingCam = f; pendingPhoto = FileProvider.getUriForFile(ctxForToast, ctxForToast.packageName + ".fileprovider", f) }
        else f?.delete()
    }
    fun launchCamera() {
        val f = File(File(ctxForToast.filesDir, "media").also { it.mkdirs() }, "cam_${System.currentTimeMillis()}.jpg")
        camFile = f
        try {
            takePhoto.launch(FileProvider.getUriForFile(ctxForToast, ctxForToast.packageName + ".fileprovider", f))
        } catch (e: Exception) { camFile = null; f.delete(); error = "برنامهٔ دوربین پیدا نشد" }
    }
    val camPerm = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { ok ->
        if (ok) launchCamera() else error = "برای گرفتن عکس اجازهٔ دوربین لازم است"
    }
    fun openCamera() {
        if (ContextCompat.checkSelfPermission(ctxForToast, Manifest.permission.CAMERA) != PackageManager.PERMISSION_GRANTED)
            camPerm.launch(Manifest.permission.CAMERA)
        else launchCamera()
    }
    fun sendPhoto(uri: Uri, compress: Boolean) {
        val cam = pendingCam
        pendingPhoto = null; pendingCam = null
        scope.launch {
            sending = true
            error = Engine.sendUri(convo, uri, true, replyTo, compress)
            if (error == null) replyTo = null
            sending = false
            cam?.delete()
        }
    }
    pendingPhoto?.let { uri ->
        PhotoSendDialog(uri,
            onSend = { compress -> sendPhoto(uri, compress) },
            onCancel = { pendingPhoto = null; pendingCam?.delete(); pendingCam = null })
    }
    val pickFile = rememberLauncherForActivityResult(ActivityResultContracts.GetContent()) { uri ->
        if (uri != null) scope.launch {
            sending = true
            error = Engine.sendUri(convo, uri, false, replyTo)
            if (error == null) replyTo = null
            sending = false
        }
    }

    // ---- voice messages: hold the mic to record, release to send, slide sideways to cancel, up to lock ----
    var recorder by remember { mutableStateOf<VoiceRecorder?>(null) }
    var recLocked by remember { mutableStateOf(false) }
    var recElapsed by remember { mutableStateOf(0L) }
    var recDrag by remember { mutableStateOf(0f) }
    val micPerm = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { ok ->
        error = if (ok) "اجازه داده شد؛ برای ضبط، دکمهٔ میکروفون را نگه دارید" else "برای ضبط پیام صوتی اجازهٔ میکروفون لازم است"
    }
    LaunchedEffect(recorder) { while (recorder != null) { recElapsed = recorder?.elapsed() ?: 0L; delay(100) } }
    DisposableEffect(convo) { onDispose { recorder?.cancel(); recorder = null } }
    fun startRec(): Boolean {
        if (ContextCompat.checkSelfPermission(ctxForToast, Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED) {
            micPerm.launch(Manifest.permission.RECORD_AUDIO)
            return false
        }
        if (recorder != null) return false
        VoicePlayer.stop()
        val r = VoiceRecorder(ctxForToast, Engine.newRecordingFile())
        return try { r.start(); recorder = r; recLocked = false; recDrag = 0f; true } catch (e: Exception) {
            r.cancel(); error = "ضبط صدا شروع نشد"; false
        }
    }
    fun finishRec(send: Boolean) {
        val r = recorder ?: return
        recorder = null; recLocked = false; recDrag = 0f
        if (!send) { r.cancel(); return }
        val res = r.stop()
        if (res == null || res.first < 700) { r.file.delete(); return }
        Engine.sendVoice(convo, r.file, res.first, res.second, replyTo)
        replyTo = null
    }
    val onRecStart by rememberUpdatedState(::startRec)
    val endRec: (Int) -> Unit = { result -> if (result == 2) recLocked = true else finishRec(result == 1) }
    val onRecEnd by rememberUpdatedState(endRec)

    // ---- location: one point, after asking ----
    var locating by remember { mutableStateOf(false) }
    var locConfirm by remember { mutableStateOf<Loc?>(null) }
    fun fetchLocation() {
        locating = true
        scope.launch {
            val l = GeoLocation.current(ctxForToast)
            locating = false
            if (l == null) error = "موقعیت مکانی پیدا نشد؛ مکان (GPS) گوشی را روشن کنید و دوباره امتحان کنید" else locConfirm = l
        }
    }
    val locPerm = rememberLauncherForActivityResult(ActivityResultContracts.RequestMultiplePermissions()) { res ->
        if (res.values.any { it }) fetchLocation() else error = "اجازهٔ دسترسی به موقعیت مکانی داده نشد"
    }
    fun shareLocation() {
        val has = listOf(Manifest.permission.ACCESS_FINE_LOCATION, Manifest.permission.ACCESS_COARSE_LOCATION)
            .any { ContextCompat.checkSelfPermission(ctxForToast, it) == PackageManager.PERMISSION_GRANTED }
        if (has) fetchLocation() else locPerm.launch(arrayOf(Manifest.permission.ACCESS_FINE_LOCATION, Manifest.permission.ACCESS_COARSE_LOCATION))
    }

    var reactFor by remember { mutableStateOf<Msg?>(null) }
    var reactorsOf by remember { mutableStateOf<Msg?>(null) }
    var seenBy by remember { mutableStateOf<Msg?>(null) }
    fun react(m: Msg, e: String?) { scope.launch { Engine.react(m, e)?.let { error = it } } }

    val peer = users.firstOrNull { it.username == convo }
    val group = groups.firstOrNull { it.key == convo }
    val groupTyping = remember(gtyping, now) { if (isGroup) Engine.typingIn(convo, now) else emptyList() }
    val subtitle = when {
        isGroup && groupTyping.isNotEmpty() ->
            (if (groupTyping.size == 1) Engine.nameOf(groupTyping[0]) else "${groupTyping.size} نفر") + " در حال نوشتن…"
        isGroup -> {
            val members = group?.members ?: emptyList()
            "${members.size} عضو، ${members.count { m -> users.firstOrNull { it.username == m }?.online == true }} آنلاین"
        }
        (typing[convo] ?: 0L) > now - 4000 -> "در حال نوشتن…"
        else -> U.lastSeen(peer)
    }
    var showProfile by remember { mutableStateOf(false) }
    var muteMenu by remember { mutableStateOf(false) }
    val notifTick by Prefs.notifTick.collectAsState()
    val muted = remember(notifTick, convo) { Prefs.isMuted(convo) }
    val canSend = isGroup || peer == null || peer.dm || allMsgs.any { !it.mine }
    val pinnedId = pins[convo]
    val pinnedMsg = remember(pinnedId, tick) { pinnedId?.let { Engine.db.get(it) } }

    SystemBars.HeaderShown()
    Scaffold(
        topBar = {
            TopAppBar(
                colors = Look.barColors(),
                navigationIcon = {
                    IconButton(onClick = { if (searching) { searching = false; query = "" } else onBack() }) {
                        Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = "بازگشت")
                    }
                },
                title = {
                    if (searching) {
                        OutlinedTextField(
                            value = query, onValueChange = { query = it }, singleLine = true,
                            placeholder = { Text("جستجو در این گفتگو…") }, modifier = Modifier.fillMaxWidth(),
                            colors = OutlinedTextFieldDefaults.colors(
                                focusedTextColor = Color.White, unfocusedTextColor = Color.White, cursorColor = Color.White,
                                focusedBorderColor = Color.White.copy(alpha = 0.7f), unfocusedBorderColor = Color.White.copy(alpha = 0.4f),
                                focusedPlaceholderColor = Look.barSub, unfocusedPlaceholderColor = Look.barSub
                            )
                        )
                    } else {
                        Row(verticalAlignment = Alignment.CenterVertically, modifier = Modifier.clickable(enabled = !isGroup) { showProfile = true }) {
                            Avatar(convo, false, 38)
                            Spacer(Modifier.width(10.dp))
                            Column {
                                Text(Engine.titleOf(convo), fontWeight = FontWeight.Bold, fontSize = 17.sp, maxLines = 1, overflow = TextOverflow.Ellipsis)
                                Text(subtitle, fontSize = 12.sp, color = Look.barSub)
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
                        Box {
                            IconButton(onClick = { muteMenu = true }) { Text(if (muted) "🔕" else "🔔", fontSize = 18.sp) }
                            DropdownMenu(expanded = muteMenu, onDismissRequest = { muteMenu = false }) {
                                if (muted) DropdownMenuItem(text = { Text("روشن کردن اعلان") }, onClick = { muteMenu = false; Prefs.unmute(convo) })
                                DropdownMenuItem(text = { Text("بی‌صدا برای ۱ ساعت") }, onClick = { muteMenu = false; Prefs.mute(convo, 3600_000L) })
                                DropdownMenuItem(text = { Text("بی‌صدا برای ۸ ساعت") }, onClick = { muteMenu = false; Prefs.mute(convo, 8 * 3600_000L) })
                                DropdownMenuItem(text = { Text("بی‌صدا برای ۲ روز") }, onClick = { muteMenu = false; Prefs.mute(convo, 48 * 3600_000L) })
                                DropdownMenuItem(text = { Text("بی‌صدا برای همیشه") }, onClick = { muteMenu = false; Prefs.mute(convo, null) })
                            }
                        }
                        IconButton(onClick = { showKeys = true }) { Icon(Icons.Default.Lock, contentDescription = "امنیت") }
                    }
                }
            )
        }
    ) { pad ->
        Column(Modifier.padding(pad).consumeWindowInsets(pad).imePadding().fillMaxSize().then(Look.chatBackground())) {
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
            if (reqState != null && !searching) {
                Surface(color = MaterialTheme.colorScheme.secondaryContainer, modifier = Modifier.fillMaxWidth()) {
                    Column(Modifier.padding(horizontal = 12.dp, vertical = 8.dp)) {
                        if (reqState == "out") {
                            Text(
                                "درخواست پیام: ${Engine.nameOf(convo)} هنوز در مخاطبان شما نیست. تا وقتی بپذیرد، تا ۳ پیام متنی (بدون فایل) می‌شود فرستاد. تماس بعد از پذیرفتن ممکن است.",
                                fontSize = 13.sp
                            )
                        } else {
                            val calls = (incomingReqs + declinedReqs).firstOrNull { it.username == convo }?.calls ?: 0
                            Text(
                                "${Engine.nameOf(convo)} (@$convo) در مخاطبان شما نیست" + (if (reqState == "declined") " و این درخواست را رد کرده‌اید" else "") + "." +
                                    (if (calls > 0) " 📞 $calls تماس بی‌پاسخ." else "") + " با پاسخ دادن یا «پذیرفتن» به هم وصل می‌شوید.",
                                fontSize = 13.sp
                            )
                            var confirmBlock by remember { mutableStateOf(false) }
                            Row {
                                TextButton(onClick = { scope.launch { error = Engine.contactAction("respond", convo, true).first } }) { Text("پذیرفتن") }
                                if (reqState == "in") TextButton(onClick = { scope.launch { error = Engine.contactAction("respond", convo, false).first; if (error == null) onBack() } }) { Text("رد") }
                                TextButton(onClick = { confirmBlock = true }) { Text("مسدود", color = MaterialTheme.colorScheme.error) }
                            }
                            if (confirmBlock) AlertDialog(
                                onDismissRequest = { confirmBlock = false },
                                title = { Text("مسدود کردن") },
                                text = { Text("${Engine.nameOf(convo)} دیگر نمی‌تواند به شما پیام بدهد یا زنگ بزند. بعداً از «درخواست‌ها» می‌شود رفع مسدودی کرد.") },
                                confirmButton = { TextButton(onClick = { confirmBlock = false; scope.launch { error = Engine.contactAction("block", convo).first; if (error == null) onBack() } }) { Text("مسدود", color = MaterialTheme.colorScheme.error) } },
                                dismissButton = { TextButton(onClick = { confirmBlock = false }) { Text("انصراف") } }
                            )
                        }
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
                CompositionLocalProvider(LocalLayoutDirection provides LayoutDirection.Ltr, LocalOpenMention provides openMention, LocalMediaActions provides mediaActions) {
                    LazyColumn(Modifier.fillMaxSize(), state = listState, reverseLayout = true) {
                        items(rowsList.size, key = { i -> val x = rowsList[i]; if (x is Msg) x.id else "d$x" }) { i ->
                            val it = rowsList[i]
                            if (it is Msg) {
                                // 1.9: the tail goes on the last bubble of a run (the list is reversed: i - 1 is newer)
                                val newer = rowsList.getOrNull(i - 1)
                                val tail = !(newer is Msg && newer.mine == it.mine && newer.sender == it.sender && newer.type != "call")
                                Bubble(
                                    m = it, group = isGroup, tail = tail, progress = progress[it.id], failure = failures[it.id],
                                    pinned = pinnedId == it.id, tick = Engine.tickOf(it, receipts).also { hideSeen },
                                    onReact = { e -> react(it, e) }, onMoreReactions = { reactFor = it },
                                    onReactors = { reactorsOf = it }, onSeenBy = { seenBy = it },
                                    onImage = { p -> viewer = p to it },
                                    onReply = { replyTo = it },
                                    onPin = { scope.launch { error = Engine.pinMessage(convo, if (pinnedId == it.id) null else it.id) } },
                                    onRetry = { Engine.retry(it) },
                                    onDelete = { Engine.deleteLocal(it) },
                                    selecting = selected.isNotEmpty(), selected = it.id in selected,
                                    onSelect = { if (it.id in selected) selected.remove(it.id) else if (it.id > 0 && it.status == 0) selected.add(it.id) },
                                    onEdit = { editing = it; replyTo = null; text = it.text; field = TextFieldValue(it.text, TextRange(it.text.length)) },
                                    onForward = { forwarding = listOf(it) },
                                    onInfo = { info = it },
                                    onDeleteAll = { deleteAll = it }
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
            if (selected.isNotEmpty()) {
                Surface(color = MaterialTheme.colorScheme.surface, modifier = Modifier.fillMaxWidth()) {
                    Row(Modifier.padding(horizontal = 8.dp, vertical = 4.dp), verticalAlignment = Alignment.CenterVertically) {
                        IconButton(onClick = { selected.clear() }) { Icon(Icons.Default.Close, contentDescription = "لغو انتخاب") }
                        Text("${selected.size} پیام انتخاب شد", modifier = Modifier.weight(1f), fontWeight = FontWeight.SemiBold)
                        TextButton(onClick = { forwarding = allMsgs.filter { m -> m.id in selected } }) { Text("فوروارد") }
                    }
                }
            }
            if (sending || locating) {
                Text(if (locating) "در حال پیدا کردن موقعیت مکانی…" else "در حال آماده‌سازی فایل…", fontSize = 12.sp, modifier = Modifier.padding(horizontal = 12.dp))
                LinearProgressIndicator(Modifier.fillMaxWidth())
            }
            error?.let {
                Text(it, color = MaterialTheme.colorScheme.error, fontSize = 13.sp, modifier = Modifier.padding(horizontal = 12.dp, vertical = 4.dp).clickable { error = null })
            }
            editing?.let { e ->
                Surface(color = MaterialTheme.colorScheme.surface, modifier = Modifier.fillMaxWidth()) {
                    Row(Modifier.padding(horizontal = 12.dp, vertical = 6.dp), verticalAlignment = Alignment.CenterVertically) {
                        Box(Modifier.width(3.dp).height(34.dp).background(MaterialTheme.colorScheme.primary))
                        Column(Modifier.weight(1f).padding(start = 8.dp)) {
                            Text("✏️ ویرایش پیام", fontSize = 12.sp, color = MaterialTheme.colorScheme.primary, fontWeight = FontWeight.Bold)
                            Text(e.text, fontSize = 13.sp, maxLines = 1, overflow = TextOverflow.Ellipsis)
                        }
                        IconButton(onClick = { editing = null; text = "" }) { Icon(Icons.Default.Close, contentDescription = "لغو ویرایش") }
                    }
                }
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
                  val rec = recorder
                  if (rec != null) {
                    // recording: elapsed time and how to cancel / lock
                    val blink by produceState(1f, rec) { while (true) { delay(500); value = if (value > 0.5f) 0.25f else 1f } }
                    Row(Modifier.weight(1f).height(56.dp).padding(horizontal = 10.dp), verticalAlignment = Alignment.CenterVertically) {
                        Box(Modifier.size(10.dp).clip(CircleShape).background(Color(0xFFE53935).copy(alpha = blink)))
                        Spacer(Modifier.width(8.dp))
                        Text(U.dur(recElapsed), fontSize = 16.sp)
                        Spacer(Modifier.weight(1f))
                        if (recLocked) TextButton(onClick = { finishRec(false) }) { Text("لغو", color = MaterialTheme.colorScheme.error) }
                        else Text(
                            "برای لغو به کنار بکشید · برای قفل بالا",
                            fontSize = 12.sp, maxLines = 1, color = MaterialTheme.colorScheme.onSurface.copy(alpha = (0.6f - kotlin.math.abs(recDrag) / 400f).coerceAtLeast(0.15f))
                        )
                    }
                  } else {
                    if (reqState != "out") Box {
                        IconButton(onClick = { attachMenu = true }) { Icon(Icons.Default.Add, contentDescription = "پیوست") }
                        DropdownMenu(expanded = attachMenu, onDismissRequest = { attachMenu = false }) {
                            DropdownMenuItem(text = { Text("🖼  عکس از گالری") }, onClick = { attachMenu = false; pickImage.launch("image/*") })
                            DropdownMenuItem(text = { Text("📷  عکس با دوربین") }, onClick = { attachMenu = false; openCamera() })
                            DropdownMenuItem(text = { Text("📎  فایل") }, onClick = { attachMenu = false; pickFile.launch("*/*") })
                            DropdownMenuItem(text = { Text("📍  موقعیت مکانی") }, onClick = { attachMenu = false; shareLocation() })
                        }
                    }
                    IconButton(onClick = {
                        if (emojiOpen) { emojiOpen = false; inputFocus.requestFocus(); keyboard?.show() }
                        else { keyboard?.hide(); emojiOpen = true }
                    }) { Text(if (emojiOpen) "⌨️" else "😊", fontSize = 22.sp) }
                    OutlinedTextField(
                        // keep the cursor/selection so emoji go where the cursor is; `text` stays the source of truth
                        value = if (field.text == text) field else TextFieldValue(text, TextRange(text.length)),
                        onValueChange = {
                            if (it.text.length <= 4000) {
                                if (it.text != text && it.text.isNotEmpty() && editing == null) Engine.sendTyping(convo)
                                field = it; text = it.text
                            }
                        },
                        placeholder = { Text("پیام…") }, interactionSource = inputTouch,
                        shape = RoundedCornerShape(22.dp), maxLines = 5, modifier = Modifier.weight(1f).focusRequester(inputFocus)
                    )
                  }
                  if (rec != null && recLocked) {
                    IconButton(onClick = { finishRec(true) }) {
                        Icon(Icons.AutoMirrored.Filled.Send, contentDescription = "ارسال پیام صوتی", tint = MaterialTheme.colorScheme.primary)
                    }
                  } else if (rec != null || (text.isBlank() && editing == null && reqState != "out")) {
                    Box(
                        Modifier.size(48.dp).clip(CircleShape)
                            .background(if (rec != null) Color(0xFFE53935) else Color.Transparent)
                            .pointerInput(convo) {
                                val cancelPx = 90.dp.toPx()
                                val lockPx = 70.dp.toPx()
                                awaitEachGesture {
                                    val down = awaitFirstDown()
                                    if (!onRecStart()) return@awaitEachGesture
                                    down.consume()
                                    var result = 1 // 1 = send, 0 = cancel, 2 = locked
                                    while (true) {
                                        val ev = awaitPointerEvent()
                                        val ch = ev.changes.firstOrNull { it.id == down.id } ?: break
                                        if (!ch.pressed) { ch.consume(); break }
                                        val d = ch.position - down.position
                                        recDrag = d.x
                                        if (kotlin.math.abs(d.x) > cancelPx) { result = 0; break }
                                        if (-d.y > lockPx) { result = 2; break }
                                        ch.consume()
                                    }
                                    onRecEnd(result)
                                }
                            },
                        contentAlignment = Alignment.Center
                    ) { Text("🎤", fontSize = 22.sp) }
                  } else
                    IconButton(
                        enabled = text.isNotBlank(),
                        onClick = {
                            val t = text.trim()
                            val e = editing
                            if (e != null) {
                                editing = null; text = ""
                                if (t != e.text) scope.launch { error = Engine.editMessage(e, t) }
                            } else {
                                val r = replyTo
                                text = ""; replyTo = null
                                Engine.sendText(convo, t, r)
                            }
                        }
                    ) { Icon(Icons.AutoMirrored.Filled.Send, contentDescription = "ارسال", tint = if (text.isNotBlank()) MaterialTheme.colorScheme.primary else Color.Gray) }
                }
                if (emojiOpen && recorder == null) EmojiStickerPanel(onEmoji = { e ->
                    val cur = if (field.text == text) field else TextFieldValue(text, TextRange(text.length))
                    val a = minOf(cur.selection.start, cur.selection.end).coerceIn(0, text.length)
                    val b = maxOf(cur.selection.start, cur.selection.end).coerceIn(0, text.length)
                    val t = text.substring(0, a) + e + text.substring(b)
                    if (t.length <= 4000) { text = t; field = TextFieldValue(t, TextRange(a + e.length)) }
                }, onSticker = { k ->
                    // 1.10: a sticker goes out at once (like Telegram); a reply in progress goes with it
                    val r = replyTo
                    replyTo = null
                    Engine.sendSticker(convo, k, r)
                })
              }
            }
        }
    }

    viewer?.let { (p, vm) -> ImageViewer(p, MediaSave.refOf(vm, p)) { viewer = null } }
    forwarding?.let { list ->
        ForwardDialog(list.size, onClose = { forwarding = null }) { targets, hide ->
            Engine.forward(list, targets, hide)
            forwarding = null
            selected.clear()
            if (targets.size == 1 && targets[0] != convo) Toast.makeText(ctxForToast, "فوروارد شد به ${Engine.titleOf(targets[0])}", Toast.LENGTH_SHORT).show()
        }
    }
    info?.let { MessageInfoDialog(it) { info = null } }
    deleteAll?.let { m ->
        AlertDialog(
            onDismissRequest = { deleteAll = null },
            title = { Text("حذف برای همه") },
            text = { Text("این پیام برای همهٔ اعضای گفتگو حذف می‌شود و برنمی‌گردد.") },
            confirmButton = { TextButton(onClick = { deleteAll = null; scope.launch { error = Engine.deleteForAll(m) } }) { Text("حذف", color = MaterialTheme.colorScheme.error) } },
            dismissButton = { TextButton(onClick = { deleteAll = null }) { Text("انصراف") } }
        )
    }
    if (showProfile) ContactProfileDialog(convo) { showProfile = false }
    reactFor?.let { m -> ReactionPickerDialog(onClose = { reactFor = null }) { e -> reactFor = null; react(m, e) } }
    reactorsOf?.let { m ->
        val fresh = remember(tick, m.id) { Engine.db.get(m.id) ?: m }
        ReactorsDialog(fresh, onClose = { reactorsOf = null }) { reactorsOf = null; react(fresh, null) }
    }
    seenBy?.let { m -> SeenByDialog(m) { seenBy = null } }
    locConfirm?.let { l ->
        AlertDialog(
            onDismissRequest = { locConfirm = null },
            title = { Text("ارسال موقعیت مکانی") },
            text = {
                Text(
                    "موقعیت فعلی شما (" + GeoLocation.coords(l) + (if (l.acc > 0) "، دقت حدود ${l.acc} متر" else "") + ") برای " +
                        Engine.titleOf(convo) + " فرستاده شود؟ فقط همین یک نقطه، رمزنگاری‌شده، فرستاده می‌شود."
                )
            },
            confirmButton = { TextButton(onClick = { locConfirm = null; Engine.sendLocation(convo, l, replyTo); replyTo = null }) { Text("ارسال") } },
            dismissButton = { TextButton(onClick = { locConfirm = null }) { Text("انصراف") } }
        )
    }
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
    m: Msg, group: Boolean, progress: Float?, tail: Boolean = true, failure: String?, pinned: Boolean,
    onImage: (String) -> Unit, onReply: () -> Unit, onPin: () -> Unit, onRetry: () -> Unit, onDelete: () -> Unit,
    selecting: Boolean = false, selected: Boolean = false, onSelect: () -> Unit = {}, onEdit: () -> Unit = {},
    onForward: () -> Unit = {}, onInfo: () -> Unit = {}, onDeleteAll: () -> Unit = {},
    /** "sent" / "delivered" / "seen" for my messages */
    tick: String? = null, onReact: (String?) -> Unit = {}, onMoreReactions: () -> Unit = {},
    onReactors: () -> Unit = {}, onSeenBy: () -> Unit = {}
) {
    val ctx = LocalContext.current
    val scope = rememberCoroutineScope()
    val clipboard = LocalClipboardManager.current
    val dark = Look.dark()
    val bg = if (m.mine) (if (dark) Color(0xFF2B5278) else Color(0xFFEFFDDE)) else (if (dark) Color(0xFF182533) else Color.White)
    val fg = if (dark) Color(0xFFF5F5F5) else Color(0xFF111111)
    // 1.10.1: time and the "sent" tick are grey; delivered ✓ and seen ✓✓ are blue
    val sub = if (m.mine && !dark) Color(0xFF8A969F) else fg.copy(alpha = 0.55f)
    var menu by remember { mutableStateOf(false) }
    var playVideo by remember { mutableStateOf<String?>(null) }
    playVideo?.let { p -> VideoPlayerDialog(p, m.fileName, MediaSave.refOf(m, p)) { playVideo = null } }
    val textSize by Prefs.textSize.collectAsState()
    val autoAllowed = remember(m.id) { Prefs.autoDownloadAllowed(ctx) }
    val autoImage = m.type == "image" && m.localPath == null && m.fileId != null && m.size <= 25L * 1024 * 1024 && autoAllowed
    val autoVoice = m.type == "voice" && m.localPath == null && m.fileId != null && autoAllowed
    val tickBlue = if (dark) Color(0xFF72C8FF) else Color(0xFF2A9BF0)
    val reactable = m.id > 0 && m.status == 0 && m.type != "call" && m.text != LOCKED_TEXT
    val bigEmoji = remember(m.text, m.type, m.replyId) { (m.type == "text" && m.replyId == 0L && Emoji.onlyEmojiCount(m.text) > 0) || m.type == "sticker" }
    var showPack by remember { mutableStateOf<String?>(null) }
    showPack?.let { StickerPackDialog(it) { showPack = null } }
    val stickerGone by Stickers.gone.collectAsState()

    LaunchedEffect(m.id, m.localPath) {
        if (autoImage || autoVoice) Engine.downloadMedia(m)
    }

    Row(
        Modifier.fillMaxWidth()
            .background(if (selected) MaterialTheme.colorScheme.primary.copy(alpha = 0.18f) else Color.Transparent)
            .then(if (selecting) Modifier.clickable(onClick = onSelect) else Modifier)
            .padding(horizontal = 4.dp, vertical = 2.dp),
        horizontalArrangement = if (m.mine) Arrangement.End else Arrangement.Start
    ) {
        Box {
            Surface(
                color = if (bigEmoji) Color.Transparent else bg,
                shape = if (bigEmoji) RoundedCornerShape(14.dp) else BubbleShape(m.mine, tail),
                shadowElevation = if (bigEmoji) 0.dp else 1.dp,
                modifier = Modifier.widthIn(max = 300.dp).combinedClickable(
                    onClick = { if (selecting) onSelect() },
                    onLongClick = { if (selecting) onSelect() else if (m.type != "call") menu = true }
                )
            ) {
                Column(Modifier.padding(start = if (m.mine || bigEmoji) 10.dp else 16.dp, end = if (m.mine && !bigEmoji) 16.dp else 10.dp, top = 6.dp, bottom = 6.dp)) {
                    if (group && !m.mine) {
                        Text(Engine.nameOf(m.sender), color = U.colorFor(m.sender), fontWeight = FontWeight.Bold, fontSize = 13.sp)
                    }
                    if (m.fwFrom != null) {
                        Text(
                            "فوروارد از " + (Engine.users.value.firstOrNull { it.username == m.fwFrom }?.displayName?.takeIf { it.isNotBlank() } ?: m.fwName?.takeIf { it.isNotBlank() } ?: m.fwFrom),
                            color = MaterialTheme.colorScheme.primary, fontSize = 12.sp, fontWeight = FontWeight.SemiBold
                        )
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
                            ImageContent(m, progress, autoImage, onImage, onLong = { if (selecting) onSelect() else menu = true })
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
                                    val waiting by Engine.waitingDownloads.collectAsState()
                                    if (progress != null) {
                                        Text("${(progress * 100).toInt()}٪", color = sub, fontSize = 12.sp)
                                    } else if (m.id in waiting) {
                                        // 1.8: cut off by the network; continues by itself from where it stopped
                                        Text("⏸ ادامه بعد از اتصال", color = sub, fontSize = 12.sp, modifier = Modifier.clickable { Engine.resumeDownloads() })
                                    } else {
                                        // 1.7: videos play in Sepan's own player, no "open with…" menu
                                        val isVideo = (m.mime ?: "").startsWith("video/")
                                        TextButton(onClick = {
                                            scope.launch {
                                                val p = Engine.downloadMedia(m)
                                                if (p != null) { if (isVideo) playVideo = p else openFile(ctx, p, m.mime) }
                                                else Toast.makeText(ctx, if (m.id in Engine.waitingDownloads.value) "دریافت قطع شد؛ با برگشتن اینترنت خودش از همان‌جا ادامه می‌دهد" else "دریافت فایل ناموفق بود", Toast.LENGTH_SHORT).show()
                                            }
                                        }) { Text(if (isVideo) (if (m.localPath != null) "▶ پخش" else "▶ دانلود و پخش") else if (m.localPath != null) "باز کردن" else "دانلود") }
                                    }
                                }
                            }
                            if (progress != null) ProgressBar(progress, Modifier.fillMaxWidth().padding(top = 4.dp))
                        }
                        "voice" -> VoiceContent(m, progress, sub)
                        "location" -> m.loc?.let { LocationContent(it, fg, sub) } ?: Text(m.text, color = fg, fontSize = textSize.sp)
                        "sticker" -> if (m.stk != null) StickerContent(m) else Text(m.text, color = fg, fontSize = textSize.sp)
                        "call" -> Text(m.text, color = sub, fontSize = 14.sp)
                        else -> if (bigEmoji) BigEmoji(m.text, m.id, textSize * 2) else MentionText(m.text, fg, textSize.sp, LocalOpenMention.current)
                    }
                    val rx = remember(m.reactions) { Engine.reactionsOf(m) }
                    if (rx.isNotEmpty()) {
                        Row(Modifier.padding(top = 4.dp), horizontalArrangement = Arrangement.spacedBy(4.dp)) {
                            for ((e, us) in rx) {
                                val mineR = Engine.me in us
                                Box(
                                    Modifier.clip(RoundedCornerShape(12.dp))
                                        .background(if (mineR) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.primary.copy(alpha = 0.14f))
                                        .clickable(enabled = !selecting) { onReactors() }
                                        .padding(horizontal = 8.dp, vertical = 2.dp)
                                ) { Text(e + if (us.size > 1) " ${us.size}" else "", fontSize = 14.sp, color = if (mineR) Color.White else fg) }
                            }
                        }
                    }
                    if (m.status == 2) {
                        Text(failure ?: "ارسال نشد", color = MaterialTheme.colorScheme.error, fontSize = 12.sp)
                        TextButton(onClick = onRetry) { Text("تلاش دوباره") }
                    }
                    Row(Modifier.align(Alignment.End), verticalAlignment = Alignment.CenterVertically) {
                        if (pinned) Text("📌 ", fontSize = 11.sp)
                        if (m.edited > 0) {
                            val sameDay = U.dayKey(m.edited) == U.dayKey(m.ts)
                            Text("ویرایش‌شده " + (if (sameDay) "" else U.day(m.edited) + " ") + U.time(m.edited) + " · ", color = sub, fontSize = 11.sp)
                        }
                        Text(U.time(m.ts), color = sub, fontSize = 11.sp)
                        if (m.mine && m.type != "call") {
                            when (m.status) {
                                1 -> Text(" 🕓", color = sub, fontSize = 11.sp)
                                2 -> Text(" ⚠", color = MaterialTheme.colorScheme.error, fontSize = 11.sp)
                                else -> when (tick) {
                                    "seen" -> Text(" ✓✓", color = tickBlue, fontSize = 11.sp, fontWeight = FontWeight.Bold)
                                    "delivered" -> Text(" ✓", color = tickBlue, fontSize = 11.sp, fontWeight = FontWeight.Bold)
                                    else -> Text(" ✓", color = sub, fontSize = 11.sp)
                                }
                            }
                        }
                    }
                }
            }
            DropdownMenu(expanded = menu, onDismissRequest = { menu = false }) {
                if (reactable) {
                    val myR = m.reactions[Engine.me]
                    Row(Modifier.padding(horizontal = 6.dp), verticalAlignment = Alignment.CenterVertically) {
                        for (e in Engine.QUICK_REACTIONS) {
                            Box(
                                Modifier.clip(CircleShape).background(if (e == myR) MaterialTheme.colorScheme.primary.copy(alpha = 0.22f) else Color.Transparent)
                                    .clickable { menu = false; onReact(if (e == myR) null else e) }.padding(5.dp)
                            ) { Text(e, fontSize = 21.sp) }
                        }
                        Box(Modifier.clip(CircleShape).clickable { menu = false; onMoreReactions() }.padding(5.dp)) { Text("➕", fontSize = 18.sp) }
                    }
                }
                if (m.status == 0) DropdownMenuItem(text = { Text("پاسخ") }, onClick = { menu = false; onReply() })
                if (Engine.canEdit(m)) DropdownMenuItem(text = { Text("ویرایش") }, onClick = { menu = false; onEdit() })
                if (m.status == 0 && m.id > 0) DropdownMenuItem(text = { Text("فوروارد") }, onClick = { menu = false; onForward() })
                if (m.status == 0 && m.id > 0) DropdownMenuItem(text = { Text("انتخاب") }, onClick = { menu = false; onSelect() })
                if (m.status == 0 && m.fileId != null && m.type in MEDIA_TYPES) {
                    val media = LocalMediaActions.current
                    val galleryOk = m.type == "image" || MediaSave.isGalleryType(m.mime)
                    if (media != null) {
                        if (galleryOk) DropdownMenuItem(text = { Text("ذخیره در گالری") }, onClick = { menu = false; media.withMsg(m) { media.gallery(it) } })
                        DropdownMenuItem(text = { Text("ذخیره در…") }, onClick = { menu = false; media.withMsg(m) { media.saveAs(it) } })
                        DropdownMenuItem(text = { Text("اشتراک‌گذاری") }, onClick = { menu = false; media.withMsg(m) { media.share(it) } })
                    }
                }
                if (m.type == "text") DropdownMenuItem(text = { Text("کپی") }, onClick = { menu = false; clipboard.setText(AnnotatedString(m.text)) })
                m.stk?.let { k ->
                    DropdownMenuItem(text = { Text(if (Stickers.isFav(k.id)) "برداشتن از علاقه‌مندی‌ها" else "⭐ افزودن به علاقه‌مندی‌ها") }, onClick = {
                        menu = false
                        val fav = Stickers.toggleFav(k)
                        Toast.makeText(ctx, if (fav) "به علاقه‌مندی‌ها اضافه شد ⭐" else "از علاقه‌مندی‌ها برداشته شد", Toast.LENGTH_SHORT).show()
                    })
                    if (k.id !in stickerGone) DropdownMenuItem(text = { Text("🎭 نمایش پک") }, onClick = { menu = false; showPack = k.p })
                }
                if (m.id > 0) DropdownMenuItem(text = { Text("اطلاعات پیام") }, onClick = { menu = false; onInfo() })
                if (group && m.mine && m.id > 0 && m.status == 0) DropdownMenuItem(text = { Text("دیده شده توسط…") }, onClick = { menu = false; onSeenBy() })
                if (m.status == 0 && m.id > 0) DropdownMenuItem(text = { Text(if (pinned) "برداشتن پین" else "پین کردن") }, onClick = { menu = false; onPin() })
                if (m.status == 2) DropdownMenuItem(text = { Text("تلاش دوباره") }, onClick = { menu = false; onRetry() })
                if (m.mine && m.status == 0 && m.id > 0) DropdownMenuItem(
                    text = { Text("حذف برای همه", color = MaterialTheme.colorScheme.error) },
                    onClick = { menu = false; onDeleteAll() }
                )
                DropdownMenuItem(
                    text = { Text(if (m.status != 0) "لغو ارسال" else "حذف (فقط برای من)") },
                    onClick = { menu = false; onDelete() }
                )
            }
        }
    }
}

/** Play button, waveform (tap to jump) and length of a voice message. */
@Composable
private fun VoiceContent(m: Msg, progress: Float?, sub: Color) {
    val ctx = LocalContext.current
    val scope = rememberCoroutineScope()
    val ps by VoicePlayer.state.collectAsState()
    val current = ps.id == m.id
    val playing = current && ps.playing
    val total = if (current && ps.dur > 0) ps.dur else m.dur
    val frac = if (current && total > 0) (ps.pos.toFloat() / total).coerceIn(0f, 1f) else 0f
    val accent = MaterialTheme.colorScheme.primary
    Row(verticalAlignment = Alignment.CenterVertically) {
        Box(
            Modifier.size(44.dp).clip(CircleShape).background(accent).clickable {
                val p = m.localPath
                if (p != null && File(p).exists()) VoicePlayer.toggle(m.id, p)
                else if (progress == null && m.fileId != null) scope.launch {
                    val path = Engine.downloadMedia(m)
                    if (path != null) VoicePlayer.toggle(m.id, path)
                    else Toast.makeText(ctx, "دریافت پیام صوتی ناموفق بود؛ دوباره بزنید", Toast.LENGTH_SHORT).show()
                }
            },
            contentAlignment = Alignment.Center
        ) {
            if (progress != null && m.localPath == null) CircularProgressIndicator(Modifier.size(24.dp), color = Color.White, strokeWidth = 2.dp)
            else Text(if (playing) "❚❚" else "▶", color = Color.White, fontSize = 16.sp)
        }
        Column(Modifier.padding(start = 8.dp)) {
            val bars = if (m.wave.isNotEmpty()) m.wave else List(50) { 3 }
            Canvas(
                Modifier.width(160.dp).height(30.dp).pointerInput(m.id) {
                    detectTapGestures { o -> VoicePlayer.seek(m.id, o.x / size.width) }
                }
            ) {
                val n = bars.size
                val w = size.width / n
                val bw = (w * 0.62f).coerceAtLeast(1.5f)
                val minH = 2.dp.toPx()
                for (i in 0 until n) {
                    val h = maxOf(minH, bars[i] / 31f * size.height)
                    drawRoundRect(
                        color = if ((i + 0.5f) / n <= frac) accent else sub.copy(alpha = 0.45f),
                        topLeft = Offset(i * w + (w - bw) / 2, (size.height - h) / 2),
                        size = Size(bw, h), cornerRadius = CornerRadius(bw / 2, bw / 2)
                    )
                }
            }
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text(U.dur(if (current && ps.pos > 0) ps.pos else total), color = sub, fontSize = 11.sp)
                Spacer(Modifier.width(8.dp))
                // playback speed 1x -> 1.5x -> 2x (remembered for the next voice messages)
                val rate by VoicePlayer.rate.collectAsState()
                Text(
                    when (rate) { 1.5f -> "1.5×"; 2f -> "2×"; else -> "1×" },
                    color = if (rate != 1f) accent else sub, fontSize = 11.sp, fontWeight = if (rate != 1f) FontWeight.Bold else FontWeight.Normal,
                    modifier = Modifier.clip(RoundedCornerShape(8.dp)).border(1.dp, if (rate != 1f) accent else sub.copy(alpha = 0.5f), RoundedCornerShape(8.dp))
                        .clickable { VoicePlayer.cycleRate() }.padding(horizontal = 6.dp, vertical = 1.dp)
                )
            }
        }
    }
}

/** A shared location: tap opens it in the phone's map app (no map picture, so no request leaves the phone). */
@Composable
private fun LocationContent(l: Loc, fg: Color, sub: Color) {
    val ctx = LocalContext.current
    Row(
        Modifier.clip(RoundedCornerShape(10.dp)).clickable { GeoLocation.openMap(ctx, l) }.padding(4.dp),
        verticalAlignment = Alignment.CenterVertically
    ) {
        Box(Modifier.size(46.dp).clip(CircleShape).background(Color(0xFFE53935)), contentAlignment = Alignment.Center) { Text("📍", fontSize = 22.sp) }
        Column(Modifier.padding(horizontal = 10.dp)) {
            Text("موقعیت مکانی", color = fg, fontWeight = FontWeight.SemiBold, fontSize = 15.sp)
            Text(GeoLocation.coords(l) + if (l.acc > 0) " · ±${l.acc} م" else "", color = sub, fontSize = 12.sp)
            Text("باز کردن در نقشه", color = MaterialTheme.colorScheme.primary, fontSize = 12.sp)
        }
    }
}

@OptIn(ExperimentalFoundationApi::class)
@Composable
private fun ImageContent(m: Msg, progress: Float?, auto: Boolean, onImage: (String) -> Unit, onLong: () -> Unit) {
    val scope = rememberCoroutineScope()
    val bmp by produceState<ImageBitmap?>(null, m.localPath) {
        value = m.localPath?.let { p -> withContext(Dispatchers.IO) { decodeSampled(p, 900) } }
    }
    val ratio = if (m.w > 0 && m.h > 0) (m.w.toFloat() / m.h).coerceIn(0.5f, 2f) else 1f
    Box(
        Modifier.width(240.dp).aspectRatio(ratio).clip(RoundedCornerShape(8.dp))
            .background(Color.Gray.copy(alpha = 0.25f))
            // 1.12: a long press opens the message menu (reply, forward, save…), like every other message
            .combinedClickable(onLongClick = onLong) {
                if (m.localPath != null) onImage(m.localPath)
                else if (!auto && m.fileId != null && progress == null) scope.launch { Engine.downloadMedia(m) }
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

/** Save / share actions of the open chat (1.12); hoisted so the pickers' results survive bubbles scrolling away. */
val LocalMediaActions = staticCompositionLocalOf<MediaActions?> { null }
private val MEDIA_TYPES = setOf("image", "file", "voice")

@Composable
fun ImageViewer(path: String, ref: MediaRef, onClose: () -> Unit) {
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
            // 1.12: ⋮ = save to gallery, save to…, share
            MediaMoreMenu(ref, Modifier.align(Alignment.TopStart).padding(16.dp))
        }
    }
}

/** Opens the chat of an @username tapped in a message (set by ChatScreen). */
val LocalOpenMention = staticCompositionLocalOf<(String) -> Unit> { {} }
private val MENTION = Regex("@([A-Za-z0-9_]{2,20})(?![A-Za-z0-9_])")

/** Message text with tappable @usernames (1.7). */
@Composable
fun MentionText(text: String, color: Color, size: TextUnit, onMention: (String) -> Unit) {
    val accent = MaterialTheme.colorScheme.primary
    val open by rememberUpdatedState(onMention)
    val annotated = remember(text, accent) {
        buildAnnotatedString {
            var i = 0
            for (mm in MENTION.findAll(text)) {
                val start = mm.range.first
                // not an e-mail address (name@host)
                if (start > 0 && (text[start - 1].isLetterOrDigit() || text[start - 1] == '_' || text[start - 1] == '.')) continue
                append(text.substring(i, start))
                val name = mm.groupValues[1].lowercase()
                withLink(LinkAnnotation.Clickable("u:$name", TextLinkStyles(SpanStyle(color = accent))) { open(name) }) { append(mm.value) }
                i = mm.range.last + 1
            }
            append(text.substring(i))
        }
    }
    Text(annotated, color = color, fontSize = size, style = TextStyle(textDirection = TextDirection.Content))
}


/** Preview of a photo about to be sent, with a «compress» switch whose last value is remembered. */
@Composable
private fun PhotoSendDialog(uri: Uri, onSend: (Boolean) -> Unit, onCancel: () -> Unit) {
    val ctx = LocalContext.current
    var compress by remember { mutableStateOf(Engine.prefs.getBoolean("photo_compress", true)) }
    val img by produceState<ImageBitmap?>(null, uri) { value = withContext(Dispatchers.IO) { previewOf(ctx, uri, 900) } }
    val size = remember(uri) { U.fileSize(ctx, uri) }
    AlertDialog(
        onDismissRequest = onCancel,
        title = { Text("ارسال عکس") },
        text = {
            Column {
                Box(Modifier.fillMaxWidth().heightIn(min = 120.dp, max = 360.dp), contentAlignment = Alignment.Center) {
                    val b = img
                    if (b != null) Image(b, contentDescription = null, contentScale = ContentScale.Fit, modifier = Modifier.fillMaxWidth().heightIn(max = 360.dp).clip(RoundedCornerShape(8.dp)))
                    else CircularProgressIndicator()
                }
                Spacer(Modifier.height(10.dp))
                Row(Modifier.fillMaxWidth().clickable { compress = !compress }, verticalAlignment = Alignment.CenterVertically) {
                    Column(Modifier.weight(1f)) {
                        Text("فشرده‌سازی", fontWeight = FontWeight.SemiBold)
                        Text(
                            if (compress) "حجم کمتر، کیفیت مناسب چت" else "عکس اصلی" + (if (size > 0) " (" + U.size(size) + ")" else ""),
                            fontSize = 12.sp, color = MaterialTheme.colorScheme.onSurface.copy(alpha = 0.6f)
                        )
                    }
                    Switch(checked = compress, onCheckedChange = { compress = it })
                }
            }
        },
        confirmButton = {
            TextButton(onClick = { Engine.prefs.edit().putBoolean("photo_compress", compress).apply(); onSend(compress) }) { Text("ارسال") }
        },
        dismissButton = { TextButton(onClick = onCancel) { Text("انصراف") } }
    )
}
