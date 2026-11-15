'use strict';
// 1.20: groups users make themselves — the panel switch, the limit of 3, who may be added, roles, invite links,
// "only admins write", moderation, leaving, the owner leaving, deleting, and the admin panel tab.
const test = require('node:test');
const assert = require('node:assert/strict');
const net = require('node:net');
const path = require('node:path');
const { startServer } = require('./helpers/server');

const freePort = () => new Promise((resolve) => { const s = net.createServer().listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); }); });

let S, base, cookie = '', csrf = '', T = {}, cat;

async function adm(method, p, body) {
  const r = await fetch(base + '/admin/api' + p, { method, headers: { 'content-type': 'application/json', cookie, 'x-csrf': csrf }, body: body ? JSON.stringify(body) : undefined });
  const set = r.headers.get('set-cookie');
  if (set) cookie = set.split(';')[0];
  return { status: r.status, data: await r.json() };
}
const ug = (who, op, body) => S.api(T[who], 'POST', '/api/ugroups' + op, body);
const link = (a, b) => S.db.prepare('INSERT OR IGNORE INTO visibility(viewer,target) VALUES(?,?),(?,?)').run(a, b, b, a);
const groupsOf = async (who) => (await S.api(T[who], 'GET', '/api/groups')).data;

test.before(async () => {
  const port = await freePort();
  S = await startServer({ ADMIN_DISABLE: '0', ADMIN_PORT: String(port), PUBLIC_HOST: '203.0.113.5' });
  base = `http://127.0.0.1:${port}`;
  const { setSetting, hashPassword } = require(path.join(S.app.appDir, 'db.js'));
  setSetting('admin_pass', hashPassword('first-pass-1'));
  csrf = (await adm('POST', '/login', { username: 'admin', password: 'first-pass-1' })).data.csrf;
  cat = S.core.createCategory('کارمندان');
  for (const n of ['ali', 'bob', 'cy', 'dan', 'eve', 'fay']) T[n] = await S.user(n, [cat]);
  T.zed = await S.user('zed'); // connected to nobody
  link('ali', 'bob'); link('ali', 'cy'); link('ali', 'dan'); link('ali', 'eve'); link('bob', 'fay'); link('eve', 'dan');
  S.db.prepare("INSERT INTO blocks(viewer,target) VALUES('ali','fay'),('fay','ali')").run();
});
test.after(() => S && S.stop());

let G; // ali's group

test('off by default: nobody can make a group until the admin turns it on', async () => {
  const me = await S.api(T.ali, 'GET', '/api/me');
  assert.equal(me.data.ugroups.on, false);
  assert.equal(me.data.ugroups.limit, 3);
  const r = await ug('ali', '/create', { name: 'دوستان', members: ['bob'] });
  assert.equal(r.status, 403);
  assert.equal(r.data.error, 'ugroups_off');
  const s = await adm('POST', '/ugroups/settings', { on: true });
  assert.equal(s.status, 200);
  assert.equal(s.data.cfg.on, true);
  assert.equal((await adm('POST', '/ugroups/settings', { limit: -1 })).status, 400);
});

test('a user makes a group with people they are connected to; the members see it with roles', async () => {
  assert.equal((await ug('ali', '/create', { name: 'x', members: ['zed'] })).data.error, 'cannot_add');
  assert.equal((await ug('ali', '/create', { name: 'x', members: ['fay'] })).data.error, 'cannot_add'); // ⛔ in the matrix
  const r = await ug('ali', '/create', { name: 'دوستان', about: 'گروه ما', members: ['bob', 'cy'] });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  G = r.data.group;
  assert.match(G.key, /^g:\d+$/);
  assert.equal(G.kind, 'user');
  assert.equal(G.role, 'owner');
  assert.deepEqual(G.members.sort(), ['ali', 'bob', 'cy']);
  const bg = (await groupsOf('bob')).find((g) => g.key === G.key);
  assert.equal(bg.role, 'member');
  assert.equal(bg.owner, 'ali');
  assert.equal(bg.about, 'گروه ما');
  assert.equal(bg.invite, null);
  assert.ok(!(await groupsOf('dan')).some((g) => g.key === G.key));
  // the admin's categories tab does not list it, and saving a user's categories keeps their groups
  const st = await adm('GET', '/state');
  assert.ok(!st.data.categories.some((c) => c.gkey === G.key));
  assert.equal((await adm('POST', '/users/bob/update', { categories: [cat] })).status, 200);
  assert.ok((await groupsOf('bob')).some((g) => g.key === G.key));
});

test('members write; group names may repeat; an admin category name stays unique', async () => {
  const s = await S.api(T.bob, 'POST', '/api/send', { target: G.key, kind: 'text', payload: '{"v":1}' });
  assert.equal(s.status, 200);
  assert.equal((await S.api(T.dan, 'POST', '/api/send', { target: G.key, kind: 'text', payload: 'x' })).status, 403);
  const r = await ug('bob', '/create', { name: 'دوستان', members: ['fay'] });
  assert.equal(r.status, 200);
  await ug('bob', '/' + r.data.group.id + '/delete', {});
  assert.equal((await adm('POST', '/categories', { name: 'کارمندان' })).data.error, 'name_exists');
});

test('only owner/admins manage; the owner names admins; "only admins write"', async () => {
  assert.equal((await ug('bob', '/' + G.id + '/add', { users: ['fay'] })).data.error, 'not_group_admin');
  assert.equal((await ug('ali', '/' + G.id + '/role', { user: 'bob', role: 'admin' })).status, 200);
  const add = await ug('bob', '/' + G.id + '/add', { users: ['fay'] });
  assert.equal(add.status, 200, JSON.stringify(add.data));
  assert.ok(add.data.group.members.includes('fay'));
  assert.equal((await ug('bob', '/' + G.id + '/edit', { admins_only: true })).data.error, 'not_group_owner');
  assert.equal((await ug('ali', '/' + G.id + '/edit', { admins_only: true, name: 'دوستان قدیمی' })).status, 200);
  const w = await S.api(T.cy, 'POST', '/api/send', { target: G.key, kind: 'text', payload: 'x' });
  assert.equal(w.status, 403);
  assert.equal(w.data.error, 'admins_only');
  assert.equal((await S.api(T.bob, 'POST', '/api/send', { target: G.key, kind: 'text', payload: 'x' })).status, 200);
  await ug('ali', '/' + G.id + '/edit', { admins_only: false });
  // pins: admins only in a user group
  const m = await S.api(T.cy, 'POST', '/api/send', { target: G.key, kind: 'text', payload: 'cy' });
  assert.equal((await S.api(T.cy, 'POST', '/api/pin', { target: G.key, messageId: m.data.id })).status, 403);
  assert.equal((await S.api(T.bob, 'POST', '/api/pin', { target: G.key, messageId: m.data.id })).status, 200);
  // an admin deletes someone else's message, but cannot edit it
  assert.equal((await S.api(T.bob, 'POST', '/api/edit', { id: m.data.id, payload: 'y' })).status, 404);
  assert.equal((await S.api(T.bob, 'POST', '/api/delete', { id: m.data.id })).status, 200);
  // a plain member cannot delete other people's messages
  const m2 = await S.api(T.bob, 'POST', '/api/send', { target: G.key, kind: 'text', payload: 'b' });
  assert.equal((await S.api(T.cy, 'POST', '/api/delete', { id: m2.data.id })).status, 404);
});

test('invite link: preview, join, a removed member cannot rejoin by link, revoke', async () => {
  const inv = await ug('ali', '/' + G.id + '/invite', {});
  assert.equal(inv.status, 200);
  const l = inv.data.group.invite_link;
  assert.match(l, /^https:\/\/203\.0\.113\.5\/#join=[A-Za-z0-9_-]{16}$/);
  const tok = l.split('join=')[1];
  const pv = await S.api(T.zed, 'GET', '/api/ugroups/join/' + tok);
  assert.equal(pv.status, 200);
  assert.equal(pv.data.name, 'دوستان قدیمی');
  assert.equal(pv.data.member, false);
  // members who do not manage it do not see the link
  assert.equal((await groupsOf('cy')).find((g) => g.key === G.key).invite, null);
  const j = await S.api(T.zed, 'POST', '/api/ugroups/join/' + tok);
  assert.equal(j.status, 200);
  assert.ok(j.data.group.members.includes('zed'));
  // zed now knows the members (group mates) without being able to write to them privately
  const users = (await S.api(T.zed, 'GET', '/api/users')).data;
  assert.ok(users.some((u) => u.username === 'ali'));
  // removed: cannot come back by the link
  assert.equal((await ug('cy', '/' + G.id + '/remove', { user: 'zed' })).data.error, 'not_group_admin');
  assert.equal((await ug('bob', '/' + G.id + '/remove', { user: 'zed' })).status, 200);
  assert.equal((await S.api(T.zed, 'POST', '/api/ugroups/join/' + tok)).data.error, 'removed_from_group');
  assert.equal((await S.api(T.zed, 'POST', '/api/send', { target: G.key, kind: 'text', payload: 'x' })).status, 403);
  // an admin cannot remove another admin or the owner
  await ug('ali', '/' + G.id + '/role', { user: 'cy', role: 'admin' });
  assert.equal((await ug('bob', '/' + G.id + '/remove', { user: 'cy' })).data.error, 'not_group_owner');
  assert.equal((await ug('bob', '/' + G.id + '/remove', { user: 'ali' })).data.error, 'cannot_remove');
  await ug('ali', '/' + G.id + '/role', { user: 'cy', role: 'member' });
  // revoke
  await ug('ali', '/' + G.id + '/invite', { revoke: true });
  assert.equal((await S.api(T.dan, 'GET', '/api/ugroups/join/' + tok)).status, 404);
  const qr = await S.api(T.ali, 'GET', '/api/ugroups/' + G.id + '/qr');
  assert.equal(qr.status, 404);
});

test('at most 3 groups each (panel limit, per-user override); deleting frees a place', async () => {
  const made = [];
  for (let i = 0; i < 2; i++) made.push((await ug('ali', '/create', { name: 'g' + i, members: [] })).data.group);
  const r = await ug('ali', '/create', { name: 'g3', members: [] });
  assert.equal(r.status, 403);
  assert.equal(r.data.error, 'group_limit');
  assert.equal((await S.api(T.ali, 'GET', '/api/me')).data.ugroups.owned, 3);
  await ug('ali', '/' + made[0].id + '/delete', {});
  assert.equal((await ug('ali', '/create', { name: 'g3', members: [] })).status, 200);
  // the admin gives ali one more, and takes bob's right away
  assert.equal((await adm('POST', '/ugroups/limit', { username: 'ali', limit: 4 })).status, 200);
  assert.equal((await ug('ali', '/create', { name: 'g4', members: [] })).status, 200);
  await adm('POST', '/ugroups/limit', { username: 'bob', limit: 0 });
  assert.equal((await ug('bob', '/create', { name: 'b', members: [] })).data.error, 'group_limit');
  // a transfer to somebody at their limit is refused
  assert.equal((await ug('ali', '/' + G.id + '/transfer', { user: 'bob' })).data.error, 'their_group_limit');
  await adm('POST', '/ugroups/limit', { username: 'bob', limit: null });
  await adm('POST', '/ugroups/limit', { username: 'ali', limit: null });
});

test('leaving and ownership', async () => {
  // bob is admin of G: when ali leaves, bob owns it
  const lv = await ug('ali', '/' + G.id + '/leave', {});
  assert.equal(lv.status, 200);
  let bg = (await groupsOf('bob')).find((g) => g.key === G.key);
  assert.equal(bg.role, 'owner');
  assert.equal(bg.owner, 'bob');
  assert.ok(!(await groupsOf('ali')).some((g) => g.key === G.key));
  // demote everyone, then bob leaves: no admin left -> frozen, nobody writes
  const lv2 = await ug('bob', '/' + G.id + '/leave', {});
  assert.equal(lv2.status, 200);
  const cg = (await groupsOf('cy')).find((g) => g.key === G.key);
  assert.equal(cg.frozen, true);
  assert.equal(cg.owner, null);
  assert.equal((await S.api(T.cy, 'POST', '/api/send', { target: G.key, kind: 'text', payload: 'x' })).data.error, 'group_frozen');
});

test('admin panel tab: list, members, hand over, freeze, remove, add a whole category, delete', async () => {
  const l = await adm('GET', '/ugroups');
  assert.equal(l.status, 200);
  const g = l.data.groups.find((x) => x.key === G.key);
  assert.ok(g);
  assert.equal(g.frozen, true);
  assert.ok(g.msgs >= 3);
  assert.ok(l.data.limits.some((x) => x.username === 'ali' && x.owned >= 3));
  const mem = await adm('GET', `/ugroups/${G.id}/members`);
  assert.ok(mem.data.members.some((m) => m.username === 'zed' && m.banned));
  assert.equal((await adm('POST', `/ugroups/${G.id}/role`, { username: 'cy', role: 'owner' })).status, 200);
  assert.equal((await adm('POST', `/ugroups/${G.id}/freeze`, { on: false })).status, 200);
  let cg = (await groupsOf('cy')).find((x) => x.key === G.key);
  assert.equal(cg.role, 'owner');
  assert.equal(cg.frozen, false);
  const add = await adm('POST', `/ugroups/${G.id}/add`, { category: cat });
  assert.ok(add.data.added >= 3);
  assert.ok((await groupsOf('zed')).length === 0); // zed is not in the category and stays out
  assert.equal((await adm('POST', `/ugroups/${G.id}/remove`, { username: 'fay' })).status, 200);
  assert.ok(!(await groupsOf('fay')).some((x) => x.key === G.key));
  assert.equal((await adm('POST', `/ugroups/${G.id}/delete`, {})).status, 200);
  assert.ok(!(await groupsOf('cy')).some((x) => x.key === G.key));
  assert.equal(S.db.prepare('SELECT COUNT(*) AS n FROM messages WHERE target=?').get(G.key).n, 0);
  // the admin's categories cannot be touched through this tab
  assert.equal((await adm('POST', `/ugroups/${cat}/delete`, {})).status, 404);
});

test('a deleted account hands its groups to the oldest admin', async () => {
  await adm('POST', '/ugroups/limit', { username: 'ali', limit: 10 });
  const r = await ug('ali', '/create', { name: 'h', members: ['dan', 'eve'] });
  const id = r.data.group.id;
  await ug('ali', '/' + id + '/role', { user: 'eve', role: 'admin' });
  assert.equal((await adm('POST', '/users/ali/delete', {})).status, 200);
  const eg = (await groupsOf('eve')).find((g) => g.id === id);
  assert.equal(eg.owner, 'eve');
});

test('group calls follow the panel switch and the owner switch', async () => {
  const r = await ug('eve', '/create', { name: 'call', members: [] });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.group.call, true);
  await ug('eve', '/' + r.data.group.id + '/edit', { call_on: false });
  assert.equal((await groupsOf('eve')).find((g) => g.id === r.data.group.id).call, false);
  await ug('eve', '/' + r.data.group.id + '/edit', { call_on: true });
  await adm('POST', '/ugroups/settings', { calls: false });
  assert.equal((await groupsOf('eve')).find((g) => g.id === r.data.group.id).call, false);
});

test('group photo: admins set it, members fetch it, others cannot', async () => {
  const WEBP = Buffer.from('UklGRhoAAABXRUJQVlA4TA0AAAAvAAAAEAcQERGIiP4HAA==', 'base64');
  const r = await ug('eve', '/create', { name: 'photo', members: ['dan'] });
  const id = r.data.group.id;
  assert.equal((await S.api(T.eve, 'GET', '/api/gavatar/' + id)).status, 404);
  assert.equal((await S.api(T.dan, 'POST', `/api/ugroups/${id}/avatar`, WEBP, { 'content-type': 'image/webp' })).status, 403);
  const up = await S.api(T.eve, 'POST', `/api/ugroups/${id}/avatar`, WEBP, { 'content-type': 'image/webp' });
  assert.equal(up.status, 200);
  assert.equal(up.data.group.avatar_ver, 1);
  assert.equal((await S.api(T.dan, 'GET', '/api/gavatar/' + id)).status, 200);
  assert.equal((await S.api(T.zed, 'GET', '/api/gavatar/' + id)).status, 404);
});

test('1.20 migration: an existing categories table keeps its rows and ids, loses UNIQUE(name), gains kind', () => {
  const os = require('node:os');
  const fs = require('node:fs');
  const { DatabaseSync } = require('node:sqlite');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sepan-ug-'));
  try {
    const old = new DatabaseSync(path.join(dir, 'messenger.db'));
    old.exec(`CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      INSERT INTO settings VALUES ('migrated_v2','1'),('migrated_v13_links','1');
      CREATE TABLE categories (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE NOT NULL, gkey TEXT UNIQUE NOT NULL);
      INSERT INTO categories VALUES (1,'عمومی','all'),(5,'تیم','g:5');
      CREATE TABLE user_categories (username TEXT NOT NULL, category_id INTEGER NOT NULL, PRIMARY KEY (username, category_id));
      INSERT INTO user_categories VALUES ('a',1),('a',5);
      INSERT INTO categories VALUES (9,'old','g:9'); DELETE FROM categories WHERE id=9;
      CREATE TABLE messages (id INTEGER PRIMARY KEY AUTOINCREMENT, sender TEXT NOT NULL, target TEXT NOT NULL, kind TEXT NOT NULL, payload TEXT NOT NULL, file_id TEXT, ts INTEGER NOT NULL);
      INSERT INTO messages(sender,target,kind,payload,ts) VALUES ('a','g:12','msg','x',1);`);
    old.close();
    const { execFileSync } = require('node:child_process');
    const out = execFileSync(process.execPath, ['-e', `
      const { db } = require(${JSON.stringify(path.join(__dirname, '..', 'server', 'src', 'db.js'))});
      const cats = db.prepare('SELECT id, name, gkey, kind FROM categories ORDER BY id').all();
      db.prepare("INSERT INTO categories(name,gkey,kind) VALUES('تیم','g:x','user')").run();
      const next = db.prepare("INSERT INTO categories(name,gkey) VALUES('n','g:y')").run().lastInsertRowid;
      const uc = db.prepare('SELECT username, category_id, role FROM user_categories ORDER BY category_id').all();
      console.log(JSON.stringify({ cats, next: Number(next), uc }));`], { env: { ...process.env, DATA_DIR: dir, NODE_NO_WARNINGS: '1' } }).toString();
    const r = JSON.parse(out.trim().split('\n').pop());
    assert.deepEqual(r.cats, [{ id: 1, name: 'عمومی', gkey: 'all', kind: 'cat' }, { id: 5, name: 'تیم', gkey: 'g:5', kind: 'cat' }]);
    assert.equal(r.next, 14); // after the user group (13): never a deleted category's id or one old messages use
    assert.deepEqual(r.uc, [{ username: 'a', category_id: 1, role: 'member' }, { username: 'a', category_id: 5, role: 'member' }]);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
