'use strict';
// Key backup: a new device (or the web app) restores the same identity key, so old messages stay readable.
const test = require('node:test');
const assert = require('node:assert/strict');
const C = require('./helpers/pchat-crypto');
const { startServer } = require('./helpers/server');

let S, pw;
const login = (password, pubkey) => S.api(null, 'POST', '/api/login', { username: 'sara', password, pubkey });

test.before(async () => {
  S = await startServer();
  pw = S.core.createUser('sara', 'Sara', []);
  S.core.createUser('omid', 'Omid', []);
  S.db.prepare("INSERT INTO visibility(viewer,target) VALUES('omid','sara'),('sara','omid')").run();
});
test.after(() => S && S.stop());

test('first device uploads a backup; a second device restores it and reads old messages', async () => {
  const phone = C.newIdentity();
  const r1 = await login(pw, phone.pubB64);
  assert.equal(r1.status, 200);
  assert.equal(r1.data.key_backup, null);
  const t1 = r1.data.token;
  assert.equal((await S.api(t1, 'POST', '/api/keybackup', { key_backup: C.exportBackup(phone, 'sara', pw), password: pw })).status, 200);

  // omid writes to sara's (phone) key
  const omid = C.newIdentity();
  const tO = (await S.api(null, 'POST', '/api/login', { username: 'omid', password: S.core.resetPassword('omid'), pubkey: omid.pubB64 })).data.token;
  const saraPub = (await S.api(tO, 'GET', '/api/users')).data.find((u) => u.username === 'sara').pubkey;
  assert.equal(saraPub, phone.pubB64);
  const payload = C.encryptFor(omid, 'omid', 'sara', { omid: omid.pubB64, sara: saraPub }, 'سلام');

  // a new device logs in with a fresh key: the server keeps the backed-up key and hands the backup over
  const web = C.newIdentity();
  const r2 = await login(pw, web.pubB64);
  assert.equal(r2.status, 200);
  assert.equal(S.core.q.user.get('sara').pubkey, phone.pubB64, 'the fresh key must not replace the backed-up one');
  const restored = C.importBackup(r2.data.key_backup, 'sara', pw);
  assert.equal(restored.pubB64, phone.pubB64);
  assert.equal(C.decryptFrom(restored, 'sara', 'omid', 'sara', omid.pubB64, payload).toString(), 'سلام');
  assert.throws(() => C.importBackup(r2.data.key_backup, 'sara', 'wrong-password'));
  assert.throws(() => C.importBackup(r2.data.key_backup, 'omid', pw), 'the username is bound into the backup');

  // the old pubkey endpoint cannot silently swap the key behind a backup
  assert.equal((await S.api(r2.data.token, 'POST', '/api/pubkey', { pubkey: web.pubB64 })).status, 409);
  assert.deepEqual((await S.api(r2.data.token, 'GET', '/api/keybackup')).data.key_backup, r2.data.key_backup);
});

test('after a password reset the old device re-wraps the same key with the new password', async () => {
  const kb = (await login(pw, undefined)).data.key_backup;
  const phone = C.importBackup(kb, 'sara', pw);
  const pw2 = S.core.resetPassword('sara');
  const r = await login(pw2, phone.pubB64);
  assert.throws(() => C.importBackup(r.data.key_backup, 'sara', pw2), 'old backup needs the old password');
  assert.equal((await S.api(r.data.token, 'POST', '/api/keybackup', { key_backup: C.exportBackup(phone, 'sara', pw2), password: pw2 })).status, 200);
  assert.equal(C.importBackup((await login(pw2)).data.key_backup, 'sara', pw2).pubB64, phone.pubB64);
});

test('malformed backups are refused', async () => {
  const p3 = S.core.resetPassword('sara');
  const t = (await login(p3)).data.token;
  assert.equal((await S.api(t, 'POST', '/api/keybackup', { key_backup: C.exportBackup(C.newIdentity(), 'sara', p3), password: 'nope' })).data.error, 'bad_password',
    'a session token alone cannot replace the key');
  for (const bad of [null, { v: 2 }, { v: 1, kdf: 'pbkdf2-sha256', iter: 10, salt: 'x', iv: 'x', ct: 'x', pub: 'x' }]) {
    assert.equal((await S.api(t, 'POST', '/api/keybackup', { key_backup: bad, password: p3 })).data.error, 'bad_key_backup');
  }
});
