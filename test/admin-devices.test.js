'use strict';
// 1.24: paired phones («سپن مدیر»): pairing, challenge sign-in, removal, expiry, password change.
const test = require('node:test');
const assert = require('node:assert/strict');
const net = require('node:net');
const path = require('node:path');
const crypto = require('node:crypto');
const { startServer } = require('./helpers/server');

const freePort = () => new Promise((resolve) => { const s = net.createServer().listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); }); });

let S, base, D, db;
function client() {
  const c = { cookie: '', csrf: '' };
  c.call = async (method, p, body) => {
    const r = await fetch(base + '/admin/api' + p, { method, headers: { 'content-type': 'application/json', cookie: c.cookie, 'x-csrf': c.csrf }, body: body ? JSON.stringify(body) : undefined });
    const set = r.headers.get('set-cookie');
    if (set) c.cookie = set.split(';')[0];
    let data = null; try { data = await r.json(); } catch { }
    if (data && data.csrf) c.csrf = data.csrf;
    return { status: r.status, data };
  };
  return c;
}
const phoneKey = () => {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  return { pub: publicKey.export({ format: 'der', type: 'spki' }).toString('base64'), priv: privateKey };
};
async function deviceLogin(c, id, priv) {
  const ch = await c.call('POST', '/device/challenge', { id });
  if (ch.status !== 200) return ch;
  const sig = crypto.sign('sha256', Buffer.from(D.signedText(id, ch.data.nonce)), priv).toString('base64');
  return c.call('POST', '/device/login', { id, nonce: ch.data.nonce, sig });
}

test.before(async () => {
  const port = await freePort();
  S = await startServer({ ADMIN_DISABLE: '0', ADMIN_PORT: String(port) });
  base = `http://127.0.0.1:${port}`;
  const m = require(path.join(S.app.appDir, 'db.js'));
  m.setSetting('admin_pass', m.hashPassword('first-pass-1'));
  db = m.db;
  D = require(path.join(S.app.appDir, 'admindevices.js'));
});
test.after(() => S && S.stop());

test('a phone pairs from a password session and then signs in with its key', async () => {
  const web = client();
  assert.equal((await web.call('POST', '/devices/pair', { name: 'x', pubkey: phoneKey().pub })).status, 401);
  assert.equal((await web.call('POST', '/login', { username: 'admin', password: 'first-pass-1' })).status, 200);
  assert.equal((await web.call('GET', '/session')).data.can_pair, true);
  assert.equal((await web.call('POST', '/devices/pair', { name: 'x', pubkey: 'AAAA' })).data.error, 'bad_device_key');
  const rsa = crypto.generateKeyPairSync('rsa', { modulusLength: 1024 }).publicKey.export({ format: 'der', type: 'spki' }).toString('base64');
  assert.equal((await web.call('POST', '/devices/pair', { name: 'x', pubkey: rsa })).data.error, 'bad_device_key');
  const k = phoneKey();
  const p = await web.call('POST', '/devices/pair', { name: 'Galaxy A54', pubkey: k.pub });
  assert.equal(p.status, 200);
  assert.match(p.data.id, /^[a-f0-9]{32}$/);
  assert.equal((await web.call('POST', '/devices/pair', { name: 'again', pubkey: k.pub })).data.error, 'device_exists');

  const phone = client();
  const r = await deviceLogin(phone, p.data.id, k.priv);
  assert.equal(r.status, 200);
  const s = await phone.call('GET', '/session');
  assert.equal(s.data.device, p.data.id);
  assert.equal(s.data.can_pair, false, 'a phone session cannot pair more phones');
  assert.equal((await phone.call('POST', '/devices/pair', { name: 'y', pubkey: phoneKey().pub })).data.error, 'pair_needs_fresh_login');
  const l = await phone.call('GET', '/devices');
  assert.equal(l.data.current, p.data.id);
  assert.equal(l.data.devices.length, 1);
  assert.equal(l.data.devices[0].name, 'Galaxy A54');
  assert.equal(l.data.expire_days, 90);
  assert.ok(!('pubkey' in l.data.devices[0]));
});

test('a wrong key, a reused or foreign challenge and an unknown device are refused', async () => {
  const id = D.list()[0].id;
  const c = client();
  const ch = await c.call('POST', '/device/challenge', { id });
  const other = phoneKey();
  const bad = crypto.sign('sha256', Buffer.from(D.signedText(id, ch.data.nonce)), other.priv).toString('base64');
  assert.equal((await c.call('POST', '/device/login', { id, nonce: ch.data.nonce, sig: bad })).data.error, 'bad_signature');
  // the challenge was used up by the failed try
  assert.equal((await c.call('POST', '/device/login', { id, nonce: ch.data.nonce, sig: bad })).status, 401);
  assert.equal((await c.call('POST', '/device/challenge', { id: 'f'.repeat(32) })).data.error, 'device_unknown');
  assert.equal((await c.call('GET', '/state')).status, 401);
});

test('removing a phone ends its open session; changing the password removes every phone', async () => {
  // reset lockout counters from the failed tries above with a good password sign-in
  const web = client();
  assert.equal((await web.call('POST', '/login', { username: 'admin', password: 'first-pass-1' })).status, 200);
  const k1 = phoneKey(), k2 = phoneKey();
  const id1 = (await web.call('POST', '/devices/pair', { name: 'one', pubkey: k1.pub })).data.id;
  const id2 = (await web.call('POST', '/devices/pair', { name: 'two', pubkey: k2.pub })).data.id;
  const ph1 = client();
  assert.equal((await deviceLogin(ph1, id1, k1.priv)).status, 200);
  assert.equal((await ph1.call('GET', '/state')).status, 200);
  assert.equal((await web.call('POST', '/devices/remove', { id: id1 })).data.removed, 1);
  assert.equal((await ph1.call('GET', '/state')).status, 401, 'the removed phone is signed out at once');
  assert.equal((await deviceLogin(client(), id1, k1.priv)).data.error, 'device_unknown');

  const ph2 = client();
  assert.equal((await deviceLogin(ph2, id2, k2.priv)).status, 200);
  assert.equal((await ph2.call('POST', '/account', { current: 'first-pass-1', password: 'second-pass-2' })).status, 200);
  assert.equal(D.list().length, 0);
  // the session that changed the password stays, proven by the password now, and may pair this phone again
  const s = await ph2.call('GET', '/session');
  assert.equal(s.status, 200);
  assert.equal(s.data.device, null);
  assert.equal(s.data.can_pair, true);
});

test('a phone unused for 90 days expires; the window slides with every sign-in', async () => {
  const web = client();
  assert.equal((await web.call('POST', '/login', { username: 'admin', password: 'second-pass-2' })).status, 200);
  const k = phoneKey();
  const id = (await web.call('POST', '/devices/pair', { name: 'old', pubkey: k.pub })).data.id;
  db.prepare('UPDATE admin_devices SET last_used=? WHERE id=?').run(Date.now() - 89 * 86400e3, id);
  assert.equal((await deviceLogin(client(), id, k.priv)).status, 200);
  assert.ok(D.list()[0].last_used > Date.now() - 60e3, 'signing in renews it');
  db.prepare('UPDATE admin_devices SET last_used=? WHERE id=?').run(Date.now() - 91 * 86400e3, id);
  assert.equal((await deviceLogin(client(), id, k.priv)).data.error, 'device_unknown');
  assert.equal(D.list().length, 0);
});

test('at most 10 phones; removing all works', async () => {
  const web = client();
  assert.equal((await web.call('POST', '/login', { username: 'admin', password: 'second-pass-2' })).status, 200);
  for (let i = 0; i < 10; i++) assert.equal((await web.call('POST', '/devices/pair', { name: 'p' + i, pubkey: phoneKey().pub })).status, 200);
  assert.equal((await web.call('POST', '/devices/pair', { name: 'p11', pubkey: phoneKey().pub })).data.error, 'too_many_devices');
  assert.equal((await web.call('POST', '/devices/remove', { all: true })).data.removed, 10);
});

test('the «سپن مدیر» APK info is empty until one is uploaded', async () => {
  const web = client();
  assert.equal((await web.call('POST', '/login', { username: 'admin', password: 'second-pass-2' })).status, 200);
  assert.equal((await web.call('GET', '/adminapp')).data.app, null);
  assert.equal((await web.call('GET', '/adminapp/download')).status, 404);
});
