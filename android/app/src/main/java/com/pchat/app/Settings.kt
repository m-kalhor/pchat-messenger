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

            // ---- privacy and security ----
            SectionTitle("حریم خصوصی و امنیت")
            SettingRow("اثرانگشت کلیدها", "مقایسهٔ کلید امنیتی با مخاطبان") { showKeys = true }

            Spacer(Modifier.height(12.dp))
            HorizontalDivider(color = MaterialTheme.colorScheme.onSurface.copy(alpha = 0.08f))
            SettingRow("خروج از حساب", null, color = MaterialTheme.colorScheme.error, onClick = onLogout)
            Spacer(Modifier.height(24.dp))
        }
    }
    if (showKeys) KeysDialog(users.map { it.username }.filter { it != Engine.me }) { showKeys = false }
    if (showPhoto) PhotoDialog(Engine.me) { showPhoto = false }
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
    var showPhoto by remember { mutableStateOf(false) }
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
