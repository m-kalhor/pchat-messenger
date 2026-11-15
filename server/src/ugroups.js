'use strict';
/**
 * 1.20: groups that users make themselves (Telegram-like), next to the admin's categories.
 *
 * A user group is a row of `categories` with kind='user' and the same `g:<id>` key as an admin group, so
 * sending, receipts, pins, typing, files and group calls need no change. What is new is who may do what:
 *   - owner: everything, including deleting the group and handing it to somebody else
 *   - admin: add and remove members, edit the name, photo and description, delete other people's messages,
 *            make or revoke the invite link
 *   - member: write (unless the owner set "only admins write"), react, leave
 * Each user may own at most `limit` groups and channels together (3, admin panel; a per-user value overrides
 * it, 0 = may not make any). Groups of the admin and memberships do not count.
 * Members are added directly only from the adder's own connections (never across a ⛔ of the admin matrix);
 * anyone else joins with the invite link. Somebody who was removed comes back only when an admin adds them.
 * The admin panel can freeze a group (nobody writes), hand it over, remove members or delete it.
 *
 * 1.21: channels are the same with kind='chan': only the owner and admins post, members do not see each other
 * (they are not "mates" and get only the owner/admins as the member list), no group calls, and posts are
 * sealed with a shared channel key (see chanKeys below) so a post does not grow with the member count and new
 * members can read older posts. Removing somebody moves the channel to a new key version.
 */
const crypto = require('node:crypto');
const { db, getSetting, setSetting } = require('./db');
const core = require('./core');

const DEFAULTS = { on: false, limit: 3, max_members: 200, calls: true, chan_on: false, chan_max: 1000 };

function int(key, def, min, max) {
  const n = Number(getSetting(key, String(def)));
  return Number.isFinite(n) ? Math.min(max, Math.max(min, Math.round(n))) : def;
}
function cfg() {
  return {
    on: getSetting('ugroups_on', DEFAULTS.on ? '1' : '0') === '1',
    limit: int('ugroups_limit', DEFAULTS.limit, 0, 50),
    max_members: int('ugroups_max_members', DEFAULTS.max_members, 2, 1000),
    calls: getSetting('ugroups_calls', DEFAULTS.calls ? '1' : '0') === '1',
    chan_on: getSetting('chans_on', DEFAULTS.chan_on ? '1' : '0') === '1',
    chan_max: int('chans_max_members', DEFAULTS.chan_max, 2, 5000),
  };
}
/** Saves the fields present in b (admin panel); throws Error('bad_ugroup_settings'). */
function setCfg(b) {
  const bad = () => { throw new Error('bad_ugroup_settings'); };
  const out = [];
  const bool = (k, v) => { if (typeof v !== 'boolean') bad(); out.push([k, v ? '1' : '0']); };
  const num = (k, v, min, max) => { const n = Number(v); if (!Number.isInteger(n) || n < min || n > max) bad(); out.push([k, String(n)]); };
  if (b.on !== undefined) bool('ugroups_on', b.on);
  if (b.calls !== undefined) bool('ugroups_calls', b.calls);
  if (b.limit !== undefined) num('ugroups_limit', b.limit, 0, 50);
  if (b.max_members !== undefined) num('ugroups_max_members', b.max_members, 2, 1000);
  if (b.chan_on !== undefined) bool('chans_on', b.chan_on);
  if (b.chan_max !== undefined) num('chans_max_members', b.chan_max, 2, 5000);
  for (const [k, v] of out) setSetting(k, v);
  return cfg();
}

const q = {
  cat: db.prepare('SELECT * FROM categories WHERE id=?'),
  owned: db.prepare("SELECT COUNT(*) AS n FROM categories WHERE kind IN ('user','chan') AND owner=?"),
  role: db.prepare('SELECT role FROM user_categories WHERE username=? AND category_id=?'),
  count: db.prepare('SELECT COUNT(*) AS n FROM user_categories uc JOIN users u ON u.username=uc.username WHERE uc.category_id=? AND u.disabled=0'),
  add: db.prepare("INSERT OR IGNORE INTO user_categories(username,category_id,role,joined,via) VALUES(?,?,?,?,?)"),
  remove: db.prepare('DELETE FROM user_categories WHERE username=? AND category_id=?'),
  setRole: db.prepare('UPDATE user_categories SET role=? WHERE username=? AND category_id=?'),
  roles: db.prepare('SELECT username, role, joined, via FROM user_categories WHERE category_id=? ORDER BY joined, username'),
  oldestAdmin: db.prepare("SELECT uc.username FROM user_categories uc JOIN users u ON u.username=uc.username WHERE uc.category_id=? AND uc.role='admin' AND u.disabled=0 AND uc.username<>? ORDER BY uc.joined, uc.username LIMIT 1"),
  ban: db.prepare('INSERT OR IGNORE INTO group_bans(category_id,username,ts) VALUES(?,?,?)'),
  unban: db.prepare('DELETE FROM group_bans WHERE category_id=? AND username=?'),
  banned: db.prepare('SELECT 1 FROM group_bans WHERE category_id=? AND username=?'),
  byInvite: db.prepare("SELECT * FROM categories WHERE invite=? AND kind IN ('user','chan')"),
  ownedBy: db.prepare("SELECT id FROM categories WHERE kind IN ('user','chan') AND owner=?"),
  userLimit: db.prepare('SELECT ugroup_limit FROM users WHERE username=?'),
};

const err = (code, msg) => Object.assign(new Error(msg), { code });
/** A group or channel a user made (not one of the admin's categories). */
const isUser = (g) => !!g && (g.kind === 'user' || g.kind === 'chan');
const isChan = (g) => !!g && g.kind === 'chan';
const maxOf = (g) => (isChan(g) ? cfg().chan_max : cfg().max_members);
const roleOf = (user, id) => { const r = q.role.get(user, id); return r ? r.role : null; };
const canManage = (user, g) => { const r = roleOf(user, g.id); return r === 'owner' || r === 'admin'; };
const newToken = () => crypto.randomBytes(12).toString('base64url');
const cleanAbout = (s) => String(s || '').replace(/[\u0000-\u0009\u000b-\u001f\u007f]/g, ' ').replace(/\n{3,}/g, '\n\n').trim().slice(0, 255);

/** How many groups this user may still own (their own limit from the panel, else the global one). */
function limitOf(user) {
  const r = q.userLimit.get(user);
  return r && r.ugroup_limit != null ? r.ugroup_limit : cfg().limit;
}
const ownedCount = (user) => q.owned.get(user).n;

/** A user group the caller belongs to (any role), or throws. */
function mine(user, id) {
  const g = q.cat.get(Number(id));
  if (!isUser(g) || !roleOf(user, g.id)) throw err(404, 'no_such_group');
  return g;
}
function managed(user, id) {
  const g = mine(user, id);
  if (!canManage(user, g)) throw err(403, 'not_group_admin');
  if (g.frozen) throw err(403, 'group_frozen');
  return g;
}
function owned(user, id) {
  const g = mine(user, id);
  if (roleOf(user, g.id) !== 'owner') throw err(403, 'not_group_owner');
  return g;
}

/** Can `by` put `who` into a group directly? Only people they are connected with, never across a ⛔. */
function addable(by, who) {
  if (!core.activeUser(who) || who === by) return false;
  if (core.isBlocked(by, who) || core.isCut(by, who)) return false;
  return !!core.q.vis.get(by, who) && !!core.q.vis.get(who, by);
}

function list(user, names, g, via) {
  const out = [];
  const max = maxOf(g);
  let n = q.count.get(g.id).n;
  for (const raw of names) {
    const u = String(raw || '').toLowerCase();
    if (roleOf(u, g.id)) continue;
    if (!addable(user, u)) throw Object.assign(err(403, 'cannot_add'), { detail: u });
    if (n >= max) throw err(400, 'group_full');
    out.push(u); n++;
  }
  const t = Date.now();
  for (const u of out) { q.unban.run(g.id, u); q.add.run(u, g.id, 'member', t, via || 'added:' + user); }
  return out;
}

function create(user, b) {
  const c = cfg();
  const chan = b.kind === 'chan';
  if (!(chan ? c.chan_on : c.on)) throw err(403, chan ? 'chans_off' : 'ugroups_off');
  if (ownedCount(user) >= limitOf(user)) throw err(403, 'group_limit');
  const name = core.cleanDisplay(b.name);
  if (!name) throw err(400, 'bad_name');
  const members = [...new Set((Array.isArray(b.members) ? b.members : []).map((x) => String(x).toLowerCase()))].filter((u) => u !== user);
  if (members.length + 1 > (chan ? c.chan_max : c.max_members)) throw err(400, 'group_full');
  for (const u of members) if (!addable(user, u)) throw Object.assign(err(403, 'cannot_add'), { detail: u });
  db.exec('BEGIN');
  try {
    const r = db.prepare('INSERT INTO categories(name,gkey,kind,owner,created,about,ckv,sign) VALUES(?, ?, ?, ?, ?, ?, ?, ?)')
      .run(name, 'tmp:' + newToken(), chan ? 'chan' : 'user', user, Date.now(), cleanAbout(b.about) || null, chan ? 1 : 0, chan && b.sign ? 1 : 0);
    const id = Number(r.lastInsertRowid);
    db.prepare('UPDATE categories SET gkey=? WHERE id=?').run('g:' + id, id);
    q.add.run(user, id, 'owner', Date.now(), 'created');
    const t = Date.now();
    for (const u of members) q.add.run(u, id, 'member', t, 'added:' + user);
    db.exec('COMMIT');
    return q.cat.get(id);
  } catch (e) { db.exec('ROLLBACK'); throw e; }
}

function edit(user, id, b) {
  const g = managed(user, id);
  if (b.name !== undefined) {
    const n = core.cleanDisplay(b.name);
    if (!n) throw err(400, 'bad_name');
    db.prepare('UPDATE categories SET name=? WHERE id=?').run(n, g.id);
  }
  if (b.about !== undefined) db.prepare('UPDATE categories SET about=? WHERE id=?').run(cleanAbout(b.about) || null, g.id);
  // only the owner decides who may write and whether the group has calls
  const own = roleOf(user, g.id) === 'owner';
  if (b.admins_only !== undefined) { if (!own) throw err(403, 'not_group_owner'); db.prepare('UPDATE categories SET admins_only=? WHERE id=?').run(b.admins_only ? 1 : 0, g.id); }
  if (b.call_on !== undefined) { if (!own) throw err(403, 'not_group_owner'); db.prepare('UPDATE categories SET call_on=? WHERE id=?').run(b.call_on ? 1 : 0, g.id); }
  if (b.sign !== undefined) { if (!own) throw err(403, 'not_group_owner'); db.prepare('UPDATE categories SET sign=? WHERE id=?').run(b.sign ? 1 : 0, g.id); }
  return q.cat.get(g.id);
}

function add(user, id, names) {
  const g = managed(user, id);
  return list(user, Array.isArray(names) ? names : [], g);
}

/** Removes `who` (an admin may remove members, only the owner may remove admins); they cannot rejoin by link. */
function remove(user, id, who) {
  const g = managed(user, id);
  who = String(who || '').toLowerCase();
  const r = roleOf(who, g.id);
  if (!r) throw err(404, 'not_member');
  if (r === 'owner' || who === user) throw err(400, 'cannot_remove');
  if (r === 'admin' && roleOf(user, g.id) !== 'owner') throw err(403, 'not_group_owner');
  q.remove.run(who, g.id);
  q.ban.run(g.id, who, Date.now());
  memberGone(g, who, true);
  return g;
}

/** 1.21: somebody left a channel (rotate = they were removed: later posts get a new key they never see). */
function memberGone(g, who, rotate) {
  if (!isChan(g)) return;
  db.prepare('DELETE FROM chan_keys WHERE category_id=? AND username=?').run(g.id, who);
  if (rotate) db.prepare('UPDATE categories SET ckv=ckv+1 WHERE id=?').run(g.id);
}

function setRole(user, id, who, role) {
  const g = owned(user, id);
  who = String(who || '').toLowerCase();
  if (!['admin', 'member'].includes(role)) throw err(400, 'bad_role');
  const r = roleOf(who, g.id);
  if (!r || r === 'owner') throw err(400, 'not_member');
  q.setRole.run(role, who, g.id);
  return g;
}

/** Hands the group to another member; refused when they already own as many groups as they may. */
function transfer(id, from, to, { force = false } = {}) {
  const g = q.cat.get(Number(id));
  if (!isUser(g)) throw err(404, 'no_such_group');
  to = String(to || '').toLowerCase();
  if (!roleOf(to, g.id) || !core.activeUser(to)) throw err(400, 'not_member');
  if (!force && ownedCount(to) >= limitOf(to)) throw err(403, 'their_group_limit');
  db.exec('BEGIN');
  try {
    if (from && roleOf(from, g.id)) q.setRole.run('admin', from, g.id);
    q.setRole.run('owner', to, g.id);
    db.prepare('UPDATE categories SET owner=?, frozen=0 WHERE id=?').run(to, g.id);
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); throw e; }
  return q.cat.get(g.id);
}

/**
 * The owner is gone (left, or the account was deleted): the oldest admin takes over; with no admin the
 * group is frozen and the server admin sees it in the panel to hand it to somebody.
 */
function ownerGone(g, owner) {
  const next = q.oldestAdmin.get(g.id, owner);
  if (next) { q.setRole.run('owner', next.username, g.id); db.prepare('UPDATE categories SET owner=? WHERE id=?').run(next.username, g.id); return next.username; }
  db.prepare('UPDATE categories SET owner=NULL, frozen=1 WHERE id=?').run(g.id);
  return null;
}

function leave(user, id) {
  const g = mine(user, id);
  const r = roleOf(user, g.id);
  q.remove.run(user, g.id);
  memberGone(g, user, false);
  if (r === 'owner') ownerGone(g, user);
  if (!q.count.get(g.id).n) dropGroup(g.id);
  return g;
}

/** Deletes the group and its messages (the files go with the usual file clean-up). */
function dropGroup(id) {
  const g = q.cat.get(Number(id));
  if (!isUser(g)) throw err(404, 'no_such_group');
  db.exec('BEGIN');
  try {
    db.prepare('DELETE FROM reactions WHERE msg_id IN (SELECT id FROM messages WHERE target=?)').run(g.gkey);
    db.prepare('DELETE FROM msg_history WHERE msg_id IN (SELECT id FROM messages WHERE target=?)').run(g.gkey);
    db.prepare('DELETE FROM messages WHERE target=?').run(g.gkey);
    db.prepare('DELETE FROM pins WHERE convo=?').run(g.gkey);
    db.prepare('DELETE FROM receipts WHERE convo=?').run(g.gkey);
    db.prepare('DELETE FROM user_categories WHERE category_id=?').run(g.id);
    db.prepare('DELETE FROM group_bans WHERE category_id=?').run(g.id);
    db.prepare('DELETE FROM chan_keys WHERE category_id=?').run(g.id);
    db.prepare('DELETE FROM categories WHERE id=?').run(g.id);
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); throw e; }
  return g;
}

function del(user, id) { const g = owned(user, id); dropGroup(g.id); return g; }

function invite(user, id, revoke) {
  const g = managed(user, id);
  const t = revoke ? null : newToken();
  db.prepare('UPDATE categories SET invite=? WHERE id=?').run(t, g.id);
  return t;
}

const TOKEN = /^[A-Za-z0-9_-]{12,32}$/;
/** What a link shows before joining: name, description, member count. */
function preview(user, token) {
  if (!TOKEN.test(String(token || ''))) throw err(404, 'bad_invite');
  const g = q.byInvite.get(String(token));
  if (!g || g.frozen) throw err(404, 'bad_invite');
  return { id: g.id, key: g.gkey, name: g.name, about: g.about || '', count: q.count.get(g.id).n, avatar_ver: g.avatar_ver, member: !!roleOf(user, g.id), kind: g.kind };
}
function join(user, token) {
  const p = preview(user, token);
  const g = q.cat.get(p.id);
  if (!(isChan(g) ? cfg().chan_on : cfg().on)) throw err(403, isChan(g) ? 'chans_off' : 'ugroups_off');
  if (p.member) return g;
  if (q.banned.get(p.id, user)) throw err(403, 'removed_from_group');
  if (p.count >= maxOf(g)) throw err(400, 'group_full');
  q.add.run(user, p.id, 'member', Date.now(), 'link');
  return q.cat.get(p.id);
}

/** May `user` write in this group key? Admin categories always; user groups unless frozen or admins-only. */
function canWrite(user, cat) {
  if (!isUser(cat)) return true;
  if (cat.frozen) return false;
  if (!cat.admins_only && !isChan(cat)) return true;
  return canManage(user, cat);
}

/** Group fields the apps show (on top of id/key/name/members). */
function info(user, g) {
  if (!isUser(g)) return { kind: 'cat' };
  const role = roleOf(user, g.id);
  const rows = q.roles.all(g.id);
  const manage = role === 'owner' || role === 'admin';
  return {
    kind: g.kind, role, owner: g.owner, about: g.about || '', avatar_ver: g.avatar_ver,
    admins: rows.filter((r) => r.role === 'admin' || r.role === 'owner').map((r) => r.username),
    admins_only: isChan(g) || !!g.admins_only, frozen: !!g.frozen, call_on: !isChan(g) && !!g.call_on,
    invite: manage ? g.invite || null : null,
    ...(isChan(g) ? { ckv: g.ckv, sign: !!g.sign, count: rows.length } : {}),
  };
}

/**
 * Who of the group the user may see: everybody in a group; in a channel the owner and admins see everybody,
 * members only the owner and admins (the people who post).
 */
function visibleMembers(user, g) {
  const all = core.membersOf(g.id);
  if (!isChan(g) || canManage(user, g)) return all;
  const adm = new Set(q.roles.all(g.id).filter((r) => r.role === 'admin' || r.role === 'owner').map((r) => r.username));
  return all.filter((u) => adm.has(u));
}
/** Who should reload their lists when the group changes (a channel: only its owner and admins, plus extra). */
function audienceOf(g) {
  if (!isChan(g)) return core.membersOf(g.id);
  return q.roles.all(g.id).filter((r) => r.role === 'admin' || r.role === 'owner').map((r) => r.username);
}

// ---- 1.21: the shared channel key ----
// Version v of a channel's key is made by the first owner/admin device that needs it (claim: nobody has a
// copy of v yet) and sealed for each member with ECDH(that device, member) like a message key. Other admins
// who hold v seal it for members who join later. The server checks who may store what, never the key.
const ck = {
  mine: db.prepare('SELECT kv, wrapped, by_user, by_pub, for_pub FROM chan_keys WHERE category_id=? AND username=? ORDER BY kv'),
  any: db.prepare('SELECT 1 FROM chan_keys WHERE category_id=? AND kv=? LIMIT 1'),
  has: db.prepare('SELECT for_pub FROM chan_keys WHERE category_id=? AND kv=? AND username=?'),
  kvs: db.prepare('SELECT DISTINCT kv FROM chan_keys WHERE category_id=? ORDER BY kv'),
  put: db.prepare('INSERT OR REPLACE INTO chan_keys(category_id,kv,username,wrapped,by_user,by_pub,for_pub,ts) VALUES(?,?,?,?,?,?,?,?)'),
  members: db.prepare('SELECT u.username, u.pubkey FROM user_categories uc JOIN users u ON u.username=uc.username WHERE uc.category_id=? AND u.disabled=0 AND u.pubkey IS NOT NULL'),
  sealed: db.prepare('SELECT username, for_pub FROM chan_keys WHERE category_id=? AND kv=?'),
};
const WRAP = /^[A-Za-z0-9+/]{40,200}={0,2}$/;

function chanOf(user, id) {
  const g = mine(user, id);
  if (!isChan(g)) throw err(404, 'no_such_group');
  return g;
}
/**
 * The user's copies of the channel key (every version), and for an owner/admin the members still waiting
 * for versions this admin holds (`pending`, at most 300 people a call) and whether the current version
 * still has to be made (`claim`).
 */
function chanKeys(user, id) {
  const g = chanOf(user, id);
  const keys = ck.mine.all(g.id, user);
  const out = { kv: g.ckv, keys };
  if (!canManage(user, g) || g.frozen) return out;
  out.claim = !ck.any.get(g.id, g.ckv);
  const held = keys.map((k) => k.kv);
  const pending = new Map();
  const members = ck.members.all(g.id);
  for (const kv of held) {
    const done = new Map(ck.sealed.all(g.id, kv).map((r) => [r.username, r.for_pub]));
    for (const m of members) {
      if (done.get(m.username) === m.pubkey) continue;
      let e = pending.get(m.username);
      if (!e) { if (pending.size >= 300) continue; pending.set(m.username, (e = { u: m.username, pub: m.pubkey, kvs: [] })); }
      e.kvs.push(kv);
    }
  }
  out.pending = [...pending.values()];
  return out;
}
/** Stores sealed copies: b = { kv, by_pub, wraps: [{ u, w, for_pub }] }. Returns the users who got a copy. */
function putChanKeys(user, id, b) {
  const g = managed(user, id);
  if (!isChan(g)) throw err(404, 'no_such_group');
  const kv = Number(b.kv);
  if (!Number.isInteger(kv) || kv < 1 || kv > g.ckv) throw err(400, 'bad_key_version');
  const me = core.q.user.get(user);
  if (!me.pubkey || b.by_pub !== me.pubkey) throw err(409, 'key_changed');
  const wraps = Array.isArray(b.wraps) ? b.wraps.slice(0, 1000) : [];
  const claim = !ck.any.get(g.id, kv);
  if (claim) {
    // a new version: only the current one, and the maker keeps a copy for themselves
    if (kv !== g.ckv) throw err(400, 'bad_key_version');
    if (!wraps.some((x) => x && x.u === user)) throw err(400, 'bad_keys');
  } else if (!ck.has.get(g.id, kv, user)) throw err(409, 'key_taken');
  const pubs = new Map(ck.members.all(g.id).map((r) => [r.username, r.pubkey]));
  const t = Date.now();
  const got = [];
  db.exec('BEGIN');
  try {
    if (claim && ck.any.get(g.id, kv)) throw err(409, 'key_taken');
    for (const x of wraps) {
      if (!x || typeof x.w !== 'string' || !WRAP.test(x.w)) throw err(400, 'bad_keys');
      const u = String(x.u || '');
      if (!pubs.has(u) || pubs.get(u) !== x.for_pub) continue; // left, or changed key meanwhile: asked again later
      ck.put.run(g.id, kv, u, x.w, user, me.pubkey, x.for_pub, t);
      got.push(u);
    }
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); throw e; }
  return { g, got };
}
/** A channel post must be sealed with the current key version (so a removed member cannot read it). */
function postKeyOk(g, payload) {
  if (!isChan(g)) return true;
  try { const o = JSON.parse(payload); return o && o.v === 2 && o.kv === g.ckv && typeof o.c === 'string'; } catch { return false; }
}
/** How far each member has read (no names), for the 👁 count under posts. */
function chanViews(user, id) {
  const g = chanOf(user, id);
  return db.prepare('SELECT seen FROM receipts WHERE convo=? AND seen>0 ORDER BY seen').all(g.gkey).map((r) => r.seen);
}

/** Groups the user owns (deleted account): hand each to the oldest admin or freeze it. */
function userDeleted(user) {
  for (const r of q.ownedBy.all(user)) {
    const g = q.cat.get(r.id);
    ownerGone(g, user);
    if (!q.count.get(g.id).n) dropGroup(g.id);
  }
}

// ---- admin panel ----
function adminList() {
  const rows = db.prepare(`SELECT c.*, (SELECT COUNT(*) FROM user_categories WHERE category_id=c.id) AS count,
      (SELECT COUNT(*) FROM messages WHERE target=c.gkey) AS msgs,
      (SELECT COALESCE(SUM(f.size),0) FROM files f WHERE f.id IN (SELECT file_id FROM messages WHERE target=c.gkey AND file_id IS NOT NULL)) AS bytes,
      (SELECT MAX(ts) FROM messages WHERE target=c.gkey) AS last
    FROM categories c WHERE c.kind IN ('user','chan') ORDER BY c.id`).all();
  return rows.map((g) => ({
    id: g.id, key: g.gkey, kind: g.kind, name: g.name, about: g.about || '', owner: g.owner, created: g.created, count: g.count, msgs: g.msgs,
    bytes: g.bytes, last: g.last, frozen: !!g.frozen, admins_only: !!g.admins_only, call_on: !!g.call_on, invite: !!g.invite,
    ...(g.kind === 'chan' ? { ckv: g.ckv, sign: !!g.sign } : {}),
  }));
}
function adminMembers(id) {
  const g = q.cat.get(Number(id));
  if (!isUser(g)) throw err(404, 'no_such_group');
  return q.roles.all(g.id).map((r) => ({ ...r, banned: false }))
    .concat(db.prepare('SELECT username, ts FROM group_bans WHERE category_id=?').all(g.id).map((r) => ({ username: r.username, role: null, joined: r.ts, via: null, banned: true })));
}
function adminAdd(id, names, category) {
  const g = q.cat.get(Number(id));
  if (!isUser(g)) throw err(404, 'no_such_group');
  let list2 = Array.isArray(names) ? names.map((x) => String(x).toLowerCase()) : [];
  if (category) list2 = list2.concat(core.membersOf(Number(category)));
  const t = Date.now();
  let n = 0;
  for (const u of new Set(list2)) {
    if (!core.activeUser(u) || roleOf(u, g.id)) continue;
    q.unban.run(g.id, u); q.add.run(u, g.id, 'member', t, 'panel'); n++;
  }
  return n;
}
function adminRemove(id, who, ban) {
  const g = q.cat.get(Number(id));
  if (!isUser(g)) throw err(404, 'no_such_group');
  who = String(who || '').toLowerCase();
  const r = roleOf(who, g.id);
  if (r) { q.remove.run(who, g.id); memberGone(g, who, ban !== false); if (r === 'owner') ownerGone(g, who); }
  if (ban === false) q.unban.run(g.id, who); else if (r) q.ban.run(g.id, who, Date.now());
  return g;
}
function adminRole(id, who, role) {
  const g = q.cat.get(Number(id));
  if (!isUser(g)) throw err(404, 'no_such_group');
  if (role === 'owner') return transfer(g.id, g.owner, who, { force: true });
  if (!['admin', 'member'].includes(role)) throw err(400, 'bad_role');
  const r = roleOf(String(who), g.id);
  if (!r || r === 'owner') throw err(400, 'not_member');
  q.setRole.run(role, String(who), g.id);
  return g;
}
function adminFreeze(id, on) {
  const g = q.cat.get(Number(id));
  if (!isUser(g)) throw err(404, 'no_such_group');
  db.prepare('UPDATE categories SET frozen=? WHERE id=?').run(on ? 1 : 0, g.id);
  return g;
}
function setUserLimit(user, v) {
  if (!core.q.user.get(user)) throw err(404, 'no_such_user');
  if (v === null || v === '') { db.prepare('UPDATE users SET ugroup_limit=NULL WHERE username=?').run(user); return; }
  const n = Number(v);
  if (!Number.isInteger(n) || n < 0 || n > 50) throw err(400, 'bad_limit');
  db.prepare('UPDATE users SET ugroup_limit=? WHERE username=?').run(n, user);
}
function userLimits() {
  const own = new Map(db.prepare("SELECT owner, COUNT(*) AS n FROM categories WHERE kind IN ('user','chan') AND owner IS NOT NULL GROUP BY owner").all().map((r) => [r.owner, r.n]));
  return db.prepare('SELECT username, ugroup_limit FROM users').all().map((r) => ({ username: r.username, owned: own.get(r.username) || 0, limit: r.ugroup_limit }));
}

module.exports = {
  DEFAULTS, cfg, setCfg, limitOf, ownedCount, roleOf, canManage, isUser, isChan, canWrite, info, visibleMembers, audienceOf,
  chanKeys, putChanKeys, postKeyOk, chanViews,
  create, edit, add, remove, setRole, transfer, leave, del, dropGroup, invite, preview, join, userDeleted, mine, managed, owned,
  adminList, adminMembers, adminAdd, adminRemove, adminRole, adminFreeze, setUserLimit, userLimits,
};
