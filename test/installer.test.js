'use strict';
// 1.25: pieces of the new-server installer that live in the server: license (source tree = no check),
// app name branding, and `msgadmin setup` / `license request`.
const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { extractApp } = require('./helpers/extract');

const app = extractApp();
process.env.DATA_DIR = app.dataDir;
const cli = (args, input) => spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', path.join(app.appDir, 'cli.js'), ...args],
  { env: { ...process.env, DATA_DIR: app.dataDir }, input, encoding: 'utf8' });

test.after(() => app.cleanup());

test('source tree: no license needed, request code carries the machine and "src"', () => {
  const lic = require(path.join(app.appDir, 'license.js'));
  assert.equal(lic.PACKAGED, false);
  assert.equal(lic.check().ok, true);
  assert.equal(lic.userLimit(), 0);
  const r = lic.requestCode({ ip: '1.2.3.4', app: 'x', id: 'acme' });
  assert.match(r, /^SR1\./);
  const p = JSON.parse(Buffer.from(r.slice(4), 'base64url').toString());
  assert.equal(p.ip, '1.2.3.4'); assert.equal(p.id, 'acme'); assert.equal(p.bin, 'src'); assert.match(p.hw, /^[0-9a-f]{32}$/);
  assert.equal(lic.verify('SA1.e30.AAAA').ok, false);
  assert.equal(lic.verify('nonsense').why, 'format');
});

test('msgadmin setup writes the installer answers (secrets via stdin)', () => {
  const r = cli(['setup'], JSON.stringify({
    app_name: 'پیام‌یار', admin_user: 'boss', admin_pass: 'longenough1', open_signup: true, group_calls: false,
    sms: { provider: 'artapayamak', values: { token: 'abcdefghijk', from: '3000505', pattern: 'p1', param: 'code' } },
  }));
  assert.equal(r.status, 0, r.stderr);
  const { getSetting, checkPassword } = require(path.join(app.appDir, 'db.js'));
  assert.equal(getSetting('app_name'), 'پیام‌یار');
  assert.equal(getSetting('admin_user'), 'boss');
  assert.equal(getSetting('open_signup'), '1');
  assert.equal(getSetting('gcall_on'), '0');
  assert.equal(getSetting('sms_provider'), 'artapayamak');
  assert.ok(checkPassword('longenough1', getSetting('admin_pass')));
  assert.notEqual(cli(['setup'], JSON.stringify({ admin_pass: 'short' })).status, 0);
  assert.notEqual(cli(['setup'], JSON.stringify({ admin_user: 'Bad User' })).status, 0);
});

test('app name replaces «سپن» in served text', () => {
  const { brand, appName } = require(path.join(app.appDir, 'brand.js'));
  assert.equal(appName(), 'پیام‌یار');
  assert.equal(brand('ورود به سپن'), 'ورود به پیام‌یار');
  assert.ok(Buffer.isBuffer(brand(Buffer.from('سپن'))));
  const { setSetting } = require(path.join(app.appDir, 'db.js'));
  setSetting('app_name', '<b>x</b>');
  assert.equal(appName(), 'bx/b'); // markup characters are dropped
  setSetting('app_name', '');
  assert.equal(brand('سپن'), 'سپن');
});
