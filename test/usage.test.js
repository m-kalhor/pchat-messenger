'use strict';
// 1.14: the admin panel's «مصرف کاربران» report (messages, storage, traffic, calls per user).
const test = require('node:test');
const assert = require('node:assert/strict');
const net = require('node:net');
const path = require('node:path');
const { startServer } = require('./helpers/server');

const freePort = () => new Promise((resolve) => { const s = net.createServer().listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); }); });

let S, base, cookie = '', csrf = '', ann, ben;
async function adm(method, p, body) {
  const r = await fetch(base + '/admin/api' + p, { method, headers: { 'content-type': 'application/json', cookie, 'x-csrf': csrf }, body: body ? JSON.stringify(body) : undefined });
  const set = r.headers.get('set-cookie');
  if (set) cookie = set.split(';')[0];
  return { status: r.status, data: await r.json() };
}
const row = (d, u) => d.rows.find((r) => r.username === u);

test.before(async () => {
  const port = await freePort();
  S = await startServer({ ADMIN_DISABLE: '0', ADMIN_PORT: String(port) });
  base = `http://127.0.0.1:${port}`;
  const { setSetting, hashPassword } = require(path.join(S.app.appDir, 'db.js'));
  setSetting('admin_pass', hashPassword('first-pass-1'));
  csrf = (await adm('POST', '/login', { username: 'admin', password: 'first-pass-1' })).data.csrf;
  ann = await S.user('ann'); ben = await S.user('ben'); await S.user('cid');
  for (const [v, t] of [['ann', 'ben'], ['ben', 'ann']]) S.db.prepare('INSERT INTO visibility(viewer,target) VALUES(?,?)').run(v, t);
  S.db.prepare('INSERT INTO blocks(viewer,target) VALUES(?,?)').run('cid', 'ann');
});
test.after(() => S && S.stop());

test('the report needs the admin session', async () => {
  const r = await fetch(base + '/admin/api/usage');
  assert.equal(r.status, 401);
});

test('messages, files, storage, traffic, calls and devices are counted per user', async () => {
  // ben listens on the event stream so ann's call rings (is delivered)
  const ctl = new AbortController();
  const ev = await fetch(S.base + '/api/events?since=0', { headers: { authorization: 'Bearer ' + ben }, signal: ctl.signal });
  assert.equal(ev.status, 200);
  const reader = ev.body.getReader(); reader.read().catch(() => { });

  for (let i = 0; i < 3; i++) assert.equal((await S.api(ann, 'POST', '/api/send', { target: 'ben', kind: 'msg', payload: 'x'.repeat(100) })).status, 200);
  assert.equal((await S.api(ben, 'POST', '/api/send', { target: 'ann', kind: 'msg', payload: 'hi' })).status, 200);
  const up = await S.api(ann, 'POST', '/api/upload', Buffer.alloc(5000, 1));
  assert.equal(up.status, 200, JSON.stringify(up.data));
  assert.equal((await S.api(ann, 'POST', '/api/send', { target: 'ben', kind: 'msg', payload: 'file', fileId: up.data.fileId })).status, 200);
  const dl = await S.api(ben, 'GET', '/api/file/' + up.data.fileId);
  assert.equal(dl.data.length, 5000, JSON.stringify(dl.status) + JSON.stringify(dl.data));

  // a call: invite -> accept -> about a second -> hang up; then a cancelled second call
  const sig = (tok, to, kind) => S.api(tok, 'POST', '/api/send', { target: to, kind, payload: 'enc' });
  assert.equal((await sig(ann, 'ben', 'sig_invite')).data.delivered, true);
  await sig(ann, 'ben', 'sig_invite'); // the same call sent again does not count twice
  await sig(ben, 'ann', 'sig_accept');
  await new Promise((r) => setTimeout(r, 1200));
  await sig(ann, 'ben', 'sig_hangup');
  await sig(ann, 'ben', 'sig_invite');
  await sig(ann, 'ben', 'sig_hangup');
  ctl.abort();

  const r = await adm('GET', '/usage');
  assert.equal(r.status, 200);
  const a = row(r.data, 'ann'), b = row(r.data, 'ben'), c = row(r.data, 'cid');
  assert.equal(a.sent, 4); assert.equal(a.sent7, 4); assert.equal(a.sent30, 4); assert.equal(a.received, 1);
  assert.equal(b.sent, 1); assert.equal(b.received, 4);
  assert.equal(a.files, 1); assert.equal(a.files_bytes, 5000);
  assert.ok(a.text_bytes >= 304);
  assert.equal(a.storage, a.files_bytes + a.text_bytes + a.avatar_bytes + a.stickers_bytes);
  assert.ok(a.up >= 5000 + 300, 'upload counted: ' + a.up);
  assert.ok(b.down >= 5000, 'download counted: ' + b.down);
  assert.equal(a.traffic30, a.traffic);
  assert.equal(a.calls_out, 2); assert.equal(b.calls_in, 2); assert.equal(b.calls_out, 0);
  assert.ok(a.call_secs >= 1 && a.call_secs <= 3, 'call length ' + a.call_secs);
  assert.equal(b.call_secs, a.call_secs);
  assert.equal(a.devices, 1);
  assert.equal(a.blocked_by, 1); assert.equal(c.blocked_by, 0);
  assert.equal(c.sent, 0); assert.equal(c.storage, c.avatar_bytes);
  assert.ok(r.data.since);
  assert.ok(r.data.dbBytes > 0);
});

test('deleting a user drops their usage rows', async () => {
  assert.equal((await adm('POST', '/users/cid/delete')).status, 200);
  assert.equal(S.db.prepare("SELECT COUNT(*) AS n FROM usage_daily WHERE username='cid'").get().n, 0);
  assert.equal(row((await adm('GET', '/usage')).data, 'cid'), undefined);
});
