'use strict';
// 1.10 sticker packs: official packs from the admin panel, users' own packs, adding someone else's pack,
// limits, deletion, and that only clean static WebP / PNG images of at most 512x512 are stored.
const test = require('node:test');
const assert = require('node:assert/strict');
const net = require('node:net');
const path = require('node:path');
const zlib = require('node:zlib');
const { startServer } = require('./helpers/server');

const freePort = () => new Promise((resolve) => { const s = net.createServer().listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); }); });

function crc32(buf) {
  let c, crc = 0xffffffff;
  for (let n = 0; n < buf.length; n++) { c = (crc ^ buf[n]) & 0xff; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; crc = (crc >>> 8) ^ c; }
  return (crc ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
/** A w x h RGBA PNG, optionally with a text chunk or an animation chunk. */
function png(w, h, extra = [], noisy = false) {
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 6;
  const raw = noisy ? require('node:crypto').randomBytes((w * 4 + 1) * h) : Buffer.alloc((w * 4 + 1) * h, 0x80);
  for (let y = 0; y < h; y++) raw[y * (w * 4 + 1)] = 0;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), ...extra, chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

let S, ann, ben, adminBase, cookie = '', csrf = '';
async function adm(method, p, body, raw) {
  const r = await fetch(adminBase + '/admin/api' + p, {
    method, headers: { 'content-type': raw ? 'application/octet-stream' : 'application/json', cookie, 'x-csrf': csrf }, body: raw || (body ? JSON.stringify(body) : undefined),
  });
  const set = r.headers.get('set-cookie');
  if (set) cookie = set.split(';')[0];
  const ct = r.headers.get('content-type') || '';
  return { status: r.status, data: ct.includes('json') ? await r.json() : Buffer.from(await r.arrayBuffer()) };
}

test.before(async () => {
  const port = await freePort();
  S = await startServer({ ADMIN_DISABLE: '0', ADMIN_PORT: String(port) });
  adminBase = `http://127.0.0.1:${port}`;
  const { setSetting, hashPassword } = require(path.join(S.app.appDir, 'db.js'));
  setSetting('admin_pass', hashPassword('admin-pass-1'));
  const r = await adm('POST', '/login', { username: 'admin', password: 'admin-pass-1' });
  csrf = r.data.csrf;
  ann = await S.user('ann');
  ben = await S.user('ben');
});
test.after(() => S && S.stop());

test('the admin makes an official pack that every user sees', async () => {
  const p = await adm('POST', '/stickers/packs', { title: 'گربه‌ها' });
  assert.equal(p.status, 200);
  const up = await adm('POST', '/stickers/pack/' + p.data.id + '/sticker?emoji=' + encodeURIComponent('😺'), null, png(512, 400));
  assert.equal(up.status, 200, JSON.stringify(up.data));
  assert.equal(up.data.emoji, '😺');
  const { webpFile } = await import('./helpers/webp-sample.mjs');
  assert.equal((await adm('POST', '/stickers/pack/' + p.data.id + '/sticker', null, webpFile(64, 64))).status, 200);

  const list = (await S.api(ben, 'GET', '/api/stickers')).data;
  assert.equal(list.create, true);
  const off = list.packs.find((x) => x.id === p.data.id);
  assert.ok(off && off.official && !off.mine);
  assert.equal(off.stickers.length, 2);
  const img = await S.api(ann, 'GET', '/api/sticker/' + off.stickers[0].id);
  assert.equal(img.status, 200);
  assert.equal(img.headers.get('content-type'), 'image/png');
  assert.equal((await S.api(null, 'GET', '/api/sticker/' + off.stickers[0].id)).status, 401);
  const panel = (await adm('GET', '/stickers')).data;
  assert.equal(panel.packs.find((x) => x.id === p.data.id).count, 2);
});

test('images are cleaned: no metadata, no animation, at most 512x512', async () => {
  const pk = (await S.api(ann, 'POST', '/api/stickers/packs', { title: 'mine' })).data;
  const add = (buf) => S.api(ann, 'POST', '/api/stickers/pack/' + pk.id + '/sticker', buf, { 'content-type': 'application/octet-stream' });
  const withText = png(100, 100, [chunk('tEXt', Buffer.from('Comment\0secret gps'))]);
  const ok = await add(withText);
  assert.equal(ok.status, 200);
  const back = (await S.api(ann, 'GET', '/api/sticker/' + ok.data.id)).data;
  assert.ok(!back.includes(Buffer.from('secret')), 'text chunk dropped');
  assert.equal((await add(png(600, 100))).data.error, 'bad_sticker');
  assert.equal((await add(png(100, 100, [chunk('acTL', Buffer.alloc(8))]))).data.error, 'bad_sticker');
  assert.equal((await add(Buffer.from('<svg></svg>'.padEnd(200)))).data.error, 'bad_sticker');
  assert.equal((await S.api(ann, 'DELETE', '/api/stickers/pack/' + pk.id)).status, 200);
});

test('own packs: create, add, rename, share with someone who received a sticker, delete', async () => {
  const pk = (await S.api(ann, 'POST', '/api/stickers/packs', { title: '  my  pack ' })).data;
  assert.equal(pk.title, 'my pack');
  assert.ok(pk.mine && pk.added);
  const s = (await S.api(ann, 'POST', '/api/stickers/pack/' + pk.id + '/sticker?emoji=%F0%9F%98%82', png(64, 64), { 'content-type': 'image/png' })).data;
  assert.match(s.id, /^[a-f0-9]{32}$/);
  // ben cannot change ann's pack, but can look at it and add it to his collection
  assert.equal((await S.api(ben, 'POST', '/api/stickers/pack/' + pk.id + '/sticker', png(8, 8))).status, 403);
  assert.equal((await S.api(ben, 'POST', '/api/stickers/pack/' + pk.id + '/rename', { title: 'x' })).status, 403);
  assert.equal((await S.api(ben, 'DELETE', '/api/stickers/pack/' + pk.id)).status, 403);
  const seen = (await S.api(ben, 'GET', '/api/stickers/pack/' + pk.id)).data;
  assert.equal(seen.added, false);
  assert.equal(seen.stickers.length, 1);
  assert.equal((await S.api(ben, 'POST', '/api/stickers/pack/' + pk.id + '/add')).data.added, true);
  assert.ok((await S.api(ben, 'GET', '/api/stickers')).data.packs.some((x) => x.id === pk.id && !x.mine));
  assert.equal((await S.api(ann, 'POST', '/api/stickers/pack/' + pk.id + '/rename', { title: 'renamed' })).data.title, 'renamed');
  // owner deletes: gone for everybody, the image too
  assert.equal((await S.api(ann, 'DELETE', '/api/stickers/pack/' + pk.id)).status, 200);
  assert.ok(!(await S.api(ben, 'GET', '/api/stickers')).data.packs.some((x) => x.id === pk.id));
  assert.equal((await S.api(ben, 'GET', '/api/sticker/' + s.id)).status, 404);
  assert.equal((await S.api(ben, 'GET', '/api/stickers/pack/' + pk.id)).status, 404);
});

test('admin limits: pack count, stickers per pack, size, and turning user packs off', async () => {
  assert.equal((await adm('POST', '/stickers/config', { max_packs: 1, per_pack: 1, max_kb: 20 })).status, 200);
  assert.equal((await adm('POST', '/stickers/config', { max_kb: 1 })).data.error, 'bad_limit');
  const pk = (await S.api(ben, 'POST', '/api/stickers/packs', { title: 'one' })).data;
  assert.equal((await S.api(ben, 'POST', '/api/stickers/packs', { title: 'two' })).data.error, 'pack_limit');
  const add = (buf) => S.api(ben, 'POST', '/api/stickers/pack/' + pk.id + '/sticker', buf, { 'content-type': 'image/png' });
  assert.equal((await add(png(128, 128, [], true))).status, 413); // random pixels: ~64 KB, over 20 KB
  assert.equal((await add(png(16, 16))).status, 200);
  assert.equal((await add(png(16, 16))).data.error, 'pack_full');
  await adm('POST', '/stickers/config', { user_create: false });
  assert.equal((await S.api(ben, 'GET', '/api/stickers')).data.create, false);
  assert.equal((await S.api(ben, 'POST', '/api/stickers/packs', { title: 'x' })).status, 403);
  // the admin removes the user's pack
  assert.equal((await adm('POST', '/stickers/pack/' + pk.id + '/delete')).status, 200);
  assert.ok(!(await S.api(ben, 'GET', '/api/stickers')).data.packs.some((x) => x.id === pk.id));
  await adm('POST', '/stickers/config', { user_create: true, max_packs: 10, per_pack: 120, max_kb: 300 });
});

test('reordering the collection', async () => {
  const a = (await S.api(ann, 'POST', '/api/stickers/packs', { title: 'A' })).data.id;
  const b = (await S.api(ann, 'POST', '/api/stickers/packs', { title: 'B' })).data.id;
  const own = async () => (await S.api(ann, 'GET', '/api/stickers')).data.packs.filter((x) => x.mine).map((x) => x.id);
  assert.deepEqual(await own(), [a, b]);
  await S.api(ann, 'POST', '/api/stickers/order', { packs: [b, a] });
  assert.deepEqual(await own(), [b, a]);
});

test('the starter pack is there from the first start, once', async () => {
  const st = require(path.join(S.app.appDir, 'stickers.js'));
  const starter = (await S.api(ann, 'GET', '/api/stickers')).data.packs.find((x) => x.title === 'شکلک‌های سپن');
  assert.ok(starter && starter.official, 'starter pack listed');
  assert.equal(starter.stickers.length, 50);
  assert.equal(starter.stickers[0].emoji, '👋');
  const img = await S.api(ben, 'GET', '/api/sticker/' + starter.stickers[0].id);
  assert.equal(img.status, 200);
  assert.equal(img.headers.get('content-type'), 'image/webp');
  assert.equal(st.seedDefault(), null, 'not added a second time');
  // the admin deletes it: it does not come back
  assert.equal((await adm('POST', '/stickers/pack/' + starter.id + '/delete')).status, 200);
  assert.equal(st.seedDefault(), null);
  assert.ok(!(await S.api(ann, 'GET', '/api/stickers')).data.packs.some((x) => x.title === 'شکلک‌های سپن'));
});
