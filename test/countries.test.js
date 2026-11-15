'use strict';
// 1.17: the sign-in screen's country list and how the typed number is joined to the country code.
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const { normPhone } = require('../server/src/auth');

const load = () => import(path.join(__dirname, '../server/src/web/countries.mjs'));

test('country list: Iran first, unique codes, digits-only dial codes', async () => {
  const { COUNTRIES, flag } = await load();
  assert.deepStrictEqual(COUNTRIES[0], ['IR', 'ایران', '98']);
  assert.strictEqual(new Set(COUNTRIES.map((c) => c[0])).size, COUNTRIES.length);
  for (const [iso, name, dial] of COUNTRIES) {
    assert.match(iso, /^[A-Z]{2}$/);
    assert.ok(name.length > 1);
    assert.match(dial, /^[1-9]\d{0,3}$/);
  }
  assert.strictEqual(flag('IR'), '🇮🇷');
});

test('joinPhone: number without its 0, a trunk 0 typed anyway, Persian digits, a pasted +number', async () => {
  const { joinPhone } = await load();
  assert.strictEqual(joinPhone('98', '9123456789'), '+989123456789');
  assert.strictEqual(joinPhone('98', '0912 345 6789'), '+989123456789');
  assert.strictEqual(joinPhone('98', '۹۱۲۳۴۵۶۷۸۹'), '+989123456789');
  assert.strictEqual(joinPhone('44', '07911 123456'), '+447911123456');
  assert.strictEqual(joinPhone('98', '+1 555 123 4567'), '+15551234567');
  assert.strictEqual(joinPhone('98', '0044 7911 123456'), '+447911123456');
  // the server reads the joined number the same way
  assert.strictEqual(normPhone(joinPhone('98', '9123456789')), '+989123456789');
  assert.strictEqual(normPhone(joinPhone('49', '15112345678')), '+4915112345678');
});
