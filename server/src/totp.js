'use strict';
/**
 * Second factor for the admin panel (1.18): time-based one-time codes (RFC 6238, the 6 digits of Google
 * Authenticator, Microsoft Authenticator, Aegis, ...). HMAC-SHA1, 30-second steps, one step of clock drift
 * either way. A code that was used once is not accepted again (replay).
 *
 * Settings: admin_totp = the base32 secret while the second factor is on (absent = off),
 * admin_totp_step = the last step a code was accepted for.
 * Recovery when the phone is lost: on the server, `msgadmin totp-off`.
 */
const crypto = require('node:crypto');
const { getSetting, setSetting, db } = require('./db');

const STEP = 30;
const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

function b32encode(buf) {
  let bits = 0, val = 0, out = '';
  for (const b of buf) {
    val = (val << 8) | b; bits += 8;
    while (bits >= 5) { out += B32[(val >>> (bits - 5)) & 31]; bits -= 5; }
  }
  if (bits > 0) out += B32[(val << (5 - bits)) & 31];
  return out;
}
function b32decode(s) {
  const clean = String(s || '').toUpperCase().replace(/[\s=-]/g, '');
  let bits = 0, val = 0;
  const out = [];
  for (const c of clean) {
    const i = B32.indexOf(c);
    if (i < 0) throw new Error('bad_base32');
    val = (val << 5) | i; bits += 5;
    if (bits >= 8) { out.push((val >>> (bits - 8)) & 255); bits -= 8; }
  }
  return Buffer.from(out);
}

/** The 6-digit code of `secret` (base32) for time step `step`. */
function codeAt(secret, step) {
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(step));
  const h = crypto.createHmac('sha1', b32decode(secret)).update(msg).digest();
  const o = h[h.length - 1] & 15;
  const n = ((h[o] & 0x7f) << 24) | (h[o + 1] << 16) | (h[o + 2] << 8) | h[o + 3];
  return String(n % 1e6).padStart(6, '0');
}
const stepNow = (t = Date.now()) => Math.floor(t / 1000 / STEP);
const digits = (s) => String(s || '').replace(/[۰-۹]/g, (d) => d.charCodeAt(0) - 0x6f0).replace(/[٠-٩]/g, (d) => d.charCodeAt(0) - 0x660).replace(/\s/g, '');

/**
 * The step `code` belongs to (now, one before or one after), or null. `after`: steps up to this one were
 * already used and do not count again.
 */
function match(secret, code, after = -1, t = Date.now()) {
  const c = digits(code);
  if (!/^\d{6}$/.test(c)) return null;
  const now = stepNow(t);
  for (const s of [now, now - 1, now + 1]) {
    if (s <= after) continue;
    if (crypto.timingSafeEqual(Buffer.from(codeAt(secret, s)), Buffer.from(c))) return s;
  }
  return null;
}

const newSecret = () => b32encode(crypto.randomBytes(20));
const enabled = () => !!getSetting('admin_totp');

/** Checks a code for the panel's own secret and uses it up. */
function verify(code, t = Date.now()) {
  const secret = getSetting('admin_totp');
  if (!secret) return false;
  const s = match(secret, code, Number(getSetting('admin_totp_step', '-1')), t);
  if (s === null) return false;
  setSetting('admin_totp_step', s);
  return true;
}

/** Turns the second factor on with a secret the admin just proved with a code from the app. */
function enable(secret, code, t = Date.now()) {
  const s = match(secret, code, -1, t);
  if (s === null) return false;
  setSetting('admin_totp', secret);
  setSetting('admin_totp_step', s);
  return true;
}
function disable() { db.prepare("DELETE FROM settings WHERE key IN ('admin_totp','admin_totp_step')").run(); }

/** The otpauth:// link the authenticator app reads from the QR code. */
const uri = (secret, account, issuer = 'Sepan') =>
  `otpauth://totp/${encodeURIComponent(issuer)}:${encodeURIComponent(account)}?secret=${secret}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=6&period=${STEP}`;

module.exports = { b32encode, b32decode, codeAt, stepNow, match, newSecret, enabled, verify, enable, disable, uri, STEP };
