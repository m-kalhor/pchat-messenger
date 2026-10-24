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
CREATE TABLE IF NOT EXISTS contact_requests (
  from_user TEXT NOT NULL, to_user TEXT NOT NULL, status TEXT NOT NULL, ts INTEGER NOT NULL, PRIMARY KEY (from_user, to_user));
CREATE TABLE IF NOT EXISTS blocks (
  viewer TEXT NOT NULL, target TEXT NOT NULL, PRIMARY KEY (viewer, target));
CREATE TABLE IF NOT EXISTS disconnects (
  a TEXT NOT NULL, b TEXT NOT NULL, PRIMARY KEY (a, b));
CREATE TABLE IF NOT EXISTS uploads (
  id TEXT PRIMARY KEY, owner TEXT NOT NULL, size INTEGER NOT NULL, off INTEGER NOT NULL DEFAULT 0, ts INTEGER NOT NULL);
`);

// ---- idempotent migrations for databases created by the first version ----
const userCols = db.prepare('PRAGMA table_info(users)').all().map((r) => r.name);
if (!userCols.includes('display_name')) db.exec('ALTER TABLE users ADD COLUMN display_name TEXT');
if (!userCols.includes('avatar_ver')) db.exec('ALTER TABLE users ADD COLUMN avatar_ver INTEGER NOT NULL DEFAULT 0');
if (!userCols.includes('disabled')) db.exec('ALTER TABLE users ADD COLUMN disabled INTEGER NOT NULL DEFAULT 0');
if (!userCols.includes('bio')) db.exec('ALTER TABLE users ADD COLUMN bio TEXT');

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
