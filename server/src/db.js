'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
for (const d of ['files', 'uploads', 'avatars', 'backups', 'apk']) fs.mkdirSync(path.join(DATA_DIR, d), { recursive: true });

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
CREATE TABLE IF NOT EXISTS contact_requests (
  from_user TEXT NOT NULL, to_user TEXT NOT NULL, status TEXT NOT NULL, ts INTEGER NOT NULL, PRIMARY KEY (from_user, to_user));
CREATE TABLE IF NOT EXISTS blocks (
  viewer TEXT NOT NULL, target TEXT NOT NULL, PRIMARY KEY (viewer, target));
CREATE TABLE IF NOT EXISTS disconnects (
  a TEXT NOT NULL, b TEXT NOT NULL, PRIMARY KEY (a, b));
CREATE TABLE IF NOT EXISTS msg_changes (
  seq INTEGER PRIMARY KEY AUTOINCREMENT, msg_id INTEGER NOT NULL, kind TEXT NOT NULL, ts INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS msg_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT, msg_id INTEGER NOT NULL, payload TEXT NOT NULL, ts INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS idx_hist_msg ON msg_history(msg_id);
CREATE TABLE IF NOT EXISTS uploads (
  id TEXT PRIMARY KEY, owner TEXT NOT NULL, size INTEGER NOT NULL, off INTEGER NOT NULL DEFAULT 0, ts INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS receipts (
  username TEXT NOT NULL, convo TEXT NOT NULL, delivered INTEGER NOT NULL DEFAULT 0, seen INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (username, convo));
CREATE INDEX IF NOT EXISTS idx_rcpt_convo ON receipts(convo);
CREATE TABLE IF NOT EXISTS reactions (
  msg_id INTEGER NOT NULL, username TEXT NOT NULL, emoji TEXT, seq INTEGER NOT NULL, PRIMARY KEY (msg_id, username));
CREATE INDEX IF NOT EXISTS idx_react_seq ON reactions(seq);
CREATE TABLE IF NOT EXISTS login_codes (
  id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT NOT NULL, kind TEXT NOT NULL, code TEXT NOT NULL,
  expires INTEGER NOT NULL, tries INTEGER NOT NULL DEFAULT 0, created INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS idx_codes_user ON login_codes(username);
CREATE TABLE IF NOT EXISTS push_subs (
  endpoint TEXT PRIMARY KEY, username TEXT NOT NULL, th TEXT NOT NULL, p256dh TEXT NOT NULL, auth TEXT NOT NULL, ts INTEGER NOT NULL);
`);

// ---- idempotent migrations for databases created by the first version ----
const userCols = db.prepare('PRAGMA table_info(users)').all().map((r) => r.name);
if (!userCols.includes('display_name')) db.exec('ALTER TABLE users ADD COLUMN display_name TEXT');
if (!userCols.includes('avatar_ver')) db.exec('ALTER TABLE users ADD COLUMN avatar_ver INTEGER NOT NULL DEFAULT 0');
if (!userCols.includes('disabled')) db.exec('ALTER TABLE users ADD COLUMN disabled INTEGER NOT NULL DEFAULT 0');
if (!userCols.includes('bio')) db.exec('ALTER TABLE users ADD COLUMN bio TEXT');
if (!userCols.includes('key_backup')) db.exec('ALTER TABLE users ADD COLUMN key_backup TEXT');
if (!userCols.includes('phone')) db.exec('ALTER TABLE users ADD COLUMN phone TEXT');
if (!userCols.includes('last_seen')) db.exec('ALTER TABLE users ADD COLUMN last_seen INTEGER');
if (!userCols.includes('hide_seen')) db.exec('ALTER TABLE users ADD COLUMN hide_seen INTEGER NOT NULL DEFAULT 0');
if (!userCols.includes('findable')) db.exec('ALTER TABLE users ADD COLUMN findable INTEGER NOT NULL DEFAULT 1');
if (!userCols.includes('hide_last_seen')) db.exec('ALTER TABLE users ADD COLUMN hide_last_seen INTEGER NOT NULL DEFAULT 0');
if (!userCols.includes('allow_requests')) db.exec('ALTER TABLE users ADD COLUMN allow_requests INTEGER NOT NULL DEFAULT 1');
// 1.7 message requests: a stranger's first messages (msgs) and missed calls ride on the connection request
const reqCols = db.prepare('PRAGMA table_info(contact_requests)').all().map((r) => r.name);
if (!reqCols.includes('msgs')) db.exec('ALTER TABLE contact_requests ADD COLUMN msgs INTEGER NOT NULL DEFAULT 0');
if (!reqCols.includes('calls')) db.exec('ALTER TABLE contact_requests ADD COLUMN calls INTEGER NOT NULL DEFAULT 0');
if (!reqCols.includes('last_call')) db.exec('ALTER TABLE contact_requests ADD COLUMN last_call INTEGER');
const sessCols = db.prepare('PRAGMA table_info(sessions)').all().map((r) => r.name);
if (!sessCols.includes('via')) db.exec("ALTER TABLE sessions ADD COLUMN via TEXT NOT NULL DEFAULT 'password'");
if (!sessCols.includes('device')) db.exec('ALTER TABLE sessions ADD COLUMN device TEXT');
const msgCols = db.prepare('PRAGMA table_info(messages)').all().map((r) => r.name);
if (!msgCols.includes('edited')) db.exec('ALTER TABLE messages ADD COLUMN edited INTEGER');
if (!msgCols.includes('deleted')) db.exec('ALTER TABLE messages ADD COLUMN deleted INTEGER NOT NULL DEFAULT 0');
// 1.22: a sticker sent with the full-screen effect (outside the E2E payload so the server can rate-limit it)
if (!msgCols.includes('fx')) db.exec('ALTER TABLE messages ADD COLUMN fx INTEGER NOT NULL DEFAULT 0');
db.exec('CREATE INDEX IF NOT EXISTS idx_msg_file ON messages(file_id)');

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

// 1.3: who-can-reach-whom is two-way. A one-way ⛔ closes the pair both ways; a one-way ✓ is opened
// both ways (unless the pair is closed).
if (getSetting('migrated_v13_links') !== '1') {
  db.exec('BEGIN');
  db.exec('INSERT OR IGNORE INTO blocks(viewer,target) SELECT target,viewer FROM blocks');
  db.exec('DELETE FROM visibility WHERE EXISTS (SELECT 1 FROM blocks b WHERE b.viewer=visibility.viewer AND b.target=visibility.target)');
  db.exec('INSERT OR IGNORE INTO visibility(viewer,target) SELECT target,viewer FROM visibility');
  setSetting('migrated_v13_links', '1');
  db.exec('COMMIT');
}

// 1.20: groups that users make themselves live in the same table as the admin's categories (same `g:<id>`
// keys, so messages, receipts, pins and group calls work unchanged), marked kind='user'. Their names need not
// be unique, so the table is rebuilt once without UNIQUE(name); the admin's own categories stay unique in code.
const catCols = db.prepare('PRAGMA table_info(categories)').all().map((r) => r.name);
if (!catCols.includes('kind')) {
  db.exec('BEGIN');
  try {
    db.exec(`CREATE TABLE categories_v20 (
      id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, gkey TEXT UNIQUE NOT NULL,
      kind TEXT NOT NULL DEFAULT 'cat', owner TEXT, created INTEGER, about TEXT,
      avatar_ver INTEGER NOT NULL DEFAULT 0, invite TEXT, admins_only INTEGER NOT NULL DEFAULT 0,
      frozen INTEGER NOT NULL DEFAULT 0, call_on INTEGER NOT NULL DEFAULT 1)`);
    db.exec('INSERT INTO categories_v20(id,name,gkey) SELECT id,name,gkey FROM categories');
    // never hand out the id (and so the g:<id> key) of a deleted category again: its old messages may remain
    const seqRow = db.prepare("SELECT seq FROM sqlite_sequence WHERE name='categories'").get();
    const usedRow = db.prepare("SELECT MAX(CAST(substr(target,3) AS INTEGER)) AS m FROM messages WHERE target GLOB 'g:[0-9]*'").get();
    const seq = Math.max(seqRow ? Number(seqRow.seq) : 0, usedRow && usedRow.m ? Number(usedRow.m) : 0);
    db.exec('DROP TABLE categories');
    db.exec('ALTER TABLE categories_v20 RENAME TO categories');
    if (seq > 0) {
      db.prepare("DELETE FROM sqlite_sequence WHERE name='categories'").run();
      db.prepare("INSERT INTO sqlite_sequence(name,seq) VALUES('categories',?)").run(Math.max(seq, Number(db.prepare('SELECT COALESCE(MAX(id),0) AS m FROM categories').get().m)));
    }
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); throw e; }
}
db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_cat_invite ON categories(invite) WHERE invite IS NOT NULL");
db.exec('CREATE INDEX IF NOT EXISTS idx_cat_owner ON categories(owner)');
const ucCols = db.prepare('PRAGMA table_info(user_categories)').all().map((r) => r.name);
if (!ucCols.includes('role')) db.exec("ALTER TABLE user_categories ADD COLUMN role TEXT NOT NULL DEFAULT 'member'");
if (!ucCols.includes('joined')) db.exec('ALTER TABLE user_categories ADD COLUMN joined INTEGER');
if (!ucCols.includes('via')) db.exec('ALTER TABLE user_categories ADD COLUMN via TEXT');
db.exec('CREATE INDEX IF NOT EXISTS idx_uc_cat ON user_categories(category_id)');
db.exec('CREATE TABLE IF NOT EXISTS group_bans (category_id INTEGER NOT NULL, username TEXT NOT NULL, ts INTEGER NOT NULL, PRIMARY KEY (category_id, username))');
if (!db.prepare('PRAGMA table_info(users)').all().some((r) => r.name === 'ugroup_limit')) db.exec('ALTER TABLE users ADD COLUMN ugroup_limit INTEGER');

// 1.21: channels (kind='chan') are encrypted with a shared channel key. `ckv` is the key's current version
// (it goes up when somebody is removed); chan_keys holds the key of each version sealed for each member by an
// owner/admin device (by_pub = that device's public key, for_pub = the member's key it was sealed for).
// The server never sees the key itself. `sign` = show the author's name under posts.
const catCols21 = db.prepare('PRAGMA table_info(categories)').all().map((r) => r.name);
if (!catCols21.includes('ckv')) db.exec('ALTER TABLE categories ADD COLUMN ckv INTEGER NOT NULL DEFAULT 0');
if (!catCols21.includes('sign')) db.exec('ALTER TABLE categories ADD COLUMN sign INTEGER NOT NULL DEFAULT 0');
db.exec(`CREATE TABLE IF NOT EXISTS chan_keys (
  category_id INTEGER NOT NULL, kv INTEGER NOT NULL, username TEXT NOT NULL, wrapped TEXT NOT NULL,
  by_user TEXT NOT NULL, by_pub TEXT NOT NULL, for_pub TEXT NOT NULL, ts INTEGER NOT NULL,
  PRIMARY KEY (category_id, kv, username))`);

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
