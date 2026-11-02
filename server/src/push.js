'use strict';
/**
 * Web Push (RFC 8030 / 8291 / 8292) for the web version, so an iPhone with Sepan on its home screen
 * (iOS 16.4+) gets a notification while the app is closed. No Apple or Google account is needed: the
 * browser hands us an endpoint on its push service (web.push.apple.com, fcm.googleapis.com, ...), we
 * sign a VAPID token with our own key and send the payload encrypted for that one browser, so the push
 * service only sees ciphertext. The payload never contains message text (that stays end-to-end
 * encrypted), only "new message from …".
 */
const https = require('node:https');
const http = require('node:http');
const crypto = require('node:crypto');
const { db, getSetting, setSetting } = require('./db');

const b64u = (b) => Buffer.from(b).toString('base64url');
const unb64u = (s) => Buffer.from(String(s), 'base64url');

// push services of the browsers that support Web Push; anything else is refused (no requests to
// arbitrary hosts on behalf of a user)
const HOSTS = ['push.apple.com', 'googleapis.com', 'push.services.mozilla.com', 'notify.windows.com'];
const TEST_HTTP = process.env.PUSH_TEST_HTTP === '1'; // tests: allow http://127.0.0.1 endpoints

const q = {
  add: db.prepare('INSERT INTO push_subs(endpoint,username,th,p256dh,auth,ts) VALUES(?,?,?,?,?,?) ' +
    'ON CONFLICT(endpoint) DO UPDATE SET username=excluded.username, th=excluded.th, p256dh=excluded.p256dh, auth=excluded.auth, ts=excluded.ts'),
  del: db.prepare('DELETE FROM push_subs WHERE endpoint=?'),
  delMine: db.prepare('DELETE FROM push_subs WHERE endpoint=? AND username=?'),
  // only devices whose session still exists (logged out or reset by the admin = no more notifications)
  of: db.prepare('SELECT p.* FROM push_subs p JOIN sessions s ON s.th=p.th WHERE p.username=?'),
  orphans: db.prepare('DELETE FROM push_subs WHERE th NOT IN (SELECT th FROM sessions)'),
};

let keys = null;
/** The server's VAPID key pair, made on first use and kept in the settings table. */
function vapid() {
  if (keys) return keys;
  let priv = getSetting('vapid_priv');
  if (!priv) {
    const kp = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
    priv = kp.privateKey.export({ type: 'pkcs8', format: 'der' }).toString('base64');
    setSetting('vapid_priv', priv);
  }
  const privateKey = crypto.createPrivateKey({ key: Buffer.from(priv, 'base64'), format: 'der', type: 'pkcs8' });
  const jwk = crypto.createPublicKey(privateKey).export({ format: 'jwk' });
  const pub = Buffer.concat([Buffer.from([4]), unb64u(jwk.x), unb64u(jwk.y)]);
  keys = { privateKey, pub: b64u(pub) };
  return keys;
}
const publicKey = () => vapid().pub;

function endpointOk(ep) {
  if (typeof ep !== 'string' || ep.length > 1024) return false;
  let u;
  try { u = new URL(ep); } catch { return false; }
  if (TEST_HTTP && u.protocol === 'http:' && u.hostname === '127.0.0.1') return true;
  if (u.protocol !== 'https:' || u.port || u.username || u.password) return false;
  return HOSTS.some((h) => u.hostname === h || u.hostname.endsWith('.' + h));
}

/** Saves a browser's subscription for this session. Returns false if it is not acceptable. */
function subscribe(user, th, sub) {
  if (!sub || !endpointOk(sub.endpoint) || !sub.keys) return false;
  const p256dh = unb64u(sub.keys.p256dh || ''), auth = unb64u(sub.keys.auth || '');
  if (p256dh.length !== 65 || p256dh[0] !== 4 || auth.length !== 16) return false;
  q.add.run(sub.endpoint, user, th, b64u(p256dh), b64u(auth), Date.now());
  return true;
}
const unsubscribe = (user, endpoint) => q.delMine.run(String(endpoint || ''), user).changes > 0;
const hasSubs = (user) => q.of.all(user).length > 0;

/** aes128gcm content encoding (RFC 8188) of `plain` for one subscription (RFC 8291). */
function encrypt(plain, p256dh, authSecret) {
  const ua = unb64u(p256dh), auth = unb64u(authSecret);
  const ecdh = crypto.createECDH('prime256v1');
  const as = ecdh.generateKeys();
  const shared = ecdh.computeSecret(ua);
  const ikm = Buffer.from(crypto.hkdfSync('sha256', shared, auth, Buffer.concat([Buffer.from('WebPush: info\0'), ua, as]), 32));
  const salt = crypto.randomBytes(16);
  const cek = Buffer.from(crypto.hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0'), 16));
  const nonce = Buffer.from(crypto.hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: nonce\0'), 12));
  const c = crypto.createCipheriv('aes-128-gcm', cek, nonce);
  const body = Buffer.concat([c.update(Buffer.concat([Buffer.from(plain), Buffer.from([2])])), c.final(), c.getAuthTag()]);
  const head = Buffer.alloc(21);
  salt.copy(head, 0);
  head.writeUInt32BE(4096, 16);
  head[20] = as.length;
  return Buffer.concat([head, as, body]);
}

function vapidHeader(endpoint) {
  const { privateKey, pub } = vapid();
  const aud = new URL(endpoint).origin;
  const sub = process.env.PUSH_CONTACT || 'mailto:admin@sepan.invalid';
  const head = b64u(JSON.stringify({ typ: 'JWT', alg: 'ES256' }));
  const claims = b64u(JSON.stringify({ aud, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub }));
  const sig = crypto.sign('sha256', Buffer.from(head + '.' + claims), { key: privateKey, dsaEncoding: 'ieee-p1363' });
  return `vapid t=${head}.${claims}.${b64u(sig)}, k=${pub}`;
}

let lastErrLog = 0;
/** Sends one push; resolves to the push service's HTTP status (0 = network error / timeout). */
function sendOne(s, data) {
  return new Promise((resolve) => {
    let body, u;
    try { body = encrypt(JSON.stringify(data), s.p256dh, s.auth); u = new URL(s.endpoint); } catch { return resolve(0); }
    const mod = u.protocol === 'http:' ? http : https;
    const req = mod.request(u, {
      method: 'POST', timeout: 10000,
      headers: {
        Authorization: vapidHeader(s.endpoint), TTL: '86400', Urgency: 'high', 'Content-Encoding': 'aes128gcm',
        'Content-Type': 'application/octet-stream', 'Content-Length': body.length,
      },
    }, (res) => {
      res.resume();
      // 404 / 410: the browser dropped the subscription (app removed, permission revoked)
      if (res.statusCode === 404 || res.statusCode === 410) q.del.run(s.endpoint);
      if (res.statusCode >= 400 && Date.now() - lastErrLog > 60000) { lastErrLog = Date.now(); console.error(`push: ${u.hostname} answered ${res.statusCode}`); }
      resolve(res.statusCode);
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', (e) => {
      if (Date.now() - lastErrLog > 60000) { lastErrLog = Date.now(); console.error(`push: cannot reach ${u.hostname}: ${e.message}`); }
      resolve(0);
    });
    req.end(body);
  });
}

/** Pushes `data` to every subscribed browser of `user`. Resolves to [{ host, status }]. */
function notify(user, data) {
  return Promise.all(q.of.all(user).map(async (s) => ({ host: new URL(s.endpoint).hostname, status: await sendOne(s, data) })));
}

function cleanup() { try { q.orphans.run(); } catch { } }

module.exports = { publicKey, subscribe, unsubscribe, hasSubs, notify, encrypt, cleanup, endpointOk };
