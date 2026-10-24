#!/bin/bash
# Adds a STUN/TURN server (coturn) for voice/video calls and updates the messenger server.
# Run as root:  bash install-calls.sh YOUR_SERVER_IP
set -euo pipefail
IP="${1:-}"
if [ -z "$IP" ]; then echo "Usage: bash install-calls.sh YOUR_SERVER_IP"; exit 1; fi
if [ "$(id -u)" != "0" ]; then echo "Run as root"; exit 1; fi
if [ ! -d /opt/messenger/app ]; then echo "Messenger server not found. Run install.sh first."; exit 1; fi

export DEBIAN_FRONTEND=noninteractive NEEDRESTART_MODE=a
apt-get update -y
apt-get install -y coturn

# --- shared secret between coturn and the messenger server (time-limited credentials) ---
SECRET_FILE=/opt/messenger/certs/turn_secret
[ -f "$SECRET_FILE" ] || openssl rand -hex 32 > "$SECRET_FILE"
chown msg:msg "$SECRET_FILE"; chmod 600 "$SECRET_FILE"
SECRET="$(cat "$SECRET_FILE")"

# --- coturn config ---
cat > /etc/turnserver.conf <<CONF
listening-port=3478
listening-ip=0.0.0.0
external-ip=$IP
min-port=49152
max-port=49352
fingerprint
use-auth-secret
static-auth-secret=$SECRET
realm=messenger
total-quota=100
no-tls
no-dtls
no-cli
no-multicast-peers
no-software-attribute
denied-peer-ip=0.0.0.0-0.255.255.255
denied-peer-ip=10.0.0.0-10.255.255.255
denied-peer-ip=100.64.0.0-100.127.255.255
denied-peer-ip=127.0.0.0-127.255.255.255
denied-peer-ip=169.254.0.0-169.254.255.255
denied-peer-ip=172.16.0.0-172.31.255.255
denied-peer-ip=192.168.0.0-192.168.255.255
CONF
chown root:turnserver /etc/turnserver.conf; chmod 640 /etc/turnserver.conf
echo 'TURNSERVER_ENABLED=1' > /etc/default/coturn

# --- firewall ---
ufw allow 3478/udp
ufw allow 3478/tcp
ufw allow 49152:49352/udp

systemctl enable coturn >/dev/null 2>&1
systemctl restart coturn

# --- updated messenger server (adds /api/turn) ---
cat > /opt/messenger/app/server.js <<'MSG_FILE_EOF'
'use strict';
const https = require('node:https');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { db, DATA_DIR, hashPassword, checkPassword } = require('./db');

const PORT = +(process.env.PORT || 8443);
const CERT_DIR = process.env.CERT_DIR || path.join(DATA_DIR, '..', 'certs');
const MAX_FILE = +(process.env.MAX_FILE_MB || 25) * 1024 * 1024;
const MAX_TOTAL = +(process.env.MAX_TOTAL_MB || 10000) * 1024 * 1024;
const FILE_TTL_DAYS = +(process.env.FILE_TTL_DAYS || 30);
const MSG_TTL_DAYS = +(process.env.MSG_TTL_DAYS || 90);
const SESSION_DAYS = 90;
const FILES_DIR = path.join(DATA_DIR, 'files');
const DAY = 864e5;
const PUBLIC_HOST = process.env.PUBLIC_HOST || '';
let TURN_SECRET = '';
try { if (process.env.TURN_SECRET_FILE) TURN_SECRET = fs.readFileSync(process.env.TURN_SECRET_FILE, 'utf8').trim(); } catch {}

const now = () => Date.now();
const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');
const DUMMY = hashPassword('dummy-password');

const q = {
  user: db.prepare('SELECT * FROM users WHERE username=?'),
  users: db.prepare('SELECT username,pubkey FROM users ORDER BY username'),
  setKey: db.prepare('UPDATE users SET pubkey=? WHERE username=?'),
  addSess: db.prepare('INSERT INTO sessions(th,username,created) VALUES(?,?,?)'),
  sess: db.prepare('SELECT username,created FROM sessions WHERE th=?'),
  delSess: db.prepare('DELETE FROM sessions WHERE th=?'),
  addMsg: db.prepare('INSERT INTO messages(sender,target,kind,payload,file_id,ts) VALUES(?,?,?,?,?,?)'),
  since: db.prepare("SELECT * FROM messages WHERE id>? AND (target='all' OR target=? OR sender=?) ORDER BY id LIMIT 2000"),
  addFile: db.prepare('INSERT INTO files(id,owner,size,ts) VALUES(?,?,?,?)'),
  file: db.prepare('SELECT * FROM files WHERE id=?'),
  total: db.prepare('SELECT COALESCE(SUM(size),0) AS t FROM files'),
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
function auth(req) {
  const m = /^Bearer ([a-f0-9]{64})$/.exec(req.headers.authorization || '');
  if (!m) return null;
  const th = sha256(m[1]);
  const row = q.sess.get(th);
  if (!row) return null;
  if (now() - row.created > SESSION_DAYS * DAY) { q.delSess.run(th); return null; }
  return row.username;
}

// ---------- rate limit for login ----------
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
function broadcast(event, data, id) { for (const u of clients.keys()) emit(u, event, data, id); }
const msgJson = (m) => ({ id: m.id, from: m.sender, target: m.target, kind: m.kind, payload: m.payload, fileId: m.file_id, ts: m.ts });
setInterval(() => { for (const set of clients.values()) for (const r of set) r.write(': ping\n\n'); }, 15000);

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
    const u = q.user.get(username);
    const ok = u ? checkPassword(b.password || '', u.pass) : (checkPassword(b.password || '', DUMMY), false);
    if (!ok) { addFail('ip:' + ip); addFail('u:' + username); return send(res, 401, { error: 'bad_credentials' }); }
    fails.delete('u:' + username);
    const token = crypto.randomBytes(32).toString('hex');
    q.addSess.run(sha256(token), username, now());
    if (typeof b.pubkey === 'string' && b.pubkey.length <= 1024) q.setKey.run(b.pubkey, username);
    return send(res, 200, { token, username });
  }

  const user = auth(req);
  if (!user) return send(res, 401, { error: 'unauthorized' });

  if (p === '/api/logout' && req.method === 'POST') {
    q.delSess.run(sha256(req.headers.authorization.slice(7)));
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

  if (p === '/api/users' && req.method === 'GET') {
    return send(res, 200, q.users.all().map((u) => ({ username: u.username, pubkey: u.pubkey, online: clients.has(u.username) && clients.get(u.username).size > 0 })));
  }

  if (p === '/api/pubkey' && req.method === 'POST') {
    const b = await readJson(req, 4096);
    if (typeof b.pubkey !== 'string' || b.pubkey.length > 1024) return send(res, 400, { error: 'bad_pubkey' });
    q.setKey.run(b.pubkey, user);
    return send(res, 200, { ok: true });
  }

  if (p === '/api/events' && req.method === 'GET') {
    const since = Number(url.searchParams.get('since') || req.headers['last-event-id'] || 0) || 0;
    req.socket.setTimeout(0);
    req.socket.setKeepAlive(true, 30000);
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
    res.write('retry: 2000\n\n');
    for (const m of q.since.all(since, user, user)) res.write(`id: ${m.id}\nevent: msg\ndata: ${JSON.stringify(msgJson(m))}\n\n`);
    let set = clients.get(user);
    const first = !set || !set.size;
    if (!set) clients.set(user, (set = new Set()));
    set.add(res);
    if (first) broadcast('presence', { user, online: true });
    req.on('close', () => {
      set.delete(res);
      if (!set.size) { clients.delete(user); broadcast('presence', { user, online: false }); }
    });
    return;
  }

  if (p === '/api/send' && req.method === 'POST') {
    const b = await readJson(req, 131072 + 1024);
    const target = String(b.target || 'all').toLowerCase();
    const kind = String(b.kind || 'text');
    if (!/^[a-z_]{1,16}$/.test(kind)) return send(res, 400, { error: 'bad_kind' });
    if (typeof b.payload !== 'string' || b.payload.length > 131072) return send(res, 400, { error: 'bad_payload' });
    if (target !== 'all' && !q.user.get(target)) return send(res, 404, { error: 'no_such_user' });
    if (kind.startsWith('sig_')) { // live-only call signaling, never stored
      if (target === 'all') return send(res, 400, { error: 'sig_needs_target' });
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
    if (target === 'all') broadcast('msg', msgJson(m), m.id);
    else { emit(target, 'msg', msgJson(m), m.id); if (target !== user) emit(user, 'msg', msgJson(m), m.id); }
    return send(res, 200, { id: m.id, ts });
  }

  if (p === '/api/upload' && req.method === 'POST') {
    const len = Number(req.headers['content-length']);
    if (!len || len > MAX_FILE) { res.setHeader('Connection', 'close'); return send(res, 413, { error: 'file_too_large', maxBytes: MAX_FILE }); }
    if (q.total.get().t + len > MAX_TOTAL) { res.setHeader('Connection', 'close'); return send(res, 507, { error: 'storage_full' }); }
    const id = crypto.randomBytes(16).toString('hex');
    const tmp = path.join(FILES_DIR, id + '.part');
    const final = path.join(FILES_DIR, id);
    const ws = fs.createWriteStream(tmp);
    let size = 0;
    req.on('data', (c) => { size += c.length; if (size > len) { req.destroy(); ws.destroy(); } });
    req.on('close', () => { if (!req.complete) { ws.destroy(); fs.unlink(tmp, () => {}); } });
    ws.on('error', () => { fs.unlink(tmp, () => {}); if (!res.headersSent) send(res, 500, { error: 'write_failed' }); });
    ws.on('finish', () => {
      if (size !== len) { fs.unlink(tmp, () => {}); return send(res, 400, { error: 'size_mismatch' }); }
      fs.renameSync(tmp, final);
      q.addFile.run(id, user, size, now());
      send(res, 200, { fileId: id, size });
    });
    req.pipe(ws);
    return;
  }

  const fm = /^\/api\/file\/([a-f0-9]{32})$/.exec(p);
  if (fm && req.method === 'GET') {
    const f = q.file.get(fm[1]);
    if (!f) return send(res, 404, { error: 'not_found' });
    const rs = fs.createReadStream(path.join(FILES_DIR, fm[1]));
    rs.on('open', () => {
      res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': f.size, 'Cache-Control': 'private, max-age=86400' });
      rs.pipe(res);
    });
    rs.on('error', () => { if (!res.headersSent) send(res, 404, { error: 'not_found' }); else res.destroy(); });
    res.on('close', () => rs.destroy());
    return;
  }

  return send(res, 404, { error: 'not_found' });
}

const handler = (req, res) => {
  route(req, res).catch((e) => {
    if (!res.headersSent) send(res, e.code === 413 || e.code === 400 ? e.code : 500, { error: e.code ? e.message : 'server_error' });
    else res.destroy();
  });
};

const server = process.env.PLAIN_HTTP === '1'
  ? http.createServer(handler)
  : https.createServer({
      key: fs.readFileSync(path.join(CERT_DIR, 'key.pem')),
      cert: fs.readFileSync(path.join(CERT_DIR, 'cert.pem')),
      minVersion: 'TLSv1.2',
    }, handler);
server.requestTimeout = 15 * 60 * 1000;
server.keepAliveTimeout = 65000;

// ---------- cleanup ----------
function cleanup() {
  try {
    const fcut = now() - FILE_TTL_DAYS * DAY;
    for (const f of db.prepare('SELECT id FROM files WHERE ts<?').all(fcut)) { try { fs.unlinkSync(path.join(FILES_DIR, f.id)); } catch {} }
    db.prepare('DELETE FROM files WHERE ts<?').run(fcut);
    db.prepare('DELETE FROM messages WHERE ts<?').run(now() - MSG_TTL_DAYS * DAY);
    db.prepare('DELETE FROM sessions WHERE created<?').run(now() - SESSION_DAYS * DAY);
    for (const n of fs.readdirSync(FILES_DIR)) {
      if (!n.endsWith('.part')) continue;
      const fp = path.join(FILES_DIR, n);
      if (now() - fs.statSync(fp).mtimeMs > 3600e3) fs.unlinkSync(fp);
    }
  } catch (e) { console.error('cleanup error', e.message); }
}
setInterval(cleanup, 3600e3);
cleanup();

server.listen(PORT, '0.0.0.0', () => console.log(`messenger listening on ${PORT} (${process.env.PLAIN_HTTP === '1' ? 'PLAIN HTTP - test only' : 'TLS'})`));
for (const s of ['SIGTERM', 'SIGINT']) process.on(s, () => { server.close(); process.exit(0); });
MSG_FILE_EOF
chown msg:msg /opt/messenger/app/server.js

mkdir -p /etc/systemd/system/messenger.service.d
cat > /etc/systemd/system/messenger.service.d/turn.conf <<UNIT
[Service]
Environment=TURN_SECRET_FILE=/opt/messenger/certs/turn_secret PUBLIC_HOST=$IP
UNIT
systemctl daemon-reload
systemctl restart messenger
sleep 2

echo
echo "=============== RESULT ==============="
echo -n "coturn:    "; systemctl is-active coturn
echo -n "messenger: "; systemctl is-active messenger
echo -n "health:    "; curl -sk https://127.0.0.1:8443/api/health; echo
echo "TURN listening sockets:"
ss -lunpt | grep 3478 || echo "NOT LISTENING on 3478"
echo
ufw status | grep -E "3478|49152" || true
