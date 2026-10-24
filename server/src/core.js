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
  blocked: db.prepare('SELECT 1 FROM blocks WHERE (viewer=? AND target=?) OR (viewer=? AND target=?)'),
  cut: db.prepare('SELECT 1 FROM disconnects WHERE a=? AND b=?'),
  mates: db.prepare('SELECT DISTINCT b.username AS u FROM user_categories a JOIN user_categories b ON a.category_id=b.category_id WHERE a.username=? AND b.username<>?'),
};

const activeUser = (name) => { const u = q.user.get(name); return u && !u.disabled ? u : null; };
const groupsOf = (username) => q.groupsOf.all(username);
const membersOf = (catId) => q.members.all(catId).map((r) => r.username);
const isMember = (username, catId) => !!q.isMember.get(username, catId);
const groupByKey = (gkey) => q.catByKey.get(gkey);

const pairKey = (a, b) => (a < b ? [a, b] : [b, a]);
/** The admin closed this pair in the matrix (⛔): no chat and no connection requests, in either direction. */
const isBlocked = (a, b) => !!q.blocked.get(a, b, b, a);
/** One of the two removed the connection themselves; earlier messages no longer allow replying. */
const isCut = (a, b) => !!q.cut.get(...pairKey(a, b));

/** A may start (visibility matrix) or answer (B already wrote to A) a private chat with B. */
function canDM(a, b) {
  if (a === b || !activeUser(b)) return false;
  if (q.vis.get(a, b)) return true;
  return !!q.hasMsg.get(b, a) && !isBlocked(a, b) && !isCut(a, b);
}

/** Everyone `username` is allowed to know about: matrix contacts, people who wrote to them, group mates. */
function contacts(username) {
  const m = new Map();
  for (const r of q.visList.all(username)) m.set(r.target, { dm: true });
  for (const r of q.priorSenders.all(username)) if (!m.has(r.sender) && !isBlocked(username, r.sender) && !isCut(username, r.sender)) m.set(r.sender, { dm: true });
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

/** Profile bio: up to 70 characters (like Telegram), one line breaks allowed at most as a space. */
function cleanBio(s) {
  return String(s || '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 70);
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
  db.prepare('DELETE FROM blocks WHERE viewer=? OR target=?').run(username, username);
  db.prepare('DELETE FROM disconnects WHERE a=? OR b=?').run(username, username);
  db.prepare('DELETE FROM contact_requests WHERE from_user=? OR to_user=?').run(username, username);
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
  NAME_RE, q, activeUser, isBlocked, isCut, pairKey, groupsOf, membersOf, isMember, groupByKey, canDM, contacts, convoKey,
  genPw, cleanDisplay, cleanBio, createUser, setUserCategories, resetPassword, deleteUser, createCategory,
};
