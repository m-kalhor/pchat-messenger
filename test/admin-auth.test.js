'use strict';
// Admin panel, sign-in tab: sms.ir settings, one-time login codes, unique mobile numbers, APK upload.
const test = require('node:test');
const assert = require('node:assert/strict');
const net = require('node:net');
const path = require('node:path');
const { startServer } = require('./helpers/server');

const freePort = () => new Promise((resolve) => { const s = net.createServer().listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); }); });

let S, base, cookie = '', csrf = '';
async function adm(method, p, body, raw) {
  const r = await fetch(base + '/admin/api' + p, {
    method, headers: { 'content-type': raw ? 'application/octet-stream' : 'application/json', cookie, 'x-csrf': csrf },
    body: raw || (body ? JSON.stringify(body) : undefined),
  });
  const set = r.headers.get('set-cookie');
  if (set) cookie = set.split(';')[0];
  return { status: r.status, data: await r.json() };
}

test.before(async () => {
  const port = await freePort();
  S = await startServer({ ADMIN_DISABLE: '0', ADMIN_PORT: String(port), SMS_API_URL: 'http://127.0.0.1:9/v1' });
  base = `http://127.0.0.1:${port}`;
  const { setSetting, hashPassword } = require(path.join(S.app.appDir, 'db.js'));
  setSetting('admin_pass', hashPassword('first-pass-1'));
  for (const u of ['ann', 'ben']) S.core.createUser(u, u, []);
  csrf = (await adm('POST', '/login', { username: 'admin', password: 'first-pass-1' })).data.csrf;
});
test.after(() => S && S.stop());

test('sms settings are saved; the key is never sent back', async () => {
  let r = await adm('POST', '/auth', { api_key: 'abcdef-secret-1234', template_id: '987654', param: 'CODE', enabled: true, password_login: false });
  assert.equal(r.status, 200);
  assert.equal(r.data.api_key_set, true);
  assert.equal(r.data.api_key_hint, '…1234');
  assert.ok(!JSON.stringify(r.data).includes('abcdef-secret'));
  assert.equal(r.data.ready, true);
  assert.equal(r.data.password_login, false);
  // an empty key field keeps the stored key
  r = await adm('POST', '/auth', { api_key: '', template_id: '987654', password_login: true });
  assert.equal(r.data.api_key_set, true);
  assert.equal((await adm('POST', '/auth', { template_id: 'x1' })).data.error, 'bad_template_id');
  // sms.ir cannot be reached here: the test reports it and the panel shows SMS as down
  const t = await adm('POST', '/auth/test', { phone: '09120000000' });
  assert.equal(t.data.ok, false);
  assert.equal(t.data.status.down, true);
});

test('one-time login code for a user', async () => {
  S.db.prepare("UPDATE users SET phone='09121234567' WHERE username='ann'").run();
  const r = await adm('POST', '/users/ann/logincode');
  assert.equal(r.status, 200);
  assert.match(r.data.code, /^\d{6}$/);
  assert.equal(r.data.phone, '09121234567');
  const l = await S.api(null, 'POST', '/api/auth/code', { phone: '+98 912 123 4567', code: r.data.code });
  assert.equal(l.status, 200);
  assert.equal(l.data.username, 'ann');
  assert.equal((await adm('POST', '/users/nobody/logincode')).status, 404);
});

test('the same mobile number cannot go on two users', async () => {
  const r = await adm('POST', '/save', { users: { ben: { phone: '+989121234567' } } });
  assert.equal(r.status, 400);
  assert.equal(r.data.error, 'duplicate_phone');
  assert.equal((await adm('POST', '/save', { users: { ben: { phone: '09129999999' } } })).status, 200);
});

test('APK upload: only a zip file is accepted, then it is downloadable', async () => {
  assert.equal((await adm('POST', '/apk', null, Buffer.alloc(5000, 1))).data.error, 'not_an_apk');
  const apk = Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.alloc(5000, 9)]);
  const r = await adm('POST', '/apk', null, apk);
  assert.equal(r.status, 200);
  assert.equal(r.data.apk.size, apk.length);
  assert.deepEqual((await S.api(null, 'GET', '/download/sepan.apk')).data, apk);
  assert.equal((await adm('DELETE', '/apk')).data.apk, null);
  assert.equal((await S.api(null, 'GET', '/download/sepan.apk')).status, 404);
});
