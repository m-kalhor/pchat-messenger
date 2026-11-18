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
  reqIn: db.prepare('SELECT from_user AS u, status FROM contact_requests WHERE to_user=?'),
  reqOut: db.prepare('SELECT to_user AS u, status FROM contact_requests WHERE from_user=?'),
  // 1.21: members of a channel do not see each other
  mates: db.prepare("SELECT DISTINCT b.username AS u FROM user_categories a JOIN user_categories b ON a.category_id=b.category_id JOIN categories c ON c.id=a.category_id WHERE a.username=? AND b.username<>? AND c.kind<>'chan'"),
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
  // 1.7 message requests between people who are not connected: req 'in' (open, to me), 'declined' (I declined
  // it, still acceptable), 'out' (mine, waiting; a decline is not shown). A request I blocked hides its sender.
  const linked = (o) => !!q.vis.get(username, o) && !!q.vis.get(o, username);
  for (const r of q.reqIn.all(username)) {
    if (linked(r.u) || isBlocked(username, r.u)) continue;
    if (r.status === 'blocked') { const e = m.get(r.u); if (e && e.dm) { if (q.mates.all(username, username).some((x) => x.u === r.u)) m.set(r.u, { dm: false }); else m.delete(r.u); } continue; }
    m.set(r.u, { dm: true, req: r.status === 'declined' ? 'declined' : 'in' });
  }
  for (const r of q.reqOut.all(username)) {
    if (linked(r.u) || isBlocked(username, r.u) || (m.has(r.u) && m.get(r.u).req)) continue;
    m.set(r.u, { dm: true, req: 'out' });
  }
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

/* global __SEPAN_PACKAGED__, __SEPAN_K2__, __SEPAN_M2__ */
/**
 * 1.25: a second, independent look at the activation code of the packaged server (see license.js) before
 * a new account is made: a genuine code must be present and its user limit not reached. Nothing in the source tree.
 */
function seatOk() {
  if (typeof __SEPAN_PACKAGED__ === 'undefined' || __SEPAN_PACKAGED__ !== true) return true;
  try {
    const nc = require('node:crypto');
    const code = require('node:fs').readFileSync(process.env.LICENSE_FILE || require('node:path').join(process.env.DATA_DIR || '/opt/messenger/data', 'license.txt'), 'utf8').trim().split('.');
    const raw = Buffer.from(__SEPAN_K2__.map((x, i) => x ^ __SEPAN_M2__[(i * 7 + 3) % __SEPAN_M2__.length]));
    const key = nc.createPublicKey({ key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), raw]), format: 'der', type: 'spki' });
    if (code.length !== 3 || !nc.verify(null, Buffer.from(code[0] + '.' + code[1]), key, Buffer.from(code[2], 'base64url'))) return false;
    const lic = JSON.parse(Buffer.from(code[1], 'base64url').toString('utf8'));
    if (lic.exp && Date.now() > lic.exp) return false;
    const max = +lic.users || 0;
    return !max || db.prepare('SELECT COUNT(*) AS n FROM users').get().n < max;
  } catch { return false; }
}

function createUser(username, display, catIds) {
  if (!NAME_RE.test(username) || username === 'all') throw new Error('invalid_username');
  if (q.user.get(username)) throw new Error('user_exists');
  if (!seatOk()) throw new Error('user_limit');
  const pw = genPw();
  db.prepare('INSERT INTO users(username,pass,display_name,created) VALUES(?,?,?,?)').run(username, hashPassword(pw), cleanDisplay(display) || null, Date.now());
  setUserCategories(username, catIds || []);
  return pw;
}

/** The admin's categories of a user (1.20: groups users made themselves are left alone). */
function setUserCategories(username, catIds) {
  db.prepare("DELETE FROM user_categories WHERE username=? AND category_id IN (SELECT id FROM categories WHERE kind='cat')").run(username);
  const ins = db.prepare("INSERT OR IGNORE INTO user_categories(username,category_id,joined,via) SELECT ?, id, ?, 'panel' FROM categories WHERE id=? AND kind='cat'");
  for (const id of catIds) ins.run(username, Date.now(), Number(id));
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
  db.prepare('DELETE FROM receipts WHERE username=?').run(username);
  db.prepare('DELETE FROM push_subs WHERE username=?').run(username);
  return db.prepare('DELETE FROM users WHERE username=?').run(username).changes > 0;
}

/** 1.20: names of the admin's categories stay unique (user groups may repeat names). */
function catNameTaken(name, exceptId = 0) {
  return !!db.prepare("SELECT 1 FROM categories WHERE kind='cat' AND name=? AND id<>?").get(name, exceptId);
}

function createCategory(name) {
  const n = cleanDisplay(name);
  if (!n) throw new Error('bad_name');
  if (catNameTaken(n)) throw new Error('UNIQUE name');
  const r = db.prepare("INSERT INTO categories(name,gkey) VALUES(?, 'tmp')").run(n);
  const id = Number(r.lastInsertRowid);
  db.prepare('UPDATE categories SET gkey=? WHERE id=?').run('g:' + id, id);
  return id;
}

module.exports = {
  NAME_RE, q, activeUser, isBlocked, isCut, pairKey, groupsOf, membersOf, isMember, groupByKey, canDM, contacts, convoKey,
  genPw, cleanDisplay, cleanBio, createUser, setUserCategories, resetPassword, deleteUser, createCategory, catNameTaken,
};
