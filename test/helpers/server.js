'use strict';
// Boots the real server.js (plain HTTP, admin panel off) on a free port with a temp data dir.
const { spawn } = require('node:child_process');
const net = require('node:net');
const path = require('node:path');
const { extractApp } = require('./extract');

const freePort = () => new Promise((resolve, reject) => {
  const s = net.createServer().listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
  s.on('error', reject);
});

async function startServer(env = {}) {
  const app = extractApp();
  const port = await freePort();
  const fullEnv = {
    ...process.env, PLAIN_HTTP: '1', PORT: String(port), DATA_DIR: app.dataDir, ADMIN_DISABLE: '1', WEB_DISABLE: '1', MIN_FREE_MB: '0',
    NODE_NO_WARNINGS: '1', ...env,
  };
  const child = spawn(process.execPath, [path.join(app.appDir, 'server.js')], { env: fullEnv, stdio: ['ignore', 'pipe', 'pipe'] });
  let log = '';
  await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('server did not start:\n' + log)), 15000);
    const onData = (d) => { log += d; if (/messenger listening/.test(log)) { clearTimeout(t); resolve(); } };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.on('exit', (code) => { clearTimeout(t); reject(new Error(`server exited (${code}):\n${log}`)); });
  });
  child.removeAllListeners('exit');

  // the test process shares the same SQLite database (WAL) to seed users / matrix
  process.env.DATA_DIR = app.dataDir;
  const core = require(path.join(app.appDir, 'core.js'));
  const { db } = require(path.join(app.appDir, 'db.js'));

  const base = `http://127.0.0.1:${port}`;
  async function api(token, method, p, body, headers = {}) {
    const h = { ...headers };
    if (token) h.authorization = 'Bearer ' + token;
    let payload = body;
    if (body !== undefined && !Buffer.isBuffer(body) && !(body instanceof Uint8Array)) { payload = JSON.stringify(body); h['content-type'] = 'application/json'; }
    const r = await fetch(base + p, { method, headers: h, body: payload });
    const ct = r.headers.get('content-type') || '';
    const data = ct.includes('json') ? await r.json() : Buffer.from(await r.arrayBuffer());
    return { status: r.status, data, headers: r.headers };
  }
  async function login(username, password) {
    const r = await api(null, 'POST', '/api/login', { username, password });
    if (r.status !== 200) throw new Error(`login ${username} failed: ${r.status}`);
    return r.data.token;
  }
  /** creates a user (optionally in categories) and returns a session token */
  async function user(name, catIds = []) {
    const pw = core.createUser(name, name.toUpperCase(), catIds);
    return login(name, pw);
  }
  async function stop() {
    const exited = new Promise((r) => child.once('exit', r));
    child.kill('SIGTERM');
    await exited;
    try { db.close(); } catch { }
    app.cleanup();
  }
  return { base, api, login, user, core, db, stop, app };
}

module.exports = { startServer };
