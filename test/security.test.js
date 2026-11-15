'use strict';
// 1.18.1 hardening: sign-in code limits per real account, the overall SMS budget, password lockout per
// account + address, per-user upload quota, and the setup page / APK only over https once there is a domain.
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { startServer } = require('./helpers/server');

let S, sms;
const sent = [];
const setSetting = (k, v) => S.db.prepare('INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(k, String(v));

/** A request from another loopback address (127.0.0.x), so each test has its own client address. */
function from(ip, method, p, body, token) {
  return new Promise((resolve, reject) => {
    const u = new URL(S.base + p);
    const data = body === undefined ? null : Buffer.from(JSON.stringify(body));
    const headers = { ...(data ? { 'content-type': 'application/json', 'content-length': data.length } : {}), ...(token ? { authorization: 'Bearer ' + token } : {}) };
    const req = http.request({ host: u.hostname, port: u.port, path: u.pathname, method, headers, localAddress: ip }, (res) => {
      let b = '';
      res.on('data', (c) => { b += c; });
      res.on('end', () => { let d = b; try { d = JSON.parse(b); } catch { } resolve({ status: res.statusCode, data: d }); });
    });
    req.on('error', reject);
    req.end(data || undefined);
  });
}

test.before(async () => {
  sms = http.createServer((req, res) => {
    let b = '';
    req.on('data', (c) => { b += c; });
    req.on('end', () => {
      const j = JSON.parse(b || '{}');
      if (j.params) sent.push({ mobile: j.recipients[0], code: Object.values(j.params)[0] });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ data: { message_outbox_ids: [1] }, meta: { status: true, message: 'ok', message_code: '200-1' } }));
    });
  });
  await new Promise((r) => sms.listen(0, '127.0.0.1', r));
  S = await startServer({ SMS_API_URL: `http://127.0.0.1:${sms.address().port}/v1`, MAX_USER_MB: '1', MAX_OPEN_UPLOADS: '2' });
  setSetting('sms_cfg_artapayamak', JSON.stringify({ token: 't', from: '3000505', pattern: 'p1' }));
  for (const [u, ph] of [['sara1', '09121110001'], ['omid1', '09121110002'], ['nima1', '09121110003'], ['leila1', '09121110004']]) {
    S.core.createUser(u, u, []);
    S.db.prepare('UPDATE users SET phone=? WHERE username=?').run('+98' + ph.slice(1), u);
  }
});
test.after(async () => { if (S) await S.stop(); if (sms) sms.close(); });

test('wrong codes count against the real account, whatever spelling the request used', async () => {
  const spellings = ['sara1', ' sara1', 'SARA1 ', '+989121110001', '۰۹۱۲۱۱۱۰۰۰۱'];
  for (const s of spellings) assert.equal((await from('127.0.0.11', 'POST', '/api/auth/code', { username: s, code: '000000' })).status, 401, s);
  for (const s of ['sara1', '\tsara1\t', '09121110001']) {
    const r = await from('127.0.0.12', 'POST', '/api/auth/code', { username: s, code: '000000' });
    assert.equal(r.status, 429, 'locked for every spelling: ' + JSON.stringify(s));
  }
});

test('the server sends at most sms_max_hour codes an hour, then answers sms_busy', async () => {
  setSetting('sms_max_hour', 2);
  const before = sent.length;
  assert.equal((await from('127.0.0.21', 'POST', '/api/auth/sms', { phone: '09121110002' })).status, 200);
  assert.equal((await from('127.0.0.22', 'POST', '/api/auth/sms', { phone: '09121110003' })).status, 200);
  const r = await from('127.0.0.23', 'POST', '/api/auth/sms', { phone: '09121110004' });
  assert.equal(r.status, 429);
  assert.equal(r.data.error, 'sms_busy');
  assert.equal(sent.length - before, 2, 'the third SMS never went out');
  assert.ok(Number(S.db.prepare("SELECT value FROM settings WHERE key='sms_cap_hit'").get().value) > 0, 'the panel can show it');
  setSetting('sms_max_hour', 0); // 0 = no limit
  assert.equal((await from('127.0.0.24', 'POST', '/api/auth/sms', { phone: '09121110004' })).status, 200);
});

test('wrong passwords from one address do not lock the owner out elsewhere', async () => {
  const pw = S.core.resetPassword('omid1');
  for (let i = 0; i < 5; i++) assert.equal((await from('127.0.0.31', 'POST', '/api/login', { username: 'omid1', password: 'x' + i })).status, 401);
  assert.equal((await from('127.0.0.31', 'POST', '/api/login', { username: 'omid1', password: pw })).status, 429, 'the guessing address is locked');
  const ok = await from('127.0.0.32', 'POST', '/api/login', { username: 'omid1', password: pw });
  assert.equal(ok.status, 200, 'the owner on another address signs in');
  // the guesses do not block the owner's own password change either (own counter)
  const r = await from('127.0.0.32', 'POST', '/api/password', { current: 'wrong-one', password: 'new-password-1' }, ok.data.token);
  assert.equal(r.status, 403);
  assert.equal((await from('127.0.0.32', 'POST', '/api/password', { current: pw, password: 'new-password-1' }, ok.data.token)).status, 200);
});

test('one user cannot reserve more than their quota or keep many uploads open', async () => {
  const pw = S.core.resetPassword('nima1');
  const tok = (await from('127.0.0.41', 'POST', '/api/login', { username: 'nima1', password: pw })).data.token;
  const big = await from('127.0.0.41', 'POST', '/api/uploads', { size: 2 * 1024 * 1024 }, tok);
  assert.equal(big.status, 507);
  assert.equal(big.data.error, 'user_quota');
  assert.equal((await from('127.0.0.41', 'POST', '/api/uploads', { size: 1000 }, tok)).status, 200);
  assert.equal((await from('127.0.0.41', 'POST', '/api/uploads', { size: 1000 }, tok)).status, 200);
  const third = await from('127.0.0.41', 'POST', '/api/uploads', { size: 1000 }, tok);
  assert.equal(third.status, 429);
  assert.equal(third.data.error, 'too_many_uploads');
});

const freePort = () => new Promise((resolve) => { const s = require('node:net').createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); }); });
const get = (url, headers = {}) => new Promise((resolve, reject) => {
  http.get(url, { headers }, (res) => { const c = []; res.on('data', (d) => c.push(d)); res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(c).toString() })); }).on('error', reject);
});

test('with a domain, the setup page, iPhone profile and APK leave plain http for https on the domain', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pchat-dom-'));
  const certDir = path.join(root, 'web');
  fs.mkdirSync(certDir);
  fs.mkdirSync(path.join(root, 'le', 'sepan.example.ir'), { recursive: true });
  for (const f of ['cert.pem', 'key.pem']) fs.writeFileSync(path.join(root, 'le', 'sepan.example.ir', f), 'x');
  const [webPort, httpPort] = [await freePort(), await freePort()];
  const W = await startServer({ WEB_DISABLE: '0', WEB_PORT: String(webPort), WEB_HTTP_PORT: String(httpPort), WEB_CERT_DIR: certDir, PUBLIC_HOST: '10.9.9.9', WEB_TEST_DOMAIN: '1' });
  t.after(() => { W.stop(); fs.rmSync(root, { recursive: true, force: true }); });
  for (let i = 0; i < 50; i++) { try { await get(`http://127.0.0.1:${httpPort}/x`); break; } catch { await new Promise((r) => setTimeout(r, 100)); } }
  for (const p of ['/setup', '/sepan-ca.mobileconfig', '/sepan-ca.crt', '/download/sepan.apk', '/download/sepan-qr.svg']) {
    const r = await get(`http://127.0.0.1:${httpPort}${p}`, { host: '10.9.9.9' });
    assert.equal(r.status, 302, p);
    assert.equal(r.headers.location, `https://sepan.example.ir:${webPort}${p}`);
  }
  // the web app itself stays on the IP address (its keys live there)
  assert.equal((await get(`http://127.0.0.1:${httpPort}/`, { host: '10.9.9.9' })).headers.location, `https://10.9.9.9:${webPort}/`);
  // the guide's «باز کردن سپن» opens the app on the server address, also when read on the domain
  const page = await get(`http://127.0.0.1:${webPort}/setup`, { host: 'sepan.example.ir' });
  assert.equal(page.status, 200);
  assert.match(page.body, new RegExp(`href="https://10\\.9\\.9\\.9:${webPort}/" id="open"`));
});
