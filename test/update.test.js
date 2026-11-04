'use strict';
// 1.9: the app asks the server which APK version is uploaded (in-app update, never forced),
// and users change their own login password.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { startServer } = require('./helpers/server');
const { fakeApk } = require('./helpers/fakeapk');
const { parseApk } = require('../server/src/apkinfo');

let S;
test.before(async () => { S = await startServer(); });
test.after(() => S && S.stop());

test('parseApk reads versionCode and versionName', () => {
  assert.deepEqual(parseApk(fakeApk(10, '1.9.0')), { code: 10, name: '1.9.0' });
  assert.throws(() => parseApk(Buffer.alloc(3000, 7)));
});

test('GET /api/app/version: null without an APK, the version after an upload', async () => {
  assert.deepEqual((await S.api(null, 'GET', '/api/app/version')).data, { code: null });
  const apk = fakeApk(12, '1.9.1');
  fs.mkdirSync(path.join(process.env.DATA_DIR, 'apk'), { recursive: true });
  fs.writeFileSync(path.join(process.env.DATA_DIR, 'apk', 'sepan.apk'), apk);
  assert.deepEqual((await S.api(null, 'GET', '/api/app/version')).data, { code: 12, name: '1.9.1', size: apk.length });
  // a file that is not readable as an APK gives no version (no update offered)
  fs.writeFileSync(path.join(process.env.DATA_DIR, 'apk', 'sepan.apk'), Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.alloc(3000, 7)]));
  assert.deepEqual((await S.api(null, 'GET', '/api/app/version')).data, { code: null });
});

test('a user changes their own login password; other devices are logged out', async () => {
  const pw = S.core.createUser('nima', 'Nima', []);
  const t1 = await S.login('nima', pw);
  const t2 = await S.login('nima', pw);
  assert.equal((await S.api(t1, 'POST', '/api/password', { current: pw, password: 'short' })).data.error, 'weak_password');
  assert.equal((await S.api(t1, 'POST', '/api/password', { current: 'wrong-pass', password: 'new-password-1' })).status, 403);
  assert.equal((await S.api(t1, 'POST', '/api/password', { current: pw, password: 'new-password-1' })).status, 200);
  assert.equal((await S.api(t1, 'GET', '/api/me')).status, 200, 'this device stays signed in');
  assert.equal((await S.api(t2, 'GET', '/api/me')).status, 401, 'the other device is logged out');
  assert.equal((await S.api(null, 'POST', '/api/login', { username: 'nima', password: pw })).status, 401);
  assert.equal((await S.api(null, 'POST', '/api/login', { username: 'nima', password: 'new-password-1' })).status, 200);
});
