package com.pchat.app

import android.icu.text.BreakIterator
import androidx.compose.animation.core.Animatable
import androidx.compose.animation.core.Spring
import androidx.compose.animation.core.keyframes
import androidx.compose.animation.core.spring
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.grid.GridCells
import androidx.compose.foundation.lazy.grid.LazyVerticalGrid
import androidx.compose.foundation.lazy.grid.items
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import kotlinx.coroutines.launch

object Emoji {
    /** Tab icon, title and the emoji of each category (system emoji font, no extra assets). */
    val categories: List<Triple<String, String, List<String>>> = listOf(
        Triple("😀", "شکلک‌ها", split("😀 😃 😄 😁 😆 😅 🤣 😂 🙂 🙃 😉 😊 😇 🥰 😍 🤩 😘 😗 😚 😙 😋 😛 😜 🤪 😝 🤑 🤗 🤭 🤫 🤔 🤐 🤨 😐 😑 😶 😏 😒 🙄 😬 😌 😔 😪 🤤 😴 😷 🤒 🤕 🤢 🤮 🥵 🥶 🥴 😵 🤯 🤠 🥳 😎 🤓 🧐 😕 😟 🙁 😮 😯 😲 😳 🥺 😦 😧 😨 😰 😥 😢 😭 😱 😖 😣 😞 😓 😩 😫 🥱 😤 😡 😠 🤬 😈 👿 💀 💩 🤡 👻 👽 🤖 😺 😸 😹 😻 😼 😽 🙀 😿 😾")),
        Triple("👋", "مردم", split("👋 🤚 🖐 ✋ 🖖 👌 🤌 🤏 ✌️ 🤞 🤟 🤘 🤙 👈 👉 👆 👇 ☝️ 👍 👎 ✊ 👊 🤛 🤜 👏 🙌 👐 🤲 🤝 🙏 ✍️ 💅 🤳 💪 🦾 👀 👁 👅 👄 🧠 👶 🧒 👦 👧 🧑 👱 👨 🧔 👩 🧓 👴 👵 🙍 🙎 🙅 🙆 💁 🙋 🧏 🙇 🤦 🤷 👮 🕵️ 💂 👷 🤴 👸 👳 🧕 🤵 👰 🤰 🤱 👼 🎅 🦸 🧙 🧚 🧛 🧜 🧝 💆 💇 🚶 🏃 💃 🕺 👯 🧘 👪 💑 💏")),
        Triple("❤️", "قلب و نماد", split("❤️ 🧡 💛 💚 💙 💜 🖤 🤍 🤎 💔 ❣️ 💕 💞 💓 💗 💖 💘 💝 💟 ☮️ ✝️ ☪️ 🕉 ☯️ ✡️ 🔯 ♈ ♉ ♊ ♋ ♌ ♍ ♎ ♏ ♐ ♑ ♒ ♓ ⛎ 🆗 🆕 🆒 🆓 🆙 ✅ ☑️ ✔️ ❌ ❎ ➕ ➖ ➗ ✖️ 💯 💢 💥 💫 💦 💨 🕳 💬 💭 💤 ⭐ 🌟 ✨ ⚡ 🔥 💧 🌈 ☀️ 🌙 ❓ ❗ ‼️ ⁉️ ⚠️ 🚫 ⛔ 🔞 ♻️ 🔰 ⭕ 🛑 🔴 🟠 🟡 🟢 🔵 🟣 ⚫ ⚪ 🟥 🟧 🟨 🟩 🟦 🟪 ⬛ ⬜ #️⃣ *️⃣ 0️⃣ 1️⃣ 2️⃣ 3️⃣ 4️⃣ 5️⃣ 6️⃣ 7️⃣ 8️⃣ 9️⃣ 🔟")),
        Triple("🐱", "حیوانات و طبیعت", split("🐶 🐱 🐭 🐹 🐰 🦊 🐻 🐼 🐨 🐯 🦁 🐮 🐷 🐸 🐵 🙈 🙉 🙊 🐔 🐧 🐦 🐤 🦆 🦅 🦉 🦇 🐺 🐗 🐴 🦄 🐝 🐛 🦋 🐌 🐞 🐜 🦂 🐢 🐍 🦎 🐙 🦑 🦐 🦀 🐡 🐠 🐟 🐬 🐳 🐋 🦈 🐊 🐅 🐆 🦓 🦍 🐘 🦛 🦏 🐪 🐫 🦒 🦘 🐃 🐂 🐄 🐎 🐖 🐏 🐑 🐐 🦌 🐕 🐈 🐓 🦃 🦚 🦜 🦢 🕊 🐇 🐿 🦔 🌵 🎄 🌲 🌳 🌴 🌱 🌿 ☘️ 🍀 🍃 🍂 🍁 🍄 🌾 💐 🌷 🌹 🥀 🌺 🌸 🌼 🌻 🌞 🌝 🌚 🌍 🪐 ⛅ 🌧 ⛈ ❄️ ☃️ 🌊")),
        Triple("🍕", "خوراکی", split("🍏 🍎 🍐 🍊 🍋 🍌 🍉 🍇 🍓 🫐 🍈 🍒 🍑 🥭 🍍 🥥 🥝 🍅 🍆 🥑 🥦 🥬 🥒 🌶 🌽 🥕 🧄 🧅 🥔 🍠 🥐 🍞 🥖 🥨 🧀 🥚 🍳 🥞 🧇 🥓 🥩 🍗 🍖 🌭 🍔 🍟 🍕 🥪 🌮 🌯 🥗 🥘 🍝 🍜 🍲 🍛 🍣 🍱 🥟 🍤 🍙 🍚 🍘 🍥 🥮 🍢 🍡 🍧 🍨 🍦 🥧 🧁 🍰 🎂 🍮 🍭 🍬 🍫 🍿 🍩 🍪 🌰 🥜 🍯 🥛 ☕ 🍵 🧃 🥤 🧋 🍶 🍺 🍻 🥂 🍷 🍹 🧊 🥄 🍴 🍽")),
        Triple("⚽", "فعالیت و سفر", split("⚽ 🏀 🏈 ⚾ 🎾 🏐 🏉 🎱 🏓 🏸 🥅 🏒 🏑 🏏 ⛳ 🏹 🎣 🥊 🥋 🎽 🛹 ⛸ 🎿 🏂 🏋️ 🤸 🤺 ⛹️ 🏊 🚴 🏆 🥇 🥈 🥉 🏅 🎖 🎗 🎫 🎪 🎭 🎨 🎬 🎤 🎧 🎼 🎹 🥁 🎷 🎺 🎸 🎻 🎲 ♟ 🎯 🎳 🎮 🧩 🚗 🚕 🚙 🚌 🏎 🚓 🚑 🚒 🚚 🚜 🏍 🛵 🚲 🛴 🚨 🚆 🚇 🚊 ✈️ 🛫 🛬 🚀 🛸 🚁 ⛵ 🚤 🛳 ⚓ 🚧 ⛽ 🗺 🗽 🗼 🏰 🏯 🏟 🎡 🎢 ⛲ 🏖 🏝 🏜 🌋 ⛰ 🏔 🏕 🏠 🏡 🏢 🏥 🏦 🏨 🏫 🕌 🕋 ⛪ 🌅 🌄 🌃 🌉 🎆 🎇")),
        Triple("💡", "اشیا", split("⌚ 📱 💻 ⌨️ 🖥 🖨 🖱 💾 💿 📷 📸 📹 🎥 📞 ☎️ 📺 📻 🎙 ⏰ ⏳ ⌛ 📡 🔋 🔌 💡 🔦 🕯 🧯 💵 💴 💶 💷 💰 💳 💎 ⚖️ 🔧 🔨 ⚒ 🛠 ⛏ 🔩 ⚙️ 🧱 ⛓ 🧲 🔫 💣 🔪 🗡 ⚔️ 🛡 🔮 💈 🧪 🌡 🧹 🧺 🧻 🚽 🚿 🛁 🧼 🔑 🗝 🚪 🛋 🛏 🧸 🖼 🛍 🛒 🎁 🎈 🎏 🎀 🎊 🎉 🎎 🏮 ✉️ 📩 📨 📧 💌 📦 🏷 📪 📬 📜 📃 📄 📑 📊 📈 📉 🗒 📆 📅 🗓 📇 🗃 🗳 🗄 📋 📁 📂 🗞 📰 📓 📔 📒 📕 📗 📘 📙 📚 📖 🔖 🔗 📎 🖇 📐 📏 📌 📍 ✂️ 🖊 🖋 ✒️ 🖌 🖍 📝 ✏️ 🔍 🔎 🔏 🔐 🔒 🔓")),
        Triple("🇮🇷", "پرچم‌ها", split("🏳️ 🏴 🏁 🚩 🏳️‍🌈 🇮🇷 🇦🇫 🇹🇯 🇮🇶 🇹🇷 🇦🇿 🇦🇲 🇬🇪 🇸🇦 🇦🇪 🇶🇦 🇰🇼 🇧🇭 🇴🇲 🇵🇰 🇮🇳 🇨🇳 🇯🇵 🇰🇷 🇷🇺 🇺🇦 🇩🇪 🇫🇷 🇮🇹 🇪🇸 🇬🇧 🇳🇱 🇸🇪 🇳🇴 🇨🇭 🇦🇹 🇺🇸 🇨🇦 🇧🇷 🇦🇷 🇦🇺 🇳🇿 🇪🇬 🇿🇦")),
    )

    private fun split(s: String) = s.split(' ').filter { it.isNotEmpty() }

    private fun isEmojiCp(cp: Int): Boolean =
        cp in 0x1F000..0x1FAFF || cp in 0x2600..0x27BF || cp in 0x2300..0x23FF || cp in 0x2B00..0x2BFF ||
            cp in 0x2194..0x21AA || cp == 0x2934 || cp == 0x2935 || cp in 0x25AA..0x25FE ||
            cp == 0x00A9 || cp == 0x00AE || cp == 0x203C || cp == 0x2049 || cp == 0x2122 || cp == 0x2139 ||
            cp == 0x3030 || cp == 0x303D || cp == 0x3297 || cp == 0x3299

    /** Joiners, variation selectors, skin tones, keycaps and tag characters that may follow an emoji. */
    private fun isEmojiPart(cp: Int): Boolean =
        isEmojiCp(cp) || cp == 0x200D || cp == 0xFE0F || cp == 0xFE0E || cp == 0x20E3 || cp in 0xE0020..0xE007F

    private fun isEmojiCluster(c: String): Boolean {
        val cps = c.codePoints().toArray()
        if (cps.isEmpty()) return false
        val first = cps[0]
        val keycap = (first in '0'.code..'9'.code || first == '#'.code || first == '*'.code) && cps.contains(0x20E3)
        if (!keycap && !isEmojiCp(first)) return false
        return cps.drop(1).all { isEmojiPart(it) }
    }

    /** 1..3 when the message is nothing but that many emoji (shown large and animated), otherwise 0. */
    fun onlyEmojiCount(text: String): Int {
        val s = text.trim()
        if (s.isEmpty() || s.length > 64) return 0
        val it = BreakIterator.getCharacterInstance()
        it.setText(s)
        var start = it.first()
        var n = 0
        var end = it.next()
        while (end != BreakIterator.DONE) {
            val c = s.substring(start, end)
            if (c.isNotBlank()) {
                if (!isEmojiCluster(c)) return 0
                n++
                if (n > 3) return 0
            }
            start = end
            end = it.next()
        }
        return n
    }

    fun recent(): List<String> = (Engine.prefs.getString("emoji_recent", "") ?: "").split(' ').filter { it.isNotEmpty() }

    fun addRecent(e: String) {
        val list = (listOf(e) + recent().filter { it != e }).take(32)
        Engine.prefs.edit().putString("emoji_recent", list.joinToString(" ")).apply()
    }
}

/** Emoji keyboard shown in place of the system keyboard. */
@Composable
fun EmojiPanel(onPick: (String) -> Unit) {
    var tab by remember { mutableIntStateOf(if (Emoji.recent().isEmpty()) 1 else 0) }
    var recent by remember { mutableStateOf(Emoji.recent()) }
    val tabs = listOf(Triple("🕘", "اخیر", recent)) + Emoji.categories
    Column(Modifier.fillMaxWidth().height(290.dp)) {
        LazyRow(Modifier.fillMaxWidth().padding(vertical = 4.dp)) {
            itemsIndexed(tabs) { i, t ->
                Box(
                    Modifier.padding(horizontal = 2.dp).clip(RoundedCornerShape(10.dp))
                        .background(if (i == tab) MaterialTheme.colorScheme.primary.copy(alpha = 0.18f) else androidx.compose.ui.graphics.Color.Transparent)
                        .clickable { tab = i }.padding(horizontal = 10.dp, vertical = 6.dp)
                ) { Text(t.first, fontSize = 20.sp) }
            }
        }
        val list = tabs[tab].third
        if (list.isEmpty()) {
            Box(Modifier.fillMaxWidth().padding(24.dp), contentAlignment = Alignment.Center) {
                Text("هنوز ایموجی‌ای نفرستاده‌اید", color = MaterialTheme.colorScheme.onSurface.copy(alpha = 0.6f))
            }
        } else {
            LazyVerticalGrid(columns = GridCells.Adaptive(44.dp), modifier = Modifier.fillMaxWidth().weight(1f)) {
                items(list) { e ->
                    Box(
                        Modifier.clip(RoundedCornerShape(8.dp)).clickable { Emoji.addRecent(e); if (tab != 0) recent = Emoji.recent(); onPick(e) }.padding(6.dp),
                        contentAlignment = Alignment.Center
                    ) { Text(e, fontSize = 26.sp) }
                }
            }
        }
    }
}

/** An emoji-only message: twice the normal text size, pops in and wobbles once; tap to replay. */
@Composable
fun BigEmoji(text: String, key: Any) {
    val scope = rememberCoroutineScope()
    val scale = remember { Animatable(0.4f) }
    val angle = remember { Animatable(0f) }
    suspend fun play() {
        scale.snapTo(0.4f)
        scale.animateTo(1f, spring(dampingRatio = 0.35f, stiffness = Spring.StiffnessMediumLow))
        angle.animateTo(0f, keyframes { durationMillis = 700; -14f at 120; 12f at 260; -8f at 400; 4f at 540 })
    }
    LaunchedEffect(key) { play() }
    Row(
        Modifier.clickable(indication = null, interactionSource = remember { androidx.compose.foundation.interaction.MutableInteractionSource() }) { scope.launch { play() } }
    ) {
        Text(
            text.trim(), fontSize = 32.sp, lineHeight = 40.sp,
            modifier = Modifier.graphicsLayer { scaleX = scale.value; scaleY = scale.value; rotationZ = angle.value }
        )
    }
}
