'use strict';
const fs = require('node:fs');
const os = require('node:os');

const KEEP = 300; // 10 minutes at 2 s
const history = [];
let prev = null;

const rd = (p) => { try { return fs.readFileSync(p, 'utf8'); } catch { return ''; } };

function cpuTimes() {
  const l = rd('/proc/stat').split('\n')[0].trim().split(/\s+/).slice(1).map(Number);
  if (l.length < 4) return null;
  return { idle: l[3] + (l[4] || 0), total: l.reduce((a, b) => a + b, 0) };
}
function mem() {
  const m = {};
  for (const line of rd('/proc/meminfo').split('\n')) {
    const x = /^(\w+):\s+(\d+)/.exec(line);
    if (x) m[x[1]] = Number(x[2]) * 1024;
  }
  const total = m.MemTotal || os.totalmem();
  const avail = m.MemAvailable !== undefined ? m.MemAvailable : os.freemem();
  return { total, used: total - avail };
}
function net() {
  let rx = 0, tx = 0;
  for (const line of rd('/proc/net/dev').split('\n').slice(2)) {
    const x = /^\s*([^:\s]+):\s*(.*)$/.exec(line);
    if (!x || x[1] === 'lo') continue;
    const f = x[2].trim().split(/\s+/).map(Number);
    rx += f[0] || 0; tx += f[8] || 0;
  }
  return { rx, tx };
}
function disk() {
  let r = 0, w = 0;
  for (const line of rd('/proc/diskstats').split('\n')) {
    const f = line.trim().split(/\s+/);
    if (f.length < 10) continue;
    if (!/^(sd[a-z]+|vd[a-z]+|xvd[a-z]+|nvme\d+n\d+|mmcblk\d+)$/.test(f[2])) continue;
    r += Number(f[5]) * 512; w += Number(f[9]) * 512;
  }
  return { r, w };
}

function sample() {
  const t = Date.now();
  const c = cpuTimes(), m = mem(), n = net(), d = disk();
  const cur = { t, c, n, d };
  if (prev) {
    const dt = Math.max(0.5, (t - prev.t) / 1000);
    let cpu = 0;
    if (c && prev.c && c.total > prev.c.total) cpu = 100 * (1 - (c.idle - prev.c.idle) / (c.total - prev.c.total));
    history.push({
      t, cpu: Math.max(0, Math.min(100, cpu)), memUsed: m.used, memTotal: m.total,
      rx: Math.max(0, (n.rx - prev.n.rx) / dt), tx: Math.max(0, (n.tx - prev.n.tx) / dt),
      dr: Math.max(0, (d.r - prev.d.r) / dt), dw: Math.max(0, (d.w - prev.d.w) / dt),
      load: os.loadavg()[0],
    });
    if (history.length > KEEP) history.shift();
  }
  prev = cur;
}

function snapshot(extra = {}) {
  let diskTotal = 0, diskFree = 0;
  try { const s = fs.statfsSync('/'); diskTotal = s.blocks * s.bsize; diskFree = s.bavail * s.bsize; } catch { }
  return {
    samples: history,
    info: {
      hostname: os.hostname(), cores: os.cpus().length, uptime: os.uptime(), diskTotal, diskFree,
      nodeRss: process.memoryUsage().rss, nodeUptime: process.uptime(), ...extra,
    },
  };
}

function start() { sample(); const t = setInterval(sample, 2000); t.unref(); }

module.exports = { start, snapshot };
