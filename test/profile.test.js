'use strict';
// Profile: bio (Telegram-style, 70 chars) and removing the profile photo.
const test = require('node:test');
const assert = require('node:assert/strict');
const { startServer } = require('./helpers/server');

const WEBP = Buffer.from('UklGRhoAAABXRUJQVlA4TA0AAAAvAAAAEAcQERGIiP4HAA==', 'base64'); // 1x1 lossless
let S, a, b;
test.before(async () => {
  S = await startServer();
  const g = S.core.createCategory('دوستان');
  a = await S.user('amy', [g]);
  b = await S.user('bo', [g]);
});
test.after(() => S && S.stop());

test('bio is saved, trimmed to 70 chars and visible to contacts', async () => {
  const long = 'سلام  دنیا\n' + 'x'.repeat(100);
  const r = await S.api(a, 'POST', '/api/profile', { bio: long });
  assert.equal(r.status, 200);
  assert.equal(r.data.bio.length, 70);
  assert.ok(r.data.bio.startsWith('سلام دنیا x'));
  assert.equal(r.data.display_name, 'AMY', 'sending only a bio keeps the display name');
  assert.equal((await S.api(a, 'GET', '/api/me')).data.bio, r.data.bio);
  const seen = (await S.api(b, 'GET', '/api/users')).data.find((u) => u.username === 'amy');
  assert.equal(seen.bio, r.data.bio);
  assert.equal((await S.api(a, 'POST', '/api/profile', { bio: '' })).data.bio, null);
});

test('removing the photo hides it and the next upload gets a newer version', async () => {
  const up = await S.api(a, 'POST', '/api/avatar', WEBP, { 'content-type': 'image/webp' });
  assert.equal(up.status, 200, JSON.stringify(up.data));
  assert.equal(up.data.avatar_ver, 1);
  assert.equal((await S.api(b, 'GET', '/api/avatar/amy')).status, 200);
  const del = await S.api(a, 'DELETE', '/api/avatar');
  assert.equal(del.data.avatar_ver, -1);
  assert.equal((await S.api(b, 'GET', '/api/avatar/amy')).data.error, 'no_avatar');
  assert.equal((await S.api(a, 'POST', '/api/avatar', WEBP, { 'content-type': 'image/webp' })).data.avatar_ver, 2);
});
