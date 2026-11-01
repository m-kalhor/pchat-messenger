'use strict';
// Sign-in by mobile number: SMS codes (a fake sms.ir), codes from another device and from the admin.
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const C = require('./helpers/pchat-crypto');
const { startServer } = require('./helpers/server');

let S, sms, smsUp = true;
const sent = []; // { mobile, templateId, code }
const post = (p, body, token) => S.api(token || null, 'POST', p, body);
const lastCode = () => sent[sent.length - 1].code;
const setSetting = (k, v) => S.db.prepare('INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(k, String(v));

test.before(async () => {
  sms = http.createServer((req, res) => {
    let b = '';
    req.on('data', (c) => { b += c; });
    req.on('end', () => {
      if (!smsUp) { res.writeHead(500); return res.end('{"status":0,"message":"down"}'); }
      if (req.headers['x-api-key'] !== 'test-key') { res.writeHead(401, { 'Content-Type': 'application/json' }); return res.end('{"status":0,"message":"bad key"}'); }
      if (req.url === '/v1/credit') { res.writeHead(200, { 'Content-Type': 'application/json' }); return res.end('{"status":1,"message":"ok","data":4200}'); }
      const j = JSON.parse(b);
      sent.push({ mobile: j.mobile, templateId: j.templateId, code: j.parameters[0].value, name: j.parameters[0].name });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{"status":1,"message":"ok","data":{"messageId":1,"cost":1}}');
    });
  });
  await new Promise((r) => sms.listen(0, '127.0.0.1', r));
  S = await startServer({ SMS_API_URL: `http://127.0.0.1:${sms.address().port}/v1` });
  S.core.createUser('sara', 'Sara', []);
  S.core.createUser('omid', 'Omid', []);
  S.db.prepare("UPDATE users SET phone='+98 912 111 2233' WHERE username='sara'").run();
  S.db.prepare("UPDATE users SET phone='09124445566' WHERE username='omid'").run();
  S.core.createUser('nima', 'Nima', []);
  S.db.prepare("UPDATE users SET phone='09127778899' WHERE username='nima'").run();
});
test.after(async () => { if (S) await S.stop(); if (sms) sms.close(); });

test('without sms.ir settings the login screen offers no SMS and sending says so', async () => {
  const c = (await S.api(null, 'GET', '/api/auth/config')).data;
  assert.deepEqual(c, { sms: false, password: true, apk: false });
  const r = await post('/api/auth/sms', { phone: '09121112233' });
  assert.equal(r.status, 503);
  assert.equal(r.data.error, 'sms_unavailable');
});

test('SMS code signs in once; every spelling of the number works', async () => {
  setSetting('sms_api_key', 'test-key'); setSetting('sms_template_id', '123456');
  assert.equal((await S.api(null, 'GET', '/api/auth/config')).data.sms, true);
  const r = await post('/api/auth/sms', { phone: '۰۹۱۲ ۱۱۱ ۲۲۳۳' });
  assert.equal(r.status, 200);
  assert.deepEqual(sent.at(-1).mobile, '09121112233');
  assert.equal(sent.at(-1).templateId, 123456);
  assert.equal(sent.at(-1).name, 'CODE');
  assert.match(lastCode(), /^\d{5}$/);
  const id = C.newIdentity();
  const ok = await post('/api/auth/code', { phone: '+989121112233', code: lastCode(), pubkey: id.pubB64, device: 'Android' });
  assert.equal(ok.status, 200);
  assert.equal(ok.data.username, 'sara');
  assert.equal(ok.data.via, 'sms');
  assert.equal(S.core.q.user.get('sara').pubkey, id.pubB64);
  assert.equal((await S.api(ok.data.token, 'GET', '/api/me')).data.username, 'sara');
  // the code is used up
  assert.equal((await post('/api/auth/code', { phone: '09121112233', code: lastCode() })).status, 401);
  // one SMS a minute per number
  const again = await post('/api/auth/sms', { phone: '09121112233' });
  assert.equal(again.status, 429);
  assert.equal(again.data.error, 'wait');
});

test('an unknown number gets the same answer but no SMS', async () => {
  const before = sent.length;
  const r = await post('/api/auth/sms', { phone: '09350000000' });
  assert.equal(r.status, 200);
  assert.equal(sent.length, before);
  assert.equal((await post('/api/auth/sms', { phone: '12' })).data.error, 'bad_phone');
});

test('three wrong tries kill the code', async () => {
  await post('/api/auth/sms', { phone: '09124445566' });
  const good = lastCode();
  for (let i = 0; i < 3; i++) {
    const bad = String((Number(good) + 1 + i) % 100000).padStart(5, '0');
    assert.equal((await post('/api/auth/code', { phone: '09124445566', code: bad })).status, 401);
  }
  assert.equal((await post('/api/auth/code', { phone: '09124445566', code: good })).status, 401, 'dead after 3 misses');
});

test('a signed-in device makes a code for a new one, and gets a login alert', async () => {
  const pw = S.core.resetPassword('omid');
  const t1 = (await post('/api/login', { username: 'omid', password: pw })).data.token;
  const d = await post('/api/auth/devicecode', {}, t1);
  assert.equal(d.status, 200);
  assert.match(d.data.code, /^\d{6}$/);
  assert.equal(d.data.phone, true);
  // listen on the first device for the alert
  const ctl = new AbortController();
  const ev = await fetch(S.base + '/api/events?since=0', { headers: { authorization: 'Bearer ' + t1 }, signal: ctl.signal });
  const reader = ev.body.getReader();
  const r = await post('/api/auth/code', { phone: '0912 444 5566', code: d.data.code, device: 'iPhone web' });
  assert.equal(r.status, 200);
  assert.equal(r.data.via, 'device');
  let text = '';
  const until = Date.now() + 5000;
  while (!/login_alert/.test(text) && Date.now() < until) text += new TextDecoder().decode((await reader.read()).value);
  ctl.abort();
  assert.match(text, /event: login_alert\ndata: .*"via":"device".*"device":"iPhone web"/);
  // also by username (a user without a mobile number)
  const d2 = await post('/api/auth/devicecode', {}, t1);
  assert.equal((await post('/api/auth/code', { username: 'omid', code: d2.data.code })).status, 200);
});

test('when sms.ir is down the error says so and the state is recorded', async () => {
  smsUp = false;
  const r = await post('/api/auth/sms', { phone: '09127778899' });
  assert.equal(r.status, 503);
  assert.equal(r.data.error, 'sms_unavailable');
  const st = JSON.parse(S.db.prepare("SELECT value FROM settings WHERE key='sms_last_error'").get().value);
  assert.ok(st.t > Date.now() - 10000);
  smsUp = true;
});

test('the admin code works once; disabled users cannot use codes', async () => {
  const auth = require(require('node:path').join(S.app.appDir, 'auth.js'));
  const { code } = auth.issue('sara', 'admin');
  assert.equal((await post('/api/auth/code', { phone: '09121112233', code })).status, 200);
  assert.equal((await post('/api/auth/code', { phone: '09121112233', code })).status, 401);
  const c2 = auth.issue('sara', 'admin').code;
  S.db.prepare("UPDATE users SET disabled=1 WHERE username='sara'").run();
  assert.equal((await post('/api/auth/code', { phone: '09121112233', code: c2 })).status, 401);
  S.db.prepare("UPDATE users SET disabled=0 WHERE username='sara'").run();
});

test('key backup: a fresh code sign-in or an SMS code stands in for the login password', async () => {
  const auth = require(require('node:path').join(S.app.appDir, 'auth.js'));
  const id = C.newIdentity();
  const t = (await post('/api/auth/code', { phone: '09121112233', code: auth.issue('sara', 'admin').code, pubkey: id.pubB64 })).data.token;
  const kb = C.exportBackup(id, 'sara', 'key-pass-1');
  assert.equal((await post('/api/keybackup', { key_backup: kb }, t)).status, 200, 'fresh code session needs no password');
  // an old session (or one opened with the password) must prove the account again
  S.db.prepare('UPDATE sessions SET created=? WHERE username=?').run(Date.now() - 3600e3, 'sara');
  assert.equal((await post('/api/keybackup', { key_backup: kb }, t)).status, 403);
  assert.equal((await post('/api/keybackup', { key_backup: kb, password: '12345' }, t)).status, 403);
  assert.equal((await post('/api/auth/reauth', {}, t)).status, 200);
  assert.equal((await post('/api/keybackup', { key_backup: kb, password: lastCode() }, t)).status, 200);
  const pw = S.core.resetPassword('omid');
  const tp = (await post('/api/login', { username: 'omid', password: pw })).data.token;
  assert.equal((await post('/api/keybackup', { key_backup: C.exportBackup(C.newIdentity(), 'omid', 'x-pass-12') }, tp)).status, 403, 'password sessions still need the password');
});

test('password login can be switched off', async () => {
  const pw = S.core.resetPassword('omid');
  setSetting('password_login', '0');
  const r = await post('/api/login', { username: 'omid', password: pw });
  assert.equal(r.status, 403);
  assert.equal(r.data.error, 'password_login_disabled');
  assert.equal((await S.api(null, 'GET', '/api/auth/config')).data.password, false);
  setSetting('password_login', '1');
  assert.equal((await post('/api/login', { username: 'omid', password: pw })).status, 200);
});

test('the APK is served when the admin put one in place', async () => {
  assert.equal((await S.api(null, 'GET', '/download/sepan.apk')).status, 404);
  const fs = require('node:fs');
  const apk = Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.alloc(2000, 7)]);
  fs.writeFileSync(require('node:path').join(S.app.dataDir, 'apk', 'sepan.apk'), apk);
  const r = await S.api(null, 'GET', '/download/sepan.apk');
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('content-type'), 'application/vnd.android.package-archive');
  assert.deepEqual(r.data, apk);
  assert.equal((await S.api(null, 'GET', '/api/auth/config')).data.apk, true);
});
