package com.pchat.app

import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
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
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.window.Dialog
import kotlinx.coroutines.launch
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.RadioButton
import androidx.compose.material3.Switch
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext

const val BIO_MAX = 70

/** Telegram-style settings: profile on top, then grouped sections. */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun SettingsScreen(onBack: () -> Unit, onLogout: () -> Unit) {
    val scope = rememberCoroutineScope()
    val users by Engine.users.collectAsState()
    val self = users.firstOrNull { it.username == Engine.me }
    var name by remember(self?.displayName) { mutableStateOf(self?.displayName ?: "") }
    var bio by remember(self?.bio) { mutableStateOf(self?.bio ?: "") }
    var busy by remember { mutableStateOf(false) }
    var msg by remember { mutableStateOf<String?>(null) }
    var photoMenu by remember { mutableStateOf(false) }
    var showKeys by remember { mutableStateOf(false) }
    var showPhoto by remember { mutableStateOf(false) }
    val notifTick by Prefs.notifTick.collectAsState()
    var showLock by remember { mutableStateOf(false) }
    var lockOn by remember { mutableStateOf(AppLock.enabled) }
    var confirmClear by remember { mutableStateOf(false) }
    var usage by remember { mutableStateOf<Long?>(null) }
    LaunchedEffect(confirmClear) { if (!confirmClear) usage = withContext(Dispatchers.IO) { Engine.storageUsage() } }
    val hasPhoto = (self?.avatarVer ?: 0) > 0
    val changed = name.trim() != (self?.displayName ?: "") || bio.trim() != (self?.bio ?: "")

    val pick = rememberLauncherForActivityResult(ActivityResultContracts.GetContent()) { uri ->
        if (uri != null) {
            busy = true; msg = null
            scope.launch { msg = Engine.saveAvatar(uri) ?: "عکس پروفایل به‌روز شد"; busy = false }
        }
    }

    Scaffold(
        topBar = {
            TopAppBar(
                navigationIcon = { IconButton(onClick = onBack) { Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = "بازگشت") } },
                title = { Text("تنظیمات", fontWeight = FontWeight.Bold) }
            )
        }
    ) { pad ->
        Column(Modifier.padding(pad).fillMaxSize().verticalScroll(rememberScrollState())) {
            // ---- profile header ----
            Column(Modifier.fillMaxWidth().padding(vertical = 16.dp), horizontalAlignment = Alignment.CenterHorizontally) {
                Box {
                    Box(Modifier.clip(CircleShape).clickable(enabled = !busy) { photoMenu = true }) { Avatar(Engine.me, false, 104) }
                    DropdownMenu(expanded = photoMenu, onDismissRequest = { photoMenu = false }) {
                        DropdownMenuItem(text = { Text(if (hasPhoto) "تغییر عکس" else "انتخاب عکس") }, onClick = { photoMenu = false; pick.launch("image/*") })
                        if (hasPhoto) {
                            DropdownMenuItem(text = { Text("نمایش عکس") }, onClick = { photoMenu = false; showPhoto = true })
                            DropdownMenuItem(text = { Text("حذف عکس") }, onClick = {
                                photoMenu = false; busy = true; msg = null
                                scope.launch { msg = Engine.removeAvatar() ?: "عکس پروفایل حذف شد"; busy = false }
                            })
                        }
                    }
                }
                Spacer(Modifier.height(10.dp))
                Text(Engine.nameOf(Engine.me), fontWeight = FontWeight.Bold, fontSize = 20.sp)
                Text("@" + Engine.me, fontSize = 13.sp, color = MaterialTheme.colorScheme.onSurface.copy(alpha = 0.6f))
                TextButton(onClick = { photoMenu = true }, enabled = !busy) { Text(if (hasPhoto) "تغییر عکس پروفایل" else "افزودن عکس پروفایل") }
                if (busy) CircularProgressIndicator(Modifier.size(22.dp), strokeWidth = 2.dp)
                msg?.let { Text(it, fontSize = 13.sp) }
            }

            // ---- account ----
            SectionTitle("حساب")
            Column(Modifier.padding(horizontal = 16.dp)) {
                OutlinedTextField(
                    value = name, onValueChange = { if (it.length <= 40) name = it }, singleLine = true,
                    label = { Text("نام نمایشی") }, modifier = Modifier.fillMaxWidth()
                )
                Spacer(Modifier.height(8.dp))
                OutlinedTextField(
                    value = bio, onValueChange = { bio = it.replace('\n', ' ').take(BIO_MAX) }, maxLines = 3,
                    label = { Text("بایو") }, placeholder = { Text("چند کلمه دربارهٔ خودتان") },
                    supportingText = { Text("${BIO_MAX - bio.length}", modifier = Modifier.fillMaxWidth(), textAlign = TextAlign.End) },
                    modifier = Modifier.fillMaxWidth()
                )
                Button(
                    enabled = changed && !busy,
                    onClick = {
                        busy = true; msg = null
                        scope.launch { msg = Engine.saveProfile(name, bio) ?: "ذخیره شد"; busy = false }
                    },
                    modifier = Modifier.align(Alignment.End)
                ) { Text("ذخیره") }
            }

            // ---- notifications ----
            SectionTitle("اعلان‌ها")
            SwitchRow("پیام‌های خصوصی", "نمایش اعلان برای گفتگوهای خصوصی", Prefs.notifyPrivate.also { notifTick }) { Prefs.notifyPrivate = it }
            SwitchRow("گروه‌ها", "نمایش اعلان برای پیام‌های گروه", Prefs.notifyGroups.also { notifTick }) { Prefs.notifyGroups = it }
            SwitchRow("صدا", null, Prefs.sound.also { notifTick }) { Prefs.sound = it }
            SwitchRow("لرزش", null, Prefs.vibrate.also { notifTick }) { Prefs.vibrate = it }
            Text("برای بی‌صدا کردن یک گفتگو، دکمهٔ 🔔 بالای همان گفتگو را بزنید.", fontSize = 12.sp,
                color = MaterialTheme.colorScheme.onSurface.copy(alpha = 0.6f), modifier = Modifier.padding(horizontal = 16.dp))

            // ---- appearance ----
            SectionTitle("ظاهر")
            val theme by Prefs.theme.collectAsState()
            for ((v, label) in listOf(Prefs.THEME_SYSTEM to "مطابق تنظیمات گوشی", Prefs.THEME_LIGHT to "روشن", Prefs.THEME_DARK to "تیره")) {
                RadioRow(label, theme == v) { Prefs.setTheme(v) }
            }
            val textSize by Prefs.textSize.collectAsState()
            Text("اندازهٔ متن پیام‌ها", fontSize = 15.sp, modifier = Modifier.padding(start = 16.dp, end = 16.dp, top = 10.dp))
            Row(Modifier.padding(horizontal = 12.dp)) {
                for ((i, sz) in Prefs.textSizes.withIndex()) {
                    TextButton(onClick = { Prefs.setTextSize(sz) }) {
                        Text(listOf("کوچک", "معمولی", "بزرگ", "خیلی بزرگ")[i], fontSize = (sz - 2).sp,
                            fontWeight = if (sz == textSize) FontWeight.Bold else FontWeight.Normal,
                            color = if (sz == textSize) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.onSurface)
                    }
                }
            }
            Text("نمونهٔ متن پیام با این اندازه", fontSize = textSize.sp, modifier = Modifier.padding(horizontal = 16.dp, vertical = 4.dp))

            // ---- privacy and security ----
            SectionTitle("حریم خصوصی و امنیت")
            SettingRow("قفل برنامه", if (lockOn) "روشن" else "خاموش") { showLock = true }
            SettingRow("اثرانگشت کلیدها", "مقایسهٔ کلید امنیتی با مخاطبان") { showKeys = true }

            // ---- data and storage ----
            SectionTitle("داده و حافظه")
            Text("دانلود خودکار عکس‌ها", fontSize = 15.sp, modifier = Modifier.padding(horizontal = 16.dp, vertical = 4.dp))
            val auto = Prefs.autoDownload.also { notifTick }
            for ((v, label) in listOf(Prefs.AUTO_ALWAYS to "همیشه", Prefs.AUTO_WIFI to "فقط با وای‌فای", Prefs.AUTO_NEVER to "هرگز (با ضربه دانلود شود)")) {
                RadioRow(label, auto == v) { Prefs.autoDownload = v }
            }
            SettingRow("فضای استفاده‌شده", (usage?.let { U.size(it) } ?: "در حال محاسبه…") + " · پاک کردن فایل‌های ذخیره‌شده") { confirmClear = true }

            Spacer(Modifier.height(12.dp))
            HorizontalDivider(color = MaterialTheme.colorScheme.onSurface.copy(alpha = 0.08f))
            SettingRow("خروج از حساب", null, color = MaterialTheme.colorScheme.error, onClick = onLogout)
            Spacer(Modifier.height(24.dp))
        }
    }
    if (showKeys) KeysDialog(users.map { it.username }.filter { it != Engine.me }) { showKeys = false }
    if (showPhoto) PhotoDialog(Engine.me) { showPhoto = false }
    if (showLock) LockSettingsDialog { showLock = false; lockOn = AppLock.enabled }
    if (confirmClear) AlertDialog(
        onDismissRequest = { confirmClear = false },
        title = { Text("پاک کردن فایل‌ها") },
        text = { Text("عکس‌ها و فایل‌های ذخیره‌شده روی این گوشی پاک می‌شوند تا فضا آزاد شود. پیام‌ها می‌مانند و هر فایل با باز کردنش دوباره از سرور دریافت می‌شود (تا وقتی سرور آن را نگه دارد).") },
        confirmButton = { TextButton(onClick = { scope.launch { Engine.clearMedia(); confirmClear = false } }) { Text("پاک کن", color = MaterialTheme.colorScheme.error) } },
        dismissButton = { TextButton(onClick = { confirmClear = false }) { Text("انصراف") } }
    )
}

@Composable
fun SwitchRow(title: String, subtitle: String?, checked: Boolean, onChange: (Boolean) -> Unit) {
    SettingRow(title, subtitle, trailing = { Switch(checked = checked, onCheckedChange = onChange) }) { onChange(!checked) }
}

@Composable
fun RadioRow(label: String, selected: Boolean, onClick: () -> Unit) {
    Row(Modifier.fillMaxWidth().clickable(onClick = onClick).padding(horizontal = 8.dp), verticalAlignment = Alignment.CenterVertically) {
        RadioButton(selected = selected, onClick = onClick)
        Text(label, fontSize = 15.sp)
    }
}

/** Turn the app lock on/off, change the PIN, pick when it locks and whether the fingerprint may unlock it. */
@Composable
fun LockSettingsDialog(onClose: () -> Unit) {
    val ctx = LocalContext.current
    var enabled by remember { mutableStateOf(AppLock.enabled) }
    var settingPin by remember { mutableStateOf(!AppLock.enabled) }
    var pin1 by remember { mutableStateOf("") }
    var pin2 by remember { mutableStateOf("") }
    var msg by remember { mutableStateOf<String?>(null) }
    var timeout by remember { mutableStateOf(AppLock.timeoutMs) }
    var bio by remember { mutableStateOf(AppLock.useBiometric) }
    AlertDialog(
        onDismissRequest = onClose,
        title = { Text("قفل برنامه") },
        confirmButton = { TextButton(onClick = onClose) { Text("بستن") } },
        text = {
            Column(Modifier.verticalScroll(rememberScrollState())) {
                if (settingPin) {
                    Text(if (enabled) "رمز تازه را وارد کنید" else "یک رمز ۴ تا ۶ رقمی انتخاب کنید. هر بار که برنامه باز شود، این رمز پرسیده می‌شود.", fontSize = 13.sp)
                    Spacer(Modifier.height(8.dp))
                    PinField(pin1, "رمز") { pin1 = it }
                    Spacer(Modifier.height(6.dp))
                    PinField(pin2, "تکرار رمز") { pin2 = it }
                    Row {
                        TextButton(onClick = {
                            msg = when {
                                pin1.length < 4 -> "رمز باید دست‌کم ۴ رقم باشد"
                                pin1 != pin2 -> "رمز و تکرار آن یکی نیستند"
                                else -> { AppLock.setPin(pin1); enabled = true; settingPin = false; pin1 = ""; pin2 = ""; "قفل برنامه روشن شد" }
                            }
                        }) { Text("ذخیرهٔ رمز") }
                        if (enabled) TextButton(onClick = { settingPin = false; pin1 = ""; pin2 = "" }) { Text("انصراف") }
                    }
                } else {
                    Text("قفل برنامه روشن است.", fontSize = 14.sp)
                    Text("قفل شود بعد از:", fontSize = 14.sp, modifier = Modifier.padding(top = 8.dp))
                    for ((v, label) in listOf(0L to "فوراً", 60_000L to "۱ دقیقه", 5 * 60_000L to "۵ دقیقه", 3600_000L to "۱ ساعت")) {
                        RadioRow(label, timeout == v) { timeout = v; AppLock.timeoutMs = v }
                    }
                    if (AppLock.biometricAvailable(ctx)) {
                        Row(verticalAlignment = Alignment.CenterVertically) {
                            Text("باز کردن با اثرانگشت", fontSize = 14.sp, modifier = Modifier.weight(1f))
                            Switch(checked = bio, onCheckedChange = { bio = it; AppLock.useBiometric = it })
                        }
                    }
                    Row {
                        TextButton(onClick = { settingPin = true; msg = null }) { Text("تغییر رمز") }
                        TextButton(onClick = { AppLock.disable(); enabled = false; settingPin = true; msg = "قفل برنامه خاموش شد" }) {
                            Text("خاموش کردن قفل", color = MaterialTheme.colorScheme.error)
                        }
                    }
                }
                msg?.let { Text(it, fontSize = 13.sp, modifier = Modifier.padding(top = 6.dp)) }
                Text("اگر رمز را فراموش کنید، باید برنامه را پاک کنید و دوباره وارد شوید.", fontSize = 12.sp,
                    color = MaterialTheme.colorScheme.onSurface.copy(alpha = 0.6f), modifier = Modifier.padding(top = 8.dp))
            }
        }
    )
}

@Composable
private fun PinField(value: String, label: String, onChange: (String) -> Unit) {
    OutlinedTextField(
        value = value, onValueChange = { v -> onChange(v.filter { it.isDigit() }.take(6)) }, singleLine = true,
        label = { Text(label) }, visualTransformation = PasswordVisualTransformation(),
        keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.NumberPassword), modifier = Modifier.fillMaxWidth()
    )
}

@Composable
fun SectionTitle(text: String) {
    Text(
        text, color = MaterialTheme.colorScheme.primary, fontWeight = FontWeight.Bold, fontSize = 14.sp,
        modifier = Modifier.fillMaxWidth().padding(start = 16.dp, end = 16.dp, top = 18.dp, bottom = 6.dp)
    )
}

@Composable
fun SettingRow(title: String, subtitle: String?, color: Color = Color.Unspecified, trailing: (@Composable () -> Unit)? = null, onClick: () -> Unit) {
    Row(Modifier.fillMaxWidth().clickable(onClick = onClick).padding(horizontal = 16.dp, vertical = 12.dp), verticalAlignment = Alignment.CenterVertically) {
        Column(Modifier.weight(1f)) {
            Text(title, fontSize = 16.sp, color = if (color == Color.Unspecified) MaterialTheme.colorScheme.onSurface else color)
            if (subtitle != null) Text(subtitle, fontSize = 13.sp, color = MaterialTheme.colorScheme.onSurface.copy(alpha = 0.6f))
        }
        trailing?.invoke()
    }
}

/** A contact's profile: large photo, name, username, bio. */
@Composable
fun ContactProfileDialog(user: String, onClose: () -> Unit) {
    val users by Engine.users.collectAsState()
    val u = users.firstOrNull { it.username == user }
    val scope = rememberCoroutineScope()
    var showPhoto by remember { mutableStateOf(false) }
    var confirmCut by remember { mutableStateOf(false) }
    var busy by remember { mutableStateOf(false) }
    var msg by remember { mutableStateOf<String?>(null) }
    AlertDialog(
        onDismissRequest = onClose,
        confirmButton = { TextButton(onClick = onClose) { Text("بستن") } },
        text = {
            Column(Modifier.fillMaxWidth(), horizontalAlignment = Alignment.CenterHorizontally) {
                Box(Modifier.clip(CircleShape).clickable(enabled = (u?.avatarVer ?: 0) > 0) { showPhoto = true }) { Avatar(user, false, 120) }
                Spacer(Modifier.height(12.dp))
                Text(Engine.nameOf(user), fontWeight = FontWeight.Bold, fontSize = 20.sp)
                Text("@$user" + if (u?.online == true) " · آنلاین" else "", fontSize = 13.sp, color = MaterialTheme.colorScheme.onSurface.copy(alpha = 0.6f))
                val bio = u?.bio
                if (!bio.isNullOrBlank()) {
                    Spacer(Modifier.height(14.dp))
                    Text(bio, fontSize = 15.sp, textAlign = TextAlign.Center)
                    Text("بایو", fontSize = 12.sp, color = MaterialTheme.colorScheme.onSurface.copy(alpha = 0.5f))
                }
                if (u?.dm == true) {
                    Spacer(Modifier.height(14.dp))
                    if (confirmCut) {
                        Text("اتصال با ${Engine.nameOf(user)} قطع شود؟ دیگر نمی‌توانید به هم پیام خصوصی بدهید، مگر با درخواست اتصال تازه.", fontSize = 13.sp, textAlign = TextAlign.Center)
                        Row {
                            TextButton(enabled = !busy, onClick = {
                                busy = true
                                scope.launch { val (err, _) = Engine.contactAction("remove", user); busy = false; if (err == null) onClose() else msg = err }
                            }) { Text("بله، قطع شود", color = MaterialTheme.colorScheme.error) }
                            TextButton(onClick = { confirmCut = false }) { Text("انصراف") }
                        }
                    } else {
                        TextButton(onClick = { confirmCut = true }) { Text("قطع اتصال", color = MaterialTheme.colorScheme.error) }
                    }
                    msg?.let { Text(it, fontSize = 13.sp, color = MaterialTheme.colorScheme.error) }
                }
            }
        }
    )
    if (showPhoto) PhotoDialog(user) { showPhoto = false }
}

/** The profile photo at full width. */
@Composable
fun PhotoDialog(user: String, onClose: () -> Unit) {
    val users by Engine.users.collectAsState()
    val ver = users.firstOrNull { it.username == user }?.avatarVer ?: 0
    val bmp by produceState<ImageBitmap?>(null, user, ver) { value = if (ver > 0) Engine.avatarBitmap(user, ver) else null }
    Dialog(onDismissRequest = onClose) {
        Box(Modifier.fillMaxWidth().clickable(onClick = onClose).background(Color.Black), contentAlignment = Alignment.Center) {
            bmp?.let { Image(it, contentDescription = null, modifier = Modifier.fillMaxWidth(), contentScale = ContentScale.FillWidth) }
                ?: CircularProgressIndicator(Modifier.padding(40.dp))
        }
    }
}
