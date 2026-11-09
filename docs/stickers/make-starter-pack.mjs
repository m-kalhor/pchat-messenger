// Renders the starter sticker pack «شکلک‌های سپن» into server/src/stickers-default/sepan/.
// Art: Noto Color Emoji (SIL OFL 1.1) and the Vazirmatn font (SIL OFL 1.1). Needs Playwright + Chromium.
//   node docs/stickers/make-starter-pack.mjs /path/to/Vazirmatn-Black.ttf
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const out = path.join(root, 'server/src/stickers-default/sepan');
const font = process.argv[2];
if (!font || !fs.existsSync(font)) { console.error('usage: make-starter-pack.mjs <Vazirmatn-Black.ttf>'); process.exit(1); }

// [emoji shown in the panel, picture, text (optional), text colour]
const STICKERS = [
  ['👋', '👋', 'سلام', '#1e88e5'],
  ['🙏', '🙏', 'مرسی', '#43a047'],
  ['👏', '👏', 'دمت گرم', '#f4511e'],
  ['🫡', '🫡', 'چاکرم', '#6d4c41'],
  ['💪', '💪', 'خسته نباشی', '#8e24aa'],
  ['☀️', '☀️', 'صبح بخیر', '#fb8c00'],
  ['🌙', '🌙', 'شب بخیر', '#3949ab'],
  ['🔥', '🔥', 'عالیه', '#e53935'],
  ['👌', '👌', 'باشه', '#00897b'],
  ['✅', '✅', 'حله', '#2e7d32'],
  ['😔', '😔', 'ببخشید', '#546e7a'],
  ['❤️', '❤️', 'دوستت دارم', '#d81b60'],
  ['🎉', '🎉', 'تبریک', '#c2185b'],
  ['🥰', '🥰', 'قربونت برم', '#ad1457'],
  ['🙂', '🙂', 'چشم', '#0277bd'],
  ['⏳', '⏳', 'منتظرم', '#5e35b1'],
  ['😂', '😂', 'خیلی باحالی', '#ef6c00'],
  ['🤔', '🤔', 'چی بگم والا', '#795548'],
  ...['😂', '🤣', '😍', '🥰', '😘', '😊', '😎', '🤔', '😢', '😭', '😡', '😱', '😴', '🤗', '🥳', '😇',
    '🙄', '😅', '😬', '🤩', '👍', '👏', '🙏', '💪', '👌', '❤️', '💔', '🔥', '🎉', '🌹', '☕', '💯'].map((e) => [e, e, '', '']),
];

const browser = await chromium.launch();
const page = await browser.newPage();
await page.setContent(`<style>@font-face{font-family:V;src:url(data:font/ttf;base64,${fs.readFileSync(font).toString('base64')})}</style><p style="font-family:V">.</p><p style="font-family:'Noto Color Emoji'">😀</p>`);
await page.evaluate(() => Promise.all([document.fonts.load('80px V', 'سلام'), document.fonts.load('80px "Noto Color Emoji"', '😀')]));

const files = await page.evaluate((list) => {
  const S = 512;
  /** Draws c onto a new canvas with a white outline of r pixels around its non-transparent parts. */
  function outlined(c, r) {
    const sil = document.createElement('canvas'); sil.width = sil.height = S;
    const s = sil.getContext('2d');
    s.drawImage(c, 0, 0); s.globalCompositeOperation = 'source-in'; s.fillStyle = '#fff'; s.fillRect(0, 0, S, S);
    const o = document.createElement('canvas'); o.width = o.height = S;
    const g = o.getContext('2d');
    g.shadowColor = 'rgba(0,0,0,.28)'; g.shadowBlur = 10; g.shadowOffsetY = 4;
    for (let a = 0; a < 360; a += 15) g.drawImage(sil, Math.cos(a * Math.PI / 180) * r, Math.sin(a * Math.PI / 180) * r);
    g.shadowColor = 'transparent';
    for (let a = 0; a < 360; a += 15) g.drawImage(sil, Math.cos(a * Math.PI / 180) * r * .6, Math.sin(a * Math.PI / 180) * r * .6);
    g.drawImage(c, 0, 0);
    return o;
  }
  return list.map(([, pic, text, color]) => {
    const c = document.createElement('canvas'); c.width = c.height = S;
    const g = c.getContext('2d');
    g.textAlign = 'center'; g.textBaseline = 'middle';
    if (!text) {
      g.font = '360px "Noto Color Emoji"'; g.fillText(pic, S / 2, S / 2 + 10);
    } else {
      g.font = '250px "Noto Color Emoji"'; g.fillText(pic, S / 2, 170);
      g.direction = 'rtl';
      let size = 120;
      do { g.font = `${size}px V`; size -= 4; } while (g.measureText(text).width > S - 70);
      g.lineJoin = 'round'; g.lineWidth = 3; g.strokeStyle = color; g.strokeText(text, S / 2, 400);
      g.fillStyle = color; g.fillText(text, S / 2, 400);
    }
    return outlined(c, 12).toDataURL('image/webp', 0.86);
  });
}, STICKERS);
await browser.close();

fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(out, { recursive: true });
const manifest = { title: 'شکلک‌های سپن', stickers: [] };
files.forEach((url, i) => {
  const name = String(i + 1).padStart(2, '0') + '.webp';
  fs.writeFileSync(path.join(out, name), Buffer.from(url.split(',')[1], 'base64'));
  manifest.stickers.push({ file: name, emoji: STICKERS[i][0] });
});
fs.writeFileSync(path.join(out, 'pack.json'), JSON.stringify(manifest, null, 1) + '\n');
fs.writeFileSync(path.join(out, 'LICENSE.txt'),
  'Starter pack art made from Noto Color Emoji (Google, SIL Open Font License 1.1)\n' +
  'and the Vazirmatn font (Saber Rastikerdar, SIL Open Font License 1.1).\n' +
  'Rendered by docs/stickers/make-starter-pack.mjs.\n');
console.log(files.length, 'stickers written to', out);
