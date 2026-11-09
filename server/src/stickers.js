'use strict';
/**
 * 1.10 sticker packs. Official packs come from the admin panel and every user sees them; users make their
 * own packs (if the admin allows it) and add other people's packs to their collection from a sticker
 * they received. Sticker images are stored on this server WITHOUT end-to-end encryption, so each one is
 * kept once and opens fast for everybody; only signed-in users can fetch them, and pack / sticker ids are
 * random so they cannot be listed. The message that carries a sticker stays end-to-end encrypted.
 * Images are static WebP or PNG, at most 512x512, with all metadata dropped (see webp.js / png below).
 */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { db, DATA_DIR, getSetting, setSetting } = require('./db');
const { sanitizeWebp } = require('./webp');

const DIR = path.join(DATA_DIR, 'stickers');
fs.mkdirSync(DIR, { recursive: true });

db.exec(`
CREATE TABLE IF NOT EXISTS sticker_packs (
  id TEXT PRIMARY KEY, owner TEXT, title TEXT NOT NULL, created INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS stickers (
  id TEXT PRIMARY KEY, pack_id TEXT NOT NULL, emoji TEXT, ord INTEGER NOT NULL, size INTEGER NOT NULL, mime TEXT NOT NULL, created INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS idx_stk_pack ON stickers(pack_id, ord);
CREATE TABLE IF NOT EXISTS user_packs (
  username TEXT NOT NULL, pack_id TEXT NOT NULL, ord INTEGER NOT NULL, PRIMARY KEY (username, pack_id));
`);

const q = {
  pack: db.prepare('SELECT * FROM sticker_packs WHERE id=?'),
  official: db.prepare('SELECT * FROM sticker_packs WHERE owner IS NULL ORDER BY created'),
  allPacks: db.prepare('SELECT p.*, (SELECT COUNT(*) FROM stickers s WHERE s.pack_id=p.id) AS count, (SELECT COALESCE(SUM(size),0) FROM stickers s WHERE s.pack_id=p.id) AS bytes, (SELECT COUNT(*) FROM user_packs u WHERE u.pack_id=p.id) AS users FROM sticker_packs p ORDER BY (p.owner IS NOT NULL), p.created'),
  ownCount: db.prepare('SELECT COUNT(*) AS n FROM sticker_packs WHERE owner=?'),
  addPack: db.prepare('INSERT INTO sticker_packs(id,owner,title,created) VALUES(?,?,?,?)'),
  rename: db.prepare('UPDATE sticker_packs SET title=? WHERE id=?'),
  delPack: db.prepare('DELETE FROM sticker_packs WHERE id=?'),
  stickers: db.prepare('SELECT id, emoji FROM stickers WHERE pack_id=? ORDER BY ord, created'),
  sticker: db.prepare('SELECT * FROM stickers WHERE id=?'),
  count: db.prepare('SELECT COUNT(*) AS n, COALESCE(MAX(ord),0) AS mx FROM stickers WHERE pack_id=?'),
  addSticker: db.prepare('INSERT INTO stickers(id,pack_id,emoji,ord,size,mime,created) VALUES(?,?,?,?,?,?,?)'),
  delSticker: db.prepare('DELETE FROM stickers WHERE id=?'),
  delPackStickers: db.prepare('DELETE FROM stickers WHERE pack_id=?'),
  mine: db.prepare('SELECT p.* FROM user_packs u JOIN sticker_packs p ON p.id=u.pack_id WHERE u.username=? ORDER BY u.ord'),
  has: db.prepare('SELECT 1 AS x FROM user_packs WHERE username=? AND pack_id=?'),
  maxOrd: db.prepare('SELECT COALESCE(MAX(ord),0) AS m FROM user_packs WHERE username=?'),
  addUser: db.prepare('INSERT OR IGNORE INTO user_packs(username,pack_id,ord) VALUES(?,?,?)'),
  setOrd: db.prepare('UPDATE user_packs SET ord=? WHERE username=? AND pack_id=?'),
  delUser: db.prepare('DELETE FROM user_packs WHERE username=? AND pack_id=?'),
  delPackUsers: db.prepare('DELETE FROM user_packs WHERE pack_id=?'),
  usersOf: db.prepare('SELECT username FROM user_packs WHERE pack_id=?'),
};

// ---- admin limits (panel › استیکرها) ----
const num = (k, d, min, max) => { const v = Number(getSetting(k, String(d))); return Number.isInteger(v) && v >= min && v <= max ? v : d; };
function config() {
  return {
    user_create: getSetting('stk_user_create', '1') === '1',
    max_kb: num('stk_max_kb', 300, 20, 2048),
    per_pack: num('stk_per_pack', 120, 1, 500),
    max_packs: num('stk_max_packs', 10, 0, 200),
  };
}
function saveConfig(b) {
  const ok = (v, min, max) => Number.isInteger(v) && v >= min && v <= max;
  if (typeof b.user_create === 'boolean') setSetting('stk_user_create', b.user_create ? '1' : '0');
  for (const [k, key, min, max] of [['max_kb', 'stk_max_kb', 20, 2048], ['per_pack', 'stk_per_pack', 1, 500], ['max_packs', 'stk_max_packs', 0, 200]]) {
    if (b[k] === undefined) continue;
    if (!ok(b[k], min, max)) throw new Error('bad_limit');
    setSetting(key, b[k]);
  }
  return config();
}

const ID_RE = /^[a-f0-9]{32}$/;
const PACK_RE = /^[a-f0-9]{16}$/;
const newId = (n) => crypto.randomBytes(n).toString('hex');
const cleanTitle = (t) => String(t || '').replace(/[\x00-\x1f\x7f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 64);
/** One emoji (or none): no letters, digits or markup. */
function cleanEmoji(e) {
  const s = String(e || '').trim();
  if (!s || s.length > 16 || /[\x00-\x7f]/.test(s) || !/\p{Extended_Pictographic}|\p{Regional_Indicator}/u.test(s)) return null;
  return s;
}

/**
 * A static PNG of at most maxDim x maxDim, rebuilt with only the chunks needed to draw it (no text,
 * EXIF, ICC or animation). Returns a Buffer or null.
 */
function sanitizePng(buf, maxDim = 512) {
  const SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  if (buf.length < 57 || !buf.subarray(0, 8).equals(SIG)) return null;
  const keep = new Set(['IHDR', 'PLTE', 'tRNS', 'IDAT', 'IEND']);
  const parts = [SIG];
  let pos = 8, w = 0, h = 0, idat = false, end = false, first = true;
  while (pos + 12 <= buf.length) {
    const len = buf.readUInt32BE(pos);
    const type = buf.toString('latin1', pos + 4, pos + 8);
    if (len > buf.length - pos - 12 || !/^[A-Za-z]{4}$/.test(type)) return null;
    if (first && type !== 'IHDR') return null;
    first = false;
    if (type === 'acTL' || type === 'fcTL' || type === 'fdAT') return null; // animated PNG
    if (type === 'IHDR') { if (len !== 13) return null; w = buf.readUInt32BE(pos + 8); h = buf.readUInt32BE(pos + 12); }
    if (type === 'IDAT') idat = true;
    if (keep.has(type)) parts.push(buf.subarray(pos, pos + 12 + len));
    pos += 12 + len;
    if (type === 'IEND') { end = true; break; }
  }
  if (!end || !idat || w < 1 || h < 1 || w > maxDim || h > maxDim) return null;
  return Buffer.concat(parts);
}
/** The cleaned image and its type, or null when it is not a static WebP / PNG within 512x512. */
function cleanImage(buf) {
  const webp = sanitizeWebp(buf, 512);
  if (webp) return { data: webp, mime: 'image/webp' };
  const png = sanitizePng(buf, 512);
  return png ? { data: png, mime: 'image/png' } : null;
}

const fileOf = (id) => path.join(DIR, id);
function packJson(p, user) {
  return {
    id: p.id, title: p.title, official: p.owner == null, mine: !!user && p.owner === user,
    stickers: q.stickers.all(p.id).map((s) => ({ id: s.id, emoji: s.emoji || null })),
  };
}
/** What the sticker panel shows: the official packs, then the user's collection in their order. */
function listFor(user) {
  const c = config();
  const official = q.official.all();
  const seen = new Set(official.map((p) => p.id));
  const packs = official.map((p) => packJson(p, user));
  for (const p of q.mine.all(user)) if (!seen.has(p.id)) packs.push({ ...packJson(p, user), added: true });
  return { create: c.user_create, limits: { kb: c.max_kb, per_pack: c.per_pack, packs: c.max_packs }, packs };
}
function packFor(user, id) {
  const p = PACK_RE.test(id) ? q.pack.get(id) : null;
  if (!p) return null;
  return { ...packJson(p, user), added: p.owner == null || !!q.has.get(user, id) };
}

class StickerError extends Error { constructor(code, status = 400) { super(code); this.status = status; } }
function own(user, id) {
  const p = PACK_RE.test(id) ? q.pack.get(id) : null;
  if (!p) throw new StickerError('no_such_pack', 404);
  if (user !== null && p.owner !== user) throw new StickerError('not_owner', 403);
  return p;
}
function createPack(user, title) {
  const t = cleanTitle(title);
  if (!t) throw new StickerError('bad_title');
  if (user !== null) {
    const c = config();
    if (!c.user_create) throw new StickerError('stickers_disabled', 403);
    if (q.ownCount.get(user).n >= c.max_packs) throw new StickerError('pack_limit');
  }
  const id = newId(8);
  q.addPack.run(id, user, t, Date.now());
  if (user !== null) q.addUser.run(user, id, q.maxOrd.get(user).m + 1);
  return id;
}
function renamePack(user, id, title) {
  own(user, id);
  const t = cleanTitle(title);
  if (!t) throw new StickerError('bad_title');
  q.rename.run(t, id);
}
/** Deletes a pack and its images; stickers already sent then show as "deleted sticker". Returns who had it. */
function deletePack(user, id) {
  const p = own(user, id);
  const had = q.usersOf.all(id).map((r) => r.username);
  for (const s of q.stickers.all(id)) { try { fs.unlinkSync(fileOf(s.id)); } catch { } }
  db.exec('BEGIN');
  try { q.delPackStickers.run(id); q.delPackUsers.run(id); q.delPack.run(id); db.exec('COMMIT'); } catch (e) { db.exec('ROLLBACK'); throw e; }
  return p.owner == null ? null : had;
}
/** Adds one image to a pack. user null = the admin (no per-user limits, 1 MB per image). */
function addSticker(user, packId, buf, emoji) {
  own(user, packId);
  const c = config();
  if (user !== null && !c.user_create) throw new StickerError('stickers_disabled', 403);
  if (buf.length > (user === null ? 1024 : c.max_kb) * 1024) throw new StickerError('sticker_too_large', 413);
  const img = cleanImage(buf);
  if (!img) throw new StickerError('bad_sticker');
  const { n, mx } = q.count.get(packId);
  if (user !== null && n >= c.per_pack) throw new StickerError('pack_full');
  if (n >= 500) throw new StickerError('pack_full');
  const id = newId(16);
  fs.writeFileSync(fileOf(id) + '.tmp', img.data);
  fs.renameSync(fileOf(id) + '.tmp', fileOf(id));
  q.addSticker.run(id, packId, cleanEmoji(emoji), mx + 1, img.data.length, img.mime, Date.now());
  return { id, emoji: cleanEmoji(emoji) };
}
function deleteSticker(user, id) {
  const s = ID_RE.test(id) ? q.sticker.get(id) : null;
  if (!s) throw new StickerError('no_such_sticker', 404);
  own(user, s.pack_id);
  q.delSticker.run(id);
  try { fs.unlinkSync(fileOf(id)); } catch { }
  return s.pack_id;
}
function addToCollection(user, id) {
  const p = PACK_RE.test(id) ? q.pack.get(id) : null;
  if (!p) throw new StickerError('no_such_pack', 404);
  if (p.owner != null) q.addUser.run(user, id, q.maxOrd.get(user).m + 1);
}
/** Takes someone else's pack out of the collection (an own pack is deleted with deletePack). */
function removeFromCollection(user, id) {
  const p = PACK_RE.test(id) ? q.pack.get(id) : null;
  if (p && p.owner === user) throw new StickerError('own_pack');
  q.delUser.run(user, id);
}
function reorder(user, ids) {
  if (!Array.isArray(ids)) throw new StickerError('bad_order');
  db.exec('BEGIN');
  try { ids.slice(0, 500).forEach((id, i) => { if (typeof id === 'string') q.setOrd.run(i + 1, user, id); }); db.exec('COMMIT'); } catch (e) { db.exec('ROLLBACK'); throw e; }
}
/** { data, mime } of one sticker image, or null. */
function image(id) {
  const s = ID_RE.test(id) ? q.sticker.get(id) : null;
  if (!s) return null;
  try { return { data: fs.readFileSync(fileOf(id)), mime: s.mime }; } catch { return null; }
}
/** Admin panel: every pack with its owner, size and how many users added it. */
function adminList() {
  return q.allPacks.all().map((p) => ({ id: p.id, title: p.title, owner: p.owner, official: p.owner == null, count: p.count, bytes: p.bytes, users: p.users, created: p.created }));
}
function deleteUser(user) {
  for (const p of db.prepare('SELECT id FROM sticker_packs WHERE owner=?').all(user)) deletePack(user, p.id);
  db.prepare('DELETE FROM user_packs WHERE username=?').run(user);
}

/**
 * 1.10.1: the starter pack «شکلک‌های سپن» (stickers-default/) is added as an official pack the first time
 * the server starts. Only once: if the admin deletes it, it stays deleted.
 */
function seedDefault(dir = path.join(__dirname, 'stickers-default')) {
  if (getSetting('stk_seeded', '')) return null;
  let man;
  try { man = JSON.parse(fs.readFileSync(path.join(dir, 'pack.json'), 'utf8')); } catch { return null; }
  const id = createPack(null, man.title);
  for (const s of man.stickers || []) {
    try { addSticker(null, id, fs.readFileSync(path.join(dir, path.basename(String(s.file)))), s.emoji); } catch (e) { console.error('[stickers] starter sticker', s.file, e.message); }
  }
  setSetting('stk_seeded', id);
  return id;
}
try { seedDefault(); } catch (e) { console.error('[stickers] starter pack:', e.message); }

module.exports = {
  StickerError, seedDefault, config, saveConfig, listFor, packFor, createPack, renamePack, deletePack, addSticker, deleteSticker,
  addToCollection, removeFromCollection, reorder, image, adminList, deleteUser, sanitizePng, cleanImage, PACK_RE, ID_RE,
};
