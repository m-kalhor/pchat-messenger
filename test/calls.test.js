'use strict';
// 1.10.1: call path settings in the admin panel, handed to the apps with /api/turn.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { startServer } = require('./helpers/server');

const freePort = () => new Promise((resolve) => { const s = net.createServer().listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); }); });

let S, base, cookie = '', csrf = '', tok;
async function adm(method, p, body) {
  const r = await fetch(base + '/admin/api' + p, { method, headers: { 'content-type': 'application/json', cookie, 'x-csrf': csrf }, body: body ? JSON.stringify(body) : undefined });
  const set = r.headers.get('set-cookie');
  if (set) cookie = set.split(';')[0];
  return { status: r.status, data: await r.json() };
}

test.before(async () => {
  const port = await freePort();
  const secret = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'turn-')), 'secret');
  fs.writeFileSync(secret, 'test-secret');
  S = await startServer({ ADMIN_DISABLE: '0', ADMIN_PORT: String(port), TURN_SECRET_FILE: secret, PUBLIC_HOST: '203.0.113.5', TURN_TLS_PORT: '5349', TURN_TLS_HOST: 'turn.example.ir' });
  base = `http://127.0.0.1:${port}`;
  const { setSetting, hashPassword } = require(path.join(S.app.appDir, 'db.js'));
  setSetting('admin_pass', hashPassword('first-pass-1'));
  csrf = (await adm('POST', '/login', { username: 'admin', password: 'first-pass-1' })).data.csrf;
  tok = await S.user('carl');
});
test.after(() => S && S.stop());

test('defaults: auto switching, 800 kb/s video cap, TURN over TLS offered', async () => {
  const r = await S.api(tok, 'GET', '/api/turn');
  assert.equal(r.status, 200);
  assert.equal(r.data.policy, 'auto');
  assert.equal(r.data.switch_rtt, 400);
  assert.equal(r.data.switch_loss, 8);
  assert.equal(r.data.video_kbps, 800);
  assert.ok(r.data.urls.includes('turns:turn.example.ir:5349?transport=tcp'));
  assert.ok(r.data.urls.includes('turn:203.0.113.5:3478?transport=udp'));
  assert.ok(r.data.username && r.data.credential && r.data.ttl);
  const a = await adm('GET', '/auth');
  assert.equal(a.data.calls.tls_available, true);
});

test('the admin changes the settings, bad values are refused, and both reset buttons work', async () => {
  let r = await adm('POST', '/auth', { calls: { route: 'relay', rtt: 300, loss: 5, video_kbps: 500, tls: false } });
  assert.equal(r.status, 200);
  assert.deepEqual({ ...r.data.calls, tls_available: undefined }, { route: 'relay', rtt: 300, loss: 5, video_kbps: 500, tls: false, tls_available: undefined });
  let t = (await S.api(tok, 'GET', '/api/turn')).data;
  assert.equal(t.policy, 'relay');
  assert.equal(t.video_kbps, 500);
  assert.ok(!t.urls.some((u) => u.startsWith('turns:')));

  for (const bad of [{ route: 'x' }, { rtt: 50 }, { loss: 0 }, { video_kbps: -1 }, { tls: 'yes' }, { rtt: 1.5 }]) {
    r = await adm('POST', '/auth', { calls: bad });
    assert.equal(r.status, 400, JSON.stringify(bad));
    assert.equal(r.data.error, 'bad_call_settings');
  }

  r = await adm('POST', '/auth', { calls: { reset: 'old' } });
  assert.equal(r.data.calls.route, 'direct');
  assert.equal(r.data.calls.video_kbps, 0);
  assert.equal(r.data.calls.tls, false);
  t = (await S.api(tok, 'GET', '/api/turn')).data;
  assert.equal(t.policy, 'direct');
  assert.deepEqual(t.urls, ['stun:203.0.113.5:3478', 'turn:203.0.113.5:3478?transport=udp', 'turn:203.0.113.5:3478?transport=tcp']);

  r = await adm('POST', '/auth', { calls: { reset: 'default' } });
  assert.equal(r.data.calls.route, 'auto');
  assert.equal(r.data.calls.tls, true);
});

test('1.15: choosing the call path is off for everyone until the admin ticks the user', async () => {
  let t = (await S.api(tok, 'GET', '/api/turn')).data;
  assert.equal(t.user_route, false);
  assert.equal((await S.api(tok, 'GET', '/api/me')).data.call_route, false);
  let st = (await adm('GET', '/state')).data;
  assert.equal(st.users.find((u) => u.username === 'carl').route, false);

  let r = await adm('POST', '/auth', { route_users: 'carl' });
  assert.equal(r.status, 200);
  assert.equal(r.data.route_users, 'carl');
  t = (await S.api(tok, 'GET', '/api/turn')).data;
  assert.equal(t.user_route, true);
  assert.equal((await S.api(tok, 'GET', '/api/me')).data.call_route, true);
  st = (await adm('GET', '/state')).data;
  assert.equal(st.users.find((u) => u.username === 'carl').route, true);

  r = await adm('POST', '/auth', { route_users: 'bad name!' });
  assert.equal(r.status, 400);

  r = await adm('POST', '/auth', { route_users: '' });
  assert.equal(r.data.route_users, '');
  assert.equal((await S.api(tok, 'GET', '/api/turn')).data.user_route, false);
});
