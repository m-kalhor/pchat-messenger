// Emoji panel data and the "only emoji" check (1 to 3 emoji are shown large, like the Android app).
export const GROUPS = [
  ['چهره‌ها', '😀 😃 😄 😁 😆 😅 😂 🤣 😊 😇 🙂 🙃 😉 😌 😍 🥰 😘 😗 😙 😚 😋 😛 😝 😜 🤪 🤨 🧐 🤓 😎 🥳 😏 😒 😞 😔 😟 😕 🙁 😣 😖 😫 😩 🥺 😢 😭 😤 😠 😡 🤯 😳 🥵 🥶 😱 😨 😰 😥 😓 🤗 🤔 🤭 🤫 🤥 😶 😐 😑 😬 🙄 😯 😦 😧 😮 😲 🥱 😴 🤤 😪 😵 🤐 🥴 🤢 🤮 🤧 😷 🤒 🤕 🤑 🤠 😈 👻 💀 🤖 🎃 😺 😸 😹 😻 😼 😽 🙀 😿 😾'],
  ['دست‌ها', '👋 🤚 🖐 ✋ 🖖 👌 🤏 ✌️ 🤞 🤟 🤘 🤙 👈 👉 👆 👇 ☝️ 👍 👎 ✊ 👊 🤛 🤜 👏 🙌 👐 🤲 🤝 🙏 💪 ✍️ 💅'],
  ['قلب‌ها', '❤️ 🧡 💛 💚 💙 💜 🖤 🤍 🤎 💔 ❣️ 💕 💞 💓 💗 💖 💘 💝 💯 💢 💥 💫 💦 💨 🔥 ✨ ⭐ 🌟'],
  ['طبیعت و غذا', '🌹 🌷 🌸 🌺 🌻 🌼 💐 🍀 🌱 🌳 🌙 ☀️ ⛅ 🌧 ❄️ 🌈 🐶 🐱 🐭 🐰 🦊 🐻 🐼 🦁 🐯 🐮 🐵 🐔 🐦 🦋 🍎 🍉 🍇 🍓 🍒 🍑 🍍 🥝 🍅 🍞 🧀 🍕 🍔 🍟 🍰 🎂 🍫 🍩 ☕ 🍵 🥤'],
  ['چیزها', '🎉 🎊 🎁 🎈 🏆 🥇 ⚽ 🏀 🎮 🎵 🎶 📱 💻 📷 🎥 📞 ⏰ 💡 📚 ✏️ 📌 📎 🔒 🔑 💰 💳 🚗 ✈️ 🏠 🕌 🇮🇷 ✅ ❌ ❓ ❗ ⚠️ 🔔 💤'],
];

const segmenter = typeof Intl !== 'undefined' && Intl.Segmenter ? new Intl.Segmenter('fa', { granularity: 'grapheme' }) : null;
const EMOJI = /\p{Extended_Pictographic}|\p{Regional_Indicator}|⃣/u;
const NOT_EMOJI = /[\p{L}\p{N}]/u;

/** Number of emoji when the text is made only of 1 to 3 emoji, otherwise 0. */
export function onlyEmojiCount(text) {
  const s = (text || '').trim();
  if (!s || s.length > 64) return 0;
  const parts = segmenter ? [...segmenter.segment(s)].map((x) => x.segment) : Array.from(s);
  let n = 0;
  for (const c of parts) {
    if (!c.trim()) continue;
    if (!EMOJI.test(c) || (NOT_EMOJI.test(c) && !c.includes('⃣'))) return 0;
    if (++n > 3) return 0;
  }
  return n;
}

export function recent() {
  try { return JSON.parse(localStorage.getItem('emoji_recent') || '[]'); } catch { return []; }
}
export function addRecent(e) {
  const list = [e, ...recent().filter((x) => x !== e)].slice(0, 24);
  try { localStorage.setItem('emoji_recent', JSON.stringify(list)); } catch { }
}
