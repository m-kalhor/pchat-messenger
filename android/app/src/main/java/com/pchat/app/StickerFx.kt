package com.pchat.app

import androidx.compose.animation.core.Animatable
import androidx.compose.animation.core.CubicBezierEasing
import androidx.compose.animation.core.FastOutSlowInEasing
import androidx.compose.animation.core.tween
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.size
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Rect
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.layout.boundsInRoot
import androidx.compose.ui.layout.onGloballyPositioned
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.min
import kotlinx.coroutines.async
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.launch

/**
 * 1.22: a sticker sent by holding it comes up big in the middle of the screen, then shrinks into its place in
 * the chat. The copy in the chat stays hidden meanwhile and reports where it is (see StickerContent).
 */
object StickerFx {
    /** msgId 0 = sent from here: its id changes when the server takes it, so it is found as my newest copy. */
    data class Fly(val stkId: String, val msgId: Long, val mine: Boolean, val since: Long = System.currentTimeMillis())

    val flying = MutableStateFlow<Fly?>(null)
    private val places = HashMap<Long, Pair<Long, Rect>>() // message id -> (its time, where it is on screen)

    fun start(stkId: String, msgId: Long, mine: Boolean) {
        if (flying.value != null) return
        synchronized(places) { places.clear() }
        flying.value = Fly(stkId, msgId, mine)
    }

    fun isTarget(f: Fly, m: Msg): Boolean = m.stk?.id == f.stkId &&
        (if (f.mine) m.mine && m.ts >= f.since - 30_000 else m.id == f.msgId)

    fun place(m: Msg, r: Rect) { synchronized(places) { places[m.id] = m.ts to r } }

    /** Where the flying sticker lands: the newest matching copy that is on screen. */
    fun target(): Rect? = synchronized(places) { places.values.maxByOrNull { it.first }?.second }

    fun done() { flying.value = null }
}

@Composable
fun StickerFxOverlay() {
    val fly by StickerFx.flying.collectAsState()
    val f = fly ?: return
    val veil = remember(f) { Animatable(0f) }
    val scale = remember(f) { Animatable(0.2f) }
    val alpha = remember(f) { Animatable(0f) }
    val dx = remember(f) { Animatable(0f) }
    val dy = remember(f) { Animatable(0f) }
    var self by remember(f) { mutableStateOf<Rect?>(null) }
    val density = LocalDensity.current
    BoxWithConstraints(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
        val side = min(min(maxWidth * 0.78f, maxHeight * 0.62f), 440.dp)
        val sidePx = with(density) { side.toPx() }
        LaunchedEffect(f) {
            // up: from small to a little bigger than full, then settle
            launch { veil.animateTo(1f, tween(250)) }
            launch { alpha.animateTo(1f, tween(200)) }
            scale.animateTo(1.08f, tween(300, easing = FastOutSlowInEasing))
            scale.animateTo(1f, tween(120))
            delay(730)
            // down: into its place in the chat (or just fade if it is not on screen)
            val to = StickerFx.target()
            val me = self
            val ease = CubicBezierEasing(0.4f, 0f, 0.2f, 1f)
            val jobs = if (to != null && me != null && to.width > 0f) listOf(
                async { dx.animateTo(to.center.x - me.center.x, tween(480, easing = ease)) },
                async { dy.animateTo(to.center.y - me.center.y, tween(480, easing = ease)) },
                async { scale.animateTo(to.width / sidePx, tween(480, easing = ease)) },
            ) else listOf(
                async { scale.animateTo(0.4f, tween(480, easing = ease)) },
                async { alpha.animateTo(0f, tween(480)) },
            )
            launch { veil.animateTo(0f, tween(480)) }
            jobs.forEach { it.await() }
            StickerFx.done()
        }
        Box(Modifier.fillMaxSize().graphicsLayer { this.alpha = veil.value }.background(Color.Black.copy(alpha = 0.35f)))
        Box(Modifier.size(side).onGloballyPositioned { if (self == null) self = it.boundsInRoot() }.graphicsLayer {
            translationX = dx.value; translationY = dy.value
            scaleX = scale.value; scaleY = scale.value
            this.alpha = alpha.value
        }) { StickerImage(f.stkId, Modifier.fillMaxSize()) }
    }
}
