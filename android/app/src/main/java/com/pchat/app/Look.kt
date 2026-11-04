package com.pchat.app

import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.TopAppBarColors
import androidx.compose.material3.TopAppBarDefaults
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.draw.drawWithCache
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Canvas
import androidx.compose.ui.graphics.ImageBitmap
import androidx.compose.ui.graphics.drawscope.CanvasDrawScope
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.StrokeJoin
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.graphics.drawscope.rotate
import androidx.compose.ui.graphics.drawscope.scale
import androidx.compose.ui.graphics.drawscope.translate
import androidx.compose.ui.graphics.luminance
import androidx.compose.ui.graphics.vector.PathParser
import androidx.compose.ui.geometry.CornerRadius
import androidx.compose.ui.geometry.RoundRect
import androidx.compose.ui.graphics.Outline
import androidx.compose.ui.graphics.PathOperation
import androidx.compose.ui.graphics.Shape
import androidx.compose.ui.unit.Density
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.LayoutDirection
import androidx.compose.ui.unit.dp

/**
 * 1.9: the Telegram-like look: blue top bars, a patterned green-blue chat wallpaper (Sepan's own doodles,
 * the same tile as the web app's wallpaper.svg), green ticks on my bubbles. Dark mode gets a dark version.
 */
object Look {
    val headLight = Color(0xFF517DA2)
    val headDark = Color(0xFF17212B)

    @Composable
    fun dark(): Boolean = MaterialTheme.colorScheme.background.luminance() < 0.5f

    @OptIn(ExperimentalMaterial3Api::class)
    @Composable
    fun barColors(): TopAppBarColors = TopAppBarDefaults.topAppBarColors(
        containerColor = if (dark()) headDark else headLight,
        titleContentColor = Color.White, navigationIconContentColor = Color.White, actionIconContentColor = Color.White
    )

    /** the bar's second line (status / "online") */
    val barSub = Color.White.copy(alpha = 0.72f)

    private class P(val icon: Int, val x: Float, val y: Float, val rot: Float, val scale: Float)

    private val icons = listOf(
        "M4 5h16a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H10l-5 4v-4H4a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2z",
        "M12 20s-7-4.5-7-10a4 4 0 0 1 7-2.5A4 4 0 0 1 19 10c0 5.5-7 10-7 10z",
        "M12 3l2.6 5.6 6 .7-4.5 4.1 1.2 6L12 16.4l-5.3 3 1.2-6-4.5-4.1 6-.7z",
        "M3 6h18v12H3z M3 6l9 7 9-7",
        "M6 3l3 4-2 2a12 12 0 0 0 8 8l2-2 4 3-2 3C10 21 3 14 3 5z",
        "M9 18V5l11-2v13 M9 18a3 3 0 1 1-6 0a3 3 0 0 1 6 0z M20 16a3 3 0 1 1-6 0a3 3 0 0 1 6 0z",
        "M7 18h10a4 4 0 0 0 0-8 6 6 0 0 0-11.5 1.5A3.3 3.3 0 0 0 7 18z",
        "M5 19C5 9 11 4 20 4c0 9-5 15-15 15z M5 19l8-8",
        "M3 8h4l2-3h6l2 3h4v11H3z M12 16a3 3 0 1 0 0-6a3 3 0 0 0 0 6z",
        "M3 11l18-8-6 18-3-7z M12 14l9-11",
        "M12 21a9 9 0 1 0 0-18a9 9 0 0 0 0 18z M8 14c1 1.3 2.3 2 4 2s3-.7 4-2 M9 9.5v.5 M15 9.5v.5",
        "M6 11h12v9H6z M8 11V8a4 4 0 0 1 8 0v3",
        "M12 4v4 M12 16v4 M4 12h4 M16 12h4",
        "M12 21a9 9 0 1 0 0-18a9 9 0 0 0 0 18z M12 7v5l3 2",
        "M4 20l4-1L19 8l-3-3L5 16z M14 7l3 3",
        "M12 2v3 M12 19v3 M2 12h3 M19 12h3 M12 16a4 4 0 1 0 0-8a4 4 0 0 0 0 8z",
    )
    /** (icon, x, y, rotation, scale) inside a 240-unit tile */
    private val placements = listOf(
        P(0, 33.2f, 35.1f, 8f, 1.09f),
        P(7, 84.6f, 27.2f, 8f, 1.14f),
        P(14, 143.7f, 25.7f, -8f, 1.17f),
        P(5, 218.4f, 36.0f, 25f, 1.15f),
        P(12, 41.6f, 91.2f, -15f, 1.31f),
        P(3, 112.6f, 83.1f, 0f, 1.17f),
        P(10, 169.2f, 95.5f, 0f, 1.06f),
        P(1, 226.4f, 88.6f, 25f, 1.17f),
        P(8, 32.8f, 146.4f, 8f, 1.3f),
        P(15, 95.3f, 158.2f, -15f, 1.28f),
        P(6, 151.4f, 142.9f, -15f, 1.17f),
        P(13, 203.5f, 152.3f, -25f, 1.21f),
        P(4, 44.2f, 218.2f, 0f, 1.23f),
        P(11, 105.4f, 215.8f, 0f, 1.16f),
        P(2, 172.1f, 216.6f, -25f, 1.12f),
        P(9, 216.5f, 207.8f, -25f, 1.25f),
    )

    private val paths: List<Path> by lazy { icons.map { PathParser().parsePathString(it).toPath() } }

    private const val TILE = 240f
    private val lightBrush = Brush.linearGradient(listOf(Color(0xFFD6E5C6), Color(0xFFBCD7CB), Color(0xFFC3D6E3)), start = Offset.Zero, end = Offset.Infinite)
    private val darkBrush = Brush.linearGradient(listOf(Color(0xFF0E1621), Color(0xFF10202A), Color(0xFF0F1D1B)), start = Offset.Zero, end = Offset.Infinite)

    /** the chat background: the wallpaper, or a plain color when it is turned off in Settings */
    @Composable
    fun chatBackground(): Modifier {
        val on by Prefs.wallpaper.collectAsState()
        val dark = dark()
        if (!on) return Modifier.drawBehind { drawRect(if (dark) Color(0xFF0E1621) else Color(0xFFE6EBEE)) }
        val stroke = if (dark) Color.White.copy(alpha = 0.06f) else Color(0xFF3D6B4F).copy(alpha = 0.16f)
        val brush = if (dark) darkBrush else lightBrush
        // drawn once into a bitmap per size (keyboard open / closed), so scrolling the chat costs nothing
        return Modifier.drawWithCache {
            val w = size.width.toInt().coerceAtLeast(1)
            val h = size.height.toInt().coerceAtLeast(1)
            val bmp = ImageBitmap(w, h)
            CanvasDrawScope().draw(this, layoutDirection, Canvas(bmp), Size(w.toFloat(), h.toFloat())) {
                drawRect(brush)
                val k = density // one tile unit = 1 dp
                val tile = TILE * k
                val style = Stroke(width = 1.5f, cap = StrokeCap.Round, join = StrokeJoin.Round)
                var ty = 0f
                while (ty < this.size.height) {
                    var tx = -tile
                    while (tx < this.size.width + tile) {
                        for (p in placements) {
                            val cx = tx + p.x * k
                            val cy = ty + p.y * k
                            if (cx < -30 * k || cx > this.size.width + 30 * k) continue
                            translate(cx, cy) {
                                rotate(p.rot, pivot = Offset.Zero) {
                                    scale(p.scale * k, pivot = Offset.Zero) {
                                        translate(-12f, -12f) { drawPath(paths[p.icon], stroke, style = style) }
                                    }
                                }
                            }
                        }
                        tx += tile
                    }
                    ty += tile
                }
            }
            onDrawBehind { drawImage(bmp) }
        }
    }
}

/**
 * 1.9: a chat bubble with a Telegram-like tail on the last bubble of a run. The tail side always keeps
 * [t] of room, so bubbles with and without a tail line up.
 */
class BubbleShape(private val mine: Boolean, private val tail: Boolean, private val r: Dp = 14.dp, private val t: Dp = 6.dp) : Shape {
    @Suppress("DEPRECATION")
    override fun createOutline(size: Size, layoutDirection: LayoutDirection, density: Density): Outline {
        val rp = with(density) { r.toPx() }
        val tp = with(density) { t.toPx() }
        val left = if (mine) 0f else tp
        val right = if (mine) size.width - tp else size.width
        val small = if (tail) 0f else with(density) { 4.dp.toPx() }
        val body = Path().apply {
            addRoundRect(RoundRect(left, 0f, right, size.height,
                topLeftCornerRadius = CornerRadius(rp), topRightCornerRadius = CornerRadius(rp),
                bottomRightCornerRadius = CornerRadius(if (mine) small else rp), bottomLeftCornerRadius = CornerRadius(if (mine) rp else small)))
        }
        if (!tail) return Outline.Generic(body)
        val th = minOf(with(density) { 12.dp.toPx() }, size.height)
        val h = size.height
        val tailPath = Path().apply {
            if (mine) { moveTo(right - 1f, h - th); quadraticBezierTo(right + 1f, h - 2f, size.width, h); lineTo(right - 1f, h) }
            else { moveTo(left + 1f, h - th); quadraticBezierTo(left - 1f, h - 2f, 0f, h); lineTo(left + 1f, h) }
            close()
        }
        val out = Path()
        out.op(body, tailPath, PathOperation.Union)
        return Outline.Generic(out)
    }
}
