'use strict';
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const { pipeline } = require('node:stream/promises');
const { db, DATA_DIR, getSetting, setSetting } = require('./db');
const cron = require('./cron');

const DIR = path.join(DATA_DIR, 'backups');
const NAME_RE = /^db-\d{8}-\d{6}\.sqlite\.gz$/;
let running = false;

function stamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}-${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}`;
}

function config() {
  return {
    enabled: getSetting('backup_enabled', '1') === '1',
    cron: getSetting('backup_cron', '0 3 * * *'),
    keep: Number(getSetting('backup_keep', '14')),
  };
}

function saveConfig(c) {
  cron.parse(c.cron); // throws if invalid
  const keep = Math.max(1, Math.min(365, parseInt(c.keep, 10) || 14));
  setSetting('backup_enabled', c.enabled ? '1' : '0');
  setSetting('backup_cron', String(c.cron).trim());
  setSetting('backup_keep', keep);
}

function list() {
  return fs.readdirSync(DIR).filter((n) => NAME_RE.test(n)).map((name) => {
    const st = fs.statSync(path.join(DIR, name));
    return { name, size: st.size, mtime: st.mtimeMs };
  }).sort((a, b) => b.mtime - a.mtime);
}

function prune() {
  const keep = config().keep;
  for (const b of list().slice(keep)) { try { fs.unlinkSync(path.join(DIR, b.name)); } catch { } }
}

async function run() {
  if (running) throw new Error('backup_in_progress');
  running = true;
  const name = `db-${stamp()}.sqlite.gz`;
  const tmp = path.join(DIR, name + '.tmp');
  try {
    db.exec(`VACUUM INTO '${tmp.replace(/'/g, "''")}'`);
    await pipeline(fs.createReadStream(tmp), zlib.createGzip({ level: 6 }), fs.createWriteStream(path.join(DIR, name)));
    setSetting('backup_last', Date.now());
    prune();
    return name;
  } finally {
    try { fs.unlinkSync(tmp); } catch { }
    running = false;
  }
}

function resolve(name) {
  if (!NAME_RE.test(name)) return null;
  const p = path.join(DIR, name);
  return fs.existsSync(p) ? p : null;
}

function remove(name) { const p = resolve(name); if (p) fs.unlinkSync(p); return !!p; }

function nextRunTime() {
  const c = config();
  if (!c.enabled) return null;
  try { const d = cron.nextRun(c.cron); return d ? d.getTime() : null; } catch { return null; }
}

let lastMinute = '';
function startScheduler() {
  const t = setInterval(() => {
    const c = config();
    if (!c.enabled) return;
    const now = new Date();
    const key = now.toISOString().slice(0, 16);
    if (key === lastMinute) return;
    try {
      if (cron.matches(cron.parse(c.cron), now)) {
        lastMinute = key;
        run().catch((e) => console.error('scheduled backup failed:', e.message));
      }
    } catch { }
  }, 20000);
  t.unref();
}

module.exports = { config, saveConfig, list, run, resolve, remove, nextRunTime, startScheduler, isRunning: () => running };
