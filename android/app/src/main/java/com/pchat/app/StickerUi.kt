package com.pchat.app

import android.graphics.Bitmap
import android.widget.Toast
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.gestures.detectDragGestures
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.grid.GridCells
import androidx.compose.foundation.lazy.grid.LazyVerticalGrid
import androidx.compose.foundation.lazy.grid.items
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Slider
import androidx.compose.material3.Surface
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableFloatStateOf
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
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

private val dim: Color @Composable get() = MaterialTheme.colorScheme.onSurface.copy(alpha = 0.6f)

/** A sticker image (cached on the phone, fetched from the server the first time); "deleted" when its pack is gone. */
@Composable
fun StickerImage(id: String, modifier: Modifier = Modifier) {
    val gone by Stickers.gone.collectAsState()
    val bmp by produceState<ImageBitmap?>(null, id) { value = Stickers.bitmap(id) }
    val b = bmp
    when {
        b != null -> Image(b, contentDescription = "استیکر", contentScale = ContentScale.Fit, modifier = modifier)
        id in gone -> Box(modifier.border(1.dp, dim, RoundedCornerShape(12.dp)).padding(6.dp), contentAlignment = Alignment.Center) {
            Text("استیکر حذف شده", fontSize = 12.sp, color = dim, textAlign = TextAlign.Center)
        }
        else -> Box(modifier.clip(RoundedCornerShape(12.dp)).background(dim.copy(alpha = 0.12f)))
    }
}

/** The composer's panel: emoji (as before) or stickers, remembered between chats. */
@Composable
fun EmojiStickerPanel(onEmoji: (String) -> Unit, onSticker: (Stk) -> Unit) {
    var mode by remember { mutableStateOf(Engine.prefs.getString("panel_mode", "emoji") ?: "emoji") }
    Column(Modifier.fillMaxWidth()) {
        Row(Modifier.padding(horizontal = 8.dp, vertical = 2.dp), horizontalArrangement = Arrangement.spacedBy(6.dp)) {
            for ((k, label) in listOf("emoji" to "شکلک", "sticker" to "استیکر")) {
                val on = k == mode
                Box(
                    Modifier.clip(RoundedCornerShape(14.dp))
                        .background(if (on) MaterialTheme.colorScheme.primary else Color.Transparent)
                        .border(1.dp, if (on) MaterialTheme.colorScheme.primary else dim.copy(alpha = 0.3f), RoundedCornerShape(14.dp))
                        .clickable { mode = k; Engine.prefs.edit().putString("panel_mode", k).apply() }
                        .padding(horizontal = 14.dp, vertical = 4.dp)
                ) { Text(label, fontSize = 14.sp, color = if (on) Color.White else dim) }
            }
        }
        if (mode == "sticker") StickerPanel(onSticker) else EmojiPanel(onEmoji)
    }
}

@OptIn(ExperimentalFoundationApi::class)
@Composable
private fun StickerPanel(onSticker: (Stk) -> Unit) {
    val ctx = LocalContext.current
    val st by Stickers.state.collectAsState()
    val favs by Stickers.favs.collectAsState()
    val recent by Stickers.recent.collectAsState()
    var manage by remember { mutableStateOf(false) }
    var tab by remember { mutableStateOf(Engine.prefs.getString("stk_tab", "") ?: "") }
    LaunchedEffect(Unit) { Stickers.refresh() }
    data class Tab(val key: String, val icon: String?, val emoji: String, val list: List<Stk>)
    val tabs = buildList {
        if (favs.isNotEmpty()) add(Tab("fav", null, "⭐", favs))
        if (recent.isNotEmpty()) add(Tab("rec", null, "🕓", recent))
        for (p in st.packs) if (p.stickers.isNotEmpty()) add(Tab(p.id, p.stickers[0].id, "", p.stickers.map { Stk(it.id, p.id, it.emoji) }))
    }
    val cur = tabs.firstOrNull { it.key == tab } ?: tabs.firstOrNull()
    Column(Modifier.fillMaxWidth().height(290.dp)) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            LazyRow(Modifier.weight(1f).padding(vertical = 4.dp)) {
                items(tabs) { t ->
                    Box(
                        Modifier.padding(horizontal = 2.dp).size(44.dp).clip(RoundedCornerShape(10.dp))
                            .background(if (t == cur) MaterialTheme.colorScheme.primary.copy(alpha = 0.18f) else Color.Transparent)
                            .clickable { tab = t.key; Engine.prefs.edit().putString("stk_tab", t.key).apply() }.padding(4.dp),
                        contentAlignment = Alignment.Center
                    ) { if (t.icon != null) StickerImage(t.icon, Modifier.fillMaxSize()) else Text(t.emoji, fontSize = 20.sp) }
                }
            }
            IconButton(onClick = { manage = true }) { Text("⚙", fontSize = 20.sp) }
        }
        HorizontalDivider()
        if (cur == null) {
            Column(Modifier.fillMaxWidth().padding(24.dp), horizontalAlignment = Alignment.CenterHorizontally) {
                Text("هنوز استیکری ندارید.", color = dim)
                TextButton(onClick = { manage = true }) { Text("ساختن یا افزودن استیکر") }
            }
        } else {
            LazyVerticalGrid(columns = GridCells.Adaptive(76.dp), modifier = Modifier.fillMaxWidth().weight(1f)) {
                items(cur.list, key = { it.id }) { k ->
                    Box(
                        Modifier.aspectRatio(1f).clip(RoundedCornerShape(10.dp)).combinedClickable(
                            onClick = { onSticker(k) },
                            onLongClick = {
                                val fav = Stickers.toggleFav(k)
                                Toast.makeText(ctx, if (fav) "به علاقه‌مندی‌ها اضافه شد ⭐" else "از علاقه‌مندی‌ها برداشته شد", Toast.LENGTH_SHORT).show()
                            }
                        ).padding(5.dp)
                    ) { StickerImage(k.id, Modifier.fillMaxSize()) }
                }
            }
        }
    }
    if (manage) StickerManager { manage = false }
}

/** A sticker in a chat: large, no bubble. */
@Composable
fun StickerContent(m: Msg) {
    val k = m.stk ?: return
    StickerImage(k.id, Modifier.size(160.dp))
}

/** A pack seen from a sticker in a chat: its stickers and «add to my stickers». */
@Composable
fun StickerPackDialog(packId: String, onClose: () -> Unit) {
    val scope = rememberCoroutineScope()
    val ctx = LocalContext.current
    var pack by remember { mutableStateOf<StickerPack?>(null) }
    var err by remember { mutableStateOf<String?>(null) }
    var busy by remember { mutableStateOf(false) }
    LaunchedEffect(packId) { val (p, e) = Stickers.pack(packId); pack = p; err = e }
    val p = pack
    AlertDialog(
        onDismissRequest = onClose,
        title = { Text(p?.title ?: "پک استیکر") },
        text = {
            when {
                err != null -> Text(err ?: "")
                p == null -> CircularProgressIndicator()
                else -> LazyVerticalGrid(columns = GridCells.Adaptive(72.dp), modifier = Modifier.height(320.dp)) {
                    items(p.stickers, key = { it.id }) { s -> Box(Modifier.aspectRatio(1f).padding(4.dp)) { StickerImage(s.id, Modifier.fillMaxSize()) } }
                }
            }
        },
        confirmButton = {
            if (p != null && !p.mine && !p.official) TextButton(enabled = !busy, onClick = {
                busy = true
                scope.launch {
                    val e = if (p.added) Stickers.removePack(p.id) else Stickers.addPack(p.id)
                    Toast.makeText(ctx, e ?: if (p.added) "پک برداشته شد" else "به استیکرهای شما اضافه شد ✓", Toast.LENGTH_SHORT).show()
                    onClose()
                }
            }) { Text(if (p.added) "برداشتن از استیکرهای من" else "افزودن به استیکرهای من (${p.stickers.size})") }
            else if (p != null) Text(if (p.mine) "این پک شماست" else "پک عمومی؛ برای همه هست", color = dim, fontSize = 13.sp)
        },
        dismissButton = { TextButton(onClick = onClose) { Text("بستن") } }
    )
}

/** Settings › استیکرهای من (also the ⚙ of the panel): my packs and the official ones. */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun StickerManager(onClose: () -> Unit) {
    val scope = rememberCoroutineScope()
    val ctx = LocalContext.current
    val st by Stickers.state.collectAsState()
    var open by remember { mutableStateOf<String?>(null) }
    var showPack by remember { mutableStateOf<String?>(null) }
    var newPack by remember { mutableStateOf(false) }
    LaunchedEffect(Unit) { Stickers.refresh() }
    Dialog(onDismissRequest = onClose, properties = DialogProperties(usePlatformDefaultWidth = false)) {
        val o = open
        if (o != null) { StickerPackEditor(o) { open = null }; return@Dialog }
        Scaffold(
            topBar = {
                TopAppBar(
                    colors = Look.barColors(),
                    navigationIcon = { IconButton(onClick = onClose) { Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = "بازگشت") } },
                    title = { Text("استیکرهای من", fontWeight = FontWeight.Bold) }
                )
            }
        ) { pad ->
            LazyColumn(Modifier.padding(pad).fillMaxSize()) {
                item {
                    if (st.create) Button(onClick = { newPack = true }, modifier = Modifier.padding(16.dp)) { Text("➕ ساختن پک تازه") }
                    else Text("مدیر سرور ساختن استیکر را خاموش کرده است؛ پک‌های عمومی و پک‌هایی که دیگران فرستاده‌اند در دسترس‌اند.",
                        fontSize = 13.sp, color = dim, modifier = Modifier.padding(16.dp))
                }
                val own = st.packs.filter { !it.official }
                if (own.isNotEmpty()) item { SectionTitle("پک‌های من") }
                items(own, key = { it.id }) { p ->
                    PackRow(p, onClick = { if (p.mine) open = p.id else showPack = p.id }) {
                        IconButton(onClick = { scope.launch { Stickers.move(p.id, -1)?.let { Toast.makeText(ctx, it, Toast.LENGTH_SHORT).show() } } }) { Text("▲") }
                        IconButton(onClick = { scope.launch { Stickers.move(p.id, 1)?.let { Toast.makeText(ctx, it, Toast.LENGTH_SHORT).show() } } }) { Text("▼") }
                    }
                }
                val official = st.packs.filter { it.official }
                if (official.isNotEmpty()) item { SectionTitle("پک‌های عمومی") }
                items(official, key = { it.id }) { p -> PackRow(p, onClick = { showPack = p.id }) {} }
                item {
                    Text(
                        "برای افزودن پک کسی دیگر، روی استیکری که فرستاده نگه دارید و «نمایش پک» را بزنید. با نگه داشتن یک استیکر در پنل، به علاقه‌مندی‌ها اضافه یا از آن برداشته می‌شود.",
                        fontSize = 12.sp, color = dim, modifier = Modifier.padding(16.dp)
                    )
                }
            }
        }
    }
    showPack?.let { StickerPackDialog(it) { showPack = null } }
    if (newPack) TextInputDialog("پک تازه", "نام پک", "") { t ->
        newPack = false
        if (t != null) scope.launch {
            val (id, e) = Stickers.createPack(t)
            if (e != null) Toast.makeText(ctx, e, Toast.LENGTH_SHORT).show() else open = id
        }
    }
}

@Composable
private fun PackRow(p: StickerPack, onClick: () -> Unit, actions: @Composable () -> Unit) {
    Row(Modifier.fillMaxWidth().clickable(onClick = onClick).padding(horizontal = 16.dp, vertical = 8.dp), verticalAlignment = Alignment.CenterVertically) {
        Box(Modifier.size(44.dp), contentAlignment = Alignment.Center) {
            if (p.stickers.isNotEmpty()) StickerImage(p.stickers[0].id, Modifier.fillMaxSize()) else Text("🎭", fontSize = 26.sp)
        }
        Column(Modifier.weight(1f).padding(horizontal = 12.dp)) {
            Text(p.title, fontWeight = FontWeight.SemiBold)
            Text("${p.stickers.size} استیکر · " + if (p.official) "عمومی" else if (p.mine) "ساختهٔ شما" else "افزوده‌شده", fontSize = 12.sp, color = dim)
        }
        actions()
    }
}

@Composable
private fun TextInputDialog(title: String, label: String, initial: String, onDone: (String?) -> Unit) {
    var t by remember { mutableStateOf(initial) }
    AlertDialog(
        onDismissRequest = { onDone(null) },
        title = { Text(title) },
        text = { OutlinedTextField(t, { if (it.length <= 64) t = it }, singleLine = true, label = { Text(label) }) },
        confirmButton = { TextButton(enabled = t.isNotBlank(), onClick = { onDone(t.trim()) }) { Text("ذخیره") } },
        dismissButton = { TextButton(onClick = { onDone(null) }) { Text("انصراف") } }
    )
}

/** One of my packs: make a sticker from a photo, import pictures or a zip, delete stickers, rename, delete. */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun StickerPackEditor(id: String, onBack: () -> Unit) {
    val scope = rememberCoroutineScope()
    val ctx = LocalContext.current
    val st by Stickers.state.collectAsState()
    val p = st.packs.firstOrNull { it.id == id }
    var status by remember { mutableStateOf<String?>(null) }
    var photo by remember { mutableStateOf<Bitmap?>(null) }
    var rename by remember { mutableStateOf(false) }
    var confirmDelete by remember { mutableStateOf(false) }
    var deleteSticker by remember { mutableStateOf<String?>(null) }
    val pickPhoto = rememberLauncherForActivityResult(ActivityResultContracts.GetContent()) { uri ->
        if (uri != null) scope.launch { photo = Stickers.loadPhoto(uri) ?: run { status = "این عکس باز نشد"; null } }
    }
    val pickFiles = rememberLauncherForActivityResult(ActivityResultContracts.OpenMultipleDocuments()) { uris ->
        if (uris.isNotEmpty()) scope.launch {
            val (ok, err) = Stickers.import(id, uris) { i, n -> status = "در حال افزودن $i از $n…" }
            status = "$ok استیکر اضافه شد" + (err?.let { " · $it" } ?: "")
        }
    }
    Scaffold(
        topBar = {
            TopAppBar(
                colors = Look.barColors(),
                navigationIcon = { IconButton(onClick = onBack) { Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = "بازگشت") } },
                title = { Text(p?.title ?: "پک", fontWeight = FontWeight.Bold) }
            )
        }
    ) { pad ->
        if (p == null) { Box(Modifier.padding(pad).fillMaxSize(), contentAlignment = Alignment.Center) { Text("این پک پیدا نشد") }; return@Scaffold }
        Column(Modifier.padding(pad).fillMaxSize()) {
            Row(Modifier.fillMaxWidth().padding(12.dp), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                Button(onClick = { pickPhoto.launch("image/*") }) { Text("✂ ساخت از عکس") }
                OutlinedButton(onClick = { pickFiles.launch(arrayOf("image/*", "application/zip", "application/x-zip-compressed")) }) { Text("⤒ فایل‌ها یا zip") }
            }
            Text(
                "${p.stickers.size} از ${st.perPack} استیکر · هر استیکر حداکثر ${st.kb} کیلوبایت. عکس‌های PNG و WebP شفاف، شفاف می‌مانند. برای حذف، روی استیکر بزنید.",
                fontSize = 12.sp, color = dim, modifier = Modifier.padding(horizontal = 16.dp)
            )
            status?.let { Text(it, fontSize = 13.sp, color = MaterialTheme.colorScheme.primary, modifier = Modifier.padding(horizontal = 16.dp, vertical = 4.dp)) }
            LazyVerticalGrid(columns = GridCells.Adaptive(80.dp), modifier = Modifier.fillMaxWidth().weight(1f).padding(8.dp)) {
                items(p.stickers, key = { it.id }) { s ->
                    Box(Modifier.aspectRatio(1f).clip(RoundedCornerShape(10.dp)).clickable { deleteSticker = s.id }.padding(5.dp)) { StickerImage(s.id, Modifier.fillMaxSize()) }
                }
            }
            Row(Modifier.fillMaxWidth().padding(12.dp), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                TextButton(onClick = { rename = true }) { Text("تغییر نام") }
                TextButton(onClick = { confirmDelete = true }) { Text("حذف پک", color = MaterialTheme.colorScheme.error) }
            }
        }
    }
    photo?.let { ph -> StickerMakerDialog(ph, id, onDone = { msg -> photo = null; if (msg != null) status = msg }) }
    if (rename && p != null) TextInputDialog("تغییر نام پک", "نام پک", p.title) { t ->
        rename = false
        if (t != null) scope.launch { Stickers.renamePack(id, t)?.let { status = it } }
    }
    deleteSticker?.let { sid ->
        AlertDialog(
            onDismissRequest = { deleteSticker = null },
            title = { Text("حذف استیکر") },
            text = { StickerImage(sid, Modifier.size(120.dp)) },
            confirmButton = { TextButton(onClick = { deleteSticker = null; scope.launch { Stickers.deleteSticker(sid)?.let { status = it } } }) { Text("حذف", color = MaterialTheme.colorScheme.error) } },
            dismissButton = { TextButton(onClick = { deleteSticker = null }) { Text("انصراف") } }
        )
    }
    if (confirmDelete && p != null) AlertDialog(
        onDismissRequest = { confirmDelete = false },
        title = { Text("حذف پک") },
        text = { Text("پک «${p.title}» برای همه حذف می‌شود و استیکرهایی که قبلاً فرستاده شده‌اند «استیکر حذف شده» نشان داده می‌شوند.") },
        confirmButton = {
            TextButton(onClick = {
                confirmDelete = false
                scope.launch {
                    val e = Stickers.deletePack(id)
                    if (e != null) Toast.makeText(ctx, e, Toast.LENGTH_SHORT).show() else onBack()
                }
            }) { Text("حذف", color = MaterialTheme.colorScheme.error) }
        },
        dismissButton = { TextButton(onClick = { confirmDelete = false }) { Text("انصراف") } }
    )
}

/** Makes one sticker from a photo: square or round crop, zoom, drag to move, an optional caption and emoji. */
@Composable
private fun StickerMakerDialog(photo: Bitmap, packId: String, onDone: (String?) -> Unit) {
    val scope = rememberCoroutineScope()
    var round by remember { mutableStateOf(false) }
    var zoom by remember { mutableFloatStateOf(1f) }
    var dx by remember { mutableFloatStateOf(0f) }
    var dy by remember { mutableFloatStateOf(0f) }
    var caption by remember { mutableStateOf("") }
    var emoji by remember { mutableStateOf("") }
    var busy by remember { mutableStateOf(false) }
    var err by remember { mutableStateOf<String?>(null) }
    val preview = remember(round, zoom, dx, dy, caption) { Stickers.render(photo, 320, round, zoom, dx, dy, caption).asImageBitmap() }
    Dialog(onDismissRequest = { if (!busy) onDone(null) }) {
        Surface(shape = RoundedCornerShape(16.dp)) {
            Column(Modifier.padding(16.dp).verticalScroll(rememberScrollState()), horizontalAlignment = Alignment.CenterHorizontally) {
                Text("ساخت استیکر", fontWeight = FontWeight.Bold, fontSize = 18.sp)
                Spacer(Modifier.height(8.dp))
                var boxPx by remember { mutableFloatStateOf(1f) }
                Box(
                    Modifier.size(240.dp).clip(RoundedCornerShape(12.dp)).background(Color(0x22888888))
                        .pointerInput(Unit) {
                            boxPx = size.width.toFloat().coerceAtLeast(1f)
                            detectDragGestures { ch, d -> ch.consume(); dx += d.x / boxPx; dy += d.y / boxPx }
                        }
                ) { Image(preview, contentDescription = null, modifier = Modifier.fillMaxSize()) }
                Text("عکس را بکشید تا جابه‌جا شود.", fontSize = 12.sp, color = dim)
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Text("بزرگ‌نمایی", fontSize = 13.sp)
                    Slider(zoom, { zoom = it }, valueRange = 1f..4f, modifier = Modifier.width(170.dp))
                }
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Text("دایره‌ای", fontSize = 13.sp, modifier = Modifier.padding(end = 8.dp))
                    Switch(round, { round = it })
                }
                OutlinedTextField(caption, { if (it.length <= 30) caption = it }, singleLine = true, label = { Text("متن روی استیکر (اختیاری)") })
                OutlinedTextField(emoji, { if (it.length <= 8) emoji = it }, singleLine = true, label = { Text("ایموجی (اختیاری) مثلاً 😂") })
                err?.let { Text(it, color = MaterialTheme.colorScheme.error, fontSize = 13.sp) }
                Row(Modifier.fillMaxWidth().padding(top = 8.dp), horizontalArrangement = Arrangement.End) {
                    TextButton(enabled = !busy, onClick = { onDone(null) }) { Text("انصراف") }
                    Button(enabled = !busy, onClick = {
                        busy = true; err = null
                        scope.launch {
                            val out = withContext(Dispatchers.Default) { Stickers.render(photo, 512, round, zoom, dx, dy, caption) }
                            val e = Stickers.addBitmap(packId, out, emoji)
                            busy = false
                            if (e != null) err = e else onDone("استیکر ساخته شد ✓")
                        }
                    }) { if (busy) CircularProgressIndicator(Modifier.size(18.dp), strokeWidth = 2.dp, color = Color.White) else Text("ذخیره") }
                }
            }
        }
    }
}

