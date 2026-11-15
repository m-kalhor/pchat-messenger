'use strict';
// 1.18: admin panel second factor (authenticator codes) and the per-address lockout.
const test = require('node:test');
const assert = require('node:assert/strict');
const net = require('node:net');
const path = require('node:path');
const { startServer } = require('./helpers/server');

const freePort = () => new Promise((resolve) => { const s = net.createServer().listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); }); });

let S, base, T, cookie = '', csrf = '';
async function adm(method, p, body, keep = true) {
  const r = await fetch(base + '/admin/api' + p, {
    method, headers: { 'content-type': 'application/json', cookie, 'x-csrf': csrf }, body: body ? JSON.stringify(body) : undefined,
  });
  const set = r.headers.get('set-cookie');
  if (set && keep) cookie = set.split(';')[0];
  return { status: r.status, data: await r.json() };
}
async function login(password, code) {
  const r = await adm('POST', '/login', { username: 'admin', password, code });
  if (r.status === 200) csrf = r.data.csrf;
  return r;
}

test.before(async () => {
  const port = await freePort();
  S = await startServer({ ADMIN_DISABLE: '0', ADMIN_PORT: String(port) });
  base = `http://127.0.0.1:${port}`;
  const { setSetting, hashPassword } = require(path.join(S.app.appDir, 'db.js'));
  setSetting('admin_pass', hashPassword('first-pass-1'));
  T = require(path.join(S.app.appDir, 'totp.js'));
});
test.after(() => S && S.stop());

test('TOTP matches the RFC 6238 test vector and accepts one step of drift', () => {
  const secret = T.b32encode(Buffer.from('12345678901234567890'));
  assert.equal(T.codeAt(secret, 1), '287082'); // T = 59 s
  assert.equal(T.codeAt(secret, Math.floor(1111111109 / 30)), '081804');
  const t = 1111111109e3, s = T.stepNow(t);
  assert.equal(T.match(secret, T.codeAt(secret, s), -1, t), s);
  assert.equal(T.match(secret, T.codeAt(secret, s - 1), -1, t), s - 1);
  assert.equal(T.match(secret, T.codeAt(secret, s + 1), -1, t), s + 1);
  assert.equal(T.match(secret, T.codeAt(secret, s - 2), -1, t), null, 'two steps old is too old');
  assert.equal(T.match(secret, T.codeAt(secret, s), s, t), null, 'a used step does not count again');
  assert.equal(T.match(secret, '۰۸۱۸۰۴', -1, 1111111109e3), s, 'Persian digits are read too');
  assert.equal(T.match(secret, '12345', -1, t), null);
});

test('turning the second factor on needs the password and a code from the app', async () => {
  assert.equal((await login('first-pass-1')).status, 200);
  assert.equal((await adm('GET', '/login-info')).data.totp, false);
  assert.equal((await adm('POST', '/totp/start', { current: 'wrong' })).data.error, 'bad_current_password');
  assert.equal((await adm('POST', '/totp/confirm', { code: '123456' })).data.error, 'totp_not_started');
  const st = await adm('POST', '/totp/start', { current: 'first-pass-1' });
  assert.equal(st.status, 200);
  assert.match(st.data.secret, /^[A-Z2-7]{32}$/);
  assert.ok(st.data.uri.startsWith('otpauth://totp/Sepan:') && st.data.uri.includes('secret=' + st.data.secret));
  assert.ok(st.data.qr.startsWith('data:image/svg+xml;base64,'));
  // not on until a code proves the app has the secret
  assert.equal((await adm('GET', '/login-info')).data.totp, false);
  assert.equal((await adm('POST', '/totp/confirm', { code: '000000' === T.codeAt(st.data.secret, T.stepNow()) ? '111111' : '000000' })).data.error, 'bad_code');
  const ok = await adm('POST', '/totp/confirm', { code: T.codeAt(st.data.secret, T.stepNow()) });
  assert.equal(ok.status, 200, JSON.stringify(ok.data));
  assert.equal((await adm('GET', '/login-info')).data.totp, true);
  assert.equal((await adm('GET', '/session')).data.totp, true);
});

test('with the second factor on, sign-in needs password and code; the same code works once', async () => {
  const { getSetting } = require(path.join(S.app.appDir, 'db.js'));
  const secret = getSetting('admin_totp');
  cookie = ''; csrf = '';
  assert.equal((await login('first-pass-1')).data.error, 'bad_login', 'password alone is not enough');
  assert.equal((await login('first-pass-1', '000000' === T.codeAt(secret, T.stepNow()) ? '111111' : '000000')).data.error, 'bad_login');
  // the code used to switch it on is spent: the next step's code (one step of drift) still works
  const next = T.codeAt(secret, T.stepNow() + 1);
  assert.equal((await login('wrong', next)).data.error, 'bad_login', 'a right code with a wrong password is the same answer');
  const ok = await login('first-pass-1', next);
  assert.equal(ok.status, 200, JSON.stringify(ok.data));
  cookie = '';
  assert.equal((await login('first-pass-1', next)).data.error, 'bad_login', 'a used code is not accepted again');
});

test('turning it off needs password and a fresh code; then the password alone signs in', async () => {
  const { getSetting, setSetting } = require(path.join(S.app.appDir, 'db.js'));
  const secret = getSetting('admin_totp');
  setSetting('admin_totp_step', T.stepNow() - 2); // as if the last code was used a minute ago
  cookie = '';
  assert.equal((await login('first-pass-1', T.codeAt(secret, T.stepNow()))).status, 200);
  assert.equal((await adm('POST', '/totp/disable', { current: 'first-pass-1', code: '000' })).data.error, 'bad_password_or_code');
  assert.equal((await adm('POST', '/totp/disable', { current: 'first-pass-1', code: T.codeAt(secret, T.stepNow() + 1) })).status, 200);
  assert.equal((await adm('GET', '/login-info')).data.totp, false);
  cookie = '';
  assert.equal((await login('first-pass-1')).status, 200);
});

test('msgadmin totp-off is the way back when the phone is lost', () => {
  const { setSetting, getSetting } = require(path.join(S.app.appDir, 'db.js'));
  setSetting('admin_totp', T.newSecret());
  T.disable();
  assert.equal(getSetting('admin_totp'), null);
  assert.equal(T.enabled(), false);
});

test('wrong sign-ins lock out the address they come from, for 15 minutes', async () => {
  cookie = '';
  for (let i = 0; i < 5; i++) assert.equal((await login('wrong-' + i)).status, 401);
  const r = await login('first-pass-1');
  assert.equal(r.status, 429);
  assert.equal(r.data.error, 'rate_limited');
  assert.ok(r.data.wait > 800 && r.data.wait <= 900, String(r.data.wait));
});
