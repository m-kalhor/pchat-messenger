'use strict';
// Web Push for the closed web app (iPhone): subscription checks, VAPID signature, RFC 8291 encryption
// (decrypted here like a browser would), who gets a push and what it contains.
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const crypto = require('node:crypto');
const { startServer } = require('./helpers/server');

let S, ali, bob, grp, sink, sinkUrl;
const got = [];

/** A fake push service on 127.0.0.1 that records what it is sent. */
function startSink() {
  return new Promise((resolve) => {
    sink = http.createServer((req, res) => {
      const chunks = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        got.push({ path: req.url, headers: req.headers, body: Buffer.concat(chunks) });
        res.writeHead(req.url.includes('gone') ? 410 : 201); res.end();
      });
    }).listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${sink.address().port}`));
  });
}

/** A browser's side of a subscription: its key pair and auth secret. */
function browser(path) {
  const ecdh = crypto.createECDH('prime256v1');
  const pub = ecdh.generateKeys();
  const auth = crypto.randomBytes(16);
  return {
    ecdh, auth,
    sub: { endpoint: sinkUrl + path, keys: { p256dh: pub.toString('base64url'), auth: auth.toString('base64url') } },
    decrypt(body) {
      const salt = body.subarray(0, 16), idlen = body[20], as = body.subarray(21, 21 + idlen), ct = body.subarray(21 + idlen);
      const shared = ecdh.computeSecret(as);
      const ikm = Buffer.from(crypto.hkdfSync('sha256', shared, auth, Buffer.concat([Buffer.from('WebPush: info\0'), pub, as]), 32));
      const cek = Buffer.from(crypto.hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0'), 16));
      const nonce = Buffer.from(crypto.hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: nonce\0'), 12));
      const d = crypto.createDecipheriv('aes-128-gcm', cek, nonce);
      d.setAuthTag(ct.subarray(ct.length - 16));
      const plain = Buffer.concat([d.update(ct.subarray(0, ct.length - 16)), d.final()]);
      assert.equal(plain.at(-1), 2, 'last-record delimiter');
      return JSON.parse(plain.subarray(0, -1).toString());
    },
  };
}
const waitPushes = async (n, ms = 3000) => {
  const end = Date.now() + ms;
  while (got.length < n && Date.now() < end) await new Promise((r) => setTimeout(r, 20));
  return got.splice(0);
};

test.before(async () => {
  sinkUrl = await startSink();
  S = await startServer({ PUSH_TEST_HTTP: '1' });
  grp = S.core.createCategory('خانواده');
  ali = await S.user('ali', [grp]);
  bob = await S.user('bob', [grp]);
  S.db.prepare("INSERT INTO visibility(viewer,target) VALUES('ali','bob'),('bob','ali')").run();
  S.db.prepare("UPDATE users SET display_name='علی' WHERE username='ali'").run();
});
test.after(async () => { if (S) await S.stop(); if (sink) sink.close(); });

test('only real push services (or the test sink) and well-formed keys are accepted', async () => {
  const k = browser('/x').sub.keys;
  for (const endpoint of ['http://evil.example/x', 'https://127.0.0.1/x', 'https://push.apple.com.evil.example/x', 'https://web.push.apple.com:444/x', 'ftp://x', 42]) {
    assert.equal((await S.api(bob, 'POST', '/api/push/subscribe', { subscription: { endpoint, keys: k } })).status, 400, String(endpoint));
  }
  assert.equal((await S.api(bob, 'POST', '/api/push/subscribe', { subscription: { endpoint: 'https://web.push.apple.com/abc', keys: { p256dh: 'AAAA', auth: k.auth } } })).status, 400);
  assert.equal((await S.api(bob, 'POST', '/api/push/subscribe', { subscription: { endpoint: 'https://web.push.apple.com/abc', keys: k } })).status, 200);
  assert.equal((await S.api(bob, 'POST', '/api/push/unsubscribe', { endpoint: 'https://web.push.apple.com/abc' })).status, 200);
  assert.equal(S.db.prepare('SELECT COUNT(*) AS n FROM push_subs').get().n, 0);
  const key = (await S.api(bob, 'GET', '/api/push/key')).data.key;
  assert.equal(Buffer.from(key, 'base64url').length, 65);
});

test('a closed web app gets an encrypted, signed push without the message text', async () => {
  const b = browser('/bob');
  assert.equal((await S.api(bob, 'POST', '/api/push/subscribe', { subscription: b.sub })).status, 200);
  const id = (await S.api(ali, 'POST', '/api/send', { target: 'bob', payload: 'ciphertext-that-must-not-leak' })).data.id;
  const [p] = await waitPushes(1);
  assert.equal(p.path, '/bob');
  assert.equal(p.headers['content-encoding'], 'aes128gcm');
  assert.equal(p.headers.ttl, '86400');
  assert.ok(!p.body.includes('ciphertext-that-must-not-leak'));
  assert.deepEqual(b.decrypt(p.body), { t: 'msg', convo: 'ali', id, title: 'علی', body: 'پیام تازه' });

  // VAPID: an ES256 JWT for the push service's origin, verifiable with the server's public key
  const m = /^vapid t=([^,]+), k=(.+)$/.exec(p.headers.authorization);
  assert.ok(m);
  const [h, c, sig] = m[1].split('.');
  const claims = JSON.parse(Buffer.from(c, 'base64url'));
  assert.equal(claims.aud, sinkUrl);
  assert.ok(claims.exp > Date.now() / 1000 && claims.exp < Date.now() / 1000 + 24 * 3600);
  const raw = Buffer.from(m[2], 'base64url');
  const pub = crypto.createPublicKey({ key: { kty: 'EC', crv: 'P-256', x: raw.subarray(1, 33).toString('base64url'), y: raw.subarray(33).toString('base64url') }, format: 'jwk' });
  assert.ok(crypto.verify('sha256', Buffer.from(h + '.' + c), { key: pub, dsaEncoding: 'ieee-p1363' }, Buffer.from(sig, 'base64url')));

  // group message: the group name and who wrote
  await S.api(ali, 'POST', '/api/send', { target: 'g:' + grp, payload: 'x' });
  const [g] = await waitPushes(1);
  assert.deepEqual({ ...b.decrypt(g.body), id: 0 }, { t: 'msg', convo: 'g:' + grp, id: 0, title: 'خانواده', body: 'علی: پیام تازه' });
  await waitPushes(9, 200);
  assert.equal(got.length, 0, 'the sender gets no push for their own message');
});

test('no push while the app is on screen, after logout, or once the push service says the subscription is gone', async () => {
  const ctl = new AbortController();
  const r = await fetch(S.base + '/api/events?since=999999999&dev=w&active=1', { headers: { authorization: 'Bearer ' + bob }, signal: ctl.signal });
  await r.body.getReader().read();
  await S.api(ali, 'POST', '/api/send', { target: 'bob', payload: 'x' });
  assert.equal((await waitPushes(1, 300)).length, 0);
  ctl.abort();
  await new Promise((res) => setTimeout(res, 100));

  // a subscription the push service rejects with 410 is dropped
  const gone = browser('/gone');
  await S.api(bob, 'POST', '/api/push/subscribe', { subscription: gone.sub });
  await S.api(ali, 'POST', '/api/send', { target: 'bob', payload: 'x' });
  await waitPushes(2);
  await new Promise((res) => setTimeout(res, 50));
  assert.equal(S.db.prepare("SELECT COUNT(*) AS n FROM push_subs WHERE endpoint LIKE '%gone'").get().n, 0);

  // the test button reports what the push services answered
  const t = await S.api(bob, 'POST', '/api/push/test');
  assert.deepEqual(t.data.results, [{ host: '127.0.0.1', status: 201 }]);
  assert.equal((await waitPushes(1)).length, 1);

  await S.api(bob, 'POST', '/api/logout');
  await S.api(ali, 'POST', '/api/send', { target: 'bob', payload: 'x' });
  assert.equal((await waitPushes(1, 300)).length, 0, 'the session that subscribed is gone');
});
