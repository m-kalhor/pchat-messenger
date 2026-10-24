'use strict';
const http = require('node:http');
const https = require('node:https');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { db, DATA_DIR, getSetting, setSetting, checkPassword, hashPassword } = require('./db');
const core = require('./core');
const stats = require('./stats');
const backup = require('./backup');

const HTML = fs.readFileSync(path.join(__dirname, 'admin.html'));
const sessions = new Map(); // token -> { csrf, ts }
const fails = new Map();
let gfail = { n: 0, t: 0 }; // global failed-login counter (all IPs)
const SESSION_MS = 12 * 3600 * 1000;
const NAME = /^[a-z0-9_]{2,20}$/;
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
  const users = db.prepare('SELECT username, display_name, bio, disabled, created, avatar_ver FROM users ORDER BY username').all();
  const uc = db.prepare('SELECT username, category_id FROM user_categories').all();
  const cats = db.prepare('SELECT c.id, c.name, c.gkey, (SELECT COUNT(*) FROM user_categories WHERE category_id=c.id) AS count FROM categories c ORDER BY c.id').all();
  return {
    users: users.map((u) => ({
      username: u.username, display_name: u.display_name || '', bio: u.bio || '', disabled: !!u.disabled, created: u.created, has_avatar: u.avatar_ver > 0,
      online: ctx.isOnline(u.username), categories: uc.filter((x) => x.username === u.username).map((x) => x.category_id),
    })),
    categories: cats,
    visibility: db.prepare('SELECT viewer, target FROM visibility').all().map((r) => [r.viewer, r.target]),
    blocks: db.prepare('SELECT viewer, target FROM blocks').all().map((r) => [r.viewer, r.target]),
  };
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

  if (sub === '/login' && req.method === 'POST') {
    const b = await readJson(req, 2048);
    const ip = req.socket.remoteAddress;
    const f = fails.get(ip);
    if ((f && f.n >= 5 && Date.now() - f.t < 600000) || (gfail.n >= 30 && Date.now() - gfail.t < 3600000)) return json(res, 429, { error: 'rate_limited' });
    const stored = getSetting('admin_pass');
    if (!stored) return json(res, 503, { error: 'admin_password_not_set' });
    const userOk = typeof b.username === 'string' && b.username.trim().toLowerCase() === adminUser();
    const passOk = typeof b.password === 'string' && checkPassword(b.password, stored);
    if (!userOk || !passOk) {
      fails.set(ip, { n: (f && Date.now() - f.t < 600000 ? f.n : 0) + 1, t: Date.now() });
      gfail = { n: (Date.now() - gfail.t < 3600000 ? gfail.n : 0) + 1, t: Date.now() };
      await new Promise((r) => setTimeout(r, 800)); // slow down guessing
      return json(res, 401, { error: 'bad_login' });
    }
    fails.delete(ip);
    const token = crypto.randomBytes(32).toString('hex');
    const csrf = crypto.randomBytes(16).toString('hex');
    sessions.set(token, { csrf, ts: Date.now() });
    res.setHeader('Set-Cookie', `adm=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${SESSION_MS / 1000}${secure ? '; Secure' : ''}`);
    return json(res, 200, { csrf, username: adminUser() });
  }

  const ses = session(req);
  if (!ses) return json(res, 401, { error: 'unauthorized' });
  if (sub === '/session') return json(res, 200, { csrf: ses.s.csrf, username: adminUser() });
  if (req.method !== 'GET' && req.headers['x-csrf'] !== ses.s.csrf) return json(res, 403, { error: 'bad_csrf' });

  if (sub === '/logout' && req.method === 'POST') { sessions.delete(ses.t); return json(res, 200, { ok: true }); }
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

  // one "save all changes" for users, categories, the visibility matrix and the backup schedule
  if (sub === '/save' && req.method === 'POST') {
    const b = await readJson(req, 1048576);
    const users = b.users && typeof b.users === 'object' ? b.users : {};
    const cats = b.categories && typeof b.categories === 'object' ? b.categories : {};
    const vis = Array.isArray(b.visibility) ? b.visibility : [];
    for (const name of Object.keys(users)) if (!core.q.user.get(name)) return json(res, 400, { error: 'no_such_user', detail: name });
    for (const [id, name] of Object.entries(cats)) if (!/^\d+$/.test(id) || !core.cleanDisplay(name)) return json(res, 400, { error: 'bad_name', detail: id });
    for (const p of vis) {
      if (!Array.isArray(p) || !NAME.test(p[0] || '') || !NAME.test(p[1] || '') || p[0] === p[1]) return json(res, 400, { error: 'bad_pair' });
    }
    if (b.backup) {
      try { backup.saveConfig({ enabled: !!b.backup.enabled, cron: b.backup.cron, keep: b.backup.keep }); }
      catch (e) { return json(res, 400, { error: e.message }); }
    }
    const setName = db.prepare('UPDATE users SET display_name=? WHERE username=?');
    const renameCat = db.prepare('UPDATE categories SET name=? WHERE id=?');
    const visOn = db.prepare('INSERT OR IGNORE INTO visibility(viewer,target) VALUES(?,?)');
    const visOff = db.prepare('DELETE FROM visibility WHERE viewer=? AND target=?');
    const blockOn = db.prepare('INSERT OR IGNORE INTO blocks(viewer,target) VALUES(?,?)');
    const blockOff = db.prepare('DELETE FROM blocks WHERE viewer=? AND target=?');
    db.exec('BEGIN');
    try {
      for (const [name, u] of Object.entries(users)) {
        if (typeof u.display_name === 'string') setName.run(core.cleanDisplay(u.display_name) || null, name);
        if (Array.isArray(u.categories)) core.setUserCategories(name, u.categories);
      }
      for (const [id, name] of Object.entries(cats)) renameCat.run(core.cleanDisplay(name), Number(id));
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

  let m = /^\/users\/([a-z0-9_]{2,20})\/(update|reset|delete)$/.exec(sub);
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
      core.deleteUser(name);
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

  if (sub === '/categories' && req.method === 'POST') {
    const b = await readJson(req);
    try { core.createCategory(b.name); ctx.refreshAll(); return json(res, 200, { ok: true }); }
    catch (e) { return json(res, 400, { error: /UNIQUE/.test(e.message) ? 'name_exists' : e.message }); }
  }
  m = /^\/categories\/(\d+)\/(rename|delete)$/.exec(sub);
  if (m && req.method === 'POST') {
    const id = Number(m[1]);
    if (m[2] === 'delete') {
      db.prepare('DELETE FROM user_categories WHERE category_id=?').run(id);
      db.prepare('DELETE FROM categories WHERE id=?').run(id);
    } else {
      const b = await readJson(req);
      const n = core.cleanDisplay(b.name);
      if (!n) return json(res, 400, { error: 'bad_name' });
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
  setInterval(() => { const t = Date.now(); for (const [k, v] of sessions) if (t - v.ts > SESSION_MS) sessions.delete(k); }, 600000).unref();
  return srv;
}

module.exports = { start };
