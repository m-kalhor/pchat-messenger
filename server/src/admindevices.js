'use strict';
/**
 * 1.24: trusted phones for the admin panel («سپن مدیر» app).
 *
 * A phone is paired once, from a panel session opened with the password (and the authenticator code when
 * that is on). The app makes an EC P-256 key pair inside the Android Keystore; the private key never leaves
 * the phone's secure hardware and can only be used after the phone's own fingerprint / screen lock. The
 * server keeps only the public key. Signing in later = the server sends a one-time challenge, the app signs
 * it, the server checks the signature and opens a normal panel session.
 *
 * A device not used for EXPIRE_MS is dropped (sliding: every sign-in renews it). The admin removes devices
 * in «حساب مدیر», changing the panel password removes all of them, and on the server `msgadmin devices-off`.
 */
const crypto = require('node:crypto');
const { db } = require('./db');

db.exec(`CREATE TABLE IF NOT EXISTS admin_devices (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, pubkey TEXT NOT NULL,
  created INTEGER NOT NULL, last_used INTEGER NOT NULL, last_ip TEXT NOT NULL DEFAULT ''
)`);

const EXPIRE_MS = 90 * 24 * 3600e3;
const CHALLENGE_MS = 120e3;
const MAX_DEVICES = 10;
const PAIR_WINDOW_MS = 15 * 60e3; // pairing only within 15 minutes of a password sign-in
const challenges = new Map(); // device id -> { nonce, t }

const ID_RE = /^[a-f0-9]{32}$/;
const signedText = (id, nonce) => 'sepan-admin-login:' + id + ':' + nonce;

function prune(now = Date.now()) {
  db.prepare('DELETE FROM admin_devices WHERE last_used < ?').run(now - EXPIRE_MS);
  for (const [k, c] of challenges) if (now - c.t > CHALLENGE_MS) challenges.delete(k);
}

/** Checks the app's public key: X.509 SubjectPublicKeyInfo (base64 DER) of an EC P-256 key. */
function parseKey(b64) {
  if (typeof b64 !== 'string' || b64.length > 400 || !/^[A-Za-z0-9+/=\s]+$/.test(b64)) return null;
  try {
    const k = crypto.createPublicKey({ key: Buffer.from(b64, 'base64'), format: 'der', type: 'spki' });
    if (k.asymmetricKeyType !== 'ec' || k.asymmetricKeyDetails.namedCurve !== 'prime256v1') return null;
    return k.export({ format: 'der', type: 'spki' }).toString('base64');
  } catch { return null; }
}

function cleanName(s) {
  const n = String(s || '').replace(/[\u0000-\u001f<>]/g, '').trim().slice(0, 60);
  return n || 'گوشی';
}

function list() {
  prune();
  return db.prepare('SELECT id, name, created, last_used, last_ip FROM admin_devices ORDER BY last_used DESC').all()
    .map((d) => ({ ...d, expires: d.last_used + EXPIRE_MS }));
}

/** Adds a device; throws with .message = error code. */
function pair(name, pubkey, ip) {
  prune();
  const key = parseKey(pubkey);
  if (!key) throw new Error('bad_device_key');
  if (db.prepare('SELECT 1 FROM admin_devices WHERE pubkey=?').get(key)) throw new Error('device_exists');
  if (db.prepare('SELECT COUNT(*) AS n FROM admin_devices').get().n >= MAX_DEVICES) throw new Error('too_many_devices');
  const id = crypto.randomBytes(16).toString('hex');
  const now = Date.now();
  db.prepare('INSERT INTO admin_devices(id,name,pubkey,created,last_used,last_ip) VALUES(?,?,?,?,?,?)').run(id, cleanName(name), key, now, now, ip || '');
  return { id, expires: now + EXPIRE_MS };
}

function exists(id) {
  return !!(ID_RE.test(String(id)) && db.prepare('SELECT 1 FROM admin_devices WHERE id=? AND last_used>=?').get(id, Date.now() - EXPIRE_MS));
}

/** A fresh one-time challenge for a known device, or null. */
function challenge(id) {
  prune();
  if (!exists(id)) return null;
  const nonce = crypto.randomBytes(32).toString('hex');
  challenges.set(id, { nonce, t: Date.now() });
  return nonce;
}

/** True when sig (base64 DER ECDSA/SHA-256) signs the device's latest challenge. The challenge is used up. */
function verify(id, nonce, sig, ip) {
  if (!ID_RE.test(String(id)) || typeof nonce !== 'string' || typeof sig !== 'string' || sig.length > 300) return false;
  const c = challenges.get(id);
  if (!c || c.nonce !== nonce || Date.now() - c.t > CHALLENGE_MS) return false;
  challenges.delete(id);
  const d = db.prepare('SELECT pubkey, last_used FROM admin_devices WHERE id=?').get(id);
  if (!d || d.last_used < Date.now() - EXPIRE_MS) return false;
  let ok = false;
  try {
    const key = crypto.createPublicKey({ key: Buffer.from(d.pubkey, 'base64'), format: 'der', type: 'spki' });
    ok = crypto.verify('sha256', Buffer.from(signedText(id, nonce)), key, Buffer.from(sig, 'base64'));
  } catch { ok = false; }
  if (ok) db.prepare('UPDATE admin_devices SET last_used=?, last_ip=? WHERE id=?').run(Date.now(), ip || '', id);
  return ok;
}

function remove(id) { challenges.delete(id); return db.prepare('DELETE FROM admin_devices WHERE id=?').run(String(id)).changes > 0; }
function removeAll() { challenges.clear(); return db.prepare('DELETE FROM admin_devices').run().changes; }

module.exports = { list, pair, challenge, verify, remove, removeAll, exists, prune, signedText, EXPIRE_MS, PAIR_WINDOW_MS, MAX_DEVICES };
