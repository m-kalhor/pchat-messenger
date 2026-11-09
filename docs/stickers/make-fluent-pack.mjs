// Renders the pack «شکلک‌های سه‌بعدی» into server/src/stickers-default/fluent3d/ from Microsoft's
// Fluent Emoji 3D (MIT licence), as packaged in the npm package @lobehub/fluent-emoji-3d (MIT).
// The 256 px originals are scaled to 512 px and get a white sticker outline. Needs Playwright + Chromium.
//   npm pack @lobehub/fluent-emoji-3d && tar xzf lobehub-fluent-emoji-3d-*.tgz
//   node docs/stickers/make-fluent-pack.mjs package/assets
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const out = path.join(root, 'server/src/stickers-default/fluent3d');
const src = process.argv[2];
if (!src || !fs.existsSync(src)) { console.error('usage: make-fluent-pack.mjs <@lobehub/fluent-emoji-3d assets folder>'); process.exit(1); }

const EMOJI = ['😂', '🤣', '😍', '🥰', '😘', '😁', '😎', '🤔', '🥺', '😭', '😡', '😱', '🤯', '🥳', '😴', '🤗',
  '🙄', '😅', '🤩', '😇', '🤭', '🫠', '😏', '🤤', '🥶', '🥵', '🤢', '🫡', '👍', '👏', '🙏', '💪',
  '👋', '🤝', '❤️', '💔', '🔥', '🎉', '🌹', '☕', '🎂', '🎁', '⭐', '💯', '🐱', '🐶', '🦁', '🐼'];
const code = (e) => [...e].map((c) => c.codePointAt(0).toString(16)).join('-');
const fileOf = (e) => {
  for (const name of [code(e), code(e).replace(/-fe0f/g, ''), code(e) + '-fe0f']) {
    const f = path.join(src, name + '.webp');
    if (fs.existsSync(f)) return f;
  }
  throw new Error('missing ' + e + ' ' + code(e));
};
const inputs = EMOJI.map((e) => 'data:image/webp;base64,' + fs.readFileSync(fileOf(e)).toString('base64'));

const browser = await chromium.launch();
const page = await browser.newPage();
const files = await page.evaluate(async (list) => {
  const S = 512, R = 12;
  const load = (u) => new Promise((ok, no) => { const i = new Image(); i.onload = () => ok(i); i.onerror = no; i.src = u; });
  const res = [];
  for (const u of list) {
    const img = await load(u);
    const c = document.createElement('canvas'); c.width = c.height = S;
    const g = c.getContext('2d');
    g.imageSmoothingEnabled = true; g.imageSmoothingQuality = 'high';
    const d = 460; g.drawImage(img, (S - d) / 2, (S - d) / 2, d, d);
    const sil = document.createElement('canvas'); sil.width = sil.height = S;
    const s = sil.getContext('2d');
    s.drawImage(c, 0, 0); s.globalCompositeOperation = 'source-in'; s.fillStyle = '#fff'; s.fillRect(0, 0, S, S);
    const o = document.createElement('canvas'); o.width = o.height = S;
    const k = o.getContext('2d');
    k.shadowColor = 'rgba(0,0,0,.28)'; k.shadowBlur = 10; k.shadowOffsetY = 4;
    for (let a = 0; a < 360; a += 15) k.drawImage(sil, Math.cos(a * Math.PI / 180) * R, Math.sin(a * Math.PI / 180) * R);
    k.shadowColor = 'transparent';
    for (let a = 0; a < 360; a += 15) k.drawImage(sil, Math.cos(a * Math.PI / 180) * R * .6, Math.sin(a * Math.PI / 180) * R * .6);
    k.drawImage(c, 0, 0);
    res.push(o.toDataURL('image/webp', 0.88));
  }
  return res;
}, inputs);
await browser.close();

fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(out, { recursive: true });
const manifest = { title: 'شکلک‌های سه‌بعدی', stickers: [] };
files.forEach((url, i) => {
  const name = String(i + 1).padStart(2, '0') + '.webp';
  fs.writeFileSync(path.join(out, name), Buffer.from(url.split(',')[1], 'base64'));
  manifest.stickers.push({ file: name, emoji: EMOJI[i] });
});
fs.writeFileSync(path.join(out, 'pack.json'), JSON.stringify(manifest, null, 1) + '\n');
fs.writeFileSync(path.join(out, 'LICENSE.txt'),
  'Made from Fluent Emoji (3D style) by Microsoft Corporation, https://github.com/microsoft/fluentui-emoji\n' +
  'via the npm package @lobehub/fluent-emoji-3d. MIT License:\n\n' +
  'Copyright (c) Microsoft Corporation.\n\n' +
  'Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated\n' +
  'documentation files (the "Software"), to deal in the Software without restriction, including without limitation\n' +
  'the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and\n' +
  'to permit persons to whom the Software is furnished to do so, subject to the following conditions:\n\n' +
  'The above copyright notice and this permission notice shall be included in all copies or substantial portions\n' +
  'of the Software.\n\n' +
  'THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO\n' +
  'THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE\n' +
  'AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF\n' +
  'CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER\n' +
  'DEALINGS IN THE SOFTWARE.\n');
console.log(files.length, 'stickers written to', out);
