package com.pchat.app

import android.Manifest
import android.content.ContentValues
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.os.Environment
import android.provider.MediaStore
import android.webkit.MimeTypeMap
import android.widget.Toast
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContract
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.MoreVert
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.core.content.ContextCompat
import androidx.core.content.FileProvider
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import java.io.File

/**
 * 1.12: «ذخیره در گالری», «ذخیره در…» and «اشتراک‌گذاری» for photos, videos, files and voice messages.
 * What is saved is always the decrypted local copy (downloaded first if needed), i.e. a normal file.
 */
data class MediaRef(val path: String, val name: String, val mime: String)

object MediaSave {
    const val ALBUM = "Sepan"

    fun isGalleryType(mime: String?) = mime != null && (mime.startsWith("image/") || mime.startsWith("video/"))

    /** Best mime + a file name with a fitting extension for a message's media. */
    fun refOf(m: Msg, path: String): MediaRef {
        val mime = m.mime?.takeIf { it.isNotBlank() && it != "application/octet-stream" }
            ?: when (m.type) { "image" -> "image/jpeg"; "voice" -> "audio/ogg"; else -> null }
            ?: MimeTypeMap.getSingleton().getMimeTypeFromExtension((m.fileName ?: "").substringAfterLast('.', "").lowercase())
            ?: "application/octet-stream"
        var name = m.fileName?.takeIf { it.isNotBlank() }?.replace(Regex("[\\\\/:*?\"<>|]"), "_") ?: run {
            val prefix = when { mime.startsWith("image/") -> "IMG"; mime.startsWith("video/") -> "VID"; m.type == "voice" -> "VOICE"; else -> "FILE" }
            prefix + "_Sepan_" + java.text.SimpleDateFormat("yyyyMMdd_HHmmss", java.util.Locale.US).format(java.util.Date(m.ts))
        }
        if (!name.contains('.')) MimeTypeMap.getSingleton().getExtensionFromMimeType(mime)?.let { name += ".$it" }
        return MediaRef(path, name, mime)
    }

    /** Copies the file into the phone's gallery, album «Sepan». */
    fun toGallery(ctx: Context, r: MediaRef): Boolean = try {
        val video = r.mime.startsWith("video/")
        val src = File(r.path)
        if (Build.VERSION.SDK_INT >= 29) {
            val coll = if (video) MediaStore.Video.Media.getContentUri(MediaStore.VOLUME_EXTERNAL_PRIMARY)
            else MediaStore.Images.Media.getContentUri(MediaStore.VOLUME_EXTERNAL_PRIMARY)
            val cv = ContentValues().apply {
                put(MediaStore.MediaColumns.DISPLAY_NAME, r.name)
                put(MediaStore.MediaColumns.MIME_TYPE, r.mime)
                put(MediaStore.MediaColumns.RELATIVE_PATH, (if (video) Environment.DIRECTORY_MOVIES else Environment.DIRECTORY_PICTURES) + "/" + ALBUM)
                put(MediaStore.MediaColumns.IS_PENDING, 1)
            }
            val uri = ctx.contentResolver.insert(coll, cv) ?: throw IllegalStateException("no uri")
            try {
                ctx.contentResolver.openOutputStream(uri)!!.use { out -> src.inputStream().use { it.copyTo(out) } }
                ctx.contentResolver.update(uri, ContentValues().apply { put(MediaStore.MediaColumns.IS_PENDING, 0) }, null, null)
            } catch (e: Exception) {
                ctx.contentResolver.delete(uri, null, null); throw e
            }
        } else {
            @Suppress("DEPRECATION")
            val dir = File(Environment.getExternalStoragePublicDirectory(if (video) Environment.DIRECTORY_MOVIES else Environment.DIRECTORY_PICTURES), ALBUM)
            dir.mkdirs()
            var f = File(dir, r.name)
            var i = 1
            while (f.exists()) f = File(dir, r.name.substringBeforeLast('.') + " ($i)." + r.name.substringAfterLast('.', "bin")).also { i++ }
            src.copyTo(f)
            android.media.MediaScannerConnection.scanFile(ctx, arrayOf(f.absolutePath), arrayOf(r.mime), null)
        }
        true
    } catch (e: Exception) { false }

    fun copyTo(ctx: Context, r: MediaRef, dest: Uri): Boolean = try {
        ctx.contentResolver.openOutputStream(dest, "w")!!.use { out -> File(r.path).inputStream().use { it.copyTo(out) } }
        true
    } catch (e: Exception) { false }

    fun share(ctx: Context, r: MediaRef) {
        try {
            val uri = FileProvider.getUriForFile(ctx, ctx.packageName + ".fileprovider", File(r.path), r.name)
            val send = Intent(Intent.ACTION_SEND).setType(r.mime).putExtra(Intent.EXTRA_STREAM, uri)
                .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
            ctx.startActivity(Intent.createChooser(send, "اشتراک‌گذاری"))
        } catch (e: Exception) {
            Toast.makeText(ctx, "اشتراک‌گذاری ممکن نشد", Toast.LENGTH_SHORT).show()
        }
    }
}

/** «ذخیره در…»: the system's own picker, where the user chooses the folder and the name. */
private class SaveAsContract : ActivityResultContract<MediaRef, Uri?>() {
    override fun createIntent(context: Context, input: MediaRef) =
        Intent(Intent.ACTION_CREATE_DOCUMENT).addCategory(Intent.CATEGORY_OPENABLE).setType(input.mime).putExtra(Intent.EXTRA_TITLE, input.name)
    override fun parseResult(resultCode: Int, intent: Intent?): Uri? = intent?.data
}

class MediaActions internal constructor(
    private val ctx: Context, private val scope: CoroutineScope,
    private val saveAsLaunch: (MediaRef) -> Unit, private val permLaunch: (MediaRef) -> Unit
) {
    fun gallery(r: MediaRef) {
        if (Build.VERSION.SDK_INT < 29 &&
            ContextCompat.checkSelfPermission(ctx, Manifest.permission.WRITE_EXTERNAL_STORAGE) != PackageManager.PERMISSION_GRANTED
        ) { permLaunch(r); return }
        galleryNow(r)
    }

    internal fun galleryNow(r: MediaRef) {
        scope.launch {
            val ok = withContext(Dispatchers.IO) { MediaSave.toGallery(ctx, r) }
            Toast.makeText(ctx, if (ok) "در گالری ذخیره شد (آلبوم ${MediaSave.ALBUM})" else "ذخیره در گالری ممکن نشد", Toast.LENGTH_SHORT).show()
        }
    }

    fun saveAs(r: MediaRef) {
        try { saveAsLaunch(r) } catch (e: Exception) { Toast.makeText(ctx, "پنجرهٔ انتخاب پوشه باز نشد", Toast.LENGTH_SHORT).show() }
    }

    fun share(r: MediaRef) = MediaSave.share(ctx, r)

    /** Runs [act] on the message's decrypted file, downloading it first when needed. */
    fun withMsg(m: Msg, act: (MediaRef) -> Unit) {
        scope.launch {
            val local = m.localPath?.takeIf { File(it).exists() }
            if (local == null) Toast.makeText(ctx, "در حال دریافت…", Toast.LENGTH_SHORT).show()
            val p = local ?: Engine.downloadMedia(m)
            if (p == null) Toast.makeText(ctx, "دریافت فایل ناموفق بود", Toast.LENGTH_SHORT).show()
            else act(MediaSave.refOf(m, p))
        }
    }
}

@Composable
fun rememberMediaActions(): MediaActions {
    val ctx = LocalContext.current
    val scope = rememberCoroutineScope()
    var pending by remember { mutableStateOf<MediaRef?>(null) }
    val holder = remember { arrayOfNulls<MediaActions>(1) }
    val saveAs = rememberLauncherForActivityResult(SaveAsContract()) { uri ->
        val r = pending
        pending = null
        if (uri != null && r != null) scope.launch {
            val ok = withContext(Dispatchers.IO) { MediaSave.copyTo(ctx, r, uri) }
            Toast.makeText(ctx, if (ok) "ذخیره شد" else "ذخیره ممکن نشد", Toast.LENGTH_SHORT).show()
        }
    }
    val perm = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
        val r = pending
        pending = null
        if (r != null) {
            if (granted) holder[0]?.galleryNow(r)
            else Toast.makeText(ctx, "برای ذخیره در گالری اجازهٔ دسترسی به حافظه لازم است", Toast.LENGTH_LONG).show()
        }
    }
    return remember(ctx) {
        MediaActions(ctx, scope,
            saveAsLaunch = { r -> pending = r; saveAs.launch(r) },
            permLaunch = { r -> pending = r; perm.launch(Manifest.permission.WRITE_EXTERNAL_STORAGE) }
        ).also { holder[0] = it }
    }
}

/** The ⋮ menu in the corner of the full-screen photo / video viewer. */
@Composable
fun MediaMoreMenu(r: MediaRef, modifier: Modifier = Modifier) {
    val act = rememberMediaActions()
    var open by remember { mutableStateOf(false) }
    androidx.compose.foundation.layout.Box(modifier) {
        IconButton(onClick = { open = true }) { Icon(Icons.Default.MoreVert, contentDescription = "گزینه‌ها", tint = Color.White) }
        DropdownMenu(expanded = open, onDismissRequest = { open = false }) {
            if (MediaSave.isGalleryType(r.mime)) DropdownMenuItem(text = { Text("ذخیره در گالری") }, onClick = { open = false; act.gallery(r) })
            DropdownMenuItem(text = { Text("ذخیره در…") }, onClick = { open = false; act.saveAs(r) })
            DropdownMenuItem(text = { Text("اشتراک‌گذاری") }, onClick = { open = false; act.share(r) })
        }
    }
}
