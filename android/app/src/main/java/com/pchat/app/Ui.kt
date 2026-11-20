package com.pchat.app

import android.content.Context
import android.provider.Settings
import androidx.compose.animation.core.LinearEasing
import androidx.compose.animation.core.RepeatMode
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.tween
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Button
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.hapticfeedback.HapticFeedback
import androidx.compose.ui.hapticfeedback.HapticFeedbackType
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp

/** 1.28: small shared pieces of the new look: empty screens, loading rows, haptics, motion. */
object Ui {
    /** the phone's «remove animations» / animation scale 0: our own transitions then just snap */
    fun reduceMotion(ctx: Context): Boolean = try {
        Settings.Global.getFloat(ctx.contentResolver, Settings.Global.ANIMATOR_DURATION_SCALE, 1f) == 0f
    } catch (e: Exception) { false }

    /** a short tap felt in the hand (follows the phone's own touch-vibration setting) */
    fun tick(h: HapticFeedback) = h.performHapticFeedback(HapticFeedbackType.TextHandleMove)
    fun press(h: HapticFeedback) = h.performHapticFeedback(HapticFeedbackType.LongPress)
}

/** A friendly empty screen: a round picture, a line that says what is missing, what to do, and a button for it. */
@Composable
fun EmptyState(icon: ImageVector, title: String, text: String, modifier: Modifier = Modifier, action: String? = null, onAction: () -> Unit = {}) {
    val p = MaterialTheme.colorScheme.primary
    Column(
        modifier.fillMaxWidth().padding(horizontal = 32.dp, vertical = 40.dp),
        horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(10.dp)
    ) {
        Box(Modifier.size(104.dp).clip(CircleShape).background(p.copy(alpha = 0.10f)), contentAlignment = Alignment.Center) {
            Box(Modifier.size(64.dp).clip(CircleShape).background(p.copy(alpha = 0.16f)), contentAlignment = Alignment.Center) {
                Icon(icon, contentDescription = null, tint = p, modifier = Modifier.size(34.dp))
            }
        }
        Spacer(Modifier.height(4.dp))
        Text(title, fontWeight = FontWeight.Bold, fontSize = 17.sp, textAlign = TextAlign.Center, color = MaterialTheme.colorScheme.onSurface)
        Text(text, fontSize = 14.sp, textAlign = TextAlign.Center, lineHeight = 22.sp, color = MaterialTheme.colorScheme.onSurface.copy(alpha = 0.6f))
        if (action != null) {
            Spacer(Modifier.height(4.dp))
            Button(onClick = onAction, shape = RoundedCornerShape(22.dp)) { Text(action, fontWeight = FontWeight.Bold) }
        }
    }
}

/** A shimmer brush for loading placeholders. */
@Composable
fun shimmer(): Brush {
    val base = MaterialTheme.colorScheme.onSurface.copy(alpha = 0.07f)
    val hi = MaterialTheme.colorScheme.onSurface.copy(alpha = 0.02f)
    val t = rememberInfiniteTransition(label = "shimmer")
    val x by t.animateFloat(0f, 1f, infiniteRepeatable(tween(1300, easing = LinearEasing), RepeatMode.Restart), label = "x")
    val w = 900f
    return Brush.linearGradient(listOf(base, hi, base), start = Offset(-w + x * 2 * w, 0f), end = Offset(x * 2 * w, 0f))
}

/** Grey rows that stand in for the chat list until it arrives. */
@Composable
fun SkeletonRows(n: Int = 7) {
    val b = shimmer()
    val widths = remember { listOf(0.55f to 0.8f, 0.4f to 0.7f, 0.62f to 0.5f, 0.35f to 0.75f, 0.5f to 0.6f, 0.45f to 0.82f, 0.58f to 0.66f) }
    Column(Modifier.fillMaxSize()) {
        repeat(n) { i ->
            val (a, c) = widths[i % widths.size]
            Row(Modifier.fillMaxWidth().padding(horizontal = 14.dp, vertical = 11.dp), verticalAlignment = Alignment.CenterVertically) {
                Box(Modifier.size(52.dp).clip(CircleShape).background(b))
                Spacer(Modifier.width(12.dp))
                Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(9.dp)) {
                    Box(Modifier.fillMaxWidth(a).height(12.dp).clip(RoundedCornerShape(6.dp)).background(b))
                    Box(Modifier.fillMaxWidth(c).height(10.dp).clip(RoundedCornerShape(5.dp)).background(b))
                }
            }
        }
    }
}

/** A thin moving line under the top bar while the app is (re)connecting. */
@Composable
fun ConnectingLine() {
    val t = rememberInfiniteTransition(label = "conn")
    val x by t.animateFloat(-0.4f, 1.1f, infiniteRepeatable(tween(1400, easing = LinearEasing), RepeatMode.Restart), label = "cx")
    val c = MaterialTheme.colorScheme.primary
    Canvas(Modifier.fillMaxWidth().height(2.dp)) {
        val w = size.width * 0.4f
        drawRect(Brush.horizontalGradient(listOf(Color.Transparent, c, Color.Transparent), startX = x * size.width, endX = x * size.width + w))
    }
}

/** Three dots that pulse one after another («در حال نوشتن ...»). */
@Composable
fun TypingDots(color: Color, dot: Int = 4) {
    val t = rememberInfiniteTransition(label = "dots")
    Row(horizontalArrangement = Arrangement.spacedBy(2.dp), verticalAlignment = Alignment.CenterVertically) {
        for (i in 0 until 3) {
            val a by t.animateFloat(
                0.25f, 0.25f,
                infiniteRepeatable(androidx.compose.animation.core.keyframes {
                    durationMillis = 1200
                    0.25f at 0
                    0.25f at i * 200
                    1f at i * 200 + 300
                    0.25f at i * 200 + 600
                }, RepeatMode.Restart), label = "d$i"
            )
            Box(Modifier.size(dot.dp).clip(CircleShape).background(color.copy(alpha = a)))
        }
    }
}
