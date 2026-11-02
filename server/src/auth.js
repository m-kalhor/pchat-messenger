'use strict';
/**
 * Sign-in by mobile number (1.5.0). A user is found by the mobile number on the account (entered by the admin, or confirmed by SMS at open sign-up);
 * one-time codes come from three places, so a dead SMS service never locks
 * anybody out:
 *   'sms'    5 digits by SMS (sms.ir), 2 minutes;
 *   'device' 6 digits shown on one of the user's devices that is already signed in, 5 minutes;
 *   'admin'  6 digits made by the admin in the panel and passed on in person or by phone, 10 minutes;
 *   'reauth' 5 digits by SMS to confirm the account before the key backup changes (no login password);
 *   'signup' 5 digits by SMS to a number that has no account yet (open sign-up, 1.6), kept under 'tel:<number>'.
 * Every code is single-use, stored only as an HMAC and dies after 3 wrong tries. A code opens the account
 * only; the messages still need the key password, which only the user knows.
 */
const crypto = require('node:crypto');
const { db, getSetting, setSetting } = require('./db');

const MIN = 60e3;
const TTL = { sms: 2 * MIN, device: 5 * MIN, admin: 10 * MIN, reauth: 5 * MIN, signup: 2 * MIN };
const DIGITS = { sms: 5, device: 6, admin: 6, reauth: 5, signup: 5 };
const MAX_TRIES = 3;
const SMS_URL = process.env.SMS_API_URL || 'https://api.sms.ir/v1';

const q = {
  add: db.prepare('INSERT INTO login_codes(username,kind,code,expires,tries,created) VALUES(?,?,?,?,0,?)'),
  dropKind: db.prepare('DELETE FROM login_codes WHERE username=? AND kind=?'),
  live: db.prepare('SELECT * FROM login_codes WHERE username=? AND expires>? ORDER BY id'),
  del: db.prepare('DELETE FROM login_codes WHERE id=?'),
  miss: db.prepare('UPDATE login_codes SET tries=tries+1 WHERE id=?'),
  dead: db.prepare('DELETE FROM login_codes WHERE expires<=? OR tries>=?'),
  phones: db.prepare('SELECT username, phone, disabled FROM users WHERE phone IS NOT NULL AND phone<>\'\''),
};

function secret() {
  let s = getSetting('code_secret');
  if (!s) { s = crypto.randomBytes(32).toString('hex'); setSetting('code_secret', s); }
  return s;
}
const mac = (username, code) => crypto.createHmac('sha256', secret()).update(username + '\n' + code).digest('hex');

/** Persian / Arabic digits to ASCII, spaces and dashes dropped. */
const asciiDigits = (s) => String(s || '').replace(/[۰-۹]/g, (d) => d.charCodeAt(0) - 0x6f0).replace(/[٠-٩]/g, (d) => d.charCodeAt(0) - 0x660);

/**
 * One spelling per number, so "+98 912 …", "0098912…", "98912…", "912…" and "0912…" all match.
 * Iranian mobiles become 09xxxxxxxxx (what sms.ir expects); other numbers keep their digits (and +).
 */
function normPhone(s) {
  let p = asciiDigits(s).replace(/[\s\-().]/g, '');
  if (!/^\+?[0-9]{7,15}$/.test(p)) return null;
  if (p.startsWith('+98')) p = '0' + p.slice(3);
  else if (p.startsWith('0098')) p = '0' + p.slice(4);
  else if (/^989\d{9}$/.test(p)) p = '0' + p.slice(2);
  else if (/^9\d{9}$/.test(p)) p = '0' + p;
  return p;
}

/** The active user with this mobile number (or this username, for a device / admin code). */
function findUser(ident) {
  const s = asciiDigits(ident).trim().toLowerCase();
  if (/^[a-z0-9_]{2,20}$/.test(s) && !/^\d+$/.test(s)) {
    const u = db.prepare('SELECT username, disabled FROM users WHERE username=?').get(s);
    return u && !u.disabled ? u.username : null;
  }
  const p = normPhone(s);
  if (!p) return null;
  const hits = q.phones.all().filter((u) => !u.disabled && normPhone(u.phone) === p);
  return hits.length === 1 ? hits[0].username : null;
}
const phoneOf = (username) => {
  const u = db.prepare('SELECT phone FROM users WHERE username=?').get(username);
  return u && u.phone ? normPhone(u.phone) : null;
};

/** Makes a new code of `kind` for the user (an older one of the same kind stops working). */
function issue(username, kind) {
  const n = DIGITS[kind];
  const code = String(crypto.randomInt(10 ** (n - 1), 10 ** n));
  q.dropKind.run(username, kind);
  const expires = Date.now() + TTL[kind];
  q.add.run(username, kind, mac(username, code), expires, Date.now());
  return { code, expires };
}

/**
 * Checks a code against the user's live codes of the given kinds. A match is used up; a miss counts
 * against every live code, so guessing burns them quickly. Returns the matching kind or null.
 */
function consume(username, code, kinds) {
  const c = asciiDigits(code).replace(/\s/g, '');
  q.dead.run(Date.now(), MAX_TRIES);
  const live = q.live.all(username, Date.now()).filter((r) => kinds.includes(r.kind));
  if (!/^\d{5,6}$/.test(c) || !live.length) { for (const r of live) q.miss.run(r.id); return null; }
  const h = Buffer.from(mac(username, c), 'hex');
  for (const r of live) {
    if (r.code.length === h.length * 2 && crypto.timingSafeEqual(Buffer.from(r.code, 'hex'), h)) { q.del.run(r.id); return r.kind; }
  }
  for (const r of live) q.miss.run(r.id);
  return null;
}

// ---------------- sms.ir ----------------
const smsConfig = () => ({
  api_key: getSetting('sms_api_key', ''),
  template_id: getSetting('sms_template_id', ''),
  param: getSetting('sms_param', 'CODE'),
  enabled: getSetting('sms_enabled', '1') === '1',
});
const smsReady = () => { const c = smsConfig(); return c.enabled && !!c.api_key && /^\d+$/.test(c.template_id); };
const passwordLogin = () => getSetting('password_login', '1') === '1';
/** Open sign-up: anybody with a mobile number confirmed by SMS gets an account (off unless the admin turns it on). */
const openSignup = () => getSetting('open_signup', '0') === '1' && smsReady();
const signupCategory = () => { const v = getSetting('signup_category', ''); return /^\d+$/.test(v) ? Number(v) : null; };
/** Phone numbers in use (normalized) -> username. */
function phoneMap() {
  const m = new Map();
  for (const u of q.phones.all()) { const p = normPhone(u.phone); if (p) m.set(p, u.username); }
  return m;
}

function smsState(ok, error) {
  if (ok) setSetting('sms_last_ok', Date.now());
  else setSetting('sms_last_error', JSON.stringify({ t: Date.now(), error: String(error).slice(0, 200) }));
}
/** { last_ok, last_error: {t, error} } and down = the newest attempt failed. */
function smsStatus() {
  const ok = Number(getSetting('sms_last_ok', 0)) || null;
  let err = null;
  try { err = JSON.parse(getSetting('sms_last_error', 'null')); } catch { }
  return { last_ok: ok, last_error: err, down: !!err && err.t > (ok || 0) };
}

async function smsCall(path, method, body, apiKey) {
  const r = await fetch(SMS_URL + path, {
    method,
    headers: { 'Content-Type': 'application/json', Accept: 'application/json', 'X-API-KEY': apiKey },
    body: body && JSON.stringify(body),
    signal: AbortSignal.timeout(10000),
  });
  let data = null;
  try { data = await r.json(); } catch { }
  // sms.ir answers { status: 1, message, data } on success
  if (!r.ok || !data || data.status !== 1) throw new Error((data && data.message) || 'http_' + r.status);
  return data.data;
}

/** Sends the code with the verify ("fast send") template. Throws when the SMS did not go out. */
async function sendSms(phone, code) {
  const c = smsConfig();
  if (!smsReady()) throw new Error('sms_not_configured');
  try {
    await smsCall('/send/verify', 'POST', { mobile: phone, templateId: Number(c.template_id), parameters: [{ name: c.param || 'CODE', value: code }] }, c.api_key);
    smsState(true);
  } catch (e) {
    smsState(false, e.name === 'TimeoutError' ? 'timeout' : e.message);
    throw e;
  }
}
/** Account credit; a good answer also proves the key, so it clears an old 'SMS down' warning. */
async function smsCredit() {
  try { const d = await smsCall('/credit', 'GET', undefined, smsConfig().api_key); smsState(true); return d; } catch (e) { smsState(false, e.name === 'TimeoutError' ? 'timeout' : e.message); throw e; }
}

function cleanup() { q.dead.run(Date.now(), MAX_TRIES); }

module.exports = {
  TTL, normPhone, findUser, phoneOf, phoneMap, issue, consume, smsConfig, smsReady, passwordLogin, openSignup, signupCategory, smsStatus,
  sendSms, smsCredit, cleanup,
};
