package com.pchat.app

import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Canvas
import android.graphics.Matrix
import android.graphics.Paint
import android.graphics.Path
import android.graphics.PorterDuff
import android.graphics.Typeface
import android.net.Uri
import android.os.Build
import androidx.compose.ui.graphics.ImageBitmap
import androidx.compose.ui.graphics.asImageBitmap
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.withContext
import org.json.JSONArray
import org.json.JSONObject
import java.io.ByteArrayOutputStream
import java.io.File
import java.util.zip.ZipInputStream

data class StickerItem(val id: String, val emoji: String)
data class StickerPack(
    val id: String, val title: String, val official: Boolean, val mine: Boolean,
    val stickers: List<StickerItem>, val added: Boolean = true
)
/** The sticker panel: official packs first, then my collection in my order, and the admin's limits. */
data class StickerState(
    val create: Boolean = false, val kb: Int = 300, val perPack: Int = 120, val maxPacks: Int = 10,
    val packs: List<StickerPack> = emptyList()
)

/**
 * 1.10 sticker packs. The images live on the self-hosted server (not end-to-end encrypted, so each is
 * stored once); a sticker message itself is an encrypted text message with an extra "stk" field. Images
 * are cached in filesDir/stickers, so stickers seen once open without the network.
 */
object Stickers {
    val state = MutableStateFlow(StickerState())
    val favs = MutableStateFlow<List<Stk>>(emptyList())
    val recent = MutableStateFlow<List<Stk>>(emptyList())
    /** stickers whose pack was deleted (the server answered 404) */
    val gone = MutableStateFlow<Set<String>>(emptySet())
    private val mem = object : android.util.LruCache<String, ImageBitmap>(80) {}
    private const val MAX = 512

    private fun dir(): File = File(Engine.app.filesDir, "stickers").also { it.mkdirs() }

    fun load() {
        try { Engine.prefs.getString("stickers_raw", null)?.let { state.value = parse(JSONObject(it)) } } catch (e: Exception) { }
        favs.value = readList("stk_favs")
        recent.value = readList("stk_recent")
    }

    private fun readList(key: String): List<Stk> = try {
        val a = JSONArray(Engine.prefs.getString(key, "[]") ?: "[]")
        (0 until a.length()).mapNotNull { i -> a.optJSONObject(i)?.let { o -> Stk(o.optString("id"), o.optString("p"), o.optString("e")).takeIf { it.id.length == 32 } } }
    } catch (e: Exception) { emptyList() }

    private fun writeList(key: String, list: List<Stk>) {
        val a = JSONArray()
        list.forEach { a.put(JSONObject().put("id", it.id).put("p", it.p).put("e", it.e)) }
        Engine.prefs.edit().putString(key, a.toString()).apply()
    }

    fun isFav(id: String) = favs.value.any { it.id == id }
    /** Adds or removes a favourite; returns true when it is now a favourite. */
    fun toggleFav(k: Stk): Boolean {
        val now = !isFav(k.id)
        favs.value = if (now) (listOf(k) + favs.value).take(60) else favs.value.filter { it.id != k.id }
        writeList("stk_favs", favs.value)
        return now
    }
    fun addRecent(k: Stk) {
        recent.value = (listOf(k) + recent.value.filter { it.id != k.id }).take(30)
        writeList("stk_recent", recent.value)
    }

    private fun packOf(o: JSONObject): StickerPack {
        val a = o.optJSONArray("stickers") ?: JSONArray()
        return StickerPack(
            o.getString("id"), o.optString("title"), o.optBoolean("official"), o.optBoolean("mine"),
            (0 until a.length()).map { i -> a.getJSONObject(i).let { StickerItem(it.getString("id"), if (it.isNull("emoji")) "" else it.optString("emoji")) } },
            o.optBoolean("added", true)
        )
    }

    private fun parse(o: JSONObject): StickerState {
        val l = o.optJSONObject("limits") ?: JSONObject()
        val a = o.optJSONArray("packs") ?: JSONArray()
        return StickerState(
            o.optBoolean("create"), l.optInt("kb", 300), l.optInt("per_pack", 120), l.optInt("packs", 10),
            (0 until a.length()).map { packOf(a.getJSONObject(it)) }
        )
    }

    suspend fun refresh() = withContext(Dispatchers.IO) {
        try {
            val o = Api.stickers()
            Engine.prefs.edit().putString("stickers_raw", o.toString()).apply()
            state.value = parse(o)
        } catch (e: Exception) { }
    }

    /** The image of a sticker (memory, then the file cache, then the server); null when it is gone or offline. */
    suspend fun bitmap(id: String): ImageBitmap? = withContext(Dispatchers.IO) {
        if (id.length != 32 || !id.all { it in '0'..'9' || it in 'a'..'f' }) return@withContext null
        mem.get(id)?.let { return@withContext it }
        val f = File(dir(), id)
        try {
            if (!f.exists()) {
                val bytes = try { Api.stickerImage(id) } catch (e: Api.HttpError) {
                    if (e.code == 404) gone.value = gone.value + id
                    return@withContext null
                }
                File(dir(), "$id.tmp").apply { writeBytes(bytes); renameTo(f) }
            }
            val bmp = BitmapFactory.decodeFile(f.path)?.asImageBitmap()
            if (bmp != null) mem.put(id, bmp)
            bmp
        } catch (e: Exception) { null }
    }

    /** Runs a server call, reloads the panel; returns an error text or null. */
    private suspend fun call(block: () -> Unit): String? = withContext(Dispatchers.IO) {
        try { block(); refresh(); null } catch (e: Exception) { Engine.errorText(e) }
    }

    suspend fun pack(id: String): Pair<StickerPack?, String?> = withContext(Dispatchers.IO) {
        try { packOf(Api.stickerPack(id)) to null } catch (e: Exception) { null to Engine.errorText(e) }
    }
    suspend fun createPack(title: String): Pair<String?, String?> = withContext(Dispatchers.IO) {
        try { val id = Api.createStickerPack(title).getString("id"); refresh(); id to null } catch (e: Exception) { null to Engine.errorText(e) }
    }
    suspend fun addPack(id: String) = call { Api.stickerPackAction(id, "add") }
    suspend fun removePack(id: String) = call { Api.stickerPackAction(id, "remove") }
    suspend fun renamePack(id: String, title: String) = call { Api.renameStickerPack(id, title) }
    suspend fun deletePack(id: String) = call { Api.deleteStickerPack(id) }
    suspend fun deleteSticker(id: String) = call { Api.deleteSticker(id) }
    /** Moves one of my (non-official) packs up (-1) or down (+1). */
    suspend fun move(id: String, d: Int): String? {
        val ids = state.value.packs.filter { !it.official }.map { it.id }.toMutableList()
        val i = ids.indexOf(id); val j = i + d
        if (i < 0 || j < 0 || j >= ids.size) return null
        ids[i] = ids[j].also { ids[j] = ids[i] }
        return call { Api.orderStickerPacks(ids) }
    }

    /** Encodes a sticker as WebP within the admin's size limit (smaller and smaller if needed). */
    private fun encode(src: Bitmap): ByteArray {
        val max = state.value.kb * 1024
        var bmp = src
        @Suppress("DEPRECATION")
        val fmt = if (Build.VERSION.SDK_INT >= 30) Bitmap.CompressFormat.WEBP_LOSSY else Bitmap.CompressFormat.WEBP
        while (true) {
            for (q in intArrayOf(90, 75, 60, 45)) {
                val out = ByteArrayOutputStream()
                bmp.compress(fmt, q, out)
                if (out.size() <= max) return out.toByteArray()
            }
            if (bmp.width < 128) throw UserError("حجم استیکر بیش از حد مجاز است")
            bmp = Bitmap.createScaledBitmap(bmp, bmp.width * 4 / 5, bmp.height * 4 / 5, true)
        }
    }

    /** Fits a picture into 512x512, keeping its shape and transparency. */
    private fun fit(b: Bitmap): Bitmap {
        val k = minOf(1f, MAX.toFloat() / maxOf(b.width, b.height))
        return if (k >= 1f) b else Bitmap.createScaledBitmap(b, maxOf(1, (b.width * k).toInt()), maxOf(1, (b.height * k).toInt()), true)
    }

    private fun decode(bytes: ByteArray): Bitmap? {
        val o = BitmapFactory.Options().apply { inJustDecodeBounds = true }
        BitmapFactory.decodeByteArray(bytes, 0, bytes.size, o)
        if (o.outWidth <= 0) return null
        var s = 1
        while (maxOf(o.outWidth, o.outHeight) / (s * 2) >= MAX) s *= 2
        return BitmapFactory.decodeByteArray(bytes, 0, bytes.size, BitmapFactory.Options().apply { inSampleSize = s })
    }

    suspend fun addBitmap(packId: String, bmp: Bitmap, emoji: String): String? = call {
        Api.addSticker(packId, encode(bmp), "image/webp", emoji.trim().ifEmpty { null })
    }

    /**
     * Adds pictures (and the pictures inside .zip files) to my pack, each fitted to 512x512.
     * Returns how many were added and the last error (or null).
     */
    suspend fun import(packId: String, uris: List<Uri>, progress: (Int, Int) -> Unit): Pair<Int, String?> = withContext(Dispatchers.IO) {
        val cr = Engine.app.contentResolver
        val items = ArrayList<Pair<String, ByteArray>>()
        for (u in uris) {
            val type = cr.getType(u) ?: ""
            val name = U.fileName(Engine.app, u)
            try {
                if (type.contains("zip") || name.endsWith(".zip", true)) {
                    cr.openInputStream(u)?.use { ins ->
                        ZipInputStream(ins).use { z ->
                            var e = z.nextEntry
                            var total = 0L
                            while (e != null && items.size < 500) {
                                val n = e.name
                                if (!e.isDirectory && Regex("\\.(png|webp|jpe?g|gif)$", RegexOption.IGNORE_CASE).containsMatchIn(n) && !n.contains("__MACOSX") && !n.substringAfterLast('/').startsWith(".")) {
                                    val b = z.readBytes()
                                    total += b.size
                                    if (total > 200L * 1024 * 1024) break
                                    items.add(n to b)
                                }
                                e = z.nextEntry
                            }
                        }
                    }
                } else cr.openInputStream(u)?.use { items.add(name to it.readBytes()) }
            } catch (e: Exception) { }
        }
        items.sortBy { it.first.lowercase() }
        if (items.isEmpty()) return@withContext 0 to "عکسی پیدا نشد"
        var ok = 0
        var err: String? = null
        for ((i, it) in items.withIndex()) {
            progress(i + 1, items.size)
            try {
                val bmp = decode(it.second) ?: throw UserError("عکس «${it.first.substringAfterLast('/')}» باز نشد")
                Api.addSticker(packId, encode(fit(bmp)), "image/webp", null)
                ok++
            } catch (e: Exception) {
                err = Engine.errorText(e)
                if (e is Api.HttpError && (e.error == "pack_full" || e.error == "stickers_disabled")) break
            }
        }
        refresh()
        ok to err
    }

    /** A picture from the gallery, rotated upright, at most 1024 px on its long side (for the sticker maker). */
    suspend fun loadPhoto(uri: Uri): Bitmap? = withContext(Dispatchers.IO) {
        try {
            val cr = Engine.app.contentResolver
            val bytes = cr.openInputStream(uri)?.use { it.readBytes() } ?: return@withContext null
            val o = BitmapFactory.Options().apply { inJustDecodeBounds = true }
            BitmapFactory.decodeByteArray(bytes, 0, bytes.size, o)
            var s = 1
            while (maxOf(o.outWidth, o.outHeight) / (s * 2) >= 1024) s *= 2
            var bmp = BitmapFactory.decodeByteArray(bytes, 0, bytes.size, BitmapFactory.Options().apply { inSampleSize = s }) ?: return@withContext null
            val rot = bytes.inputStream().use { exifRotation(it) }
            if (rot != 0) bmp = Bitmap.createBitmap(bmp, 0, 0, bmp.width, bmp.height, Matrix().apply { postRotate(rot.toFloat()) }, true)
            bmp
        } catch (e: Exception) { null }
    }

    /**
     * Draws the sticker maker's result: the photo scaled by [zoom] and moved by ([dx], [dy]) (fractions of the
     * side), cropped square or round, with an optional caption at the bottom. size x size, transparent outside.
     */
    fun render(photo: Bitmap, size: Int, round: Boolean, zoom: Float, dx: Float, dy: Float, caption: String): Bitmap {
        val out = Bitmap.createBitmap(size, size, Bitmap.Config.ARGB_8888)
        val c = Canvas(out)
        c.drawColor(0, PorterDuff.Mode.CLEAR)
        c.save()
        if (round) c.clipPath(Path().apply { addCircle(size / 2f, size / 2f, size / 2f, Path.Direction.CW) })
        val base = maxOf(size.toFloat() / photo.width, size.toFloat() / photo.height) * zoom
        val w = photo.width * base; val h = photo.height * base
        val m = Matrix().apply { postScale(base, base); postTranslate((size - w) / 2 + dx * size, (size - h) / 2 + dy * size) }
        c.drawBitmap(photo, m, Paint(Paint.FILTER_BITMAP_FLAG or Paint.ANTI_ALIAS_FLAG))
        c.restore()
        if (caption.isNotBlank()) {
            val fs = size * 0.11f
            val p = Paint(Paint.ANTI_ALIAS_FLAG).apply { textSize = fs; typeface = Typeface.DEFAULT_BOLD; textAlign = Paint.Align.CENTER }
            while (p.measureText(caption) > size * 0.94f && p.textSize > 10f) p.textSize = p.textSize * 0.9f
            val y = size - size * 0.05f
            p.style = Paint.Style.STROKE; p.strokeWidth = p.textSize * 0.18f; p.strokeJoin = Paint.Join.ROUND; p.color = android.graphics.Color.BLACK
            c.drawText(caption, size / 2f, y, p)
            p.style = Paint.Style.FILL; p.color = android.graphics.Color.WHITE
            c.drawText(caption, size / 2f, y, p)
        }
        return out
    }
}
