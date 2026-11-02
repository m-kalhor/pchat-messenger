package com.pchat.app

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.ui.text.font.FontFamily
import android.widget.Toast
import androidx.compose.ui.platform.LocalContext

private const val MIN_KEY_PASS = 6

@Composable
private fun PassField(value: String, label: String, onChange: (String) -> Unit) {
    OutlinedTextField(
        value = value, onValueChange = onChange, singleLine = true, label = { Text(label) },
        visualTransformation = PasswordVisualTransformation(),
        keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Password),
        modifier = Modifier.fillMaxWidth()
    )
}

/** The login password or, for accounts that sign in by SMS and have none, an SMS code sent with the button. */
@Composable
private fun AccountField(value: String, onChange: (String) -> Unit) {
    val scope = rememberCoroutineScope()
    val ctx = LocalContext.current
    var sent by remember { mutableStateOf(false) }
    PassField(value, "رمز ورود حساب یا کد پیامکی", onChange)
    Row(verticalAlignment = Alignment.CenterVertically) {
        Text("اگر با پیامک وارد می‌شوید و رمز ندارید:", fontSize = 12.sp, modifier = Modifier.weight(1f))
        TextButton(enabled = !sent, onClick = {
            sent = true
            scope.launch {
                val e = Engine.reauthSms()
                Toast.makeText(ctx, e ?: "کد تأیید به موبایل شما پیامک شد", Toast.LENGTH_LONG).show()
                if (e != null) sent = false
            }
        }) { Text("ارسال کد پیامکی") }
    }
}

private fun checkNew(p1: String, p2: String): String? = when {
    p1.length < MIN_KEY_PASS -> "رمز کلید باید دست‌کم $MIN_KEY_PASS نویسه باشد"
    p1 != p2 -> "رمز کلید و تکرار آن یکی نیستند"
    else -> null
}

/**
 * Shown instead of the chats while the identity key needs attention (Engine.keyStep):
 * CHOOSE = this phone does not have the account's key: restore it with the key password (recommended)
 * or make a new one; SET_PASSWORD = the key has no key password yet, which is mandatory.
 */
@Composable
fun KeyScreen(step: KeyStep, onLogout: () -> Unit) {
    val scope = rememberCoroutineScope()
    val kb = Engine.keyBackup
    val askAccount = Engine.needsAccountPassword()
    var busy by remember { mutableStateOf(false) }
    var restorePass by remember { mutableStateOf("") }
    var restoreErr by remember { mutableStateOf<String?>(null) }
    var p1 by remember { mutableStateOf("") }
    var p2 by remember { mutableStateOf("") }
    var acct by remember { mutableStateOf("") }
    var newErr by remember { mutableStateOf<String?>(null) }
    var confirmNew by remember { mutableStateOf(false) }

    fun submitNew(makeNew: Boolean) {
        newErr = checkNew(p1, p2) ?: if (askAccount && acct.isEmpty()) "رمز ورود حساب یا کد پیامکی را وارد کنید" else null
        if (newErr != null) return
        busy = true
        scope.launch {
            val a = acct.ifEmpty { null }
            newErr = if (makeNew) Engine.newKey(p1, a) else Engine.setKeyPassword(p1, a)
            busy = false
        }
    }

    Column(
        Modifier.fillMaxSize().background(MaterialTheme.colorScheme.background).verticalScroll(rememberScrollState()).padding(24.dp),
        verticalArrangement = Arrangement.spacedBy(10.dp)
    ) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Text("🔑 کلید رمزنگاری", fontSize = 22.sp, fontWeight = FontWeight.Bold, modifier = Modifier.weight(1f))
            TextButton(onClick = onLogout, enabled = !busy) { Text("خروج") }
        }
        if (step == KeyStep.CHOOSE) {
            Text("کلید رمزنگاری این گوشی با کلید حساب شما یکی نیست. تا یکی از دو راه زیر را انتخاب نکنید، پیامی فرستاده یا باز نمی‌شود.", fontSize = 14.sp)
            if (kb != null) {
                val v2 = kb.optInt("v", 1) == 2
                Text("بازگرداندن کلید قبلی (پیشنهادی)", fontWeight = FontWeight.SemiBold, fontSize = 16.sp, modifier = Modifier.padding(top = 8.dp))
                Text(
                    if (v2) "رمز کلیدی را که برای حسابتان گذاشته‌اید وارد کنید. پیام‌های قبلی خوانا می‌مانند و مخاطبان تغییری نمی‌بینند."
                    else "این حساب هنوز رمز کلید ندارد و کلیدش با رمز ورود قبلی قفل است. همان رمز قبلی را وارد کنید.",
                    fontSize = 13.sp, color = MaterialTheme.colorScheme.onBackground.copy(alpha = 0.7f)
                )
                PassField(restorePass, if (v2) "رمز کلید" else "رمز ورود قبلی حساب") { restorePass = it }
                restoreErr?.let { Text(it, color = MaterialTheme.colorScheme.error, fontSize = 13.sp) }
                Button(
                    enabled = !busy && restorePass.isNotEmpty(), modifier = Modifier.fillMaxWidth().height(48.dp),
                    onClick = { busy = true; restoreErr = null; scope.launch { restoreErr = Engine.restoreKey(restorePass); busy = false } }
                ) { Text("بازگرداندن کلید قبلی") }
            } else {
                Text("برای کلید این حساب پشتیبانی روی سرور نیست، پس فقط ساخت کلید تازه ممکن است.", fontSize = 13.sp)
            }
            HorizontalDivider(Modifier.padding(vertical = 8.dp))
            Text("ساخت کلید تازه", fontWeight = FontWeight.SemiBold, fontSize = 16.sp)
            Text(
                "پیام‌های قبلی با کلید تازه باز نمی‌شوند و برای مخاطبان «کلید عوض شد» نشان داده می‌شود. اگر رمز کلید را فراموش کرده‌اید، همین راه را بزنید.",
                fontSize = 13.sp, color = MaterialTheme.colorScheme.onBackground.copy(alpha = 0.7f)
            )
        } else {
            Text("رمز کلید بگذارید", fontWeight = FontWeight.SemiBold, fontSize = 16.sp)
            Text(
                "کلید رمزنگاری شما با این رمز قفل می‌شود و روی سرور می‌ماند تا روی هر دستگاه بازگردد. این رمز جدا از رمز ورود است، " +
                    "فقط شما آن را می‌دانید و مدیر هم نمی‌تواند عوضش کند. اگر فراموشش کنید، پیام‌های قدیمی روی دستگاه تازه باز نمی‌شوند.",
                fontSize = 13.sp, color = MaterialTheme.colorScheme.onBackground.copy(alpha = 0.7f)
            )
        }
        PassField(p1, "رمز کلید تازه") { p1 = it }
        PassField(p2, "تکرار رمز کلید") { p2 = it }
        if (askAccount) AccountField(acct) { acct = it }
        newErr?.let { Text(it, color = MaterialTheme.colorScheme.error, fontSize = 13.sp) }
        if (step == KeyStep.CHOOSE) {
            OutlinedButton(
                enabled = !busy, modifier = Modifier.fillMaxWidth().height(48.dp),
                colors = ButtonDefaults.outlinedButtonColors(contentColor = MaterialTheme.colorScheme.error),
                onClick = { confirmNew = true }
            ) { Text("ساخت کلید تازه") }
        } else {
            Button(enabled = !busy, modifier = Modifier.fillMaxWidth().height(48.dp), onClick = { submitNew(false) }) { Text("ذخیرهٔ رمز کلید") }
        }
        if (busy) CircularProgressIndicator(Modifier.size(28.dp).align(Alignment.CenterHorizontally))
        Spacer(Modifier.height(24.dp))
    }

    if (confirmNew) AlertDialog(
        onDismissRequest = { confirmNew = false },
        title = { Text("ساخت کلید تازه") },
        text = { Text("با کلید تازه، پیام‌های قبلی روی دستگاه‌هایی که آن‌ها را ندارند باز نمی‌شوند و دستگاه‌های دیگر شما باید دوباره کلید را بازگردانند. ادامه می‌دهید؟") },
        confirmButton = { TextButton(onClick = { confirmNew = false; submitNew(true) }) { Text("ساخت کلید تازه", color = MaterialTheme.colorScheme.error) } },
        dismissButton = { TextButton(onClick = { confirmNew = false }) { Text("انصراف") } }
    )
}

/** Settings › «رمز کلید»: locks the same key with a new key password. */
@Composable
fun KeyPasswordDialog(onClose: () -> Unit) {
    val scope = rememberCoroutineScope()
    var p1 by remember { mutableStateOf("") }
    var p2 by remember { mutableStateOf("") }
    var acct by remember { mutableStateOf("") }
    var busy by remember { mutableStateOf(false) }
    var msg by remember { mutableStateOf<String?>(null) }
    AlertDialog(
        onDismissRequest = { if (!busy) onClose() },
        title = { Text("رمز کلید") },
        text = {
            Column(Modifier.verticalScroll(rememberScrollState()), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                Text("کلید همان می‌ماند؛ فقط رمزی که پشتیبانش روی سرور با آن قفل است عوض می‌شود. این رمز جدا از رمز ورود است و مدیر هم نمی‌تواند عوضش کند.", fontSize = 13.sp)
                PassField(p1, "رمز کلید تازه") { p1 = it }
                PassField(p2, "تکرار رمز کلید") { p2 = it }
                AccountField(acct) { acct = it }
                if (busy) CircularProgressIndicator(Modifier.size(24.dp))
                msg?.let { Text(it, fontSize = 13.sp, color = MaterialTheme.colorScheme.error) }
            }
        },
        confirmButton = {
            TextButton(enabled = !busy, onClick = {
                msg = checkNew(p1, p2) ?: if (acct.isEmpty()) "رمز ورود حساب یا کد پیامکی را وارد کنید" else null
                if (msg == null) {
                    busy = true
                    scope.launch { msg = Engine.setKeyPassword(p1, acct); busy = false; if (msg == null) onClose() }
                }
            }) { Text("ذخیره") }
        },
        dismissButton = { TextButton(enabled = !busy, onClick = onClose) { Text("انصراف") } }
    )
}

/** Settings › «ورود دستگاه تازه»: a one-time code (5 minutes) that signs this account in on another device. */
@Composable
fun DeviceCodeDialog(onClose: () -> Unit) {
    var code by remember { mutableStateOf<String?>(null) }
    var byPhone by remember { mutableStateOf(true) }
    var err by remember { mutableStateOf<String?>(null) }
    var left by remember { mutableStateOf(0) }
    LaunchedEffect(Unit) {
        val (r, e) = Engine.deviceCode()
        if (r != null) { code = r.getString("code"); byPhone = r.optBoolean("phone", true); left = r.optInt("ttl", 300) } else err = e
    }
    LaunchedEffect(left) { if (left > 0) { delay(1000); left-- } }
    AlertDialog(
        onDismissRequest = onClose,
        title = { Text("ورود دستگاه تازه") },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(8.dp), horizontalAlignment = Alignment.CenterHorizontally) {
                val c = code
                when {
                    err != null -> Text(err!!, color = MaterialTheme.colorScheme.error, fontSize = 13.sp)
                    c == null -> CircularProgressIndicator(Modifier.size(28.dp))
                    else -> {
                        Text(
                            c.chunked(3).joinToString(" "), fontSize = 34.sp, fontWeight = FontWeight.Bold,
                            fontFamily = FontFamily.Monospace, letterSpacing = 4.sp
                        )
                        Text(if (left > 0) "اعتبار: %d:%02d".format(left / 60, left % 60) else "منقضی شد", fontSize = 13.sp)
                        Text(
                            "روی دستگاه تازه، در صفحهٔ ورود " + (if (byPhone) "شمارهٔ موبایلتان" else "نام کاربری‌تان (" + Engine.me + ")") +
                                " را بزنید، بعد «کد را دارم» و این کد را. فقط یک بار کار می‌کند. این کد را به هیچ‌کس دیگری ندهید.",
                            fontSize = 13.sp
                        )
                    }
                }
            }
        },
        confirmButton = { TextButton(onClick = onClose) { Text("بستن") } }
    )
}
