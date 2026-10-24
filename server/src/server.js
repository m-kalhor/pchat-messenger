'use strict';
const https = require('node:https');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { db, DATA_DIR, hashPassword, checkPassword } = require('./db');
const core = require('./core');
const { sanitizeWebp } = require('./webp');
const stats = require('./stats');
const backup = require('./backup');

const PORT = +(process.env.PORT || 8443);
const CERT_DIR = process.env.CERT_DIR || path.join(DATA_DIR, '..', 'certs');
const MAX_LEGACY = +(process.env.MAX_FILE_MB || 25) * 1024 * 1024;       // old single-shot /api/upload
const MAX_UPLOAD = +(process.env.MAX_UPLOAD_MB || 2048) * 1024 * 1024;   // chunked uploads
const MAX_TOTAL = +(process.env.MAX_TOTAL_MB || 10000) * 1024 * 1024;
const MIN_FREE = +(process.env.MIN_FREE_MB || 1500) * 1024 * 1024;
const CHUNK_MAX = 16 * 1024 * 1024;
const FILE_TTL_DAYS = +(process.env.FILE_TTL_DAYS || 30);
const MSG_TTL_DAYS = +(process.env.MSG_TTL_DAYS || 90);
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
  addSess: db.prepare('INSERT INTO sessions(th,username,created) VALUES(?,?,?)'),
  sess: db.prepare('SELECT s.username AS username, s.created AS created, u.disabled AS disabled FROM sessions s JOIN users u ON u.username=s.username WHERE s.th=?'),
  delSess: db.prepare('DELETE FROM sessions WHERE th=?'),
  setKey: db.prepare('UPDATE users SET pubkey=? WHERE username=?'),
  addMsg: db.prepare('INSERT INTO messages(sender,target,kind,payload,file_id,ts) VALUES(?,?,?,?,?,?)'),
  msg: db.prepare('SELECT * FROM messages WHERE id=?'),
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
  return { user: row.username, th };
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
const clients = new Map(); // username -> Set(res)
function emit(user, event, data, id) {
  const set = clients.get(user);
  if (!set || !set.size) return false;
  const chunk = (id ? `id: ${id}\n` : '') + `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const r of set) r.write(chunk);
  return true;
}
const isOnline = (u) => !!clients.get(u) && clients.get(u).size > 0;
const onlineUsers = () => [...clients.keys()].filter(isOnline);
const msgJson = (m) => ({ id: m.id, from: m.sender, target: m.target, kind: m.kind, payload: m.payload, fileId: m.file_id, ts: m.ts });
setInterval(() => { for (const set of clients.values()) for (const r of set) r.write(': ping\n\n'); }, 15000);

/** online people who are allowed to know about `username` (plus the user themself) */
function audienceOf(username) {
  return onlineUsers().filter((u) => u === username || core.contacts(u).has(username));
}
function broadcastTo(users, event, data) { for (const u of users) emit(u, event, data); }
function refreshAll() { for (const u of onlineUsers()) emit(u, 'refresh', {}); }
function profileChanged(username) {
  const u = core.q.user.get(username);
  if (!u) return;
  broadcastTo(audienceOf(username), 'profile', { username, display_name: u.display_name, avatar_ver: u.avatar_ver, bio: u.bio || null });
}
function kick(username) {
  const set = clients.get(username);
  if (set) for (const r of [...set]) { try { r.end(); } catch { } }
  clients.delete(username);
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

function publicUser(u, extra) {
  return { username: u.username, display_name: u.display_name || null, pubkey: u.pubkey || null, online: isOnline(u.username), avatar_ver: u.avatar_ver, bio: u.bio || null, ...extra };
}

function replay(user, since) {
  const gk = core.groupsOf(user).map((g) => g.gkey);
  const sql = `SELECT * FROM messages WHERE id>? AND (target=? OR sender=?${gk.length ? ` OR target IN (${gk.map(() => '?').join(',')})` : ''}) ORDER BY id LIMIT 2000`;
  return db.prepare(sql).all(since, user, user, ...gk);
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

function freeSpace() { try { const s = fs.statfsSync(FILES_DIR); return s.bavail * s.bsize; } catch { return Infinity; } }

// ---------- routes ----------
async function route(req, res) {
  const url = new URL(req.url, 'http://x');
  const p = url.pathname;
  res.setHeader('X-Content-Type-Options', 'nosniff');

  if (p === '/api/health') return send(res, 200, { ok: true });

  if (p === '/api/login' && req.method === 'POST') {
    const b = await readJson(req, 4096);
    const username = String(b.username || '').toLowerCase();
    const ip = req.socket.remoteAddress;
    if (limited('ip:' + ip, 20) || limited('u:' + username, 5)) return send(res, 429, { error: 'rate_limited' });
    const u = core.q.user.get(username);
    const ok = u ? checkPassword(b.password || '', u.pass) : (checkPassword(b.password || '', DUMMY), false);
    if (!ok || u.disabled) { addFail('ip:' + ip); addFail('u:' + username); return send(res, 401, { error: 'bad_credentials' }); }
    fails.delete('u:' + username);
    const token = crypto.randomBytes(32).toString('hex');
    q.addSess.run(sha256(token), username, now());
    if (typeof b.pubkey === 'string' && b.pubkey.length <= 1024) q.setKey.run(b.pubkey, username);
    return send(res, 200, { token, username });
  }

  const a = authInfo(req);
  if (!a) return send(res, 401, { error: 'unauthorized' });
  const user = a.user;

  if (p === '/api/logout' && req.method === 'POST') { q.delSess.run(a.th); return send(res, 200, { ok: true }); }

  if (p === '/api/me' && req.method === 'GET') {
    const u = core.q.user.get(user);
    return send(res, 200, { username: user, display_name: u.display_name || null, avatar_ver: u.avatar_ver, bio: u.bio || null });
  }

  if (p === '/api/users' && req.method === 'GET') {
    const out = [publicUser(core.q.user.get(user), { dm: false })];
    for (const [name, v] of core.contacts(user)) out.push(publicUser(core.q.user.get(name), { dm: v.dm }));
    return send(res, 200, out);
  }

  if (p === '/api/groups' && req.method === 'GET') {
    return send(res, 200, core.groupsOf(user).map((g) => ({ id: g.id, key: g.gkey, name: g.name, members: core.membersOf(g.id) })));
  }

  if (p === '/api/pubkey' && req.method === 'POST') {
    const b = await readJson(req, 4096);
    if (typeof b.pubkey !== 'string' || b.pubkey.length > 1024) return send(res, 400, { error: 'bad_pubkey' });
    q.setKey.run(b.pubkey, user);
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
    for (const m of replay(user, since)) res.write(`id: ${m.id}\nevent: msg\ndata: ${JSON.stringify(msgJson(m))}\n\n`);
    for (const pn of pinsFor(user)) res.write(`event: pin\ndata: ${JSON.stringify(pn)}\n\n`);
    let set = clients.get(user);
    const first = !set || !set.size;
    if (!set) clients.set(user, (set = new Set()));
    set.add(res);
    if (first) broadcastTo(audienceOf(user), 'presence', { user, online: true });
    req.on('close', () => {
      set.delete(res);
      if (!set.size) {
        if (clients.get(user) === set) clients.delete(user);
        broadcastTo(audienceOf(user), 'presence', { user, online: false });
      }
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
      const f = q.file.get(b.fileId);
      if (!f || f.owner !== user) return send(res, 400, { error: 'bad_file' });
      fileId = b.fileId;
    }
    const ts = now();
    const r = q.addMsg.run(user, target, kind, b.payload, fileId, ts);
    const m = { id: Number(r.lastInsertRowid), sender: user, target, kind, payload: b.payload, file_id: fileId, ts };
    if (tr.type === 'group') for (const u of core.membersOf(tr.cat.id)) emit(u, 'msg', msgJson(m), m.id);
    else { emit(target, 'msg', msgJson(m), m.id); emit(user, 'msg', msgJson(m), m.id); }
    return send(res, 200, { id: m.id, ts });
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
const ctx = { kick, refreshAll, profileChanged, onlineUsers, isOnline };
require('./adminpanel').start(ctx, tlsOptions);

server.listen(PORT, '0.0.0.0', () => console.log(`messenger listening on ${PORT} (${PLAIN ? 'PLAIN HTTP - test only' : 'TLS'})`));
for (const s of ['SIGTERM', 'SIGINT']) process.on(s, () => { server.close(); process.exit(0); });
module.exports = { ctx };
