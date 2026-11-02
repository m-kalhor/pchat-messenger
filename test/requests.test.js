'use strict';
// 1.7: message requests by @username (like Telegram), missed calls from strangers, find by username,
// international phone numbers and the admin-only call diagnostics.
const test = require('node:test');
const assert = require('node:assert/strict');
const { startServer } = require('./helpers/server');

let S, t;
const send = (from, target, extra = {}) => S.api(t[from], 'POST', '/api/send', { target, kind: 'msg', payload: 'x', ...extra });
const post = (u, what, body) => S.api(t[u], 'POST', '/api/contacts/' + what, body);
const lists = async (u) => (await S.api(t[u], 'GET', '/api/contacts/requests')).data;
const users = async (u) => Object.fromEntries((await S.api(t[u], 'GET', '/api/users')).data.map((x) => [x.username, x]));
const setting = (k, v) => S.db.prepare('INSERT OR REPLACE INTO settings(key,value) VALUES(?,?)').run(k, v);

test.before(async () => {
  S = await startServer();
  t = {};
  for (const u of ['mostafa', 'reza', 'sima', 'taha', 'yas', 'zoe']) t[u] = await S.user(u, []);
});
test.after(() => S && S.stop());

test('a stranger writes by username: up to 3 messages without files, shown as a request', async () => {
  let r = await send('reza', 'sima');
  assert.equal(r.status, 200);
  assert.equal(r.data.request, true);
  assert.equal(r.data.left, 2);
  assert.equal((await send('reza', 'sima', { fileId: 'a'.repeat(32) })).data.error, 'request_text_only');
  await send('reza', 'sima');
  await send('reza', 'sima');
  r = await send('reza', 'sima');
  assert.equal(r.status, 403);
  assert.equal(r.data.error, 'request_limit');
  const s = await users('sima');
  assert.equal(s.reza.req, 'in');
  assert.equal(s.reza.online, false, 'no presence across a request');
  assert.equal((await users('reza')).sima.req, 'out');
  const l = await lists('sima');
  assert.deepEqual(l.incoming.map((x) => [x.username, x.msgs]), [['reza', 3]]);
  assert.deepEqual((await lists('reza')).outgoing.map((x) => x.status), ['pending']);
});

test('replying accepts the request; then it is an ordinary chat', async () => {
  assert.equal((await send('sima', 'reza')).status, 200);
  assert.ok(S.core.q.vis.get('sima', 'reza') && S.core.q.vis.get('reza', 'sima'));
  const r = await send('reza', 'sima');
  assert.equal(r.status, 200);
  assert.equal(r.data.request, undefined);
  assert.equal((await users('sima')).reza.req, undefined);
});

test('decline is silent and reversible; block stops messages and can be lifted', async () => {
  await send('taha', 'yas');
  await post('yas', 'respond', { username: 'taha', accept: false });
  assert.equal((await users('yas')).taha.req, 'declined');
  assert.deepEqual((await lists('taha')).outgoing.map((x) => x.status), ['pending'], 'the sender is not told');
  assert.equal((await send('taha', 'yas')).status, 200, 'a declined request still takes messages (quietly)');
  await post('yas', 'block', { username: 'taha' });
  assert.equal((await send('taha', 'yas')).data.error, 'not_allowed');
  assert.equal((await users('yas')).taha, undefined, 'a blocked sender is hidden');
  assert.deepEqual((await lists('yas')).blocked.map((x) => x.username), ['taha']);
  await post('yas', 'unblock', { username: 'taha' });
  assert.deepEqual((await lists('yas')).declined.map((x) => x.username), ['taha']);
  await post('yas', 'respond', { username: 'taha', accept: true });
  assert.ok(S.core.canDM('taha', 'yas') && S.core.canDM('yas', 'taha'));
});

test('a call from a stranger does not ring; it is noted on the request', async () => {
  const r = await send('zoe', 'mostafa', { kind: 'sig_invite' });
  assert.equal(r.status, 403);
  assert.equal(r.data.error, 'not_connected');
  const l = await lists('mostafa');
  assert.deepEqual(l.incoming.map((x) => [x.username, x.calls, x.msgs]), [['zoe', 1, 0]]);
  assert.equal((await send('zoe', 'mostafa', { kind: 'sig_ice' })).status, 403);
});

test('own privacy setting and the panel switch close message requests', async () => {
  assert.equal((await S.api(t.zoe, 'POST', '/api/privacy', { allow_requests: false })).data.allow_requests, false);
  assert.equal((await S.api(t.zoe, 'GET', '/api/me')).data.allow_requests, false);
  assert.equal((await send('sima', 'zoe')).data.error, 'not_allowed');
  await S.api(t.zoe, 'POST', '/api/privacy', { allow_requests: true });
  setting('msg_requests', '0');
  assert.equal((await send('sima', 'zoe')).data.error, 'not_allowed');
  setting('msg_requests', '1');
  assert.equal((await send('sima', 'zoe')).status, 200);
  // the admin's closed pair (⛔) always wins
  S.db.prepare('INSERT INTO blocks(viewer,target) VALUES(?,?),(?,?)').run('sima', 'taha', 'taha', 'sima');
  assert.equal((await send('sima', 'taha')).data.error, 'not_allowed');
  assert.equal((await S.api(t.sima, 'GET', '/api/users/find?u=taha')).status, 404);
});

test('find by exact @username', async () => {
  const r = await S.api(t.yas, 'GET', '/api/users/find?u=@Mostafa');
  assert.equal(r.status, 200);
  assert.equal(r.data.username, 'mostafa');
  assert.equal(r.data.connected, false);
  assert.equal(r.data.can_message, true);
  assert.ok('pubkey' in r.data);
  assert.equal((await S.api(t.yas, 'GET', '/api/users/find?u=most')).status, 404, 'no prefix search');
  assert.equal((await S.api(t.yas, 'GET', '/api/users/find?u=a')).status, 400);
  assert.equal((await S.api(t.yas, 'GET', '/api/users/find?u=taha')).data.connected, true);
});

test('phone numbers are kept in the international form', async () => {
  const auth = require(require('node:path').join(S.app.appDir, 'auth.js'));
  for (const x of ['09365751198', '9365751198', '+98 936 575 1198', '00989365751198', '989365751198', '+9809365751198', '۰۹۳۶۵۷۵۱۱۹۸']) {
    assert.equal(auth.normPhone(x), '+989365751198', x);
  }
  assert.equal(auth.normPhone('+44 7700 900123'), '+447700900123');
  assert.equal(auth.normPhone('0044 7700 900123'), '+447700900123');
  assert.equal(auth.normPhone('02188776655'), null, 'a landline without a country code is not guessed');
  assert.equal(auth.smsMobile('+989365751198'), '09365751198');
  const r = await S.api(null, 'POST', '/api/auth/sms', { phone: '+447700900123' });
  assert.equal(r.data.error, 'sms_foreign');
});
