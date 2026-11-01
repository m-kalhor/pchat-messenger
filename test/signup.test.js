'use strict';
// Open sign-up (SMS-proven number, own username) and finding members by mobile number.
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { startServer } = require('./helpers/server');

let S, sms;
const sent = [];
const post = (p, body, token) => S.api(token || null, 'POST', p, body);
const adminCode = (u) => require(require('node:path').join(S.app.appDir, 'auth.js')).issue(u, 'admin').code;
const setSetting = (k, v) => S.db.prepare('INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(k, String(v));

test.before(async () => {
  sms = http.createServer((req, res) => {
    let b = '';
    req.on('data', (c) => { b += c; });
    req.on('end', () => {
      const j = JSON.parse(b || '{}');
      if (j.parameters) sent.push({ mobile: j.mobile, code: j.parameters[0].value });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{"status":1,"message":"ok","data":{}}');
    });
  });
  await new Promise((r) => sms.listen(0, '127.0.0.1', r));
  S = await startServer({ SMS_API_URL: `http://127.0.0.1:${sms.address().port}/v1`, SIGNUPS_PER_IP: '3' });
  setSetting('sms_api_key', 'k'); setSetting('sms_template_id', '1');
  S.core.createUser('omid', 'Omid', []);
  S.db.prepare("UPDATE users SET phone='09124445566' WHERE username='omid'").run();
});
test.after(async () => { if (S) await S.stop(); if (sms) sms.close(); });

async function proveNumber(phone) {
  assert.equal((await post('/api/auth/sms', { phone })).status, 200);
  return post('/api/auth/code', { phone, code: sent.at(-1).code });
}

test('without open sign-up a new number gets no SMS and no account', async () => {
  assert.equal((await S.api(null, 'GET', '/api/auth/config')).data.signup, false);
  const before = sent.length;
  assert.equal((await post('/api/auth/sms', { phone: '09350001111' })).status, 200);
  assert.equal(sent.length, before);
});

test('open sign-up: SMS proves the number, the user picks a username, sees nobody', async () => {
  setSetting('open_signup', '1');
  assert.equal((await S.api(null, 'GET', '/api/auth/config')).data.signup, true);
  const r = await proveNumber('0935 000 2222');
  assert.equal(r.status, 200);
  assert.equal(r.data.signup, true);
  assert.equal(r.data.phone, '09350002222');
  const t = r.data.ticket;
  assert.equal((await post('/api/auth/signup', { ticket: t, username: 'Omid' })).data.error, 'user_exists');
  assert.equal((await post('/api/auth/signup', { ticket: t, username: '1234' })).data.error, 'invalid_username');
  const ok = await post('/api/auth/signup', { ticket: t, username: 'nava', display_name: 'نوا', device: 'Android' });
  assert.equal(ok.status, 200);
  assert.equal(ok.data.created, true);
  assert.equal(ok.data.username, 'nava');
  const u = S.core.q.user.get('nava');
  assert.equal(u.phone, '09350002222');
  assert.equal(u.display_name, 'نوا');
  const users = (await S.api(ok.data.token, 'GET', '/api/users')).data;
  assert.deepEqual(users.map((x) => x.username), ['nava'], 'a new user sees nobody');
  assert.equal((await post('/api/auth/signup', { ticket: t, username: 'nava2' })).data.error, 'bad_ticket', 'ticket is single-use');
  // the number now belongs to nava: the next code signs in
  const again = await post('/api/auth/code', { phone: '09350002222', code: adminCode('nava') });
  assert.equal(again.data.username, 'nava');
});

test('new users join the default category when the admin set one', async () => {
  const g = S.core.createCategory('مشتریان');
  setSetting('signup_category', g);
  const r = await proveNumber('09350003333');
  const ok = await post('/api/auth/signup', { ticket: r.data.ticket, username: 'sami' });
  assert.equal(ok.status, 200);
  assert.deepEqual(S.core.groupsOf('sami').map((x) => x.id), [g]);
  setSetting('signup_category', '');
});

test('a few accounts per IP per day', async () => {
  const r = await proveNumber('09350004444');
  assert.equal((await post('/api/auth/signup', { ticket: r.data.ticket, username: 'third' })).status, 200);
  const r2 = await proveNumber('09350005555');
  assert.equal((await post('/api/auth/signup', { ticket: r2.data.ticket, username: 'fourth' })).data.error, 'rate_limited');
});

test('lookup by mobile number finds findable members only', async () => {
  const pw = S.core.resetPassword('omid');
  const tO = (await post('/api/login', { username: 'omid', password: pw })).data.token;
  const tN = (await post('/api/auth/code', { phone: '09350002222', code: adminCode('nava') })).data.token;
  let r = await post('/api/contacts/lookup', { phones: ['+98 935 000 2222', '09350003333', '0999 000 0000', '09124445566'] }, tO);
  assert.equal(r.status, 200);
  assert.deepEqual(r.data.matches.map((m) => m.username).sort(), ['nava', 'sami']);
  assert.equal(r.data.matches.find((m) => m.username === 'nava').connected, false);
  // nava hides herself
  assert.equal((await post('/api/privacy', { findable: false }, tN)).data.findable, false);
  assert.equal((await S.api(tN, 'GET', '/api/me')).data.findable, false);
  r = await post('/api/contacts/lookup', { phones: ['09350002222'] }, tO);
  assert.deepEqual(r.data.matches, []);
  // then a request connects them as before
  assert.equal((await post('/api/contacts/request', { username: 'sami' }, tO)).data.result, 'sent');
});

test('lookups are capped per day', async () => {
  const pw = S.core.resetPassword('omid');
  const t = (await post('/api/login', { username: 'omid', password: pw })).data.token;
  const many = Array.from({ length: 2000 }, (_, i) => '0912' + String(1000000 + i));
  assert.equal((await post('/api/contacts/lookup', { phones: many }, t)).status, 200);
  assert.equal((await post('/api/contacts/lookup', { phones: many.map((x) => x.replace('0912', '0913')) }, t)).status, 429);
});
