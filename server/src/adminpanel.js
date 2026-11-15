'use strict';
const { apkVersion } = require('./apkinfo');
const http = require('node:http');
const https = require('node:https');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { db, DATA_DIR, getSetting, setSetting, checkPassword, hashPassword } = require('./db');
const core = require('./core');
const stats = require('./stats');
const backup = require('./backup');
const auth = require('./auth');
const sms = require('./sms');
const diag = require('./diag');
const callcfg = require('./callcfg');
const gcall = require('./gcall');
const ugroups = require('./ugroups');
const stickers = require('./stickers');
const usage = require('./usage');
const totp = require('./totp');
const { qrSvg } = require('./web');

const HTML = fs.readFileSync(path.join(__dirname, 'admin.html'));
const sessions = new Map(); // token -> { csrf, ts }
// 1.18: wrong sign-ins lock out only where they come from: one address after IP_MAX misses, its network
// (IPv4 /24, IPv6 /64) after NET_MAX, each for LOCK_MS after the last miss. There is no lock for everybody,
// so somebody guessing from elsewhere can never keep the real admin out.
const fails = new Map(); // key -> { n, t }
const LOCK_MS = 15 * 60e3;
const IP_MAX = 5;
const NET_MAX = 20;
const cleanIp = (ip) => String(ip || '').replace(/^::ffff:/, '');
function netOf(ip) {
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(ip)) return ip.split('.').slice(0, 3).join('.') + '.0/24';
  const parts = ip.split(':');
  return parts.slice(0, 4).join(':') + '::/64';
}
const failKeys = (ip) => [['ip:' + ip, IP_MAX], ['net:' + netOf(ip), NET_MAX]];
/** Seconds this address still has to wait, 0 when it may try. */
function lockedFor(ip) {
  let wait = 0;
  for (const [k, max] of failKeys(ip)) {
    const f = fails.get(k);
    if (f && f.n >= max) wait = Math.max(wait, f.t + LOCK_MS - Date.now());
  }
  return wait > 0 ? Math.ceil(wait / 1000) : 0;
}
function addFail(ip) {
  for (const [k] of failKeys(ip)) {
    const f = fails.get(k);
    fails.set(k, { n: f && Date.now() - f.t < LOCK_MS ? f.n + 1 : 1, t: Date.now() });
  }
}
const SESSION_MS = 12 * 3600 * 1000;
const NAME = /^[a-z0-9_]{2,20}$/;
/** Mobile number for the SMS login: optional +, 7 to 15 digits (spaces, dashes and brackets are dropped). */
const ADMIN_NAME = /^[a-z0-9_.\-]{3,32}$/;
const adminUser = () => getSetting('admin_user', 'admin');

const json = (res, code, obj) => {
  const b = Buffer.from(JSON.stringify(obj));
  res.writeHead(code, { 'Content-Type': 'application/json', 'Content-Length': b.length, 'Cache-Control': 'no-store' });
  res.end(b);
};
function readJson(req, limit = 65536) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', (c) => { size += c.length; if (size > limit) { reject(Object.assign(new Error('too large'), { code: 413 })); req.destroy(); } else chunks.push(c); });
    req.on('end', () => { try { resolve(JSON.parse(Buffer.concat(chunks).toString() || '{}')); } catch { reject(Object.assign(new Error('bad json'), { code: 400 })); } });
    req.on('error', reject);
  });
}
const cookie = (req, name) => {
  const m = new RegExp('(?:^|;\\s*)' + name + '=([a-f0-9]+)').exec(req.headers.cookie || '');
  return m ? m[1] : null;
};

function session(req) {
  const t = cookie(req, 'adm');
  const s = t && sessions.get(t);
  if (!s) return null;
  if (Date.now() - s.ts > SESSION_MS) { sessions.delete(t); return null; }
  return { t, s };
}

function stateDump(ctx) {
  const users = db.prepare('SELECT username, display_name, bio, phone, disabled, created, avatar_ver FROM users ORDER BY username').all();
  const uc = db.prepare("SELECT uc.username, uc.category_id FROM user_categories uc JOIN categories c ON c.id=uc.category_id WHERE c.kind='cat'").all();
  const cats = db.prepare('SELECT c.id, c.name, c.gkey, (SELECT COUNT(*) FROM user_categories WHERE category_id=c.id) AS count FROM categories c WHERE c.kind=\'cat\' ORDER BY c.id').all();
  return {
    users: users.map((u) => ({
      username: u.username, display_name: u.display_name || '', bio: u.bio || '', phone: u.phone || '', disabled: !!u.disabled, created: u.created, has_avatar: u.avatar_ver > 0, diag: diag.enabledFor(u.username), route: callcfg.routeAllowed(u.username),
      online: ctx.isOnline(u.username), categories: uc.filter((x) => x.username === u.username).map((x) => x.category_id),
    })),
    categories: cats,
    visibility: db.prepare('SELECT viewer, target FROM visibility').all().map((r) => [r.viewer, r.target]),
    blocks: db.prepare('SELECT viewer, target FROM blocks').all().map((r) => [r.viewer, r.target]),
  };
}

function authInfo(ctx) {
  let apk = ctx.apkInfo ? ctx.apkInfo() : null;
  if (apk && ctx.apkPath) { const v = apkVersion(ctx.apkPath); apk = { ...apk, version: v ? v.name : null, version_code: v ? v.code : null }; }
  return {
    ...sms.publicInfo(),
    enabled: sms.enabled(), ready: auth.smsReady(), password_login: auth.passwordLogin(), status: auth.smsStatus(), apk,
    open_signup: getSetting('open_signup', '0') === '1', signup_category: auth.signupCategory(),
    msg_requests: getSetting('msg_requests', '1') === '1', diag_users: diag.users().join(', '), route_users: callcfg.routeUsers().join(', '),
    calls: callcfg.get(),
    sms_usage: auth.smsUsage(), // 1.18.1: codes sent in the last hour / day and the limits
    gcall: gcall.cfg(), // 1.19: group calls
  };
}

const APK_MAX = 200 * 1024 * 1024;
/** Streams the upload to a temp file, checks it is a zip (an APK is one) and moves it in place. */
function saveApk(req, dest) {
  return new Promise((resolve, reject) => {
    const tmp = dest + '.part';
    const out = fs.createWriteStream(tmp);
    let size = 0, head = null, failed = false;
    const fail = (e) => { if (failed) return; failed = true; out.destroy(); try { fs.unlinkSync(tmp); } catch { } reject(e); };
    req.on('data', (c) => {
      if (!head) head = c.subarray(0, 4);
      size += c.length;
      if (size > APK_MAX) { fail(Object.assign(new Error('too_large'), { code: 413 })); req.destroy(); }
    });
    req.on('error', fail);
    out.on('error', fail);
    out.on('finish', () => {
      if (failed) return;
      if (!head || head.length < 4 || head.readUInt32LE(0) !== 0x04034b50 || size < 1024) return fail(new Error('not_an_apk'));
      fs.renameSync(tmp, dest);
      resolve();
    });
    req.pipe(out);
  });
}

function backupInfo() {
  const last = getSetting('backup_last');
  return { config: backup.config(), next: backup.nextRunTime(), last: last ? Number(last) : null, list: backup.list(), running: backup.isRunning() };
}

async function route(ctx, req, res, secure) {
  const url = new URL(req.url, 'http://x');
  const p = url.pathname;
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');

  if (req.method === 'GET' && (p === '/' || p === '/index.html')) {
    res.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store',
      'Content-Security-Policy': "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
    });
    return res.end(HTML);
  }
  if (!p.startsWith('/admin/api/')) return json(res, 404, { error: 'not_found' });
  const sub = p.slice('/admin/api'.length);

  // what the sign-in form must ask for (the code field only when the second factor is on)
  if (sub === '/login-info' && req.method === 'GET') return json(res, 200, { totp: totp.enabled() });

  if (sub === '/login' && req.method === 'POST') {
    const b = await readJson(req, 2048);
    const ip = cleanIp(req.socket.remoteAddress);
    const wait = lockedFor(ip);
    if (wait) return json(res, 429, { error: 'rate_limited', wait });
    const stored = getSetting('admin_pass');
    if (!stored) return json(res, 503, { error: 'admin_password_not_set' });
    const userOk = typeof b.username === 'string' && b.username.trim().toLowerCase() === adminUser();
    const passOk = typeof b.password === 'string' && checkPassword(b.password, stored);
    // the same answer for a wrong password and a wrong code: a guess never learns which part was right
    const codeOk = userOk && passOk && (!totp.enabled() || totp.verify(b.code));
    if (!codeOk) {
      addFail(ip);
      await new Promise((r) => setTimeout(r, 800)); // slow down guessing
      return json(res, 401, { error: 'bad_login' });
    }
    for (const [k] of failKeys(ip)) fails.delete(k);
    const token = crypto.randomBytes(32).toString('hex');
    const csrf = crypto.randomBytes(16).toString('hex');
    sessions.set(token, { csrf, ts: Date.now() });
    res.setHeader('Set-Cookie', `adm=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${SESSION_MS / 1000}${secure ? '; Secure' : ''}`);
    return json(res, 200, { csrf, username: adminUser() });
  }

  const ses = session(req);
  if (!ses) return json(res, 401, { error: 'unauthorized' });
  if (sub === '/session') return json(res, 200, { csrf: ses.s.csrf, username: adminUser(), totp: totp.enabled() });
  if (req.method !== 'GET' && req.headers['x-csrf'] !== ses.s.csrf) return json(res, 403, { error: 'bad_csrf' });

  if (sub === '/logout' && req.method === 'POST') { sessions.delete(ses.t); return json(res, 200, { ok: true }); }

  // ---- 1.18 second factor (authenticator app) for the panel: start with the password, confirm with a code ----
  if (sub === '/totp/start' && req.method === 'POST') {
    const b = await readJson(req, 4096);
    if (typeof b.current !== 'string' || !checkPassword(b.current, getSetting('admin_pass'))) {
      await new Promise((r) => setTimeout(r, 800));
      return json(res, 403, { error: 'bad_current_password' });
    }
    const secret = totp.newSecret();
    ses.s.pendingTotp = secret;
    const link = totp.uri(secret, adminUser() + '@' + (process.env.PUBLIC_HOST || 'sepan'));
    return json(res, 200, { secret, uri: link, qr: 'data:image/svg+xml;base64,' + qrSvg(link).toString('base64') });
  }
  if (sub === '/totp/confirm' && req.method === 'POST') {
    const b = await readJson(req, 1024);
    if (!ses.s.pendingTotp) return json(res, 400, { error: 'totp_not_started' });
    if (!totp.enable(ses.s.pendingTotp, b.code)) return json(res, 400, { error: 'bad_code' });
    delete ses.s.pendingTotp;
    for (const k of [...sessions.keys()]) if (k !== ses.t) sessions.delete(k); // every other browser signs in again, with a code
    return json(res, 200, { ok: true, totp: true });
  }
  if (sub === '/totp/disable' && req.method === 'POST') {
    const b = await readJson(req, 4096);
    if (typeof b.current !== 'string' || !checkPassword(b.current, getSetting('admin_pass')) || !totp.verify(b.code)) {
      await new Promise((r) => setTimeout(r, 800));
      return json(res, 403, { error: 'bad_password_or_code' });
    }
    totp.disable();
    return json(res, 200, { ok: true, totp: false });
  }
  if (sub === '/state' && req.method === 'GET') return json(res, 200, stateDump(ctx));

  // change the panel's own username and/or password (the current password is always required)
  if (sub === '/account' && req.method === 'POST') {
    const b = await readJson(req, 4096);
    if (typeof b.current !== 'string' || !checkPassword(b.current, getSetting('admin_pass'))) {
      await new Promise((r) => setTimeout(r, 800));
      return json(res, 403, { error: 'bad_current_password' });
    }
    const user = typeof b.username === 'string' && b.username.trim() ? b.username.trim().toLowerCase() : adminUser();
    if (!ADMIN_NAME.test(user)) return json(res, 400, { error: 'bad_admin_username' });
    const pw = typeof b.password === 'string' && b.password ? b.password : null;
    if (pw !== null && (pw.length < 8 || pw.length > 200)) return json(res, 400, { error: 'weak_password' });
    setSetting('admin_user', user);
    if (pw !== null) {
      setSetting('admin_pass', hashPassword(pw));
      for (const k of [...sessions.keys()]) if (k !== ses.t) sessions.delete(k); // log out every other browser
    }
    return json(res, 200, { ok: true, username: user });
  }

  // one "save all changes" for users, categories, who-can-reach-whom and the backup schedule.
  // links: [a, b, state] for the pair in both directions; visibility: [viewer, target, state] one way (older panels)
  if (sub === '/save' && req.method === 'POST') {
    const b = await readJson(req, 1048576);
    const users = b.users && typeof b.users === 'object' ? b.users : {};
    const cats = b.categories && typeof b.categories === 'object' ? b.categories : {};
    const vis = Array.isArray(b.visibility) ? b.visibility.slice() : [];
    if (Array.isArray(b.links)) for (const l of b.links) { if (!Array.isArray(l)) return json(res, 400, { error: 'bad_pair' }); vis.push([l[0], l[1], l[2]], [l[1], l[0], l[2]]); }
    for (const u of Object.values(users)) {
      // stored in the international form (+98912…), whatever spelling the admin typed
      if (u && typeof u.phone === 'string' && u.phone.trim()) { const n = auth.normPhone(u.phone); if (!n) return json(res, 400, { error: 'bad_phone' }); u.phone = n; }
      else if (u && typeof u.phone === 'string') u.phone = '';
    }
    for (const name of Object.keys(users)) if (!core.q.user.get(name)) return json(res, 400, { error: 'no_such_user', detail: name });
    // one number signs in one account: the same mobile on two users would make the SMS login ambiguous
    const phones = new Map(db.prepare('SELECT username, phone FROM users').all().map((r) => [r.username, r.phone || '']));
    for (const [name, u] of Object.entries(users)) if (u && typeof u.phone === 'string') phones.set(name, u.phone);
    const seen = new Map();
    for (const [name, ph] of phones) {
      const n = ph && auth.normPhone(ph);
      if (!n) continue;
      if (seen.has(n)) return json(res, 400, { error: 'duplicate_phone', detail: seen.get(n) + ', ' + name });
      seen.set(n, name);
    }
    for (const [id, name] of Object.entries(cats)) if (!/^\d+$/.test(id) || !core.cleanDisplay(name)) return json(res, 400, { error: 'bad_name', detail: id });
    for (const p of vis) {
      if (!Array.isArray(p) || !NAME.test(p[0] || '') || !NAME.test(p[1] || '') || p[0] === p[1]) return json(res, 400, { error: 'bad_pair' });
    }
    if (b.backup) {
      try { backup.saveConfig({ enabled: !!b.backup.enabled, cron: b.backup.cron, keep: b.backup.keep }); }
      catch (e) { return json(res, 400, { error: e.message }); }
    }
    const setName = db.prepare('UPDATE users SET display_name=? WHERE username=?');
    const setPhone = db.prepare('UPDATE users SET phone=? WHERE username=?');
    const renameCat = db.prepare("UPDATE categories SET name=? WHERE id=? AND kind='cat'");
    const visOn = db.prepare('INSERT OR IGNORE INTO visibility(viewer,target) VALUES(?,?)');
    const visOff = db.prepare('DELETE FROM visibility WHERE viewer=? AND target=?');
    const blockOn = db.prepare('INSERT OR IGNORE INTO blocks(viewer,target) VALUES(?,?)');
    const blockOff = db.prepare('DELETE FROM blocks WHERE viewer=? AND target=?');
    db.exec('BEGIN');
    try {
      for (const [name, u] of Object.entries(users)) {
        if (typeof u.display_name === 'string') setName.run(core.cleanDisplay(u.display_name) || null, name);
        if (typeof u.phone === 'string') setPhone.run(u.phone || null, name);
        if (Array.isArray(u.categories)) core.setUserCategories(name, u.categories);
      }
      for (const [id, name] of Object.entries(cats)) renameCat.run(core.cleanDisplay(name), Number(id));
      if (db.prepare("SELECT 1 FROM categories WHERE kind='cat' GROUP BY name HAVING COUNT(*)>1").get()) throw new Error('UNIQUE name');
      // a cell is true (can see), false (cannot) or 'block' (cannot, and no connection requests either way)
      for (const [v, t, on] of vis) {
        (on === true ? visOn : visOff).run(v, t);
        (on === 'block' ? blockOn : blockOff).run(v, t);
      }
      db.exec('COMMIT');
    } catch (e) {
      db.exec('ROLLBACK');
      return json(res, 400, { error: /UNIQUE/.test(e.message) ? 'name_exists' : e.message });
    }
    for (const name of Object.keys(users)) ctx.profileChanged(name);
    ctx.refreshAll();
    return json(res, 200, { ok: true });
  }

  if (sub === '/users' && req.method === 'POST') {
    const b = await readJson(req);
    try {
      const pw = core.createUser(String(b.username || '').toLowerCase(), b.display_name, Array.isArray(b.categories) ? b.categories : []);
      ctx.refreshAll();
      return json(res, 200, { password: pw });
    } catch (e) { return json(res, 400, { error: e.message }); }
  }

  // ---- public intro page shown when the web app is opened by a domain name ----
  if (sub === '/site' && req.method === 'GET') {
    return json(res, 200, { title: getSetting('site_title', ''), about: getSetting('site_about', ''), contact: getSetting('site_contact', '') });
  }
  if (sub === '/site' && req.method === 'POST') {
    const b = await readJson(req, 16384);
    for (const [k, max] of [['title', 100], ['about', 3000], ['contact', 1000]]) {
      if (b[k] === undefined) continue;
      if (typeof b[k] !== 'string' || b[k].length > max) return json(res, 400, { error: 'bad_text' });
      setSetting('site_' + k, b[k].trim());
    }
    return json(res, 200, { ok: true });
  }

  // ---- sign-in: SMS provider settings, password login on/off, SMS state ----
  if (sub === '/auth' && req.method === 'GET') return json(res, 200, authInfo(ctx));
  if (sub === '/auth' && req.method === 'POST') {
    const b = await readJson(req, 4096);
    // 1.16.0: the SMS provider and its fields ({ provider: 'artapayamak', sms: { token, from, pattern, param } })
    if (typeof b.provider === 'string') { try { sms.update(b.provider, b.sms && typeof b.sms === 'object' ? b.sms : {}); } catch (e) { return json(res, 400, { error: e.message }); } }
    if (typeof b.enabled === 'boolean') setSetting('sms_enabled', b.enabled ? '1' : '0');
    if (typeof b.password_login === 'boolean') setSetting('password_login', b.password_login ? '1' : '0');
    if (typeof b.open_signup === 'boolean') setSetting('open_signup', b.open_signup ? '1' : '0');
    if (typeof b.msg_requests === 'boolean') setSetting('msg_requests', b.msg_requests ? '1' : '0');
    for (const k of ['sms_max_hour', 'sms_max_day']) {
      if (b[k] === undefined) continue;
      const v = Number(b[k]);
      if (!Number.isInteger(v) || v < 0 || v > 100000) return json(res, 400, { error: 'bad_limit' });
      setSetting(k, v);
    }
    if (typeof b.diag_users === 'string') { try { diag.setUsers(b.diag_users); } catch (e) { return json(res, 400, { error: e.message }); } }
    if (typeof b.route_users === 'string') { try { callcfg.setRouteUsers(b.route_users); } catch (e) { return json(res, 400, { error: e.message }); } }
    if (b.calls && typeof b.calls === 'object') { try { callcfg.set(b.calls); } catch (e) { return json(res, 400, { error: e.message }); } }
    if (b.gcall && typeof b.gcall === 'object') { try { gcall.setCfg(b.gcall); } catch (e) { return json(res, 400, { error: e.message }); } }
    if (b.signup_category !== undefined) {
      const c = b.signup_category === null || b.signup_category === '' ? '' : String(b.signup_category);
      if (c && !db.prepare("SELECT 1 FROM categories WHERE id=? AND kind='cat'").get(Number(c))) return json(res, 400, { error: 'bad_category' });
      setSetting('signup_category', c);
    }
    return json(res, 200, authInfo(ctx));
  }
  // sends one real SMS with a test code, to check the key, the template and that the server reaches the SMS provider
  if (sub === '/auth/test' && req.method === 'POST') {
    const b = await readJson(req, 1024);
    const phone = auth.normPhone(b.phone);
    if (!phone) return json(res, 400, { error: 'bad_phone' });
    try { await auth.sendSms(phone, String(crypto.randomInt(100000, 1000000)), { test: true }); return json(res, 200, { ok: true, ...authInfo(ctx) }); }
    catch (e) { return json(res, 200, { ok: false, error: e.message, ...authInfo(ctx) }); }
  }
  if (sub === '/auth/credit' && req.method === 'GET') {
    try { return json(res, 200, { credit: await auth.smsCredit() }); }
    catch (e) { return json(res, 200, { error: e.message }); }
  }

  // ---- the Android app offered for download on the web login page (raw APK as the request body) ----
  if (sub === '/apk' && req.method === 'POST') {
    try { await saveApk(req, ctx.apkPath); } catch (e) { return json(res, e.code === 413 ? 413 : 400, { error: e.message }); }
    if (ctx.appUpdated) ctx.appUpdated(); // 1.10.2: open Android apps check now and tell the user about the new version
    return json(res, 200, authInfo(ctx));
  }
  if (sub === '/apk' && req.method === 'DELETE') {
    try { fs.unlinkSync(ctx.apkPath); } catch { }
    return json(res, 200, authInfo(ctx));
  }

  // ---- 1.10 sticker packs: official packs for everyone, limits for the users' own packs ----
  if (sub.startsWith('/stickers')) {
    try {
      if (sub === '/stickers' && req.method === 'GET') return json(res, 200, { config: stickers.config(), packs: stickers.adminList() });
      if (sub === '/stickers/config' && req.method === 'POST') {
        const b = await readJson(req, 2048);
        const c = stickers.saveConfig(b);
        ctx.stickersChanged && ctx.stickersChanged();
        return json(res, 200, { config: c, packs: stickers.adminList() });
      }
      if (sub === '/stickers/packs' && req.method === 'POST') {
        const b = await readJson(req, 2048);
        const id = stickers.createPack(null, b.title);
        ctx.stickersChanged && ctx.stickersChanged();
        return json(res, 200, { id });
      }
      let sm = /^\/stickers\/pack\/([a-f0-9]{16})(?:\/(sticker|rename|delete))?$/.exec(sub);
      if (sm) {
        const [, id, act] = sm;
        if (!act && req.method === 'GET') { const pk = stickers.packFor(null, id); return pk ? json(res, 200, pk) : json(res, 404, { error: 'no_such_pack' }); }
        if (act === 'delete' && req.method === 'POST') { stickers.deletePack(null, id); ctx.stickersChanged && ctx.stickersChanged(); return json(res, 200, { ok: true }); }
        if (act === 'rename' && req.method === 'POST') { const b = await readJson(req, 2048); stickers.renamePack(null, id, b.title); ctx.stickersChanged && ctx.stickersChanged(); return json(res, 200, { ok: true }); }
        if (act === 'sticker' && req.method === 'POST') {
          const buf = await new Promise((resolve, reject) => {
            const chunks = []; let size = 0;
            req.on('data', (c) => { size += c.length; if (size > 1024 * 1024) { reject(Object.assign(new Error('sticker_too_large'), { code: 413 })); req.destroy(); } else chunks.push(c); });
            req.on('end', () => resolve(Buffer.concat(chunks)));
            req.on('error', reject);
          });
          const s = stickers.addSticker(null, id, buf, url.searchParams.get('emoji'));
          ctx.stickersChanged && ctx.stickersChanged();
          return json(res, 200, s);
        }
      }
      sm = /^\/stickers\/sticker\/([a-f0-9]{32})(\/delete)?$/.exec(sub);
      if (sm && sm[2] && req.method === 'POST') { stickers.deleteSticker(null, sm[1]); ctx.stickersChanged && ctx.stickersChanged(); return json(res, 200, { ok: true }); }
      if (sm && !sm[2] && req.method === 'GET') {
        const img = stickers.image(sm[1]);
        if (!img) return json(res, 404, { error: 'no_such_sticker' });
        res.writeHead(200, { 'Content-Type': img.mime, 'Content-Length': img.data.length, 'Cache-Control': 'private, max-age=86400' });
        return res.end(img.data);
      }
    } catch (e) {
      if (e instanceof stickers.StickerError) return json(res, e.status, { error: e.message });
      throw e;
    }
    return json(res, 404, { error: 'not_found' });
  }

  let m = /^\/users\/([a-z0-9_]{2,20})\/logincode$/.exec(sub);
  if (m && req.method === 'POST') {
    // a one-time sign-in code for a user who has no signed-in device and gets no SMS
    if (!core.activeUser(m[1])) return json(res, 404, { error: 'no_such_user' });
    const { code, expires } = auth.issue(m[1], 'admin');
    return json(res, 200, { code, expires, ttl: auth.TTL.admin / 1000, phone: auth.phoneOf(m[1]) });
  }

  m = /^\/users\/([a-z0-9_]{2,20})\/(update|reset|delete)$/.exec(sub);
  if (m && req.method === 'POST') {
    const [, name, action] = m;
    const u = core.q.user.get(name);
    if (!u) return json(res, 404, { error: 'no_such_user' });
    if (action === 'reset') {
      const pw = core.resetPassword(name);
      ctx.kick(name);
      return json(res, 200, { password: pw });
    }
    if (action === 'delete') {
      ugroups.userDeleted(name); // 1.20: their groups go to the oldest admin there, or are frozen
      core.deleteUser(name);
      stickers.deleteUser(name);
      usage.deleteUser(name);
      ctx.kick(name);
      try { fs.unlinkSync(path.join(DATA_DIR, 'avatars', name + '.webp')); } catch { }
      ctx.refreshAll();
      return json(res, 200, { ok: true });
    }
    const b = await readJson(req);
    if (typeof b.display_name === 'string') db.prepare('UPDATE users SET display_name=? WHERE username=?').run(core.cleanDisplay(b.display_name) || null, name);
    if (Array.isArray(b.categories)) core.setUserCategories(name, b.categories);
    if (typeof b.disabled === 'boolean') {
      db.prepare('UPDATE users SET disabled=? WHERE username=?').run(b.disabled ? 1 : 0, name);
      if (b.disabled) { db.prepare('DELETE FROM sessions WHERE username=?').run(name); ctx.kick(name); }
    }
    ctx.profileChanged(name);
    ctx.refreshAll();
    return json(res, 200, { ok: true });
  }

  // ---- 1.20: groups users made (tab «گروه‌ها و کانال‌های کاربران») ----
  if (sub === '/ugroups' && req.method === 'GET') return json(res, 200, { cfg: ugroups.cfg(), groups: ugroups.adminList(), limits: ugroups.userLimits() });
  if (sub === '/ugroups/settings' && req.method === 'POST') {
    const b = await readJson(req);
    try { const c = ugroups.setCfg(b); ctx.refreshAll(); return json(res, 200, { cfg: c }); }
    catch (e) { return json(res, 400, { error: e.message }); }
  }
  if (sub === '/ugroups/limit' && req.method === 'POST') {
    const b = await readJson(req);
    try { ugroups.setUserLimit(String(b.username || ''), b.limit); ctx.refreshAll(); return json(res, 200, { ok: true }); }
    catch (e) { return json(res, e.code || 400, { error: e.message }); }
  }
  m = /^\/ugroups\/(\d+)\/(members|add|remove|role|freeze|delete)$/.exec(sub);
  if (m) {
    const id = Number(m[1]);
    try {
      if (m[2] === 'members' && req.method === 'GET') return json(res, 200, { members: ugroups.adminMembers(id) });
      if (req.method !== 'POST') return json(res, 404, { error: 'not_found' });
      const b = await readJson(req);
      if (m[2] === 'add') { const n = ugroups.adminAdd(id, b.users, b.category); ctx.refreshAll(); return json(res, 200, { added: n }); }
      if (m[2] === 'remove') ugroups.adminRemove(id, b.username, b.ban);
      else if (m[2] === 'role') ugroups.adminRole(id, String(b.username || '').toLowerCase(), String(b.role || ''));
      else if (m[2] === 'freeze') ugroups.adminFreeze(id, !!b.on);
      else if (m[2] === 'delete') ugroups.dropGroup(id);
      ctx.refreshAll();
      return json(res, 200, { ok: true });
    } catch (e) {
      if (typeof e.code !== 'number') throw e;
      return json(res, e.code, { error: e.message });
    }
  }

  if (sub === '/categories' && req.method === 'POST') {
    const b = await readJson(req);
    try { core.createCategory(b.name); ctx.refreshAll(); return json(res, 200, { ok: true }); }
    catch (e) { return json(res, 400, { error: /UNIQUE/.test(e.message) ? 'name_exists' : e.message }); }
  }
  m = /^\/categories\/(\d+)\/(rename|delete)$/.exec(sub);
  if (m && req.method === 'POST') {
    const id = Number(m[1]);
    if (!db.prepare("SELECT 1 FROM categories WHERE id=? AND kind='cat'").get(id)) return json(res, 404, { error: 'no_such_category' });
    if (m[2] === 'delete') {
      db.prepare('DELETE FROM user_categories WHERE category_id=?').run(id);
      db.prepare('DELETE FROM categories WHERE id=?').run(id);
    } else {
      const b = await readJson(req);
      const n = core.cleanDisplay(b.name);
      if (!n) return json(res, 400, { error: 'bad_name' });
      if (core.catNameTaken(n, id)) return json(res, 400, { error: 'name_exists' });
      try { db.prepare('UPDATE categories SET name=? WHERE id=?').run(n, id); }
      catch (e) { return json(res, 400, { error: 'name_exists' }); }
    }
    ctx.refreshAll();
    return json(res, 200, { ok: true });
  }

  if (sub === '/visibility/set' && req.method === 'POST') {
    const b = await readJson(req);
    if (!NAME.test(b.viewer || '') || !NAME.test(b.target || '') || b.viewer === b.target) return json(res, 400, { error: 'bad_pair' });
    db.prepare('DELETE FROM blocks WHERE viewer=? AND target=?').run(b.viewer, b.target);
    if (b.on) db.prepare('INSERT OR IGNORE INTO visibility(viewer,target) VALUES(?,?)').run(b.viewer, b.target);
    else db.prepare('DELETE FROM visibility WHERE viewer=? AND target=?').run(b.viewer, b.target);
    ctx.refreshAll();
    return json(res, 200, { ok: true });
  }
  if (sub === '/visibility/preset' && req.method === 'POST') {
    const b = await readJson(req);
    db.exec('DELETE FROM visibility');
    db.exec('DELETE FROM blocks');
    if (b.preset === 'all') db.exec('INSERT INTO visibility(viewer,target) SELECT a.username,b.username FROM users a, users b WHERE a.username<>b.username');
    ctx.refreshAll();
    return json(res, 200, { ok: true });
  }

  if (sub === '/stats' && req.method === 'GET') {
    const files = db.prepare('SELECT COALESCE(SUM(size),0) AS s, COUNT(*) AS n FROM files').get();
    let dbBytes = 0;
    try { dbBytes = fs.statSync(path.join(DATA_DIR, 'messenger.db')).size; } catch { }
    return json(res, 200, stats.snapshot({
      online: ctx.onlineUsers().length,
      users: db.prepare('SELECT COUNT(*) AS n FROM users').get().n,
      messages: db.prepare('SELECT COUNT(*) AS n FROM messages').get().n,
      filesBytes: files.s, filesCount: files.n, dbBytes,
    }));
  }

  // 1.14: «مصرف کاربران» — messages, storage, traffic, calls, devices per user
  if (sub === '/usage' && req.method === 'GET') {
    const r = usage.report(ctx);
    let dbBytes = 0, diskTotal = 0, diskFree = 0;
    try { dbBytes = fs.statSync(path.join(DATA_DIR, 'messenger.db')).size; } catch { }
    try { const s = fs.statfsSync(DATA_DIR); diskTotal = s.blocks * s.bsize; diskFree = s.bavail * s.bsize; } catch { }
    return json(res, 200, { ...r, dbBytes, diskTotal, diskFree });
  }

  if (sub === '/backup' && req.method === 'GET') return json(res, 200, backupInfo());
  if (sub === '/backup/config' && req.method === 'POST') {
    const b = await readJson(req);
    try { backup.saveConfig({ enabled: !!b.enabled, cron: b.cron, keep: b.keep }); return json(res, 200, backupInfo()); }
    catch (e) { return json(res, 400, { error: e.message }); }
  }
  if (sub === '/backup/run' && req.method === 'POST') {
    try { const name = await backup.run(); return json(res, 200, { name }); }
    catch (e) { return json(res, 500, { error: e.message }); }
  }
  m = /^\/backup\/download\/([\w.\-]+)$/.exec(sub);
  if (m && req.method === 'GET') {
    const fp = backup.resolve(m[1]);
    if (!fp) return json(res, 404, { error: 'not_found' });
    const st = fs.statSync(fp);
    res.writeHead(200, { 'Content-Type': 'application/gzip', 'Content-Length': st.size, 'Content-Disposition': `attachment; filename="${m[1]}"`, 'Cache-Control': 'no-store' });
    return fs.createReadStream(fp).pipe(res);
  }
  if (sub === '/backup/delete' && req.method === 'POST') {
    const b = await readJson(req);
    return json(res, 200, { ok: backup.remove(String(b.name || '')) });
  }
  return json(res, 404, { error: 'not_found' });
}

function start(ctx, tlsOptions) {
  if (process.env.ADMIN_DISABLE === '1') return null;
  const port = +(process.env.ADMIN_PORT || 8444);
  const bind = process.env.ADMIN_BIND || '127.0.0.1';
  const secure = !!tlsOptions;
  const handler = (req, res) => {
    route(ctx, req, res, secure).catch((e) => {
      if (!res.headersSent) json(res, e.code === 413 || e.code === 400 ? e.code : 500, { error: e.message || 'error' });
      else res.destroy();
    });
  };
  const srv = secure ? https.createServer(tlsOptions, handler) : http.createServer(handler);
  srv.listen(port, bind, () => console.log(`admin panel on ${bind}:${port}`));
  setInterval(() => {
    const t = Date.now();
    for (const [k, v] of sessions) if (t - v.ts > SESSION_MS) sessions.delete(k);
    for (const [k, v] of fails) if (t - v.t > LOCK_MS) fails.delete(k);
  }, 600000).unref();
  return srv;
}

module.exports = { start };
