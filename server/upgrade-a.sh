#!/bin/bash
# Messenger server upgrade - phase A (profiles/avatars, visibility matrix, category groups,
# chunked uploads, pins, admin web panel, monitoring, scheduled DB backups).
# Run as root:
#   bash upgrade-a.sh            admin panel open to the whole Internet (https, port 8444, rate-limited)
#   bash upgrade-a.sh YOUR_IP    admin panel open only to that single IP
#   bash upgrade-a.sh local      admin panel reachable only from the server itself (SSH tunnel)
set -euo pipefail
MODE="${1:-open}"
if [ "$(id -u)" != "0" ]; then echo "Run as root"; exit 1; fi
if [ ! -d /opt/messenger/app ]; then echo "Messenger server not found. Run install.sh first."; exit 1; fi
APP=/opt/messenger/app

# --- safety copy of the old version + database, then stop the service ---
TS=$(date +%Y%m%d-%H%M%S)
SAFE=/root/messenger-backup-$TS
mkdir -p "$SAFE"
systemctl stop messenger || true
cp -a /opt/messenger/app "$SAFE/app"
cp -a /opt/messenger/data/messenger.db* "$SAFE/" 2>/dev/null || true
echo "Old version + database saved in $SAFE"

rm -f $APP/admin.js
cat > $APP/db.js <<'MSG_FILE_EOF'
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
for (const d of ['files', 'uploads', 'avatars', 'backups']) fs.mkdirSync(path.join(DATA_DIR, d), { recursive: true });

const db = new DatabaseSync(path.join(DATA_DIR, 'messenger.db'));
db.exec(`
PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;
CREATE TABLE IF NOT EXISTS users (
  username TEXT PRIMARY KEY, pass TEXT NOT NULL, pubkey TEXT, created INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS sessions (
  th TEXT PRIMARY KEY, username TEXT NOT NULL, created INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT, sender TEXT NOT NULL, target TEXT NOT NULL,
  kind TEXT NOT NULL, payload TEXT NOT NULL, file_id TEXT, ts INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS idx_msg_target ON messages(target, id);
CREATE INDEX IF NOT EXISTS idx_msg_sender ON messages(sender, target);
CREATE TABLE IF NOT EXISTS files (
  id TEXT PRIMARY KEY, owner TEXT NOT NULL, size INTEGER NOT NULL, ts INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS categories (
  id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE NOT NULL, gkey TEXT UNIQUE NOT NULL);
CREATE TABLE IF NOT EXISTS user_categories (
  username TEXT NOT NULL, category_id INTEGER NOT NULL, PRIMARY KEY (username, category_id));
CREATE TABLE IF NOT EXISTS visibility (
  viewer TEXT NOT NULL, target TEXT NOT NULL, PRIMARY KEY (viewer, target));
CREATE TABLE IF NOT EXISTS pins (
  convo TEXT PRIMARY KEY, message_id INTEGER NOT NULL, by TEXT NOT NULL, ts INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS uploads (
  id TEXT PRIMARY KEY, owner TEXT NOT NULL, size INTEGER NOT NULL, off INTEGER NOT NULL DEFAULT 0, ts INTEGER NOT NULL);
`);

// ---- idempotent migrations for databases created by the first version ----
const userCols = db.prepare('PRAGMA table_info(users)').all().map((r) => r.name);
if (!userCols.includes('display_name')) db.exec('ALTER TABLE users ADD COLUMN display_name TEXT');
if (!userCols.includes('avatar_ver')) db.exec('ALTER TABLE users ADD COLUMN avatar_ver INTEGER NOT NULL DEFAULT 0');
if (!userCols.includes('disabled')) db.exec('ALTER TABLE users ADD COLUMN disabled INTEGER NOT NULL DEFAULT 0');

function getSetting(key, def = null) {
  const r = db.prepare('SELECT value FROM settings WHERE key=?').get(key);
  return r ? r.value : def;
}
function setSetting(key, value) {
  db.prepare('INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key, String(value));
}

// first run of this version: keep everything working as before
// (one default category "عمومی" = the old global group "all", everybody sees everybody)
if (getSetting('migrated_v2') !== '1') {
  db.exec("INSERT OR IGNORE INTO categories(id,name,gkey) VALUES(1,'عمومی','all')");
  db.exec('INSERT OR IGNORE INTO user_categories(username,category_id) SELECT username,1 FROM users');
  db.exec('INSERT OR IGNORE INTO visibility(viewer,target) SELECT a.username,b.username FROM users a, users b WHERE a.username<>b.username');
  setSetting('migrated_v2', '1');
}

function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  const h = crypto.scryptSync(pw, salt, 64);
  return salt.toString('hex') + ':' + h.toString('hex');
}
function checkPassword(pw, stored) {
  const [s, h] = stored.split(':');
  const calc = crypto.scryptSync(String(pw), Buffer.from(s, 'hex'), 64);
  return crypto.timingSafeEqual(calc, Buffer.from(h, 'hex'));
}

module.exports = { db, DATA_DIR, hashPassword, checkPassword, getSetting, setSetting };
MSG_FILE_EOF

cat > $APP/core.js <<'MSG_FILE_EOF'
'use strict';
const crypto = require('node:crypto');
const { db, hashPassword } = require('./db');

const NAME_RE = /^[a-z0-9_]{2,20}$/;

const q = {
  user: db.prepare('SELECT * FROM users WHERE username=?'),
  catByKey: db.prepare('SELECT * FROM categories WHERE gkey=?'),
  groupsOf: db.prepare('SELECT c.* FROM categories c JOIN user_categories uc ON uc.category_id=c.id WHERE uc.username=? ORDER BY c.id'),
  members: db.prepare('SELECT u.username FROM user_categories uc JOIN users u ON u.username=uc.username WHERE uc.category_id=? AND u.disabled=0 ORDER BY u.username'),
  isMember: db.prepare('SELECT 1 FROM user_categories WHERE username=? AND category_id=?'),
  vis: db.prepare('SELECT 1 FROM visibility WHERE viewer=? AND target=?'),
  visList: db.prepare('SELECT target FROM visibility WHERE viewer=?'),
  priorSenders: db.prepare('SELECT DISTINCT sender FROM messages WHERE target=?'),
  hasMsg: db.prepare('SELECT 1 FROM messages WHERE sender=? AND target=? LIMIT 1'),
  mates: db.prepare('SELECT DISTINCT b.username AS u FROM user_categories a JOIN user_categories b ON a.category_id=b.category_id WHERE a.username=? AND b.username<>?'),
};

const activeUser = (name) => { const u = q.user.get(name); return u && !u.disabled ? u : null; };
const groupsOf = (username) => q.groupsOf.all(username);
const membersOf = (catId) => q.members.all(catId).map((r) => r.username);
const isMember = (username, catId) => !!q.isMember.get(username, catId);
const groupByKey = (gkey) => q.catByKey.get(gkey);

/** A may start (visibility matrix) or answer (B already wrote to A) a private chat with B. */
function canDM(a, b) {
  if (a === b || !activeUser(b)) return false;
  return !!q.vis.get(a, b) || !!q.hasMsg.get(b, a);
}

/** Everyone `username` is allowed to know about: matrix contacts, people who wrote to them, group mates. */
function contacts(username) {
  const m = new Map();
  for (const r of q.visList.all(username)) m.set(r.target, { dm: true });
  for (const r of q.priorSenders.all(username)) if (!m.has(r.sender)) m.set(r.sender, { dm: true });
  for (const r of q.mates.all(username, username)) if (!m.has(r.u)) m.set(r.u, { dm: false });
  m.delete(username);
  for (const k of [...m.keys()]) if (!activeUser(k)) m.delete(k);
  return m;
}

const convoKey = (a, b) => 'dm:' + [a, b].sort().join(':');

function genPw() {
  const al = 'abcdefghjkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let s = '';
  for (let i = 0; i < 16; i++) s += al[crypto.randomInt(al.length)];
  return s;
}

function cleanDisplay(s) {
  return String(s || '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 40);
}

function createUser(username, display, catIds) {
  if (!NAME_RE.test(username) || username === 'all') throw new Error('invalid_username');
  if (q.user.get(username)) throw new Error('user_exists');
  const pw = genPw();
  db.prepare('INSERT INTO users(username,pass,display_name,created) VALUES(?,?,?,?)').run(username, hashPassword(pw), cleanDisplay(display) || null, Date.now());
  setUserCategories(username, catIds || []);
  return pw;
}

function setUserCategories(username, catIds) {
  db.prepare('DELETE FROM user_categories WHERE username=?').run(username);
  const ins = db.prepare('INSERT OR IGNORE INTO user_categories(username,category_id) SELECT ?, id FROM categories WHERE id=?');
  for (const id of catIds) ins.run(username, Number(id));
}

function resetPassword(username) {
  if (!q.user.get(username)) throw new Error('no_such_user');
  const pw = genPw();
  db.prepare('UPDATE users SET pass=? WHERE username=?').run(hashPassword(pw), username);
  db.prepare('DELETE FROM sessions WHERE username=?').run(username);
  return pw;
}

function deleteUser(username) {
  db.prepare('DELETE FROM sessions WHERE username=?').run(username);
  db.prepare('DELETE FROM user_categories WHERE username=?').run(username);
  db.prepare('DELETE FROM visibility WHERE viewer=? OR target=?').run(username, username);
  return db.prepare('DELETE FROM users WHERE username=?').run(username).changes > 0;
}

function createCategory(name) {
  const n = cleanDisplay(name);
  if (!n) throw new Error('bad_name');
  const r = db.prepare("INSERT INTO categories(name,gkey) VALUES(?, 'tmp')").run(n);
  const id = Number(r.lastInsertRowid);
  db.prepare('UPDATE categories SET gkey=? WHERE id=?').run('g:' + id, id);
  return id;
}

module.exports = {
  NAME_RE, q, activeUser, groupsOf, membersOf, isMember, groupByKey, canDM, contacts, convoKey,
  genPw, cleanDisplay, createUser, setUserCategories, resetPassword, deleteUser, createCategory,
};
MSG_FILE_EOF

cat > $APP/webp.js <<'MSG_FILE_EOF'
'use strict';
/**
 * Validates a WebP avatar (max 512x512, not animated) and rebuilds the container
 * WITHOUT any metadata chunks (EXIF / XMP / ICC). Returns a Buffer or null if invalid.
 */
function sanitizeWebp(buf, maxDim = 512) {
  if (buf.length < 30 || buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WEBP') return null;
  const end = buf.readUInt32LE(4) + 8;
  if (end > buf.length || end < 20) return null;
  let pos = 12, w = 0, h = 0, hasImage = false;
  const kept = [];
  while (pos + 8 <= end) {
    const fourcc = buf.toString('ascii', pos, pos + 4);
    const size = buf.readUInt32LE(pos + 4);
    const ds = pos + 8;
    if (ds + size > end) return null;
    let data = buf.subarray(ds, ds + size);
    if (fourcc === 'VP8X') {
      if (size < 10) return null;
      if (data[0] & 0x02) return null; // animated
      w = Math.max(w, 1 + data.readUIntLE(4, 3));
      h = Math.max(h, 1 + data.readUIntLE(7, 3));
      data = Buffer.from(data);
      data[0] &= ~0x2c; // clear ICC, EXIF, XMP flags
      kept.push([fourcc, data]);
    } else if (fourcc === 'VP8 ') {
      if (size < 10 || data[3] !== 0x9d || data[4] !== 0x01 || data[5] !== 0x2a) return null;
      w = Math.max(w, data.readUInt16LE(6) & 0x3fff);
      h = Math.max(h, data.readUInt16LE(8) & 0x3fff);
      hasImage = true;
      kept.push([fourcc, data]);
    } else if (fourcc === 'VP8L') {
      if (size < 5 || data[0] !== 0x2f) return null;
      const b = data.readUInt32LE(1);
      w = Math.max(w, (b & 0x3fff) + 1);
      h = Math.max(h, ((b >>> 14) & 0x3fff) + 1);
      hasImage = true;
      kept.push([fourcc, data]);
    } else if (fourcc === 'ALPH') {
      kept.push([fourcc, data]);
    } else if (fourcc === 'ANIM' || fourcc === 'ANMF') {
      return null;
    } // EXIF, XMP , ICCP and unknown chunks are dropped
    pos += 8 + size + (size & 1);
  }
  if (!hasImage || w < 1 || h < 1 || w > maxDim || h > maxDim) return null;
  const parts = [];
  for (const [fourcc, data] of kept) {
    const head = Buffer.alloc(8);
    head.write(fourcc, 0, 'ascii');
    head.writeUInt32LE(data.length, 4);
    parts.push(head, data);
    if (data.length & 1) parts.push(Buffer.alloc(1));
  }
  const body = Buffer.concat(parts);
  const out = Buffer.alloc(12);
  out.write('RIFF', 0, 'ascii');
  out.writeUInt32LE(body.length + 4, 4);
  out.write('WEBP', 8, 'ascii');
  return Buffer.concat([out, body]);
}
module.exports = { sanitizeWebp };
MSG_FILE_EOF

cat > $APP/cron.js <<'MSG_FILE_EOF'
'use strict';
// Minimal 5-field cron: minute hour day-of-month month day-of-week. Supports *, lists, ranges, steps.
const RANGES = [[0, 59], [0, 23], [1, 31], [1, 12], [0, 7]];

function parseField(src, [lo, hi]) {
  const set = new Set();
  for (const part of src.split(',')) {
    const m = /^(\*|\d+(?:-\d+)?)(?:\/(\d+))?$/.exec(part);
    if (!m) throw new Error('bad cron field: ' + src);
    const step = m[2] ? Number(m[2]) : 1;
    if (step < 1) throw new Error('bad step');
    let a, b;
    if (m[1] === '*') { a = lo; b = hi; }
    else if (m[1].includes('-')) { [a, b] = m[1].split('-').map(Number); }
    else { a = Number(m[1]); b = m[2] ? hi : a; }
    if (a < lo || b > hi || a > b) throw new Error('cron value out of range: ' + src);
    for (let v = a; v <= b; v += step) set.add(v);
  }
  return set;
}

function parse(expr) {
  const f = String(expr).trim().split(/\s+/);
  if (f.length !== 5) throw new Error('cron must have 5 fields');
  const sets = f.map((x, i) => parseField(x, RANGES[i]));
  if (sets[4].has(7)) sets[4].add(0);
  return { sets, domStar: f[2].startsWith('*'), dowStar: f[4].startsWith('*') };
}

function matches(c, d) {
  const [mi, ho, dom, mo, dow] = c.sets;
  if (!mi.has(d.getMinutes()) || !ho.has(d.getHours()) || !mo.has(d.getMonth() + 1)) return false;
  const domOk = dom.has(d.getDate());
  const dowOk = dow.has(d.getDay());
  if (c.domStar || c.dowStar) return domOk && dowOk;
  return domOk || dowOk; // classic cron: both restricted -> either
}

function nextRun(expr, from = new Date()) {
  const c = parse(expr);
  const d = new Date(from.getTime());
  d.setSeconds(0, 0);
  d.setMinutes(d.getMinutes() + 1);
  for (let i = 0; i < 366 * 24 * 60; i++) {
    if (matches(c, d)) return d;
    d.setMinutes(d.getMinutes() + 1);
  }
  return null;
}

module.exports = { parse, matches, nextRun };
MSG_FILE_EOF

cat > $APP/stats.js <<'MSG_FILE_EOF'
'use strict';
const fs = require('node:fs');
const os = require('node:os');

const KEEP = 300; // 10 minutes at 2 s
const history = [];
let prev = null;

const rd = (p) => { try { return fs.readFileSync(p, 'utf8'); } catch { return ''; } };

function cpuTimes() {
  const l = rd('/proc/stat').split('\n')[0].trim().split(/\s+/).slice(1).map(Number);
  if (l.length < 4) return null;
  return { idle: l[3] + (l[4] || 0), total: l.reduce((a, b) => a + b, 0) };
}
function mem() {
  const m = {};
  for (const line of rd('/proc/meminfo').split('\n')) {
    const x = /^(\w+):\s+(\d+)/.exec(line);
    if (x) m[x[1]] = Number(x[2]) * 1024;
  }
  const total = m.MemTotal || os.totalmem();
  const avail = m.MemAvailable !== undefined ? m.MemAvailable : os.freemem();
  return { total, used: total - avail };
}
function net() {
  let rx = 0, tx = 0;
  for (const line of rd('/proc/net/dev').split('\n').slice(2)) {
    const x = /^\s*([^:\s]+):\s*(.*)$/.exec(line);
    if (!x || x[1] === 'lo') continue;
    const f = x[2].trim().split(/\s+/).map(Number);
    rx += f[0] || 0; tx += f[8] || 0;
  }
  return { rx, tx };
}
function disk() {
  let r = 0, w = 0;
  for (const line of rd('/proc/diskstats').split('\n')) {
    const f = line.trim().split(/\s+/);
    if (f.length < 10) continue;
    if (!/^(sd[a-z]+|vd[a-z]+|xvd[a-z]+|nvme\d+n\d+|mmcblk\d+)$/.test(f[2])) continue;
    r += Number(f[5]) * 512; w += Number(f[9]) * 512;
  }
  return { r, w };
}

function sample() {
  const t = Date.now();
  const c = cpuTimes(), m = mem(), n = net(), d = disk();
  const cur = { t, c, n, d };
  if (prev) {
    const dt = Math.max(0.5, (t - prev.t) / 1000);
    let cpu = 0;
    if (c && prev.c && c.total > prev.c.total) cpu = 100 * (1 - (c.idle - prev.c.idle) / (c.total - prev.c.total));
    history.push({
      t, cpu: Math.max(0, Math.min(100, cpu)), memUsed: m.used, memTotal: m.total,
      rx: Math.max(0, (n.rx - prev.n.rx) / dt), tx: Math.max(0, (n.tx - prev.n.tx) / dt),
      dr: Math.max(0, (d.r - prev.d.r) / dt), dw: Math.max(0, (d.w - prev.d.w) / dt),
      load: os.loadavg()[0],
    });
    if (history.length > KEEP) history.shift();
  }
  prev = cur;
}

function snapshot(extra = {}) {
  let diskTotal = 0, diskFree = 0;
  try { const s = fs.statfsSync('/'); diskTotal = s.blocks * s.bsize; diskFree = s.bavail * s.bsize; } catch { }
  return {
    samples: history,
    info: {
      hostname: os.hostname(), cores: os.cpus().length, uptime: os.uptime(), diskTotal, diskFree,
      nodeRss: process.memoryUsage().rss, nodeUptime: process.uptime(), ...extra,
    },
  };
}

function start() { sample(); const t = setInterval(sample, 2000); t.unref(); }

module.exports = { start, snapshot };
MSG_FILE_EOF

cat > $APP/backup.js <<'MSG_FILE_EOF'
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const { pipeline } = require('node:stream/promises');
const { db, DATA_DIR, getSetting, setSetting } = require('./db');
const cron = require('./cron');

const DIR = path.join(DATA_DIR, 'backups');
const NAME_RE = /^db-\d{8}-\d{6}\.sqlite\.gz$/;
let running = false;

function stamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}-${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}`;
}

function config() {
  return {
    enabled: getSetting('backup_enabled', '1') === '1',
    cron: getSetting('backup_cron', '0 3 * * *'),
    keep: Number(getSetting('backup_keep', '14')),
  };
}

function saveConfig(c) {
  cron.parse(c.cron); // throws if invalid
  const keep = Math.max(1, Math.min(365, parseInt(c.keep, 10) || 14));
  setSetting('backup_enabled', c.enabled ? '1' : '0');
  setSetting('backup_cron', String(c.cron).trim());
  setSetting('backup_keep', keep);
}

function list() {
  return fs.readdirSync(DIR).filter((n) => NAME_RE.test(n)).map((name) => {
    const st = fs.statSync(path.join(DIR, name));
    return { name, size: st.size, mtime: st.mtimeMs };
  }).sort((a, b) => b.mtime - a.mtime);
}

function prune() {
  const keep = config().keep;
  for (const b of list().slice(keep)) { try { fs.unlinkSync(path.join(DIR, b.name)); } catch { } }
}

async function run() {
  if (running) throw new Error('backup_in_progress');
  running = true;
  const name = `db-${stamp()}.sqlite.gz`;
  const tmp = path.join(DIR, name + '.tmp');
  try {
    db.exec(`VACUUM INTO '${tmp.replace(/'/g, "''")}'`);
    await pipeline(fs.createReadStream(tmp), zlib.createGzip({ level: 6 }), fs.createWriteStream(path.join(DIR, name)));
    setSetting('backup_last', Date.now());
    prune();
    return name;
  } finally {
    try { fs.unlinkSync(tmp); } catch { }
    running = false;
  }
}

function resolve(name) {
  if (!NAME_RE.test(name)) return null;
  const p = path.join(DIR, name);
  return fs.existsSync(p) ? p : null;
}

function remove(name) { const p = resolve(name); if (p) fs.unlinkSync(p); return !!p; }

function nextRunTime() {
  const c = config();
  if (!c.enabled) return null;
  try { const d = cron.nextRun(c.cron); return d ? d.getTime() : null; } catch { return null; }
}

let lastMinute = '';
function startScheduler() {
  const t = setInterval(() => {
    const c = config();
    if (!c.enabled) return;
    const now = new Date();
    const key = now.toISOString().slice(0, 16);
    if (key === lastMinute) return;
    try {
      if (cron.matches(cron.parse(c.cron), now)) {
        lastMinute = key;
        run().catch((e) => console.error('scheduled backup failed:', e.message));
      }
    } catch { }
  }, 20000);
  t.unref();
}

module.exports = { config, saveConfig, list, run, resolve, remove, nextRunTime, startScheduler, isRunning: () => running };
MSG_FILE_EOF

cat > $APP/server.js <<'MSG_FILE_EOF'
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
  bumpAvatar: db.prepare('UPDATE users SET avatar_ver=avatar_ver+1 WHERE username=?'),
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
  broadcastTo(audienceOf(username), 'profile', { username, display_name: u.display_name, avatar_ver: u.avatar_ver });
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
  return { username: u.username, display_name: u.display_name || null, pubkey: u.pubkey || null, online: isOnline(u.username), avatar_ver: u.avatar_ver, ...extra };
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
    return send(res, 200, { username: user, display_name: u.display_name || null, avatar_ver: u.avatar_ver });
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
    const name = core.cleanDisplay(b.display_name);
    q.setName.run(name || null, user);
    profileChanged(user);
    return send(res, 200, { display_name: name || null });
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
MSG_FILE_EOF

cat > $APP/adminpanel.js <<'MSG_FILE_EOF'
'use strict';
const http = require('node:http');
const https = require('node:https');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { db, DATA_DIR, getSetting, setSetting, checkPassword, hashPassword } = require('./db');
const core = require('./core');
const stats = require('./stats');
const backup = require('./backup');

const HTML = fs.readFileSync(path.join(__dirname, 'admin.html'));
const sessions = new Map(); // token -> { csrf, ts }
const fails = new Map();
let gfail = { n: 0, t: 0 }; // global failed-login counter (all IPs)
const SESSION_MS = 12 * 3600 * 1000;
const NAME = /^[a-z0-9_]{2,20}$/;

const json = (res, code, obj) => {
  const b = Buffer.from(JSON.stringify(obj));
  res.writeHead(code, { 'Content-Type': 'application/json', 'Content-Length': b.length, 'Cache-Control': 'no-store' });
  res.end(b);
};
function readJson(req, limit = 65536) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', (c) => { size += c.length; if (size > limit) { reject(Object.assign(new Error('too large'), { code: 413 })); req.destroy(); } else chunks.push(c); });
    req.on('end', () => { try { resolve(JSON.parse(Buffer.concat(chunks).toString() || '{}')); } catch { reject(Object.assign(new Error('bad json'), { code: 400 })); } });
    req.on('error', reject);
  });
}
const cookie = (req, name) => {
  const m = new RegExp('(?:^|;\\s*)' + name + '=([a-f0-9]+)').exec(req.headers.cookie || '');
  return m ? m[1] : null;
};

function session(req) {
  const t = cookie(req, 'adm');
  const s = t && sessions.get(t);
  if (!s) return null;
  if (Date.now() - s.ts > SESSION_MS) { sessions.delete(t); return null; }
  return { t, s };
}

function stateDump(ctx) {
  const users = db.prepare('SELECT username, display_name, disabled, created, avatar_ver FROM users ORDER BY username').all();
  const uc = db.prepare('SELECT username, category_id FROM user_categories').all();
  const cats = db.prepare('SELECT c.id, c.name, c.gkey, (SELECT COUNT(*) FROM user_categories WHERE category_id=c.id) AS count FROM categories c ORDER BY c.id').all();
  return {
    users: users.map((u) => ({
      username: u.username, display_name: u.display_name || '', disabled: !!u.disabled, created: u.created, has_avatar: u.avatar_ver > 0,
      online: ctx.isOnline(u.username), categories: uc.filter((x) => x.username === u.username).map((x) => x.category_id),
    })),
    categories: cats,
    visibility: db.prepare('SELECT viewer, target FROM visibility').all().map((r) => [r.viewer, r.target]),
  };
}

function backupInfo() {
  const last = getSetting('backup_last');
  return { config: backup.config(), next: backup.nextRunTime(), last: last ? Number(last) : null, list: backup.list(), running: backup.isRunning() };
}

async function route(ctx, req, res, secure) {
  const url = new URL(req.url, 'http://x');
  const p = url.pathname;
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');

  if (req.method === 'GET' && (p === '/' || p === '/index.html')) {
    res.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store',
      'Content-Security-Policy': "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
    });
    return res.end(HTML);
  }
  if (!p.startsWith('/admin/api/')) return json(res, 404, { error: 'not_found' });
  const sub = p.slice('/admin/api'.length);

  if (sub === '/login' && req.method === 'POST') {
    const b = await readJson(req, 2048);
    const ip = req.socket.remoteAddress;
    const f = fails.get(ip);
    if ((f && f.n >= 5 && Date.now() - f.t < 600000) || (gfail.n >= 30 && Date.now() - gfail.t < 3600000)) return json(res, 429, { error: 'rate_limited' });
    const stored = getSetting('admin_pass');
    if (!stored) return json(res, 503, { error: 'admin_password_not_set' });
    if (typeof b.password !== 'string' || !checkPassword(b.password, stored)) {
      fails.set(ip, { n: (f && Date.now() - f.t < 600000 ? f.n : 0) + 1, t: Date.now() });
      gfail = { n: (Date.now() - gfail.t < 3600000 ? gfail.n : 0) + 1, t: Date.now() };
      await new Promise((r) => setTimeout(r, 800)); // slow down guessing
      return json(res, 401, { error: 'bad_password' });
    }
    fails.delete(ip);
    const token = crypto.randomBytes(32).toString('hex');
    const csrf = crypto.randomBytes(16).toString('hex');
    sessions.set(token, { csrf, ts: Date.now() });
    res.setHeader('Set-Cookie', `adm=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${SESSION_MS / 1000}${secure ? '; Secure' : ''}`);
    return json(res, 200, { csrf });
  }

  const ses = session(req);
  if (!ses) return json(res, 401, { error: 'unauthorized' });
  if (sub === '/session') return json(res, 200, { csrf: ses.s.csrf });
  if (req.method !== 'GET' && req.headers['x-csrf'] !== ses.s.csrf) return json(res, 403, { error: 'bad_csrf' });

  if (sub === '/logout' && req.method === 'POST') { sessions.delete(ses.t); return json(res, 200, { ok: true }); }
  if (sub === '/state' && req.method === 'GET') return json(res, 200, stateDump(ctx));

  if (sub === '/users' && req.method === 'POST') {
    const b = await readJson(req);
    try {
      const pw = core.createUser(String(b.username || '').toLowerCase(), b.display_name, Array.isArray(b.categories) ? b.categories : []);
      ctx.refreshAll();
      return json(res, 200, { password: pw });
    } catch (e) { return json(res, 400, { error: e.message }); }
  }

  let m = /^\/users\/([a-z0-9_]{2,20})\/(update|reset|delete)$/.exec(sub);
  if (m && req.method === 'POST') {
    const [, name, action] = m;
    const u = core.q.user.get(name);
    if (!u) return json(res, 404, { error: 'no_such_user' });
    if (action === 'reset') {
      const pw = core.resetPassword(name);
      ctx.kick(name);
      return json(res, 200, { password: pw });
    }
    if (action === 'delete') {
      core.deleteUser(name);
      ctx.kick(name);
      try { fs.unlinkSync(path.join(DATA_DIR, 'avatars', name + '.webp')); } catch { }
      ctx.refreshAll();
      return json(res, 200, { ok: true });
    }
    const b = await readJson(req);
    if (typeof b.display_name === 'string') db.prepare('UPDATE users SET display_name=? WHERE username=?').run(core.cleanDisplay(b.display_name) || null, name);
    if (Array.isArray(b.categories)) core.setUserCategories(name, b.categories);
    if (typeof b.disabled === 'boolean') {
      db.prepare('UPDATE users SET disabled=? WHERE username=?').run(b.disabled ? 1 : 0, name);
      if (b.disabled) { db.prepare('DELETE FROM sessions WHERE username=?').run(name); ctx.kick(name); }
    }
    ctx.profileChanged(name);
    ctx.refreshAll();
    return json(res, 200, { ok: true });
  }

  if (sub === '/categories' && req.method === 'POST') {
    const b = await readJson(req);
    try { core.createCategory(b.name); ctx.refreshAll(); return json(res, 200, { ok: true }); }
    catch (e) { return json(res, 400, { error: /UNIQUE/.test(e.message) ? 'name_exists' : e.message }); }
  }
  m = /^\/categories\/(\d+)\/(rename|delete)$/.exec(sub);
  if (m && req.method === 'POST') {
    const id = Number(m[1]);
    if (m[2] === 'delete') {
      db.prepare('DELETE FROM user_categories WHERE category_id=?').run(id);
      db.prepare('DELETE FROM categories WHERE id=?').run(id);
    } else {
      const b = await readJson(req);
      const n = core.cleanDisplay(b.name);
      if (!n) return json(res, 400, { error: 'bad_name' });
      try { db.prepare('UPDATE categories SET name=? WHERE id=?').run(n, id); }
      catch (e) { return json(res, 400, { error: 'name_exists' }); }
    }
    ctx.refreshAll();
    return json(res, 200, { ok: true });
  }

  if (sub === '/visibility/set' && req.method === 'POST') {
    const b = await readJson(req);
    if (!NAME.test(b.viewer || '') || !NAME.test(b.target || '') || b.viewer === b.target) return json(res, 400, { error: 'bad_pair' });
    if (b.on) db.prepare('INSERT OR IGNORE INTO visibility(viewer,target) VALUES(?,?)').run(b.viewer, b.target);
    else db.prepare('DELETE FROM visibility WHERE viewer=? AND target=?').run(b.viewer, b.target);
    ctx.refreshAll();
    return json(res, 200, { ok: true });
  }
  if (sub === '/visibility/preset' && req.method === 'POST') {
    const b = await readJson(req);
    db.exec('DELETE FROM visibility');
    if (b.preset === 'all') db.exec('INSERT INTO visibility(viewer,target) SELECT a.username,b.username FROM users a, users b WHERE a.username<>b.username');
    ctx.refreshAll();
    return json(res, 200, { ok: true });
  }

  if (sub === '/stats' && req.method === 'GET') {
    const files = db.prepare('SELECT COALESCE(SUM(size),0) AS s, COUNT(*) AS n FROM files').get();
    let dbBytes = 0;
    try { dbBytes = fs.statSync(path.join(DATA_DIR, 'messenger.db')).size; } catch { }
    return json(res, 200, stats.snapshot({
      online: ctx.onlineUsers().length,
      users: db.prepare('SELECT COUNT(*) AS n FROM users').get().n,
      messages: db.prepare('SELECT COUNT(*) AS n FROM messages').get().n,
      filesBytes: files.s, filesCount: files.n, dbBytes,
    }));
  }

  if (sub === '/backup' && req.method === 'GET') return json(res, 200, backupInfo());
  if (sub === '/backup/config' && req.method === 'POST') {
    const b = await readJson(req);
    try { backup.saveConfig({ enabled: !!b.enabled, cron: b.cron, keep: b.keep }); return json(res, 200, backupInfo()); }
    catch (e) { return json(res, 400, { error: e.message }); }
  }
  if (sub === '/backup/run' && req.method === 'POST') {
    try { const name = await backup.run(); return json(res, 200, { name }); }
    catch (e) { return json(res, 500, { error: e.message }); }
  }
  m = /^\/backup\/download\/([\w.\-]+)$/.exec(sub);
  if (m && req.method === 'GET') {
    const fp = backup.resolve(m[1]);
    if (!fp) return json(res, 404, { error: 'not_found' });
    const st = fs.statSync(fp);
    res.writeHead(200, { 'Content-Type': 'application/gzip', 'Content-Length': st.size, 'Content-Disposition': `attachment; filename="${m[1]}"`, 'Cache-Control': 'no-store' });
    return fs.createReadStream(fp).pipe(res);
  }
  if (sub === '/backup/delete' && req.method === 'POST') {
    const b = await readJson(req);
    return json(res, 200, { ok: backup.remove(String(b.name || '')) });
  }
  return json(res, 404, { error: 'not_found' });
}

function start(ctx, tlsOptions) {
  if (process.env.ADMIN_DISABLE === '1') return null;
  const port = +(process.env.ADMIN_PORT || 8444);
  const bind = process.env.ADMIN_BIND || '127.0.0.1';
  const secure = !!tlsOptions;
  const handler = (req, res) => {
    route(ctx, req, res, secure).catch((e) => {
      if (!res.headersSent) json(res, e.code === 413 || e.code === 400 ? e.code : 500, { error: e.message || 'error' });
      else res.destroy();
    });
  };
  const srv = secure ? https.createServer(tlsOptions, handler) : http.createServer(handler);
  srv.listen(port, bind, () => console.log(`admin panel on ${bind}:${port}`));
  setInterval(() => { const t = Date.now(); for (const [k, v] of sessions) if (t - v.ts > SESSION_MS) sessions.delete(k); }, 600000).unref();
  return srv;
}

module.exports = { start };
MSG_FILE_EOF

cat > $APP/admin.html <<'MSG_FILE_EOF'
<!doctype html>
<html lang="fa" dir="rtl">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>پنل مدیریت پیام‌رسان</title>
<style>
:root{--bg:#0f1720;--card:#17212b;--line:#243140;--text:#e8eef5;--mut:#8aa0b5;--pri:#3390ec;--red:#e5484d;--grn:#30a46c}
*{box-sizing:border-box}
body{margin:0;font-family:Tahoma,system-ui,sans-serif;background:var(--bg);color:var(--text);font-size:14px}
header{display:flex;align-items:center;gap:12px;padding:12px 18px;background:var(--card);border-bottom:1px solid var(--line);position:sticky;top:0;z-index:5}
header h1{font-size:17px;margin:0;flex:1}
nav{display:flex;gap:6px;flex-wrap:wrap;padding:12px 18px}
nav button{background:var(--card);color:var(--text);border:1px solid var(--line);padding:8px 14px;border-radius:8px;cursor:pointer}
nav button.on{background:var(--pri);border-color:var(--pri)}
main{padding:0 18px 40px;max-width:1200px;margin:0 auto}
.card{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:14px;margin-bottom:14px;overflow-x:auto}
h3{margin:0 0 10px;font-size:15px}
input[type=text],input[type=password],input[type=number],input:not([type]){background:#0f1720;color:var(--text);border:1px solid var(--line);border-radius:8px;padding:7px 9px;min-width:120px}
button{font-family:inherit}
button.pri,button.red,button.grn,button.sec{border:0;color:#fff;padding:7px 12px;border-radius:8px;cursor:pointer}
button.pri{background:var(--pri)} button.red{background:var(--red)} button.grn{background:var(--grn)} button.sec{background:#2c3b4c}
button:disabled{opacity:.5;cursor:default}
table{border-collapse:collapse;width:100%}
th,td{padding:7px 8px;border-bottom:1px solid var(--line);text-align:right;white-space:nowrap}
th{color:var(--mut);font-weight:normal}
.row{display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin-bottom:8px}
.chip{background:#0f1720;border:1px solid var(--line);border-radius:14px;padding:3px 9px;display:inline-flex;gap:4px;align-items:center;margin:2px}
.dot{display:inline-block;width:9px;height:9px;border-radius:50%;background:#556;margin-left:6px}.dot.on{background:var(--grn)}
.mut{color:var(--mut)}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(300px,1fr));gap:14px}
canvas{width:100%;height:150px;background:#0f1720;border-radius:8px;display:block}
.kv{display:flex;gap:18px;flex-wrap:wrap;margin-bottom:10px}.kv div{background:#0f1720;border:1px solid var(--line);border-radius:8px;padding:8px 12px}
.kv b{display:block;font-size:16px;margin-top:2px}
#login{max-width:340px;margin:12vh auto;text-align:center}
.err{color:#ff8b8b;min-height:20px;margin-top:8px}
.leg span{display:inline-block;margin-left:12px}.leg i{display:inline-block;width:10px;height:10px;border-radius:2px;margin-left:4px}
</style>
</head>
<body>
<div id="app"></div>
<script>
(function(){
var csrf=null,S=null,tab='users',timer=null;
var app=document.getElementById('app');

function h(tag,attrs){
  var e=document.createElement(tag);
  if(attrs)for(var k in attrs){var v=attrs[k];
    if(k==='class')e.className=v;
    else if(k.slice(0,2)==='on')e.addEventListener(k.slice(2),v);
    else if(k==='value')e.value=v;
    else if(k==='checked')e.checked=!!v;
    else if(k==='disabled')e.disabled=!!v;
    else e.setAttribute(k,v);}
  for(var i=2;i<arguments.length;i++){add(e,arguments[i]);}
  return e;
}
function add(e,c){
  if(c==null||c===false)return;
  if(Array.isArray(c)){c.forEach(function(x){add(e,x);});return;}
  e.appendChild((typeof c==='string'||typeof c==='number')?document.createTextNode(String(c)):c);
}
async function api(method,path,body){
  var r=await fetch('/admin/api'+path,{method:method,credentials:'same-origin',headers:{'Content-Type':'application/json','X-CSRF':csrf||''},body:body?JSON.stringify(body):undefined});
  var j={};try{j=await r.json();}catch(e){}
  if(!r.ok){if(r.status===401&&path!=='/login'){csrf=null;showLogin();}throw new Error(j.error||('HTTP '+r.status));}
  return j;
}
var ERR={bad_password:'رمز اشتباه است',rate_limited:'تلاش زیاد؛ ۱۰ دقیقه صبر کنید',admin_password_not_set:'رمز ادمین تنظیم نشده (msgadmin adminpw)',invalid_username:'نام کاربری نامعتبر است',user_exists:'این کاربر وجود دارد',name_exists:'این نام تکراری است',bad_name:'نام نامعتبر است',invalid_cron:'عبارت cron نامعتبر است'};
function msg(e){return ERR[e.message]||e.message;}
function fmtB(n){if(n<1024)return n.toFixed(0)+' B';if(n<1048576)return (n/1024).toFixed(1)+' KB';if(n<1073741824)return (n/1048576).toFixed(1)+' MB';return (n/1073741824).toFixed(2)+' GB';}
function fmtDur(s){s=Math.floor(s);var d=Math.floor(s/86400),hh=Math.floor(s%86400/3600),m=Math.floor(s%3600/60);return (d?d+' روز ':'')+hh+' ساعت '+m+' دقیقه';}
function fmtDate(t){return t?new Date(t).toLocaleString('fa-IR'):'—';}

function showLogin(){
  clearInterval(timer);
  var pw=h('input',{type:'password',placeholder:'رمز ادمین'}),er=h('div',{class:'err'});
  var go=async function(){er.textContent='';try{var j=await api('POST','/login',{password:pw.value});csrf=j.csrf;start();}catch(e){er.textContent=msg(e);}};
  pw.addEventListener('keydown',function(ev){if(ev.key==='Enter')go();});
  app.replaceChildren(h('div',{id:'login',class:'card'},h('h3',null,'ورود به پنل مدیریت'),pw,h('div',{style:'height:10px'}),h('button',{class:'pri',onclick:go},'ورود'),er));
}
async function start(){
  try{S=await api('GET','/state');}catch(e){return;}
  render();
}
async function reload(){S=await api('GET','/state');render();}

function render(){
  clearInterval(timer);
  var tabs=[['users','کاربران'],['cats','دسته‌ها و گروه‌ها'],['matrix','ماتریس دیده‌شدن'],['mon','منابع سرور'],['bak','پشتیبان‌گیری']];
  var nav=h('nav',null,tabs.map(function(t){return h('button',{class:t[0]===tab?'on':'',onclick:function(){tab=t[0];render();}},t[1]);}));
  var box=h('main');
  app.replaceChildren(
    h('header',null,h('h1',null,'پنل مدیریت پیام‌رسان'),h('button',{class:'sec',onclick:async function(){try{await api('POST','/logout');}catch(e){}csrf=null;showLogin();}},'خروج')),
    nav,box);
  ({users:users,cats:cats,matrix:matrix,mon:monitor,bak:backups})[tab](box);
}
function guard(fn){return async function(){try{await fn();}catch(e){alert(msg(e));}};}

// ---------------- users ----------------
function users(box){
  var un=h('input',{placeholder:'نام کاربری (a-z ، 0-9 ، _)'}),dn=h('input',{placeholder:'نام نمایشی (اختیاری)'});
  var chk={},cb=h('span');
  S.categories.forEach(function(c){var x=h('input',{type:'checkbox'});chk[c.id]=x;cb.appendChild(h('label',{class:'chip'},x,c.name));});
  box.appendChild(h('div',{class:'card'},h('h3',null,'افزودن کاربر'),h('div',{class:'row'},un,dn,cb,
    h('button',{class:'pri',onclick:guard(async function(){
      var ids=S.categories.filter(function(c){return chk[c.id].checked;}).map(function(c){return c.id;});
      var j=await api('POST','/users',{username:un.value.trim(),display_name:dn.value,categories:ids});
      prompt('رمز کاربر '+un.value.trim()+' (فقط همین یک‌بار نمایش داده می‌شود):',j.password);
      await reload();})},'ایجاد'))));
  var head=h('tr',null,h('th',null,'کاربر'),h('th',null,'نام نمایشی'),S.categories.map(function(c){return h('th',null,c.name);}),h('th',null,''));
  var rows=S.users.map(function(u){
    var name=h('input',{value:u.display_name,placeholder:'—'});
    var boxes={};
    var cells=S.categories.map(function(c){var x=h('input',{type:'checkbox',checked:u.categories.indexOf(c.id)>=0});boxes[c.id]=x;return h('td',null,x);});
    function ids(){return S.categories.filter(function(c){return boxes[c.id].checked;}).map(function(c){return c.id;});}
    return h('tr',null,
      h('td',null,h('span',{class:'dot'+(u.online?' on':'')}),u.username,u.disabled?h('span',{class:'mut'},' (غیرفعال)'):null),
      h('td',null,name),cells,
      h('td',null,
        h('button',{class:'pri',onclick:guard(async function(){await api('POST','/users/'+u.username+'/update',{display_name:name.value,categories:ids()});await reload();})},'ذخیره'),' ',
        h('button',{class:'sec',onclick:guard(async function(){if(!confirm('رمز جدید برای '+u.username+' ساخته شود؟'))return;var j=await api('POST','/users/'+u.username+'/reset');prompt('رمز جدید '+u.username+':',j.password);await reload();})},'ریست رمز'),' ',
        h('button',{class:u.disabled?'grn':'sec',onclick:guard(async function(){await api('POST','/users/'+u.username+'/update',{disabled:!u.disabled});await reload();})},u.disabled?'فعال‌سازی':'غیرفعال'),' ',
        h('button',{class:'red',onclick:guard(async function(){if(!confirm('کاربر '+u.username+' حذف شود؟'))return;await api('POST','/users/'+u.username+'/delete');await reload();})},'حذف')));
  });
  box.appendChild(h('div',{class:'card'},h('h3',null,'کاربران ('+S.users.length+')'),h('table',null,head,rows)));
}

// ---------------- categories ----------------
function cats(box){
  var nm=h('input',{placeholder:'نام دسته جدید'});
  box.appendChild(h('div',{class:'card'},h('h3',null,'هر دسته یک گروه چت است؛ فقط اعضای دسته آن گروه را می‌بینند'),h('div',{class:'row'},nm,
    h('button',{class:'pri',onclick:guard(async function(){await api('POST','/categories',{name:nm.value});await reload();})},'افزودن دسته'))));
  var rows=S.categories.map(function(c){
    var r=h('input',{value:c.name});
    var members=S.users.filter(function(u){return u.categories.indexOf(c.id)>=0;}).map(function(u){return u.username;}).join('، ');
    return h('tr',null,h('td',null,r),h('td',null,c.count),h('td',{class:'mut',style:'white-space:normal'},members||'—'),
      h('td',null,h('button',{class:'pri',onclick:guard(async function(){await api('POST','/categories/'+c.id+'/rename',{name:r.value});await reload();})},'تغییر نام'),' ',
        h('button',{class:'red',onclick:guard(async function(){if(!confirm('دسته «'+c.name+'» حذف شود؟ گروه آن برای همه بسته می‌شود.'))return;await api('POST','/categories/'+c.id+'/delete');await reload();})},'حذف')));
  });
  box.appendChild(h('div',{class:'card'},h('table',null,h('tr',null,h('th',null,'نام'),h('th',null,'اعضا'),h('th',null,'لیست اعضا'),h('th',null,'')),rows)));
}

// ---------------- visibility matrix ----------------
function matrix(box){
  var set={};S.visibility.forEach(function(p){set[p[0]+'>'+p[1]]=1;});
  box.appendChild(h('div',{class:'card'},h('h3',null,'هر سطر (کاربر) چه کسانی را می‌بیند و می‌تواند به آن‌ها پیام خصوصی بدهد'),
    h('div',{class:'mut',style:'margin-bottom:10px'},'تیک = می‌تواند گفتگو را شروع کند. اگر کسی اول به او پیام بدهد، می‌تواند جواب بدهد. اعضای یک گروه همدیگر را در همان گروه می‌بینند.'),
    h('div',{class:'row'},
      h('button',{class:'sec',onclick:guard(async function(){if(!confirm('همه همدیگر را ببینند؟'))return;await api('POST','/visibility/preset',{preset:'all'});await reload();})},'همه همدیگر را ببینند'),
      h('button',{class:'sec',onclick:guard(async function(){if(!confirm('همه تیک‌ها پاک شود؟'))return;await api('POST','/visibility/preset',{preset:'none'});await reload();})},'هیچ‌کس هیچ‌کس را نبیند'))));
  var names=S.users.map(function(u){return u.username;});
  var head=h('tr',null,h('th',null,'می‌بیند ↓ / دیده می‌شود →'),names.map(function(n){return h('th',null,n);}));
  var rows=names.map(function(v){
    return h('tr',null,h('th',null,v),names.map(function(t){
      if(t===v)return h('td',{class:'mut'},'—');
      var x=h('input',{type:'checkbox',checked:!!set[v+'>'+t]});
      x.addEventListener('change',guard(async function(){await api('POST','/visibility/set',{viewer:v,target:t,on:x.checked});}));
      return h('td',null,x);}));
  });
  box.appendChild(h('div',{class:'card'},h('table',null,head,rows)));
}

// ---------------- monitoring ----------------
function chart(cv,series,max,fmt){
  var dpr=window.devicePixelRatio||1,w=cv.clientWidth,hh=cv.clientHeight;
  cv.width=w*dpr;cv.height=hh*dpr;
  var g=cv.getContext('2d');g.scale(dpr,dpr);g.clearRect(0,0,w,hh);
  g.strokeStyle='#243140';g.lineWidth=1;
  for(var i=0;i<=4;i++){var y=Math.round((hh-1)*i/4)+.5;g.beginPath();g.moveTo(0,y);g.lineTo(w,y);g.stroke();}
  var n=series[0].data.length;
  series.forEach(function(s){
    g.strokeStyle=s.color;g.lineWidth=2;g.beginPath();
    s.data.forEach(function(v,i){var x=n<2?0:i*(w/(n-1));var y=hh-2-(Math.min(v,max)/max)*(hh-4);if(i===0)g.moveTo(x,y);else g.lineTo(x,y);});
    g.stroke();});
  g.fillStyle='#8aa0b5';g.font='11px sans-serif';g.fillText(fmt(max),4,12);g.fillText('0',4,hh-4);
}
function monitor(box){
  var kv=h('div',{class:'kv'});
  function cv(title,legend){var c=h('canvas');return {c:c,el:h('div',{class:'card'},h('h3',null,title),c,h('div',{class:'leg mut',style:'margin-top:6px'},legend))};}
  var cpu=cv('پردازنده (CPU %)',[h('span',null,h('i',{style:'background:#3390ec'}),'مصرف CPU')]);
  var mem=cv('حافظه (RAM)',[h('span',null,h('i',{style:'background:#30a46c'}),'مصرف‌شده')]);
  var net=cv('پهنای باند شبکه',[h('span',null,h('i',{style:'background:#30a46c'}),'ورودی'),h('span',null,h('i',{style:'background:#e5a03a'}),'خروجی')]);
  var dsk=cv('ورودی/خروجی دیسک',[h('span',null,h('i',{style:'background:#3390ec'}),'خواندن'),h('span',null,h('i',{style:'background:#e5484d'}),'نوشتن')]);
  box.appendChild(h('div',{class:'card'},kv));
  box.appendChild(h('div',{class:'grid'},cpu.el,mem.el,net.el,dsk.el));
  async function tick(){
    var d;try{d=await api('GET','/stats');}catch(e){return;}
    var s=d.samples,i=d.info,L=s[s.length-1]||{cpu:0,memUsed:0,memTotal:1,rx:0,tx:0,dr:0,dw:0,load:0};
    kv.replaceChildren(
      h('div',null,'CPU',h('b',null,L.cpu.toFixed(1)+'٪ ('+i.cores+' هسته)')),
      h('div',null,'RAM',h('b',null,fmtB(L.memUsed)+' / '+fmtB(L.memTotal)+' ('+(100*L.memUsed/L.memTotal).toFixed(0)+'٪)')),
      h('div',null,'دیسک',h('b',null,fmtB(i.diskTotal-i.diskFree)+' / '+fmtB(i.diskTotal)+' (آزاد '+fmtB(i.diskFree)+')')),
      h('div',null,'شبکه ↓ / ↑',h('b',null,fmtB(L.rx)+'/s  ·  '+fmtB(L.tx)+'/s')),
      h('div',null,'دیسک خواندن / نوشتن',h('b',null,fmtB(L.dr)+'/s  ·  '+fmtB(L.dw)+'/s')),
      h('div',null,'آنلاین / کل کاربران',h('b',null,i.online+' / '+i.users)),
      h('div',null,'حجم فایل‌های پیام‌رسان',h('b',null,fmtB(i.filesBytes)+' ('+i.filesCount+' فایل)')),
      h('div',null,'حجم دیتابیس',h('b',null,fmtB(i.dbBytes))),
      h('div',null,'حافظه برنامه',h('b',null,fmtB(i.nodeRss))),
      h('div',null,'زمان روشن بودن سرور',h('b',null,fmtDur(i.uptime))));
    if(!s.length)return;
    chart(cpu.c,[{data:s.map(function(x){return x.cpu;}),color:'#3390ec'}],100,function(v){return v+'%';});
    chart(mem.c,[{data:s.map(function(x){return 100*x.memUsed/x.memTotal;}),color:'#30a46c'}],100,function(v){return v+'%';});
    var nm=Math.max(10240,Math.max.apply(null,s.map(function(x){return Math.max(x.rx,x.tx);}))*1.2);
    chart(net.c,[{data:s.map(function(x){return x.rx;}),color:'#30a46c'},{data:s.map(function(x){return x.tx;}),color:'#e5a03a'}],nm,function(v){return fmtB(v)+'/s';});
    var dm=Math.max(10240,Math.max.apply(null,s.map(function(x){return Math.max(x.dr,x.dw);}))*1.2);
    chart(dsk.c,[{data:s.map(function(x){return x.dr;}),color:'#3390ec'},{data:s.map(function(x){return x.dw;}),color:'#e5484d'}],dm,function(v){return fmtB(v)+'/s';});
  }
  tick();timer=setInterval(tick,2000);
}

// ---------------- backups ----------------
async function backups(box){
  var B;try{B=await api('GET','/backup');}catch(e){return;}
  var en=h('input',{type:'checkbox',checked:B.config.enabled}),cr=h('input',{value:B.config.cron,style:'direction:ltr;width:180px'}),kp=h('input',{type:'number',value:B.config.keep,style:'width:80px'});
  box.appendChild(h('div',{class:'card'},h('h3',null,'پشتیبان‌گیری زمان‌بندی‌شده از دیتابیس'),
    h('div',{class:'row'},h('label',null,en,' فعال'),h('span',null,'زمان‌بندی (cron):'),cr,h('span',null,'نگه‌داری آخرین'),kp,h('span',null,'نسخه'),
      h('button',{class:'pri',onclick:guard(async function(){await api('POST','/backup/config',{enabled:en.checked,cron:cr.value,keep:Number(kp.value)});await render();})},'ذخیره')),
    h('div',{class:'mut'},'نمونه: «0 3 * * *» هر شب ساعت ۳ ، «*/30 * * * *» هر نیم‌ساعت ، «0 */6 * * *» هر ۶ ساعت (به ساعت سرور)'),
    h('div',{style:'margin-top:8px'},'اجرای بعدی: ',B.next?fmtDate(B.next):'—','   ·   آخرین پشتیبان: ',fmtDate(B.last))));
  var run=h('button',{class:'grn',onclick:guard(async function(){run.disabled=true;run.textContent='در حال تهیه…';try{await api('POST','/backup/run');}finally{await render();}})},'همین الان پشتیبان بگیر');
  var trs=B.list.map(function(b){
    var del=h('button',{class:'red',onclick:guard(async function(){if(!confirm('حذف شود؟'))return;await api('POST','/backup/delete',{name:b.name});await render();})},'حذف');
    var dl=h('a',{href:'/admin/api/backup/download/'+b.name,style:'color:#6cb4ff'},'دانلود');
    return h('tr',null,h('td',{style:'direction:ltr;text-align:left'},b.name),h('td',null,fmtB(b.size)),h('td',null,fmtDate(b.mtime)),h('td',null,dl,'  ',del));
  });
  var table=h('table',null,h('tr',null,h('th',null,'فایل'),h('th',null,'حجم'),h('th',null,'تاریخ'),h('th',null,'')),trs);
  box.appendChild(h('div',{class:'card'},
    h('div',{class:'row'},h('h3',{style:'margin:0;flex:1'},'پشتیبان‌ها ('+B.list.length+')'),run),
    table,
    h('div',{class:'mut',style:'margin-top:8px'},'پشتیبان فقط دیتابیس را دارد (پیام‌ها رمزشده‌اند). فایل‌های ضمیمه شامل نمی‌شوند.')));
}

(async function init(){try{var j=await api('GET','/session');csrf=j.csrf;start();}catch(e){showLogin();}})();
})();
</script>
</body>
</html>
MSG_FILE_EOF

cat > $APP/cli.js <<'MSG_FILE_EOF'
'use strict';
const { db, setSetting, hashPassword } = require('./db');
const core = require('./core');

const [, , cmd, name, ...rest] = process.argv;

function need() {
  if (!name || !core.NAME_RE.test(name) || name === 'all') {
    console.error('Username: 2-20 chars of a-z, 0-9, _ (and not "all")');
    process.exit(1);
  }
}

if (cmd === 'add') {
  need();
  try {
    const hasDefault = !!db.prepare('SELECT 1 FROM categories WHERE id=1').get();
    const pw = core.createUser(name, rest.join(' '), hasDefault ? [1] : []);
    console.log(`User: ${name}\nPassword: ${pw}\n(Shown once. Give it to the user privately.)`);
    console.log('Note: set who this user can see in the admin panel (visibility matrix).');
  } catch (e) { console.error('Error:', e.message); process.exit(1); }
} else if (cmd === 'reset') {
  need();
  try { const pw = core.resetPassword(name); console.log(`User: ${name}\nNew password: ${pw}\n(All their sessions were logged out.)`); }
  catch (e) { console.error('Error:', e.message); process.exit(1); }
} else if (cmd === 'del') {
  need();
  console.log(core.deleteUser(name) ? 'Deleted.' : 'No such user');
} else if (cmd === 'list') {
  for (const u of db.prepare('SELECT username,display_name,disabled,created FROM users ORDER BY username').all())
    console.log(u.username, u.display_name || '-', u.disabled ? '(disabled)' : '', new Date(u.created).toISOString().slice(0, 10));
} else if (cmd === 'adminpw') {
  const pw = core.genPw();
  setSetting('admin_pass', hashPassword(pw));
  console.log(`Admin panel password: ${pw}\n(Shown once. Run "msgadmin adminpw" again to reset it.)`);
} else {
  console.log('Usage: msgadmin add|reset|del <username> [display name]  |  msgadmin list  |  msgadmin adminpw');
}
MSG_FILE_EOF

# --- admin helper now points at cli.js ---
cat > /usr/local/bin/msgadmin <<'ADM'
#!/bin/bash
exec runuser -u msg -- env DATA_DIR=/opt/messenger/data /usr/bin/node --disable-warning=ExperimentalWarning /opt/messenger/app/cli.js "$@"
ADM
chmod +x /usr/local/bin/msgadmin

# --- admin panel exposure ---
mkdir -p /etc/systemd/system/messenger.service.d
case "$MODE" in
  local)
    rm -f /etc/systemd/system/messenger.service.d/admin.conf
    ufw delete allow 8444/tcp >/dev/null 2>&1 || true
    ;;
  open)
    printf '[Service]\nEnvironment=ADMIN_BIND=0.0.0.0\n' > /etc/systemd/system/messenger.service.d/admin.conf
    ufw limit 8444/tcp   # allowed from anywhere, but max ~6 new connections / 30 s per IP
    ;;
  *)
    printf '[Service]\nEnvironment=ADMIN_BIND=0.0.0.0\n' > /etc/systemd/system/messenger.service.d/admin.conf
    ufw allow from "$MODE" to any port 8444 proto tcp
    ;;
esac

chown -R msg:msg $APP /opt/messenger/data
systemctl daemon-reload
systemctl restart messenger
sleep 3

# --- first-time admin panel password ---
NEWPW=""
if [ ! -f /opt/messenger/data/.admin_pw_created ]; then
  NEWPW="$(msgadmin adminpw | head -1)"
  touch /opt/messenger/data/.admin_pw_created
  chown msg:msg /opt/messenger/data/.admin_pw_created
fi

echo
echo "=============== RESULT ==============="
echo -n "messenger service: "; systemctl is-active messenger
echo -n "health:            "; curl -sk https://127.0.0.1:8443/api/health; echo
echo "listening:"; ss -ltn | grep -E ':8443|:8444' || echo "NOT LISTENING"
echo -n "users in database: "; msgadmin list | wc -l
echo
if [ -n "$NEWPW" ]; then echo "$NEWPW"; echo "(save this password now - it is shown only once)"; else echo "Admin panel password unchanged (reset with: msgadmin adminpw)"; fi
echo
case "$MODE" in
  local) echo "Admin panel: only from the server. Use an SSH tunnel (Bitvise C2S: 127.0.0.1:8444 -> 127.0.0.1:8444), then open https://127.0.0.1:8444" ;;
  open)  echo "Admin panel: https://SERVER_IP:8444   (accept the certificate warning; open to the Internet)" ;;
  *)     echo "Admin panel: https://SERVER_IP:8444   (allowed only from $MODE)" ;;
esac
echo
echo "To roll back:  systemctl stop messenger; rm -rf /opt/messenger/app; cp -a $SAFE/app /opt/messenger/app; cp -a $SAFE/messenger.db* /opt/messenger/data/; systemctl start messenger"
