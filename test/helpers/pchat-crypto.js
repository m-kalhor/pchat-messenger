'use strict';
// Node port of android/app/src/main/java/com/pchat/app/Crypto.kt (same algorithms, same byte layout).
// Keep the two in sync: if Crypto.kt changes, this file and test/crypto.test.js must change too.
const crypto = require('node:crypto');

const b64 = (b) => Buffer.from(b).toString('base64');
const unb64 = (s) => Buffer.from(s, 'base64');

/** EC P-256 identity; pubB64 is X.509/SPKI DER like Java's PublicKey.encoded */
function newIdentity() {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  return { priv: privateKey, pubB64: b64(publicKey.export({ type: 'spki', format: 'der' })) };
}

function fingerprint(pubB64) {
  const h = crypto.createHash('sha256').update(unb64(pubB64)).digest();
  return h.subarray(0, 16).toString('hex').toUpperCase().match(/.{4}/g).join(' ');
}

/** Crypto.hkdf: HMAC-SHA256 extract with a 32-byte zero salt, single expand block (32 bytes). */
function hkdf(ikm, info) {
  const prk = crypto.createHmac('sha256', Buffer.alloc(32)).update(ikm).digest();
  return crypto.createHmac('sha256', prk).update(info).update(Buffer.from([1])).digest();
}

function pairKey(my, otherPub, a, b) {
  const pub = crypto.createPublicKey({ key: unb64(otherPub), format: 'der', type: 'spki' });
  const shared = crypto.diffieHellman({ privateKey: my.priv, publicKey: pub });
  const info = Buffer.from('pchat-v1|' + [a, b].sort().join('|'));
  return hkdf(shared, info);
}

function seal(key, plain, aad) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', key, iv);
  c.setAAD(aad);
  return Buffer.concat([iv, c.update(plain), c.final(), c.getAuthTag()]);
}

function open(key, blob, aad) {
  const d = crypto.createDecipheriv('aes-256-gcm', key, blob.subarray(0, 12));
  d.setAAD(aad);
  d.setAuthTag(blob.subarray(blob.length - 16));
  return Buffer.concat([d.update(blob.subarray(12, blob.length - 16)), d.final()]);
}

// ---------------- chunked file encryption (v2) ----------------
const FILE_CHUNK = 1 << 20;
const TAG = 16;
const CIPHER_CHUNK = FILE_CHUNK + TAG;
const chunkCount = (plain) => (plain <= 0 ? 1 : Math.ceil(plain / FILE_CHUNK));
const cipherSize = (plain) => plain + TAG * chunkCount(plain);
const newFileKey = () => b64(crypto.randomBytes(32)) + '.' + b64(crypto.randomBytes(8));
const isChunked = (fkey) => fkey.includes('.');

function chunkNonce(prefix, index) {
  const n = Buffer.alloc(12);
  prefix.copy(n, 0, 0, 8);
  n.writeUInt32BE(index >>> 0, 8);
  return n;
}
const chunkAad = (index, last) => Buffer.from(`fc|${index}|${last ? 1 : 0}`);
const splitKey = (fkey) => { const [k, np] = fkey.split('.'); return [unb64(k), unb64(np)]; };

function sealChunk(fkey, index, last, buf) {
  const [k, np] = splitKey(fkey);
  const c = crypto.createCipheriv('aes-256-gcm', k, chunkNonce(np, index));
  c.setAAD(chunkAad(index, last));
  return Buffer.concat([c.update(buf), c.final(), c.getAuthTag()]);
}

function openChunk(fkey, index, last, buf) {
  const [k, np] = splitKey(fkey);
  const d = crypto.createDecipheriv('aes-256-gcm', k, chunkNonce(np, index));
  d.setAAD(chunkAad(index, last));
  d.setAuthTag(buf.subarray(buf.length - TAG));
  return Buffer.concat([d.update(buf.subarray(0, buf.length - TAG)), d.final()]);
}

/** Whole file -> concatenated sealed chunks, exactly what the app uploads. */
function sealFileChunks(fkey, plain) {
  const n = chunkCount(plain.length);
  const out = [];
  for (let i = 0; i < n; i++) out.push(sealChunk(fkey, i, i === n - 1, plain.subarray(i * FILE_CHUNK, (i + 1) * FILE_CHUNK)));
  return Buffer.concat(out);
}

function openFileChunks(fkey, blob) {
  const out = [];
  const n = Math.ceil(blob.length / CIPHER_CHUNK) || 1;
  for (let i = 0; i < n; i++) out.push(openChunk(fkey, i, i === n - 1, blob.subarray(i * CIPHER_CHUNK, (i + 1) * CIPHER_CHUNK)));
  return Buffer.concat(out);
}

/** recipients: { username: pubB64 } (must include the sender itself). Returns the JSON payload string. */
function encryptFor(my, me, target, recipients, plain) {
  const aad = Buffer.from(`${me}|${target}`);
  const k = crypto.randomBytes(32);
  const keys = {};
  for (const [u, pub] of Object.entries(recipients)) {
    const sk = u === me ? pairKey(my, my.pubB64, me, me) : pairKey(my, pub, me, u);
    keys[u] = b64(seal(sk, k, aad));
  }
  return JSON.stringify({ v: 1, c: b64(seal(k, Buffer.from(plain), aad)), k: keys });
}

function decryptFrom(my, me, sender, target, senderPub, payload) {
  const o = JSON.parse(payload);
  const wrapped = o.k[me] || '';
  if (!wrapped) throw new Error('not addressed to me');
  const aad = Buffer.from(`${sender}|${target}`);
  const sk = sender === me ? pairKey(my, my.pubB64, me, me) : pairKey(my, senderPub, sender, me);
  const k = open(sk, unb64(wrapped), aad);
  return open(k, unb64(o.c), aad);
}

/**
 * Key backup v1 (Crypto.exportBackup / importBackup in Crypto.kt, same in the web client):
 * KEK = PBKDF2-HMAC-SHA256(password, salt, iter, 32 bytes);
 * ct = AES-256-GCM(KEK, iv, PKCS#8 DER private key, aad "sepan-keybackup-v1|" + username), tag appended.
 */
function exportBackup(my, username, password, iter = 310000) {
  const salt = crypto.randomBytes(16);
  const iv = crypto.randomBytes(12);
  const kek = crypto.pbkdf2Sync(Buffer.from(password, 'utf8'), salt, iter, 32, 'sha256');
  const c = crypto.createCipheriv('aes-256-gcm', kek, iv);
  c.setAAD(Buffer.from('sepan-keybackup-v1|' + username));
  const ct = Buffer.concat([c.update(my.priv.export({ type: 'pkcs8', format: 'der' })), c.final(), c.getAuthTag()]);
  return { v: 1, kdf: 'pbkdf2-sha256', iter, salt: b64(salt), iv: b64(iv), ct: b64(ct), pub: my.pubB64 };
}

/** Returns the identity, or throws when the password is wrong. */
function importBackup(kb, username, password) {
  const kek = crypto.pbkdf2Sync(Buffer.from(password, 'utf8'), unb64(kb.salt), kb.iter, 32, 'sha256');
  const raw = unb64(kb.ct);
  const d = crypto.createDecipheriv('aes-256-gcm', kek, unb64(kb.iv));
  d.setAAD(Buffer.from('sepan-keybackup-v1|' + username));
  d.setAuthTag(raw.subarray(raw.length - 16));
  const der = Buffer.concat([d.update(raw.subarray(0, raw.length - 16)), d.final()]);
  return { priv: crypto.createPrivateKey({ key: der, format: 'der', type: 'pkcs8' }), pubB64: kb.pub };
}

module.exports = { exportBackup, importBackup,
  b64, unb64, newIdentity, fingerprint, hkdf, pairKey, seal, open,
  FILE_CHUNK, TAG, CIPHER_CHUNK, chunkCount, cipherSize, newFileKey, isChunked,
  sealChunk, openChunk, sealFileChunks, openFileChunks, encryptFor, decryptFrom,
};
