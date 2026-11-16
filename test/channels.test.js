'use strict';
// 1.21: channels users make — panel switch, shared limit with groups, only owner/admins post, members do not
// see each other, the shared channel key (claim, seal for members, new version on removal), posts must use the
// current key version, anonymous reactions and receipts, 👁 counts, older posts for new members, panel list.
const test = require('node:test');
const assert = require('node:assert/strict');
const net = require('node:net');
const path = require('node:path');
const { startServer } = require('./helpers/server');

const freePort = () => new Promise((resolve) => { const s = net.createServer().listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); }); });

let S, base, cookie = '', csrf = '', T = {};

async function adm(method, p, body) {
  const r = await fetch(base + '/admin/api' + p, { method, headers: { 'content-type': 'application/json', cookie, 'x-csrf': csrf }, body: body ? JSON.stringify(body) : undefined });
  const set = r.headers.get('set-cookie');
  if (set) cookie = set.split(';')[0];
  return { status: r.status, data: await r.json() };
}
const ug = (who, op, body) => S.api(T[who], 'POST', '/api/ugroups' + op, body);
const get = (who, p) => S.api(T[who], 'GET', p);
const link = (a, b) => S.db.prepare('INSERT OR IGNORE INTO visibility(viewer,target) VALUES(?,?),(?,?)').run(a, b, b, a);
const groupsOf = async (who) => (await get(who, '/api/groups')).data;
const PUB = (n) => Buffer.alloc(91, n).toString('base64'); // stand-in public keys (the server never parses them)
const W = (n) => Buffer.alloc(60, n).toString('base64');   // a sealed copy of the key (opaque to the server)
const post = (who, key, kv, extra = {}) => S.api(T[who], 'POST', '/api/send', { target: key, kind: 'text', payload: JSON.stringify({ v: 2, kv, c: 'AAAA', ...extra }) });

test.before(async () => {
  const port = await freePort();
  S = await startServer({ ADMIN_DISABLE: '0', ADMIN_PORT: String(port), PUBLIC_HOST: '203.0.113.5' });
  base = `http://127.0.0.1:${port}`;
  const { setSetting, hashPassword } = require(path.join(S.app.appDir, 'db.js'));
  setSetting('admin_pass', hashPassword('first-pass-1'));
  csrf = (await adm('POST', '/login', { username: 'admin', password: 'first-pass-1' })).data.csrf;
  let i = 1;
  for (const n of ['own', 'adm', 'mia', 'nik', 'ola', 'pat']) {
    T[n] = await S.user(n);
    assert.equal((await S.api(T[n], 'POST', '/api/pubkey', { pubkey: PUB(i++) })).status, 200);
  }
  link('own', 'adm'); link('own', 'mia'); link('own', 'nik');
});
test.after(() => S && S.stop());

let C; // own's channel

test('channels have their own panel switch and share the limit with groups', async () => {
  assert.equal((await ug('own', '/create', { kind: 'chan', name: 'خبرها' })).data.error, 'chans_off');
  await adm('POST', '/ugroups/settings', { on: true, chan_on: true, limit: 2 });
  const me = (await get('own', '/api/me')).data.ugroups;
  assert.equal(me.chan_on, true);
  assert.equal(me.chan_max, 1000);
  const r = await ug('own', '/create', { kind: 'chan', name: 'خبرها', about: 'کانال ما', members: ['adm', 'mia'] });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  C = r.data.group;
  assert.equal(C.kind, 'chan');
  assert.equal(C.ckv, 1);
  assert.equal(C.admins_only, true);
  assert.equal(C.call_on, false);
  assert.equal((await ug('own', '/create', { name: 'گروه' })).status, 200);
  assert.equal((await ug('own', '/create', { kind: 'chan', name: 'سوم' })).data.error, 'group_limit');
  assert.equal((await ug('own', `/${C.id}/role`, { user: 'adm', role: 'admin' })).status, 200);
});

test('members see only the owner and admins, never each other', async () => {
  await ug('own', `/${C.id}/add`, { users: ['nik'] });
  const mg = (await groupsOf('mia')).find((g) => g.key === C.key);
  assert.deepEqual(mg.members.sort(), ['adm', 'own']);
  assert.equal(mg.role, 'member');
  assert.equal(mg.count, 4);
  const users = (await get('mia', '/api/users')).data.map((u) => u.username);
  assert.ok(!users.includes('nik'), 'channel members are not contacts of each other');
  const det = (await get('mia', `/api/ugroups/${C.id}`)).data;
  assert.deepEqual(det.roles.map((r) => r.username).sort(), ['adm', 'own']);
  const og = (await groupsOf('own')).find((g) => g.key === C.key);
  assert.deepEqual(og.members.sort(), ['adm', 'mia', 'nik', 'own']);
  assert.equal((await S.api(T.mia, 'POST', '/api/typing', { target: C.key })).status, 200);
  assert.equal((await S.api(T.mia, 'POST', '/api/gcall/start', { group: C.key })).status, 403);
});

test('the owner claims key version 1 and seals it; members fetch their copy; pending lists who still waits', async () => {
  const k0 = (await get('own', `/api/ugroups/${C.id}/keys`)).data;
  assert.equal(k0.kv, 1);
  assert.equal(k0.claim, true);
  assert.deepEqual(k0.keys, []);
  assert.deepEqual(k0.members.map((m) => m.u).sort(), ['adm', 'mia', 'nik', 'own']);
  assert.equal(k0.members.find((m) => m.u === 'mia').pub, PUB(3));
  // a claim must include the maker's own copy, and the maker's current public key
  assert.equal((await ug('own', `/${C.id}/keys`, { kv: 1, by_pub: PUB(1), wraps: [{ u: 'mia', w: W(1), for_pub: PUB(3) }] })).data.error, 'bad_keys');
  assert.equal((await ug('own', `/${C.id}/keys`, { kv: 1, by_pub: PUB(9), wraps: [{ u: 'own', w: W(1), for_pub: PUB(1) }] })).data.error, 'key_changed');
  const r = await ug('own', `/${C.id}/keys`, { kv: 1, by_pub: PUB(1), wraps: [{ u: 'own', w: W(1), for_pub: PUB(1) }, { u: 'mia', w: W(2), for_pub: PUB(3) }, { u: 'nik', w: W(3), for_pub: 'stale' }] });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.stored, 2); // nik's copy was for an old key: skipped, asked again
  // a second claim of the same version is refused for somebody without a copy
  assert.equal((await ug('adm', `/${C.id}/keys`, { kv: 1, by_pub: PUB(2), wraps: [{ u: 'adm', w: W(4), for_pub: PUB(2) }] })).data.error, 'key_taken');
  const mk = (await get('mia', `/api/ugroups/${C.id}/keys`)).data;
  assert.equal(mk.keys.length, 1);
  assert.equal(mk.keys[0].by_user, 'own');
  assert.equal(mk.keys[0].by_pub, PUB(1));
  assert.equal(mk.pending, undefined);
  const k1 = (await get('own', `/api/ugroups/${C.id}/keys`)).data;
  assert.equal(k1.claim, false);
  assert.deepEqual(k1.pending.map((p) => p.u).sort(), ['adm', 'nik']);
  assert.deepEqual(k1.pending.find((p) => p.u === 'nik').kvs, [1]);
  assert.equal(k1.pending.find((p) => p.u === 'nik').pub, PUB(4));
  // members cannot store keys
  assert.equal((await ug('mia', `/${C.id}/keys`, { kv: 1, by_pub: PUB(3), wraps: [] })).status, 403);
  await ug('own', `/${C.id}/keys`, { kv: 1, by_pub: PUB(1), wraps: [{ u: 'adm', w: W(5), for_pub: PUB(2) }, { u: 'nik', w: W(6), for_pub: PUB(4) }] });
  assert.deepEqual((await get('own', `/api/ugroups/${C.id}/keys`)).data.pending, []);
});

let P1;
test('only the owner and admins post, and only with the current key version', async () => {
  assert.equal((await post('mia', C.key, 1)).data.error, 'admins_only');
  assert.equal((await S.api(T.own, 'POST', '/api/send', { target: C.key, kind: 'text', payload: '{"v":1,"c":"x","k":{}}' })).data.error, 'chan_key_old');
  assert.equal((await post('own', C.key, 2)).data.error, 'chan_key_old');
  const r = await post('own', C.key, 1);
  assert.equal(r.status, 200);
  P1 = r.data.id;
  assert.equal((await post('adm', C.key, 1)).status, 200);
  // edits too
  assert.equal((await S.api(T.own, 'POST', '/api/edit', { id: P1, payload: '{"v":1}' })).data.error, 'chan_key_old');
  assert.equal((await S.api(T.own, 'POST', '/api/edit', { id: P1, payload: JSON.stringify({ v: 2, kv: 1, c: 'BBBB' }) })).status, 200);
});

test('reactions in a channel are anonymous for members; owner and admins see names', async () => {
  assert.equal((await S.api(T.mia, 'POST', '/api/react', { id: P1, emoji: '👍' })).status, 200);
  assert.equal((await S.api(T.nik, 'POST', '/api/react', { id: P1, emoji: '❤️' })).status, 200);
  const posts = async (who) => (await get(who, `/api/ugroups/${C.id}/posts`)).data.posts;
  const pm = (await posts('mia')).find((p) => p.id === P1);
  assert.equal(pm.reactions.mia, '👍');
  assert.ok(!('nik' in pm.reactions));
  const other = Object.keys(pm.reactions).find((k) => k !== 'mia');
  assert.match(other, /^~[0-9a-f]{10}$/);
  assert.equal(pm.reactions[other], '❤️');
  // the stand-in is stable for that message, so taking the reaction back matches
  assert.equal(Object.keys((await posts('mia')).find((p) => p.id === P1).reactions).find((k) => k !== 'mia'), other);
  const po = (await posts('own')).find((p) => p.id === P1);
  assert.deepEqual(po.reactions, { mia: '👍', nik: '❤️' });
});

test('receipts: nobody gets the others\' rows; the 👁 count comes from /views', async () => {
  await S.api(T.mia, 'POST', '/api/receipts', { items: [{ target: C.key, seen: P1 }] });
  await S.api(T.nik, 'POST', '/api/receipts', { items: [{ target: C.key, seen: P1 }] });
  const v = (await get('mia', `/api/ugroups/${C.id}/views`)).data.seen;
  assert.equal(v.filter((x) => x >= P1).length, 2);
});

test('a member who joins by link reads older posts and waits for a copy of the key', async () => {
  const inv = await ug('own', `/${C.id}/invite`, {});
  const tok = inv.data.group.invite_link.split('#join=')[1];
  const pv = (await get('ola', '/api/ugroups/join/' + tok)).data;
  assert.equal(pv.kind, 'chan');
  assert.equal((await S.api(T.ola, 'POST', '/api/ugroups/join/' + tok)).status, 200);
  const posts = (await get('ola', `/api/ugroups/${C.id}/posts`)).data.posts;
  assert.ok(posts.some((p) => p.id === P1));
  assert.ok(posts.every((p) => p.from === 'own' || p.from === 'adm'));
  assert.deepEqual((await get('ola', `/api/ugroups/${C.id}/keys`)).data.keys, []);
  const pend = (await get('adm', `/api/ugroups/${C.id}/keys`)).data.pending;
  assert.deepEqual(pend.map((p) => p.u), ['ola']);
  // the admin holds version 1 and seals it for the newcomer
  assert.equal((await ug('adm', `/${C.id}/keys`, { kv: 1, by_pub: PUB(2), wraps: [{ u: 'ola', w: W(7), for_pub: PUB(5) }] })).data.stored, 1);
  const ok = (await get('ola', `/api/ugroups/${C.id}/keys`)).data.keys;
  assert.equal(ok[0].by_user, 'adm');
});

test('removing a member moves the channel to a new key version; leaving does not', async () => {
  assert.equal((await ug('own', `/${C.id}/remove`, { user: 'nik' })).status, 200);
  const k = (await get('own', `/api/ugroups/${C.id}/keys`)).data;
  assert.equal(k.kv, 2);
  assert.equal(k.claim, true);
  assert.equal((await post('own', C.key, 1)).data.error, 'chan_key_old');
  assert.equal((await ug('adm', `/${C.id}/keys`, { kv: 2, by_pub: PUB(2), wraps: [{ u: 'adm', w: W(8), for_pub: PUB(2) }, { u: 'nik', w: W(8), for_pub: PUB(4) }] })).data.stored, 1);
  assert.equal((await post('adm', C.key, 2)).status, 200);
  assert.equal((await get('nik', `/api/ugroups/${C.id}/keys`)).status, 404);
  // the owner (who has v1 but not v2) gets v2 from the admin through pending
  const pend = (await get('adm', `/api/ugroups/${C.id}/keys`)).data.pending;
  assert.deepEqual(pend.map((p) => p.u).sort(), ['mia', 'ola', 'own']);
  assert.equal((await ug('ola', `/${C.id}/leave`, {})).status, 200);
  assert.equal((await get('own', `/api/ugroups/${C.id}/keys`)).data.kv, 2);
});

test('admin panel lists channels with their key version; panel removal also moves the key', async () => {
  const l = (await adm('GET', '/ugroups')).data;
  const row = l.groups.find((g) => g.id === C.id);
  assert.equal(row.kind, 'chan');
  assert.equal(row.ckv, 2);
  assert.equal(l.cfg.chan_on, true);
  assert.equal((await adm('POST', '/ugroups/settings', { chan_max: 1 })).status, 400);
  assert.equal((await adm('POST', `/ugroups/${C.id}/remove`, { username: 'mia' })).status, 200);
  assert.equal((await adm('GET', '/ugroups')).data.groups.find((g) => g.id === C.id).ckv, 3);
});
