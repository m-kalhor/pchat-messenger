'use strict';
// Admin panel API: username + password login, account change, and the single "save all changes" call.
const test = require('node:test');
const assert = require('node:assert/strict');
const net = require('node:net');
const path = require('node:path');
const { startServer } = require('./helpers/server');

const freePort = () => new Promise((resolve) => { const s = net.createServer().listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); }); });

let S, base, cookie = '', csrf = '';
async function adm(method, p, body, keep = true) {
  const r = await fetch(base + '/admin/api' + p, {
    method, headers: { 'content-type': 'application/json', cookie, 'x-csrf': csrf }, body: body ? JSON.stringify(body) : undefined,
  });
  const set = r.headers.get('set-cookie');
  if (set && keep) cookie = set.split(';')[0];
  return { status: r.status, data: await r.json() };
}
async function login(username, password) {
  const r = await adm('POST', '/login', { username, password });
  if (r.status === 200) csrf = r.data.csrf;
  return r;
}

test.before(async () => {
  const port = await freePort();
  S = await startServer({ ADMIN_DISABLE: '0', ADMIN_PORT: String(port) });
  base = `http://127.0.0.1:${port}`;
  const { setSetting, hashPassword } = require(path.join(S.app.appDir, 'db.js'));
  setSetting('admin_pass', hashPassword('first-pass-1'));
  for (const u of ['ann', 'ben', 'cid']) S.core.createUser(u, u, []);
});
test.after(() => S && S.stop());

test('login needs the username (default admin) as well as the password', async () => {
  assert.equal((await login('', 'first-pass-1')).status, 401);
  assert.equal((await login('root', 'first-pass-1')).status, 401);
  assert.equal((await login('admin', 'wrong')).data.error, 'bad_login');
  const ok = await login('Admin', 'first-pass-1');
  assert.equal(ok.status, 200);
  assert.equal(ok.data.username, 'admin');
});

test('save applies users, categories and the matrix in one call', async () => {
  const g = S.core.createCategory('تیم');
  const r = await adm('POST', '/save', {
    users: { ann: { display_name: 'Ann A', categories: [g] }, ben: { categories: [g] } },
    categories: { [g]: 'تیم اصلی' },
    visibility: [['ann', 'ben', true], ['ben', 'ann', true], ['cid', 'ann', false]],
  });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  const st = (await adm('GET', '/state')).data;
  const ann = st.users.find((u) => u.username === 'ann');
  assert.equal(ann.display_name, 'Ann A');
  assert.deepEqual(ann.categories, [g]);
  assert.equal(st.categories.find((c) => c.id === g).name, 'تیم اصلی');
  assert.ok(st.visibility.some(([v, t]) => v === 'ann' && t === 'ben'));
  assert.ok(st.visibility.some(([v, t]) => v === 'ben' && t === 'ann'));
});

test('a failing save changes nothing', async () => {
  const other = S.core.createCategory('دوم');
  const before = (await adm('GET', '/state')).data;
  const r = await adm('POST', '/save', { users: { cid: { display_name: 'Changed' } }, categories: { [other]: 'تیم اصلی' } }); // duplicate name
  assert.equal(r.status, 400);
  assert.equal(r.data.error, 'name_exists');
  const after = (await adm('GET', '/state')).data;
  assert.equal(after.users.find((u) => u.username === 'cid').display_name, before.users.find((u) => u.username === 'cid').display_name);
  assert.equal((await adm('POST', '/save', { users: { ghost: { display_name: 'x' } } })).data.error, 'no_such_user');
  assert.equal((await adm('POST', '/save', { backup: { enabled: true, cron: 'nope', keep: 3 } })).status, 400);
});

test('account change needs the current password and logs other sessions out', async () => {
  const mine = { cookie, csrf };
  await login('admin', 'first-pass-1'); // a second browser
  const other = { cookie, csrf };
  ({ cookie, csrf } = mine);
  assert.equal((await adm('POST', '/account', { current: 'bad', password: 'new-pass-22' })).data.error, 'bad_current_password');
  assert.equal((await adm('POST', '/account', { current: 'first-pass-1', password: 'short' })).data.error, 'weak_password');
  assert.equal((await adm('POST', '/account', { current: 'first-pass-1', username: 'x' })).data.error, 'bad_admin_username');
  const r = await adm('POST', '/account', { current: 'first-pass-1', username: 'boss', password: 'new-pass-22' });
  assert.equal(r.status, 200);
  assert.equal((await adm('GET', '/state')).status, 200, 'the session that changed it stays logged in');
  ({ cookie, csrf } = other);
  assert.equal((await adm('GET', '/state')).status, 401, 'other sessions are logged out');
  assert.equal((await login('admin', 'new-pass-22')).status, 401);
  assert.equal((await login('boss', 'first-pass-1')).status, 401);
  assert.equal((await login('boss', 'new-pass-22')).status, 200);
});
