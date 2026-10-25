package com.pchat.app

import android.content.Context
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Matrix
import android.media.ExifInterface
import android.net.Uri
import android.os.Build
import android.provider.OpenableColumns
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.ImageBitmap
import androidx.compose.ui.graphics.asImageBitmap
import java.io.ByteArrayOutputStream
import java.io.InputStream
import java.text.SimpleDateFormat
import java.util.Calendar
import java.util.Date
import java.util.Locale

object U {
    fun time(ts: Long): String = SimpleDateFormat("HH:mm", Locale.getDefault()).format(Date(ts))
    /** Full Persian (Solar Hijri) date and time, e.g. «۲ آبان ۱۴۰۵، ۱۴:۲۲». */
    fun fullDate(ts: Long): String =
        android.icu.text.SimpleDateFormat("d MMMM yyyy، HH:mm", android.icu.util.ULocale("fa_IR@calendar=persian")).format(Date(ts))
    fun day(ts: Long): String = SimpleDateFormat("d MMMM yyyy", Locale.getDefault()).format(Date(ts))

    fun dayKey(ts: Long): Long {
        val c = Calendar.getInstance()
        c.timeInMillis = ts
        return c.get(Calendar.YEAR) * 1000L + c.get(Calendar.DAY_OF_YEAR)
    }

    fun size(b: Long): String = when {
        b < 1024 -> "$b B"
        b < 1024 * 1024 -> "%.1f KB".format(b / 1024.0)
        b < 1024L * 1024 * 1024 -> "%.1f MB".format(b / 1048576.0)
        else -> "%.2f GB".format(b / 1073741824.0)
    }

    private val palette = listOf(
        Color(0xFFE17076), Color(0xFFFAA774), Color(0xFFA695E7), Color(0xFF7BC862),
        Color(0xFF6EC9CB), Color(0xFF65AADD), Color(0xFFEE7AAE), Color(0xFF3C9DC0)
    )
    fun colorFor(name: String): Color = palette[(name.hashCode() and 0x7fffffff) % palette.size]

    fun preview(m: Msg): String = when (m.type) {
        "image" -> "🖼 عکس"
        "file" -> "📎 " + (m.fileName ?: "فایل")
        "voice" -> "🎤 پیام صوتی" + if (m.dur > 0) " (" + dur(m.dur) + ")" else ""
        "location" -> "📍 موقعیت مکانی"
        else -> m.text
    }

    /** 0:07, 1:25, 12:03 */
    fun dur(ms: Long): String {
        val s = (ms / 1000).coerceAtLeast(0)
        return "%d:%02d".format(Locale.US, s / 60, s % 60)
    }

    /** «آنلاین», «۵ دقیقه پیش آنلاین بود», «آخرین بازدید دیروز ۱۴:۲۰», or «اخیراً آنلاین بوده» when hidden. */
    fun lastSeen(u: UserInfo?): String {
        if (u == null) return ""
        if (u.online) return "آنلاین"
        val ls = u.lastSeen
        if (ls != null) {
            val d = System.currentTimeMillis() - ls
            if (d < 60_000) return "لحظاتی پیش آنلاین بود"
            if (d < 3600_000) return "${d / 60_000} دقیقه پیش آنلاین بود"
            val today = dayKey(System.currentTimeMillis())
            val dk = dayKey(ls)
            val yesterday = dayKey(System.currentTimeMillis() - 86_400_000L)
            return when (dk) {
                today -> "آخرین بازدید امروز " + time(ls)
                yesterday -> "آخرین بازدید دیروز " + time(ls)
                else -> "آخرین بازدید " + day(ls)
            }
        }
        if (u.hidden) return if (u.recently) "اخیراً آنلاین بوده" else "مدت‌ها پیش آنلاین بوده"
        return "آفلاین"
    }

    fun fileName(ctx: Context, uri: Uri): String {
        ctx.contentResolver.query(uri, null, null, null, null)?.use { c ->
            val i = c.getColumnIndex(OpenableColumns.DISPLAY_NAME)
            if (i >= 0 && c.moveToFirst()) return c.getString(i) ?: "file"
        }
        return "file"
    }

    fun fileSize(ctx: Context, uri: Uri): Long {
        ctx.contentResolver.query(uri, null, null, null, null)?.use { c ->
            val i = c.getColumnIndex(OpenableColumns.SIZE)
            if (i >= 0 && c.moveToFirst() && !c.isNull(i)) return c.getLong(i)
        }
        return -1L
    }
}

private fun exifRotation(ins: InputStream): Int = try {
    when (ExifInterface(ins).getAttributeInt(ExifInterface.TAG_ORIENTATION, ExifInterface.ORIENTATION_NORMAL)) {
        ExifInterface.ORIENTATION_ROTATE_90 -> 90
        ExifInterface.ORIENTATION_ROTATE_180 -> 180
        ExifInterface.ORIENTATION_ROTATE_270 -> 270
        else -> 0
    }
} catch (e: Exception) { 0 }

private fun orientationDegrees(o: Int): Int = when (o) {
    ExifInterface.ORIENTATION_ROTATE_90 -> 90
    ExifInterface.ORIENTATION_ROTATE_180 -> 180
    ExifInterface.ORIENTATION_ROTATE_270 -> 270
    else -> 0
}

/** Displayed (rotation-corrected) pixel size of an image file, or null if it is not an image. */
fun imageSizeOf(path: String): Pair<Int, Int>? {
    val o = BitmapFactory.Options().apply { inJustDecodeBounds = true }
    BitmapFactory.decodeFile(path, o)
    if (o.outWidth <= 0 || o.outHeight <= 0) return null
    val rot = try { orientationDegrees(ExifInterface(path).getAttributeInt(ExifInterface.TAG_ORIENTATION, 1)) } catch (e: Exception) { 0 }
    return if (rot == 90 || rot == 270) Pair(o.outHeight, o.outWidth) else Pair(o.outWidth, o.outHeight)
}

/**
 * Avatar pipeline (done on the phone): decode (sampled) -> fix rotation -> center-crop square ->
 * scale to at most 512x512 -> encode WebP. Re-encoding from a Bitmap drops all EXIF/GPS data.
 * Returns null if the image can't be read.
 */
fun makeAvatarWebp(ctx: Context, uri: Uri): ByteArray? {
    val cr = ctx.contentResolver
    val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
    cr.openInputStream(uri)?.use { BitmapFactory.decodeStream(it, null, bounds) }
    if (bounds.outWidth <= 0 || bounds.outHeight <= 0) return null
    var sample = 1
    while (minOf(bounds.outWidth, bounds.outHeight) / (sample * 2) >= 512) sample *= 2
    var bmp: Bitmap = cr.openInputStream(uri)?.use { BitmapFactory.decodeStream(it, null, BitmapFactory.Options().apply { inSampleSize = sample }) } ?: return null
    val rot = cr.openInputStream(uri)?.use { exifRotation(it) } ?: 0
    if (rot != 0) bmp = Bitmap.createBitmap(bmp, 0, 0, bmp.width, bmp.height, Matrix().apply { postRotate(rot.toFloat()) }, true)
    val side = minOf(bmp.width, bmp.height)
    bmp = Bitmap.createBitmap(bmp, (bmp.width - side) / 2, (bmp.height - side) / 2, side, side)
    if (side > 512) bmp = Bitmap.createScaledBitmap(bmp, 512, 512, true)
    var q = 80
    while (true) {
        val out = ByteArrayOutputStream()
        @Suppress("DEPRECATION")
        val fmt = if (Build.VERSION.SDK_INT >= 30) Bitmap.CompressFormat.WEBP_LOSSY else Bitmap.CompressFormat.WEBP
        bmp.compress(fmt, q, out)
        if (out.size() <= 380 * 1024 || q <= 30) return out.toByteArray()
        q -= 15
    }
}

fun decodeSampled(path: String, maxDim: Int): ImageBitmap? {
    val o = BitmapFactory.Options().apply { inJustDecodeBounds = true }
    BitmapFactory.decodeFile(path, o)
    if (o.outWidth <= 0) return null
    var s = 1
    while (maxOf(o.outWidth, o.outHeight) / s > maxDim * 2) s *= 2
    var bmp = BitmapFactory.decodeFile(path, BitmapFactory.Options().apply { inSampleSize = s }) ?: return null
    val rot = try { orientationDegrees(ExifInterface(path).getAttributeInt(ExifInterface.TAG_ORIENTATION, 1)) } catch (e: Exception) { 0 }
    if (rot != 0) bmp = Bitmap.createBitmap(bmp, 0, 0, bmp.width, bmp.height, Matrix().apply { postRotate(rot.toFloat()) }, true)
    return bmp.asImageBitmap()
}

fun decodeBytes(b: ByteArray): ImageBitmap? = BitmapFactory.decodeByteArray(b, 0, b.size)?.asImageBitmap()
