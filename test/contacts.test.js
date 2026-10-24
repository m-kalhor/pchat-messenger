'use strict';
// Connection requests: A asks B, B accepts, both matrix directions are set without the admin.
const test = require('node:test');
const assert = require('node:assert/strict');
const { startServer } = require('./helpers/server');

let S, t;
const post = (u, what, body) => S.api(t[u], 'POST', '/api/contacts/' + what, body);
const lists = async (u) => (await S.api(t[u], 'GET', '/api/contacts/requests')).data;
const dmable = async (u) => Object.entries(Object.fromEntries((await S.api(t[u], 'GET', '/api/users')).data.map((x) => [x.username, x.dm]))).filter(([, d]) => d).map(([n]) => n).sort();

test.before(async () => {
  S = await startServer();
  t = {};
  for (const u of ['ali', 'bita', 'cyrus', 'dara']) t[u] = await S.user(u, []);
});
test.after(() => S && S.stop());

test('request then accept connects both ways', async () => {
  assert.equal((await post('ali', 'request', { username: 'Bita' })).data.result, 'sent');
  assert.deepEqual((await lists('bita')).incoming.map((r) => r.username), ['ali']);
  assert.deepEqual((await lists('ali')).outgoing.map((r) => [r.username, r.status]), [['bita', 'pending']]);
  assert.deepEqual(await dmable('bita'), [], 'a pending request grants nothing');
  assert.equal((await post('bita', 'respond', { username: 'ali', accept: true })).status, 200);
  assert.deepEqual(await dmable('ali'), ['bita']);
  assert.deepEqual(await dmable('bita'), ['ali']);
  assert.ok(S.core.q.vis.get('ali', 'bita') && S.core.q.vis.get('bita', 'ali'), 'the matrix shows both directions');
  assert.deepEqual(await lists('bita'), { incoming: [], outgoing: [] });
  assert.equal((await post('ali', 'request', { username: 'bita' })).data.error, 'already_connected');
});

test('two crossing requests connect at once; bad targets are refused', async () => {
  await post('cyrus', 'request', { username: 'dara' });
  assert.equal((await post('dara', 'request', { username: 'cyrus' })).data.result, 'connected');
  assert.deepEqual(await dmable('cyrus'), ['dara']);
  assert.equal((await post('ali', 'request', { username: 'ali' })).data.error, 'bad_username');
  assert.equal((await post('ali', 'request', { username: 'nobody' })).status, 404);
});

test('declined requests wait a day; cancel withdraws', async () => {
  await post('ali', 'request', { username: 'cyrus' });
  await post('cyrus', 'respond', { username: 'ali', accept: false });
  assert.deepEqual((await lists('ali')).outgoing.map((r) => r.status), ['declined']);
  assert.equal((await post('ali', 'request', { username: 'cyrus' })).data.error, 'declined_recently');
  await post('bita', 'request', { username: 'dara' });
  await post('bita', 'cancel', { username: 'dara' });
  assert.deepEqual((await lists('dara')).incoming, []);
});

test('removing a connection also stops replying to old messages', async () => {
  assert.equal((await S.api(t.ali, 'POST', '/api/send', { target: 'bita', kind: 'text', payload: 'x' })).status, 200);
  await post('bita', 'remove', { username: 'ali' });
  assert.deepEqual(await dmable('bita'), []);
  assert.equal(S.core.canDM('bita', 'ali'), false);
  assert.equal(S.core.canDM('ali', 'bita'), false);
  assert.equal((await post('ali', 'request', { username: 'bita' })).data.result, 'sent', 'they can ask again');
  await post('bita', 'respond', { username: 'ali', accept: true });
  assert.equal(S.core.canDM('bita', 'ali'), true);
});

test('a pair the admin closed (⛔) cannot request or reply', async () => {
  S.db.prepare('INSERT INTO blocks(viewer,target) VALUES(?,?)').run('dara', 'ali');
  assert.equal((await post('ali', 'request', { username: 'dara' })).data.error, 'not_allowed');
  assert.equal((await post('dara', 'request', { username: 'ali' })).data.error, 'not_allowed');
});
