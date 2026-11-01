'use strict';
const https = require('node:https');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { db, DATA_DIR, hashPassword, checkPassword } = require('./db');
const core = require('./core');
const contacts = require('./contacts');
const { sanitizeWebp } = require('./webp');
const stats = require('./stats');
const backup = require('./backup');
const push = require('./push');
const auth = require('./auth');

const PORT = +(process.env.PORT || 8443);
const CERT_DIR = process.env.CERT_DIR || path.join(DATA_DIR, '..', 'certs');
const MAX_LEGACY = +(process.env.MAX_FILE_MB || 25) * 1024 * 1024;       // old single-shot /api/upload
const MAX_UPLOAD = +(process.env.MAX_UPLOAD_MB || 2048) * 1024 * 1024;   // chunked uploads
const MAX_TOTAL = +(process.env.MAX_TOTAL_MB || 10000) * 1024 * 1024;
const MIN_FREE = +(process.env.MIN_FREE_MB || 1500) * 1024 * 1024;
const CHUNK_MAX = 16 * 1024 * 1024;
const FILE_TTL_DAYS = +(process.env.FILE_TTL_DAYS || 30);
const MSG_TTL_DAYS = +(process.env.MSG_TTL_DAYS || 90);
const EDIT_WINDOW = +(process.env.EDIT_WINDOW_HOURS || 48) * 3600e3;
const SESSION_DAYS = 90;
const PUBLIC_HOST = process.env.PUBLIC_HOST || '';
const PLAIN = process.env.PLAIN_HTTP === '1';
let TURN_SECRET = '';
try { if (process.env.TURN_SECRET_FILE) TURN_SECRET = fs.readFileSync(process.env.TURN_SECRET_FILE, 'utf8').trim(); } catch { }

const FILES_DIR = path.join(DATA_DIR, 'files');
const UPLOADS_DIR = path.join(DATA_DIR, 'uploads');
const AVATARS_DIR = path.join(DATA_DIR, 'avatars');
const DAY = 864e5;
const now = () => Date.now();
const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');
const DUMMY = hashPassword('dummy-password');

const q = {
  addSess: db.prepare('INSERT INTO sessions(th,username,created,via,device) VALUES(?,?,?,?,?)'),
  sess: db.prepare('SELECT s.username AS username, s.created AS created, s.via AS via, u.disabled AS disabled FROM sessions s JOIN users u ON u.username=s.username WHERE s.th=?'),
  delSess: db.prepare('DELETE FROM sessions WHERE th=?'),
  setKey: db.prepare('UPDATE users SET pubkey=? WHERE username=?'),
  setBackup: db.prepare('UPDATE users SET key_backup=?, pubkey=? WHERE username=?'),
  addMsg: db.prepare('INSERT INTO messages(sender,target,kind,payload,file_id,ts) VALUES(?,?,?,?,?,?)'),
  msg: db.prepare('SELECT * FROM messages WHERE id=?'),
  editMsg: db.prepare('UPDATE messages SET payload=?, edited=? WHERE id=?'),
  delMsg: db.prepare("UPDATE messages SET deleted=1, payload='', file_id=NULL WHERE id=?"),
  addChange: db.prepare('INSERT INTO msg_changes(msg_id,kind,ts) VALUES(?,?,?)'),
  maxChange: db.prepare('SELECT COALESCE(MAX(seq),0) AS s FROM msg_changes'),
  addHist: db.prepare('INSERT INTO msg_history(msg_id,payload,ts) VALUES(?,?,?)'),
  hist: db.prepare('SELECT payload, ts FROM msg_history WHERE msg_id=? ORDER BY id'),
  fileMsgs: db.prepare('SELECT sender, target FROM messages WHERE file_id=? AND deleted=0'),
  addFile: db.prepare('INSERT INTO files(id,owner,size,ts) VALUES(?,?,?,?)'),
  file: db.prepare('SELECT * FROM files WHERE id=?'),
  totalFiles: db.prepare('SELECT COALESCE(SUM(size),0) AS t FROM files'),
  totalUploads: db.prepare('SELECT COALESCE(SUM(size),0) AS t FROM uploads'),
  addUp: db.prepare('INSERT INTO uploads(id,owner,size,off,ts) VALUES(?,?,?,0,?)'),
  up: db.prepare('SELECT * FROM uploads WHERE id=?'),
  setOff: db.prepare('UPDATE uploads SET off=?, ts=? WHERE id=?'),
  delUp: db.prepare('DELETE FROM uploads WHERE id=?'),
  setName: db.prepare('UPDATE users SET display_name=? WHERE username=?'),
  setBio: db.prepare('UPDATE users SET bio=? WHERE username=?'),
  // avatar_ver > 0 = has a photo; removing it flips the sign so the next upload still gets a fresh version
  bumpAvatar: db.prepare('UPDATE users SET avatar_ver=abs(avatar_ver)+1 WHERE username=?'),
  dropAvatar: db.prepare('UPDATE users SET avatar_ver=-abs(avatar_ver) WHERE username=?'),
  setPin: db.prepare('INSERT INTO pins(convo,message_id,by,ts) VALUES(?,?,?,?) ON CONFLICT(convo) DO UPDATE SET message_id=excluded.message_id, by=excluded.by, ts=excluded.ts'),
  delPin: db.prepare('DELETE FROM pins WHERE convo=?'),
  pin: db.prepare('SELECT * FROM pins WHERE convo=?'),
  allPins: db.prepare('SELECT * FROM pins'),
  setLastSeen: db.prepare('UPDATE users SET last_seen=? WHERE username=?'),
  setPrivacy: db.prepare('UPDATE users SET hide_seen=?, hide_last_seen=? WHERE username=?'),
  rcpt: db.prepare('SELECT delivered, seen FROM receipts WHERE username=? AND convo=?'),
  setRcpt: db.prepare('INSERT INTO receipts(username,convo,delivered,seen) VALUES(?,?,?,?) ON CONFLICT(username,convo) DO UPDATE SET delivered=excluded.delivered, seen=excluded.seen'),
  maxFrom: db.prepare('SELECT COALESCE(MAX(id),0) AS m FROM messages WHERE sender=? AND target=?'),
  maxIn: db.prepare('SELECT COALESCE(MAX(id),0) AS m FROM messages WHERE target=?'),
  react: db.prepare('INSERT INTO reactions(msg_id,username,emoji,seq) VALUES(?,?,?,?) ON CONFLICT(msg_id,username) DO UPDATE SET emoji=excluded.emoji, seq=excluded.seq'),
  myReact: db.prepare('SELECT emoji FROM reactions WHERE msg_id=? AND username=?'),
  maxReact: db.prepare('SELECT COALESCE(MAX(seq),0) AS s FROM reactions'),
  reactsOf: db.prepare('SELECT username, emoji FROM reactions WHERE msg_id=? AND emoji IS NOT NULL'),
  delReacts: db.prepare('DELETE FROM reactions WHERE msg_id=?'),
};

// ---------- helpers ----------
function send(res, code, obj) {
  const b = Buffer.from(JSON.stringify(obj));
  res.writeHead(code, { 'Content-Type': 'application/json', 'Content-Length': b.length, 'Cache-Control': 'no-store' });
  res.end(b);
}
function readJson(req, limit) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { reject(Object.assign(new Error('too large'), { code: 413 })); req.destroy(); }
      else chunks.push(c);
    });
    req.on('end', () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString() || '{}')); }
      catch { reject(Object.assign(new Error('bad json'), { code: 400 })); }
    });
    req.on('error', reject);
  });
}
function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { reject(Object.assign(new Error('too large'), { code: 413 })); req.destroy(); }
      else chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}
function authInfo(req) {
  const m = /^Bearer ([a-f0-9]{64})$/.exec(req.headers.authorization || '');
  if (!m) return null;
  const th = sha256(m[1]);
  const row = q.sess.get(th);
  if (!row || row.disabled) return null;
  if (now() - row.created > SESSION_DAYS * DAY) { q.delSess.run(th); return null; }
  return { user: row.username, th, created: row.created, via: row.via };
}

// ---------- login rate limit ----------
const fails = new Map();
const limited = (key, max) => { const f = fails.get(key); return !!f && f.n >= max && now() - f.t < 600000; };
const addFail = (key) => {
  const f = fails.get(key);
  if (!f || now() - f.t > 600000) fails.set(key, { n: 1, t: now() });
  else { f.n++; f.t = now(); }
};

// ---------- live connections (SSE) ----------
// username -> Set(res). Each connection carries res.dev (the device's id) and res.active: the app is on
// screen. Android keeps its connection open in the background, so "connected" is not "online".
const clients = new Map();
function emit(user, event, data, id) {
  const set = clients.get(user);
  if (!set || !set.size) return false;
  const chunk = (id ? `id: ${id}\n` : '') + `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const r of set) r.write(chunk);
  return true;
}
const isConnected = (u) => !!clients.get(u) && clients.get(u).size > 0;
const connectedUsers = () => [...clients.keys()].filter(isConnected);
/** Online = some device has the app on screen right now. */
function isOnline(u) {
  const set = clients.get(u);
  if (set) for (const r of set) if (r.active) return true;
  return false;
}
const msgJson = (m, reactions) => ({
  id: m.id, from: m.sender, target: m.target, kind: m.kind, payload: m.payload, fileId: m.file_id, ts: m.ts, edited: m.edited || null,
  ...(reactions && reactions.length ? { reactions: Object.fromEntries(reactions.map((r) => [r.username, r.emoji])) } : {}),
});
/** An edit or delete-for-everyone of message m, as clients receive it (seq orders all changes). */
const changeJson = (seq, kind, m) => (kind === 'del'
  ? { seq, kind, id: m.id, from: m.sender, target: m.target }
  : { seq, kind, id: m.id, from: m.sender, target: m.target, payload: m.payload, edited: m.edited });
setInterval(() => { for (const set of clients.values()) for (const r of set) r.write(': ping\n\n'); }, 15000);
// keeps "last seen" right even if the server stops without the users going offline first
setInterval(() => { const t = now(); for (const u of clients.keys()) if (isOnline(u)) q.setLastSeen.run(t, u); }, 60000);

/** connected people who are allowed to know about `username` (plus the user themself) */
function audienceOf(username) {
  return connectedUsers().filter((u) => u === username || core.contacts(u).has(username));
}
function broadcastTo(users, event, data) { for (const u of users) emit(u, event, data); }
function refreshAll() { for (const u of connectedUsers()) emit(u, 'refresh', {}); }

const RECENTLY = 3 * DAY;
/**
 * What `viewer` may know about u's presence. Hiding "last seen" works both ways (like Telegram): when
 * either of the two hides it, the viewer sees neither online nor the time, only "recently" (within 3 days).
 */
function presenceOf(u, viewer) {
  const online = isOnline(u.username);
  if (viewer && viewer !== u.username) {
    const v = core.q.user.get(viewer);
    if (u.hide_last_seen || (v && v.hide_last_seen)) return { online: false, last_seen: null, recently: online || (u.last_seen || 0) > now() - RECENTLY, hidden: true };
  }
  return { online, last_seen: online ? null : u.last_seen || null, recently: false };
}
function presenceChanged(username, online) {
  if (!online) q.setLastSeen.run(now(), username);
  const u = core.q.user.get(username);
  if (!u) return;
  for (const v of audienceOf(username)) {
    // a hidden presence is not announced at all (the timing of the event would give it away)
    if (v !== username && (u.hide_last_seen || core.q.user.get(v).hide_last_seen)) continue;
    emit(v, 'presence', { user: username, ...presenceOf(u, v) });
  }
}
function profileChanged(username) {
  const u = core.q.user.get(username);
  if (!u) return;
  broadcastTo(audienceOf(username), 'profile', { username, display_name: u.display_name, avatar_ver: u.avatar_ver, bio: u.bio || null });
}
function kick(username) {
  const was = isOnline(username);
  const set = clients.get(username);
  if (set) for (const r of [...set]) { try { r.end(); } catch { } }
  clients.delete(username);
  if (was) presenceChanged(username, false);
}

// ---------- permissions ----------
function resolveTarget(user, target) {
  if (target === 'all' || /^g:\d+$/.test(target)) {
    const cat = core.groupByKey(target);
    if (!cat) return { error: 'no_such_group', code: 404 };
    if (!core.isMember(user, cat.id)) return { error: 'not_member', code: 403 };
    return { type: 'group', cat };
  }
  if (!core.activeUser(target)) return { error: 'no_such_user', code: 404 };
  if (!core.canDM(user, target)) return { error: 'not_allowed', code: 403 };
  return { type: 'dm', peer: target };
}
function pinKey(user, tr) { return tr.type === 'group' ? tr.cat.gkey : core.convoKey(user, tr.peer); }

const B64 = /^[A-Za-z0-9+/]+={0,2}$/;
function keyBackupOf(u) {
  if (!u || !u.key_backup) return null;
  try { return JSON.parse(u.key_backup); } catch { return null; }
}
/**
 * { v, kdf:'pbkdf2-sha256', iter, salt, iv, ct, pub } — all binary fields base64.
 * v1 is locked with the login password, v2 (since 1.3.0) with a separate key password; the server cannot tell them apart.
 */
function cleanKeyBackup(k) {
  if (!k || typeof k !== 'object' || (k.v !== 1 && k.v !== 2) || k.kdf !== 'pbkdf2-sha256') return null;
  const iter = Number(k.iter);
  if (!Number.isInteger(iter) || iter < 100000 || iter > 5000000) return null;
  const ok = (x, min, max) => typeof x === 'string' && x.length >= min && x.length <= max && B64.test(x);
  if (!ok(k.salt, 16, 64) || !ok(k.iv, 16, 24) || !ok(k.ct, 64, 2048) || !ok(k.pub, 64, 1024)) return null;
  return { v: k.v, kdf: 'pbkdf2-sha256', iter, salt: k.salt, iv: k.iv, ct: k.ct, pub: k.pub };
}

function publicUser(u, extra, viewer) {
  return { username: u.username, display_name: u.display_name || null, pubkey: u.pubkey || null, avatar_ver: u.avatar_ver, bio: u.bio || null, ...presenceOf(u, viewer), ...extra };
}

function replay(user, since) {
  const gk = core.groupsOf(user).map((g) => g.gkey);
  const sql = `SELECT * FROM messages WHERE id>? AND deleted=0 AND (target=? OR sender=?${gk.length ? ` OR target IN (${gk.map(() => '?').join(',')})` : ''}) ORDER BY id LIMIT 2000`;
  return db.prepare(sql).all(since, user, user, ...gk);
}

/** Reaction changes after number `since` on messages the user can see (and had already received). */
function replayReactions(user, since, msgSince) {
  const gk = core.groupsOf(user).map((g) => g.gkey);
  const sql = `SELECT r.seq AS seq, r.msg_id AS id, r.username AS user, r.emoji AS emoji, m.sender AS sender, m.target AS target
    FROM reactions r JOIN messages m ON m.id=r.msg_id
    WHERE r.seq>? AND m.id<=? AND m.deleted=0 AND (m.target=? OR m.sender=?${gk.length ? ` OR m.target IN (${gk.map(() => '?').join(',')})` : ''}) ORDER BY r.seq LIMIT 5000`;
  return db.prepare(sql).all(since, msgSince, user, user, ...gk)
    .map((r) => ({ seq: r.seq, id: r.id, from: r.sender, target: r.target, user: r.user, emoji: r.emoji }));
}

/**
 * Delivery and read receipts are watermarks: receipts(username, convo) says "every message of this
 * conversation up to id `delivered` reached one of the user's devices, up to `seen` was read".
 * convo is 'dm:a:b' for private chats and the group key for groups. Clients get them from the
 * user's own point of view: { convo (peer or group key), user, delivered, seen }.
 */
function receiptsFor(user) {
  const gk = core.groupsOf(user).map((g) => g.gkey);
  const pre = 'dm:' + user + ':', suf = ':' + user;
  const rows = db.prepare(`SELECT * FROM receipts WHERE substr(convo,1,?)=? OR (substr(convo,1,3)='dm:' AND substr(convo,-?)=?)${gk.length ? ` OR convo IN (${gk.map(() => '?').join(',')})` : ''}`)
    .all(pre.length, pre, suf.length, suf, ...gk);
  const me = core.q.user.get(user);
  return rows.map((r) => {
    if (!r.convo.startsWith('dm:')) return { convo: r.convo, user: r.username, delivered: r.delivered, seen: r.seen };
    const [a, b] = r.convo.slice(3).split(':');
    // hiding "seen" works both ways in private chats: who hides it does not see it from others either
    return { convo: a === user ? b : a, user: r.username, delivered: r.delivered, seen: r.username !== user && me.hide_seen ? 0 : r.seen };
  });
}

function applyReceipt(user, me, it) {
  const tr = resolveTarget(user, String((it && it.target) || '').toLowerCase());
  if (tr.error) return;
  const key = tr.type === 'group' ? tr.cat.gkey : core.convoKey(user, tr.peer);
  // never past the newest message that actually came in
  const max = tr.type === 'group' ? q.maxIn.get(key).m : q.maxFrom.get(tr.peer, user).m;
  const num = (x) => (Number.isInteger(x) && x > 0 ? Math.min(x, max) : 0);
  const old = q.rcpt.get(user, key) || { delivered: 0, seen: 0 };
  const seen = Math.max(old.seen, tr.type === 'dm' && me.hide_seen ? 0 : num(it.seen));
  const delivered = Math.max(old.delivered, num(it.delivered), num(it.seen));
  if (seen === old.seen && delivered === old.delivered) return;
  q.setRcpt.run(user, key, delivered, seen);
  if (tr.type === 'group') {
    for (const u of core.membersOf(tr.cat.id)) emit(u, 'receipt', { convo: key, user, delivered, seen });
  } else {
    const peer = core.q.user.get(tr.peer);
    emit(tr.peer, 'receipt', { convo: user, user, delivered, seen: peer && peer.hide_seen ? 0 : seen });
    emit(user, 'receipt', { convo: tr.peer, user, delivered, seen }); // the user's other devices: read there too
  }
}

/** The user may see message m (and react to it). */
function canSee(user, m) {
  if (!m || m.deleted || m.kind.startsWith('sig_')) return false;
  if (m.target === 'all' || /^g:\d+$/.test(m.target)) { const cat = core.groupByKey(m.target); return !!cat && core.isMember(user, cat.id); }
  return m.sender === user || m.target === user;
}

// at least one emoji, no letters, digits or spaces, at most a few code units (flags, skin tones, ZWJ sequences)
const EMOJI_RE = /^[^\x00-\x7f]{1,16}$/;
const okEmoji = (e) => typeof e === 'string' && EMOJI_RE.test(e) && /\p{Extended_Pictographic}|\p{Regional_Indicator}/u.test(e);

/** What a closed web app shows for a new message: never its text (that is end-to-end encrypted). */
function pushData(m, tr) {
  const sender = core.q.user.get(m.sender);
  const who = (sender && sender.display_name) || m.sender;
  return tr.type === 'group'
    ? { t: 'msg', convo: tr.cat.gkey, id: m.id, title: tr.cat.name, body: who + ': پیام تازه' }
    : { t: 'msg', convo: m.sender, id: m.id, title: who, body: 'پیام تازه' };
}

/** Edits and deletions after change number `since` of messages the user can see (and had already received). */
function replayChanges(user, since, msgSince) {
  const gk = core.groupsOf(user).map((g) => g.gkey);
  const sql = `SELECT c.seq AS seq, c.kind AS ckind, m.* FROM msg_changes c JOIN messages m ON m.id=c.msg_id
    WHERE c.seq>? AND m.id<=? AND (m.target=? OR m.sender=?${gk.length ? ` OR m.target IN (${gk.map(() => '?').join(',')})` : ''}) ORDER BY c.seq LIMIT 2000`;
  return db.prepare(sql).all(since, msgSince, user, user, ...gk).map((r) => changeJson(r.seq, r.ckind, r));
}

/** Everyone who receives the live events of message m. */
function msgAudience(m) {
  if (m.target === 'all' || /^g:\d+$/.test(m.target)) {
    const cat = core.groupByKey(m.target);
    return cat ? core.membersOf(cat.id) : [m.sender];
  }
  return [m.target, m.sender];
}

/** A user may attach (forward) a file they uploaded or one that arrived in a conversation they are in. */
function canUseFile(user, fileId) {
  const f = q.file.get(fileId);
  if (!f) return false;
  if (f.owner === user) return true;
  const groups = new Set(core.groupsOf(user).map((g) => g.gkey));
  return q.fileMsgs.all(fileId).some((m) => m.sender === user || m.target === user || groups.has(m.target));
}

function pinsFor(user) {
  const gk = new Set(core.groupsOf(user).map((g) => g.gkey));
  const out = [];
  for (const p of q.allPins.all()) {
    if (gk.has(p.convo)) out.push({ convo: p.convo, messageId: p.message_id, by: p.by });
    else if (p.convo.startsWith('dm:')) {
      const [a, b] = p.convo.slice(3).split(':');
      if (a === user) out.push({ convo: b, messageId: p.message_id, by: p.by });
      else if (b === user) out.push({ convo: a, messageId: p.message_id, by: p.by });
    }
  }
  return out;
}

const smsSent = new Map(); // phone -> time of the last SMS code (one per minute)
const DEVICE_RE = /[^\p{L}\p{N} .,()\-_/]/gu;

/**
 * Opens a session for user u (signed in by `via`: password, sms, device or admin) and tells the user's
 * other devices that a new one signed in. b.device is a short label the app sends ("Android", "iPhone web").
 */
function newSession(u, via, b) {
  const token = crypto.randomBytes(32).toString('hex');
  const device = String(b.device || '').replace(DEVICE_RE, '').trim().slice(0, 40) || null;
  q.addSess.run(sha256(token), u.username, now(), via, device);
  emit(u.username, 'login_alert', { ts: now(), via, device });
  // with a key backup the account keeps one identity key on every device: a new device restores it instead
  const kb = keyBackupOf(u);
  if (typeof b.pubkey === 'string' && b.pubkey.length <= 1024 && (!kb || kb.pub === b.pubkey)) q.setKey.run(b.pubkey, u.username);
  return { token, username: u.username, key_backup: kb, via };
}

// ---------- the Android app for download (the admin uploads it in the panel) ----------
const APK = path.join(DATA_DIR, 'apk', 'sepan.apk');
function apkInfo() {
  try { const st = fs.statSync(APK); return st.isFile() && st.size > 0 ? { size: st.size, mtime: st.mtimeMs } : null; } catch { return null; }
}
/** GET /download/sepan.apk: public like the setup page (the app holds nothing secret). */
function serveApk(req, res) {
  const info = apkInfo();
  if (!info) return send(res, 404, { error: 'no_apk' });
  res.writeHead(200, {
    'Content-Type': 'application/vnd.android.package-archive', 'Content-Length': info.size,
    'Content-Disposition': 'attachment; filename="sepan.apk"', 'Cache-Control': 'no-cache', 'X-Content-Type-Options': 'nosniff',
  });
  if (req.method === 'HEAD') return res.end();
  const rs = fs.createReadStream(APK);
  rs.on('error', () => res.destroy());
  res.on('close', () => rs.destroy());
  rs.pipe(res);
}

function freeSpace() { try { const s = fs.statfsSync(FILES_DIR); return s.bavail * s.bsize; } catch { return Infinity; } }

// ---------- routes ----------
async function route(req, res) {
  const url = new URL(req.url, 'http://x');
  const p = url.pathname;
  res.setHeader('X-Content-Type-Options', 'nosniff');

  if (p === '/api/health') return send(res, 200, { ok: true });
  if (p === '/download/sepan.apk' && (req.method === 'GET' || req.method === 'HEAD')) return serveApk(req, res);

  if (p === '/api/login' && req.method === 'POST') {
    const b = await readJson(req, 4096);
    if (!auth.passwordLogin()) return send(res, 403, { error: 'password_login_disabled' });
    const username = String(b.username || '').toLowerCase();
    const ip = req.socket.remoteAddress;
    if (limited('ip:' + ip, 20) || limited('u:' + username, 5)) return send(res, 429, { error: 'rate_limited' });
    const u = core.q.user.get(username);
    const ok = u ? checkPassword(b.password || '', u.pass) : (checkPassword(b.password || '', DUMMY), false);
    if (!ok || u.disabled) { addFail('ip:' + ip); addFail('u:' + username); return send(res, 401, { error: 'bad_credentials' }); }
    fails.delete('u:' + username);
    return send(res, 200, newSession(u, 'password', b));
  }

  // ---- sign-in by mobile number (see auth.js) ----
  // what the login screen offers: SMS codes, the old username + password, the Android app download
  if (p === '/api/auth/config' && req.method === 'GET') {
    return send(res, 200, { sms: auth.smsReady(), password: auth.passwordLogin(), apk: !!apkInfo() });
  }
  // sends a login code by SMS. An unknown number gets the same answer as a known one (no way to probe numbers).
  if (p === '/api/auth/sms' && req.method === 'POST') {
    const b = await readJson(req, 1024);
    const phone = auth.normPhone(b.phone);
    if (!phone) return send(res, 400, { error: 'bad_phone' });
    const ip = req.socket.remoteAddress;
    if (limited('smsip:' + ip, 10) || limited('sms:' + phone, 3)) return send(res, 429, { error: 'rate_limited' });
    const wait = Math.ceil((smsSent.get(phone) || 0) + 60e3 - now());
    if (wait > 0) return send(res, 429, { error: 'wait', wait: Math.ceil(wait / 1000) });
    if (!auth.smsReady()) return send(res, 503, { error: 'sms_unavailable' });
    addFail('smsip:' + ip); addFail('sms:' + phone);
    smsSent.set(phone, now());
    const username = auth.findUser(phone);
    if (username) {
      const { code } = auth.issue(username, 'sms');
      try { await auth.sendSms(phone, code); } catch { smsSent.delete(phone); return send(res, 503, { error: 'sms_unavailable' }); }
    }
    return send(res, 200, { ok: true, ttl: auth.TTL.sms / 1000 });
  }
  // signs in with a code: from the SMS, from another signed-in device of the user, or from the admin
  if (p === '/api/auth/code' && req.method === 'POST') {
    const b = await readJson(req, 4096);
    const ident = String(b.phone || b.username || '').slice(0, 40);
    const ip = req.socket.remoteAddress;
    const key = 'code:' + (auth.normPhone(ident) || ident.toLowerCase());
    if (limited('ip:' + ip, 20) || limited(key, 5)) return send(res, 429, { error: 'rate_limited' });
    const username = auth.findUser(ident);
    const via = username && auth.consume(username, b.code, ['sms', 'device', 'admin']);
    if (!via) { addFail('ip:' + ip); addFail(key); return send(res, 401, { error: 'bad_code' }); }
    fails.delete(key);
    return send(res, 200, newSession(core.q.user.get(username), via, b));
  }

  const a = authInfo(req);
  if (!a) return send(res, 401, { error: 'unauthorized' });
  const user = a.user;

  if (p === '/api/logout' && req.method === 'POST') { q.delSess.run(a.th); return send(res, 200, { ok: true }); }

  // a code for signing in on a new device, shown on this (signed-in) one; works without SMS or internet
  if (p === '/api/auth/devicecode' && req.method === 'POST') {
    if (limited('dev:' + user, 10)) return send(res, 429, { error: 'rate_limited' });
    addFail('dev:' + user);
    const { code, expires } = auth.issue(user, 'device');
    return send(res, 200, { code, expires, ttl: auth.TTL.device / 1000, phone: !!auth.phoneOf(user) });
  }
  // an SMS code that stands in for the login password when the key backup changes (accounts that sign in by SMS)
  if (p === '/api/auth/reauth' && req.method === 'POST') {
    const phone = auth.phoneOf(user);
    if (!phone) return send(res, 400, { error: 'no_phone' });
    if (!auth.smsReady()) return send(res, 503, { error: 'sms_unavailable' });
    if (limited('sms:' + phone, 3)) return send(res, 429, { error: 'rate_limited' });
    addFail('sms:' + phone);
    const { code } = auth.issue(user, 'reauth');
    try { await auth.sendSms(phone, code); } catch { return send(res, 503, { error: 'sms_unavailable' }); }
    return send(res, 200, { ok: true, ttl: auth.TTL.reauth / 1000 });
  }

  if (p === '/api/me' && req.method === 'GET') {
    const u = core.q.user.get(user);
    return send(res, 200, {
      username: user, display_name: u.display_name || null, avatar_ver: u.avatar_ver, bio: u.bio || null,
      hide_seen: !!u.hide_seen, hide_last_seen: !!u.hide_last_seen,
    });
  }

  if (p === '/api/users' && req.method === 'GET') {
    const out = [publicUser(core.q.user.get(user), { dm: false }, user)];
    for (const [name, v] of core.contacts(user)) out.push(publicUser(core.q.user.get(name), { dm: v.dm }, user));
    return send(res, 200, out);
  }

  // privacy: hide "seen" (private chats) and "last seen / online"; both work both ways
  if (p === '/api/privacy' && req.method === 'POST') {
    const b = await readJson(req, 1024);
    const u = core.q.user.get(user);
    const hs = typeof b.hide_seen === 'boolean' ? b.hide_seen : !!u.hide_seen;
    const hl = typeof b.hide_last_seen === 'boolean' ? b.hide_last_seen : !!u.hide_last_seen;
    q.setPrivacy.run(hs ? 1 : 0, hl ? 1 : 0, user);
    if (hl !== !!u.hide_last_seen) {
      const nu = core.q.user.get(user);
      for (const v of audienceOf(user)) if (v !== user) emit(v, 'presence', { user, ...presenceOf(nu, v) });
    }
    return send(res, 200, { hide_seen: hs, hide_last_seen: hl });
  }

  // the app went to the foreground / background on device `dev`
  if (p === '/api/presence' && req.method === 'POST') {
    const b = await readJson(req, 1024);
    const dev = String(b.dev || '').slice(0, 64);
    const set = clients.get(user);
    const was = isOnline(user);
    if (set && dev) for (const r of set) if (r.dev === dev) r.active = !!b.active;
    if (was !== isOnline(user)) presenceChanged(user, !was);
    return send(res, 200, { ok: true });
  }

  // delivered / seen watermarks, several conversations at once: { items: [{ target, delivered, seen }] }
  if (p === '/api/receipts' && req.method === 'POST') {
    const b = await readJson(req, 65536);
    const me = core.q.user.get(user);
    for (const it of (Array.isArray(b.items) ? b.items : []).slice(0, 500)) applyReceipt(user, me, it);
    return send(res, 200, { ok: true });
  }

  // "typing…" in a group (private chats use the older sig_typing signal)
  if (p === '/api/typing' && req.method === 'POST') {
    const b = await readJson(req, 1024);
    const tr = resolveTarget(user, String(b.target || '').toLowerCase());
    if (tr.error) return send(res, tr.code, { error: tr.error });
    if (tr.type === 'group') { for (const u of core.membersOf(tr.cat.id)) if (u !== user) emit(u, 'typing', { convo: tr.cat.gkey, from: user }); }
    else emit(tr.peer, 'typing', { convo: user, from: user });
    return send(res, 200, { ok: true });
  }

  // emoji reaction: one per person per message; emoji null removes it
  if (p === '/api/react' && req.method === 'POST') {
    const b = await readJson(req, 1024);
    const m = q.msg.get(Number(b.id));
    if (!canSee(user, m)) return send(res, 404, { error: 'no_such_message' });
    const tr = resolveTarget(user, m.sender === user || /^g:\d+$|^all$/.test(m.target) ? m.target : m.sender);
    if (tr.error) return send(res, tr.code, { error: tr.error });
    const emoji = b.emoji == null || b.emoji === '' ? null : b.emoji;
    if (emoji !== null && !okEmoji(emoji)) return send(res, 400, { error: 'bad_emoji' });
    const cur = q.myReact.get(m.id, user);
    if ((cur ? cur.emoji : null) === emoji) return send(res, 200, { ok: true });
    const seq = q.maxReact.get().s + 1;
    q.react.run(m.id, user, emoji, seq);
    const ev = { seq, id: m.id, from: m.sender, target: m.target, user, emoji };
    for (const u of new Set(msgAudience(m))) emit(u, 'react', ev);
    return send(res, 200, { ok: true, seq });
  }

  // ---- Web Push for the web version (notifications while it is closed) ----
  if (p === '/api/push/key' && req.method === 'GET') return send(res, 200, { key: push.publicKey() });
  if (p === '/api/push/subscribe' && req.method === 'POST') {
    const b = await readJson(req, 4096);
    if (!push.subscribe(user, a.th, b.subscription)) return send(res, 400, { error: 'bad_subscription' });
    return send(res, 200, { ok: true });
  }
  if (p === '/api/push/unsubscribe' && req.method === 'POST') {
    const b = await readJson(req, 4096);
    push.unsubscribe(user, b.endpoint);
    return send(res, 200, { ok: true });
  }
  // sends a test notification to this user's browsers and reports what the push services answered
  if (p === '/api/push/test' && req.method === 'POST') {
    if (limited('push:' + user, 10)) return send(res, 429, { error: 'rate_limited' });
    addFail('push:' + user);
    return send(res, 200, { results: await push.notify(user, { t: 'test', title: 'سپن', body: 'اعلان آزمایشی رسید ✓' }) });
  }

  if (p === '/api/groups' && req.method === 'GET') {
    return send(res, 200, core.groupsOf(user).map((g) => ({ id: g.id, key: g.gkey, name: g.name, members: core.membersOf(g.id) })));
  }

  if (p === '/api/pubkey' && req.method === 'POST') {
    const b = await readJson(req, 4096);
    if (typeof b.pubkey !== 'string' || b.pubkey.length > 1024) return send(res, 400, { error: 'bad_pubkey' });
    const kb = keyBackupOf(core.q.user.get(user));
    if (kb && kb.pub !== b.pubkey) return send(res, 409, { error: 'key_backup_mismatch' });
    q.setKey.run(b.pubkey, user);
    return send(res, 200, { ok: true });
  }

  // password-encrypted copy of the identity private key (the server cannot open it); see docs/ARCHITECTURE.md
  if (p === '/api/keybackup' && req.method === 'GET') return send(res, 200, { key_backup: keyBackupOf(core.q.user.get(user)) });
  if (p === '/api/keybackup' && req.method === 'POST') {
    const b = await readJson(req, 8192);
    const me = core.q.user.get(user);
    // the account must be confirmed, so a stolen session alone cannot swap the key: by the login password,
    // by an SMS code (/api/auth/reauth), or by a sign-in with a one-time code in the last 30 minutes
    if (limited('u:' + user, 5)) return send(res, 429, { error: 'rate_limited' });
    const pw = typeof b.password === 'string' ? b.password : '';
    const fresh = a.via !== 'password' && now() - a.created < 30 * 60e3;
    const proven = pw ? checkPassword(pw, me.pass) || !!auth.consume(user, pw, ['reauth']) : fresh;
    if (!proven) { addFail('u:' + user); return send(res, 403, { error: 'bad_password' }); }
    const kb = cleanKeyBackup(b.key_backup);
    if (!kb) return send(res, 400, { error: 'bad_key_backup' });
    const before = me.pubkey;
    q.setBackup.run(JSON.stringify(kb), kb.pub, user);
    if (before !== kb.pub) broadcastTo(audienceOf(user).filter((x) => x !== user), 'refresh', {});
    return send(res, 200, { ok: true });
  }

  if (p === '/api/profile' && req.method === 'POST') {
    const b = await readJson(req, 4096);
    if (typeof b.display_name === 'string') q.setName.run(core.cleanDisplay(b.display_name) || null, user);
    if (typeof b.bio === 'string') q.setBio.run(core.cleanBio(b.bio) || null, user);
    profileChanged(user);
    const u = core.q.user.get(user);
    return send(res, 200, { display_name: u.display_name || null, bio: u.bio || null });
  }

  if (p === '/api/avatar' && req.method === 'POST') {
    const len = Number(req.headers['content-length']);
    if (!len || len > 400 * 1024) { res.setHeader('Connection', 'close'); return send(res, 413, { error: 'avatar_too_large' }); }
    const clean = sanitizeWebp(await readBody(req, 400 * 1024));
    if (!clean) return send(res, 400, { error: 'bad_avatar' });
    const dest = path.join(AVATARS_DIR, user + '.webp');
    fs.writeFileSync(dest + '.tmp', clean);
    fs.renameSync(dest + '.tmp', dest);
    q.bumpAvatar.run(user);
    profileChanged(user);
    return send(res, 200, { avatar_ver: core.q.user.get(user).avatar_ver });
  }

  if (p === '/api/avatar' && req.method === 'DELETE') {
    try { fs.unlinkSync(path.join(AVATARS_DIR, user + '.webp')); } catch { }
    q.dropAvatar.run(user);
    profileChanged(user);
    return send(res, 200, { avatar_ver: core.q.user.get(user).avatar_ver });
  }

  const am = /^\/api\/avatar\/([a-z0-9_]{2,20})$/.exec(p);
  if (am && req.method === 'GET') {
    const who = am[1];
    if (who !== user && !core.contacts(user).has(who)) return send(res, 404, { error: 'not_found' });
    const fp = path.join(AVATARS_DIR, who + '.webp');
    if (!fs.existsSync(fp)) return send(res, 404, { error: 'no_avatar' });
    const buf = fs.readFileSync(fp);
    res.writeHead(200, { 'Content-Type': 'image/webp', 'Content-Length': buf.length, 'Cache-Control': 'private, max-age=31536000, immutable' });
    return res.end(buf);
  }

  if (p === '/api/events' && req.method === 'GET') {
    const since = Number(url.searchParams.get('since') || req.headers['last-event-id'] || 0) || 0;
    req.socket.setTimeout(0);
    req.socket.setKeepAlive(true, 30000);
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
    res.write('retry: 2000\n\n');
    // csince: last edit/delete the client has seen; -1 = none yet (it only learns the current number)
    const csParam = url.searchParams.get('csince');
    // rsince: last reaction change the client has seen; -1 = none yet (it only learns the current number)
    const rsParam = url.searchParams.get('rsince');
    for (const m of replay(user, since)) res.write(`id: ${m.id}\nevent: msg\ndata: ${JSON.stringify(msgJson(m, q.reactsOf.all(m.id)))}\n\n`);
    if (csParam != null) {
      const cs = Number(csParam);
      if (Number.isInteger(cs) && cs >= 0) for (const c of replayChanges(user, cs, since)) res.write(`event: change\ndata: ${JSON.stringify(c)}\n\n`);
      res.write(`event: cseq\ndata: ${JSON.stringify({ seq: q.maxChange.get().s })}\n\n`);
    }
    if (rsParam != null) {
      const rs = Number(rsParam);
      if (Number.isInteger(rs) && rs >= 0) for (const r of replayReactions(user, rs, since)) res.write(`event: react\ndata: ${JSON.stringify(r)}\n\n`);
      res.write(`event: rseq\ndata: ${JSON.stringify({ seq: q.maxReact.get().s })}\n\n`);
      res.write(`event: receipts\ndata: ${JSON.stringify({ list: receiptsFor(user) })}\n\n`);
    }
    for (const pn of pinsFor(user)) res.write(`event: pin\ndata: ${JSON.stringify(pn)}\n\n`);
    // clients from before 1.4 send no `active`: they count as on screen whenever connected, as before
    res.dev = String(url.searchParams.get('dev') || '').slice(0, 64);
    res.active = url.searchParams.get('active') !== '0';
    let set = clients.get(user);
    if (!set) clients.set(user, (set = new Set()));
    const wasOnline = isOnline(user);
    set.add(res);
    if (!wasOnline && isOnline(user)) presenceChanged(user, true);
    req.on('close', () => {
      const was = isOnline(user);
      set.delete(res);
      if (!set.size && clients.get(user) === set) clients.delete(user);
      if (was && !isOnline(user)) presenceChanged(user, false);
    });
    return;
  }

  if (p === '/api/send' && req.method === 'POST') {
    const b = await readJson(req, 131072 + 1024);
    const target = String(b.target || 'all').toLowerCase();
    const kind = String(b.kind || 'text');
    if (!/^[a-z_]{1,16}$/.test(kind)) return send(res, 400, { error: 'bad_kind' });
    if (typeof b.payload !== 'string' || b.payload.length > 131072) return send(res, 400, { error: 'bad_payload' });
    const tr = resolveTarget(user, target);
    if (tr.error) return send(res, tr.code, { error: tr.error });
    if (kind.startsWith('sig_')) { // live-only signalling (typing, calls) — private chats only, never stored
      if (tr.type !== 'dm') return send(res, 400, { error: 'sig_needs_target' });
      return send(res, 200, { delivered: emit(target, 'sig', { from: user, kind, payload: b.payload }) });
    }
    let fileId = null;
    if (b.fileId != null) {
      if (!/^[a-f0-9]{32}$/.test(String(b.fileId))) return send(res, 400, { error: 'bad_file' });
      if (!canUseFile(user, b.fileId)) return send(res, 400, { error: 'bad_file' });
      fileId = b.fileId;
    }
    const ts = now();
    const r = q.addMsg.run(user, target, kind, b.payload, fileId, ts);
    const m = { id: Number(r.lastInsertRowid), sender: user, target, kind, payload: b.payload, file_id: fileId, ts };
    const recipients = tr.type === 'group' ? core.membersOf(tr.cat.id) : [target, user];
    for (const u of recipients) emit(u, 'msg', msgJson(m), m.id);
    // nobody has the app on screen: wake their closed web apps (iPhone) with a notification
    for (const u of recipients) if (u !== user && !isOnline(u) && push.hasSubs(u)) push.notify(u, pushData(m, tr)).catch(() => { });
    return send(res, 200, { id: m.id, ts });
  }

  // ---- edit / delete for everyone / edit history (sender only) ----
  if ((p === '/api/edit' || p === '/api/delete') && req.method === 'POST') {
    const b = await readJson(req, 2 * 131072 + 2048);
    const m = q.msg.get(Number(b.id));
    if (!m || m.deleted || m.sender !== user || m.kind.startsWith('sig_')) return send(res, 404, { error: 'no_such_message' });
    const tr = resolveTarget(user, m.target);
    if (tr.error) return send(res, tr.code, { error: tr.error });
    const t = now();
    if (p === '/api/edit') {
      if (typeof b.payload !== 'string' || !b.payload || b.payload.length > 131072) return send(res, 400, { error: 'bad_payload' });
      if (b.prev != null && (typeof b.prev !== 'string' || b.prev.length > 131072)) return send(res, 400, { error: 'bad_payload' });
      if (t - m.ts > EDIT_WINDOW) return send(res, 403, { error: 'edit_window_passed' });
      q.editMsg.run(b.payload, t, m.id);
      if (b.prev) q.addHist.run(m.id, b.prev, t);
    } else {
      q.delMsg.run(m.id);
      db.prepare('DELETE FROM msg_history WHERE msg_id=?').run(m.id);
      q.delReacts.run(m.id);
    }
    const kind = p === '/api/edit' ? 'edit' : 'del';
    const seq = Number(q.addChange.run(m.id, kind, t).lastInsertRowid);
    const ch = changeJson(seq, kind, q.msg.get(m.id));
    for (const u of new Set(msgAudience(m))) emit(u, 'change', ch);
    return send(res, 200, { ok: true, seq, edited: kind === 'edit' ? t : null });
  }
  if (p === '/api/history' && req.method === 'GET') {
    const m = q.msg.get(Number(url.searchParams.get('id')));
    if (!m || m.sender !== user) return send(res, 404, { error: 'no_such_message' });
    return send(res, 200, { versions: q.hist.all(m.id) });
  }

  if (p === '/api/pin' && req.method === 'POST') {
    const b = await readJson(req, 2048);
    const target = String(b.target || '').toLowerCase();
    const tr = resolveTarget(user, target);
    if (tr.error) return send(res, tr.code, { error: tr.error });
    const key = pinKey(user, tr);
    if (b.messageId == null) {
      q.delPin.run(key);
    } else {
      const m = q.msg.get(Number(b.messageId));
      const okMsg = m && (tr.type === 'group' ? m.target === tr.cat.gkey : ((m.sender === user && m.target === tr.peer) || (m.sender === tr.peer && m.target === user)));
      if (!okMsg) return send(res, 400, { error: 'bad_message' });
      q.setPin.run(key, m.id, user, now());
    }
    const mid = b.messageId == null ? null : Number(b.messageId);
    if (tr.type === 'group') for (const u of core.membersOf(tr.cat.id)) emit(u, 'pin', { convo: key, messageId: mid, by: user });
    else { emit(tr.peer, 'pin', { convo: user, messageId: mid, by: user }); emit(user, 'pin', { convo: tr.peer, messageId: mid, by: user }); }
    return send(res, 200, { ok: true });
  }

  // ---- connection requests between users (fill the visibility matrix without the admin) ----
  if (p === '/api/contacts/requests' && req.method === 'GET') return send(res, 200, contacts.lists(user));
  const cm = /^\/api\/contacts\/(request|respond|cancel|remove)$/.exec(p);
  if (cm && req.method === 'POST') {
    const b = await readJson(req, 4096);
    const other = String(b.username || '').trim().toLowerCase();
    try {
      let result = 'ok';
      if (cm[1] === 'request') result = contacts.request(user, other);
      else if (cm[1] === 'respond') contacts.respond(user, other, !!b.accept);
      else if (cm[1] === 'cancel') contacts.cancel(user, other);
      else contacts.remove(user, other);
      emit(other, 'contacts', {});
      emit(user, 'contacts', {});
      if (result === 'connected' || (cm[1] === 'respond' && b.accept) || cm[1] === 'remove') { emit(other, 'refresh', {}); emit(user, 'refresh', {}); }
      return send(res, 200, { result });
    } catch (e) {
      const code = e.message === 'no_such_user' || e.message === 'no_request' ? 404 : e.message === 'not_allowed' ? 403 : 400;
      return send(res, code, { error: e.message });
    }
  }

  if (p === '/api/turn' && req.method === 'GET') {
    if (!TURN_SECRET || !PUBLIC_HOST) return send(res, 503, { error: 'turn_not_configured' });
    const ttl = 86400;
    const username = (Math.floor(now() / 1000) + ttl) + ':' + user;
    const credential = crypto.createHmac('sha1', TURN_SECRET).update(username).digest('base64');
    return send(res, 200, {
      urls: [`stun:${PUBLIC_HOST}:3478`, `turn:${PUBLIC_HOST}:3478?transport=udp`, `turn:${PUBLIC_HOST}:3478?transport=tcp`],
      username, credential, ttl,
    });
  }

  // ----- legacy single-shot upload (kept for old app versions) -----
  if (p === '/api/upload' && req.method === 'POST') {
    const len = Number(req.headers['content-length']);
    if (!len || len > MAX_LEGACY) { res.setHeader('Connection', 'close'); return send(res, 413, { error: 'file_too_large', maxBytes: MAX_LEGACY }); }
    if (q.totalFiles.get().t + q.totalUploads.get().t + len > MAX_TOTAL) { res.setHeader('Connection', 'close'); return send(res, 507, { error: 'storage_full' }); }
    const id = crypto.randomBytes(16).toString('hex');
    const tmp = path.join(FILES_DIR, id + '.part');
    const final = path.join(FILES_DIR, id);
    const ws = fs.createWriteStream(tmp);
    let size = 0;
    req.on('data', (c) => { size += c.length; if (size > len) { req.destroy(); ws.destroy(); } });
    req.on('close', () => { if (!req.complete) { ws.destroy(); fs.unlink(tmp, () => { }); } });
    ws.on('error', () => { fs.unlink(tmp, () => { }); if (!res.headersSent) send(res, 500, { error: 'write_failed' }); });
    ws.on('finish', () => {
      if (size !== len) { fs.unlink(tmp, () => { }); return send(res, 400, { error: 'size_mismatch' }); }
      fs.renameSync(tmp, final);
      q.addFile.run(id, user, size, now());
      send(res, 200, { fileId: id, size });
    });
    req.pipe(ws);
    return;
  }

  // ----- chunked / resumable upload -----
  if (p === '/api/uploads' && req.method === 'POST') {
    const b = await readJson(req, 1024);
    const size = Number(b.size);
    if (!Number.isInteger(size) || size < 1) return send(res, 400, { error: 'bad_size' });
    if (size > MAX_UPLOAD) return send(res, 413, { error: 'file_too_large', maxBytes: MAX_UPLOAD });
    if (q.totalFiles.get().t + q.totalUploads.get().t + size > MAX_TOTAL) return send(res, 507, { error: 'storage_full' });
    if (freeSpace() - size < MIN_FREE) return send(res, 507, { error: 'disk_full' });
    const id = crypto.randomBytes(16).toString('hex');
    fs.closeSync(fs.openSync(path.join(UPLOADS_DIR, id + '.part'), 'w'));
    q.addUp.run(id, user, size, now());
    return send(res, 200, { uploadId: id, offset: 0, size, chunkMax: CHUNK_MAX });
  }

  const um = /^\/api\/uploads\/([a-f0-9]{32})$/.exec(p);
  if (um) {
    const up = q.up.get(um[1]);
    if (!up || up.owner !== user) return send(res, 404, { error: 'no_such_upload' });
    if (req.method === 'GET') return send(res, 200, { offset: up.off, size: up.size });
    if (req.method === 'PATCH') {
      const reqOff = Number(req.headers['upload-offset']);
      const len = Number(req.headers['content-length']);
      if (!Number.isInteger(reqOff) || !len || len > CHUNK_MAX || reqOff + len > up.size) {
        res.setHeader('Connection', 'close'); return send(res, 400, { error: 'bad_chunk' });
      }
      if (reqOff !== up.off) { res.setHeader('Connection', 'close'); return send(res, 409, { error: 'offset_mismatch', offset: up.off }); }
      if (inflight.has(up.id)) { res.setHeader('Connection', 'close'); return send(res, 409, { error: 'busy', offset: up.off }); }
      inflight.add(up.id);
      const part = path.join(UPLOADS_DIR, up.id + '.part');
      const ws = fs.createWriteStream(part, { flags: 'r+', start: reqOff });
      let got = 0;
      const done = () => inflight.delete(up.id);
      req.on('data', (c) => { got += c.length; if (got > len) { req.destroy(); ws.destroy(); } });
      req.on('close', () => { if (!req.complete) { ws.destroy(); done(); } });
      ws.on('error', () => { done(); if (!res.headersSent) send(res, 500, { error: 'write_failed' }); });
      ws.on('finish', () => {
        done();
        if (got !== len) return send(res, 400, { error: 'size_mismatch', offset: up.off });
        const newOff = reqOff + len;
        if (newOff === up.size) {
          fs.renameSync(part, path.join(FILES_DIR, up.id));
          q.addFile.run(up.id, user, up.size, now());
          q.delUp.run(up.id);
          return send(res, 200, { offset: newOff, done: true, fileId: up.id, size: up.size });
        }
        q.setOff.run(newOff, now(), up.id);
        send(res, 200, { offset: newOff, done: false });
      });
      req.pipe(ws);
      return;
    }
  }

  // ----- download (with Range support so big files can resume) -----
  const fm = /^\/api\/file\/([a-f0-9]{32})$/.exec(p);
  if (fm && req.method === 'GET') {
    const f = q.file.get(fm[1]);
    if (!f) return send(res, 404, { error: 'not_found' });
    let start = 0, end = f.size - 1, status = 200;
    const range = req.headers.range;
    if (range) {
      const m = /^bytes=(\d*)-(\d*)$/.exec(range);
      if (!m || (m[1] === '' && m[2] === '')) { res.writeHead(416, { 'Content-Range': `bytes */${f.size}` }); return res.end(); }
      if (m[1] === '') start = Math.max(0, f.size - Number(m[2]));
      else { start = Number(m[1]); if (m[2] !== '') end = Math.min(Number(m[2]), f.size - 1); }
      if (start > end || start >= f.size) { res.writeHead(416, { 'Content-Range': `bytes */${f.size}` }); return res.end(); }
      status = 206;
    }
    const rs = fs.createReadStream(path.join(FILES_DIR, fm[1]), { start, end });
    rs.on('open', () => {
      const h = { 'Content-Type': 'application/octet-stream', 'Content-Length': end - start + 1, 'Accept-Ranges': 'bytes', 'Cache-Control': 'private, max-age=86400' };
      if (status === 206) h['Content-Range'] = `bytes ${start}-${end}/${f.size}`;
      res.writeHead(status, h);
      rs.pipe(res);
    });
    rs.on('error', () => { if (!res.headersSent) send(res, 404, { error: 'not_found' }); else res.destroy(); });
    res.on('close', () => rs.destroy());
    return;
  }

  return send(res, 404, { error: 'not_found' });
}
const inflight = new Set();

const handler = (req, res) => {
  route(req, res).catch((e) => {
    if (!res.headersSent) send(res, e.code === 413 || e.code === 400 ? e.code : 500, { error: e.code ? e.message : 'server_error' });
    else res.destroy();
  });
};

let tlsOptions = null;
if (!PLAIN) {
  tlsOptions = {
    key: fs.readFileSync(path.join(CERT_DIR, 'key.pem')),
    cert: fs.readFileSync(path.join(CERT_DIR, 'cert.pem')),
    minVersion: 'TLSv1.2',
  };
}
const server = PLAIN ? http.createServer(handler) : https.createServer(tlsOptions, handler);
server.requestTimeout = 15 * 60 * 1000;
server.keepAliveTimeout = 65000;

// ---------- cleanup ----------
function cleanup() {
  try {
    const fcut = now() - FILE_TTL_DAYS * DAY;
    for (const f of db.prepare('SELECT id FROM files WHERE ts<?').all(fcut)) { try { fs.unlinkSync(path.join(FILES_DIR, f.id)); } catch { } }
    db.prepare('DELETE FROM files WHERE ts<?').run(fcut);
    db.prepare('DELETE FROM messages WHERE ts<?').run(now() - MSG_TTL_DAYS * DAY);
    db.prepare('DELETE FROM msg_history WHERE msg_id NOT IN (SELECT id FROM messages)').run();
    db.prepare('DELETE FROM reactions WHERE msg_id NOT IN (SELECT id FROM messages)').run();
    push.cleanup();
    auth.cleanup();
    db.prepare('DELETE FROM msg_changes WHERE ts<?').run(now() - MSG_TTL_DAYS * DAY);
    db.prepare('DELETE FROM sessions WHERE created<?').run(now() - SESSION_DAYS * DAY);
    for (const u of db.prepare('SELECT id FROM uploads WHERE ts<?').all(now() - DAY)) {
      try { fs.unlinkSync(path.join(UPLOADS_DIR, u.id + '.part')); } catch { }
      q.delUp.run(u.id);
    }
    for (const n of fs.readdirSync(FILES_DIR)) {
      if (!n.endsWith('.part')) continue;
      const fp = path.join(FILES_DIR, n);
      if (now() - fs.statSync(fp).mtimeMs > 3600e3) fs.unlinkSync(fp);
    }
  } catch (e) { console.error('cleanup error', e.message); }
}
setInterval(cleanup, 3600e3);
cleanup();

stats.start();
backup.startScheduler();

// ---------- admin panel (separate listener, localhost by default) ----------
const ctx = { kick, refreshAll, profileChanged, onlineUsers: connectedUsers, isOnline: isConnected, apkPath: APK, apkInfo };
require('./adminpanel').start(ctx, tlsOptions);

// ---------- web version / PWA for iPhone (own port and certificate, same API) ----------
require('./web').start(handler, { plain: PLAIN, certDir: path.join(CERT_DIR, 'web'), publicHost: PUBLIC_HOST, serveApk, apkInfo });

server.listen(PORT, '0.0.0.0', () => console.log(`messenger listening on ${PORT} (${PLAIN ? 'PLAIN HTTP - test only' : 'TLS'})`));
for (const s of ['SIGTERM', 'SIGINT']) process.on(s, () => { server.close(); process.exit(0); });
module.exports = { ctx };
