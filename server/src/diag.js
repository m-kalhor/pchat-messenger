'use strict';
/**
 * Call diagnostics (1.7, TEST FEATURE). Only for the users listed in the admin panel (setting diag_users,
 * default "mostafa"); everybody else sees nothing. During a call their app shows the ping (round-trip time),
 * jitter, loss and the connection type from WebRTC itself, and can ask the server for the route: the
 * server runs traceroute to both people of the call, so the path reads
 *   you -> hops -> Sepan server -> hops -> the other person.
 * With the call relayed by the server's TURN this is the path the audio really takes; on a direct call it
 * is the closest picture the server can give. Browsers and iPhones cannot run traceroute themselves.
 *
 * To remove the feature: empty the list in the panel (instant), or revert the commit that added this file.
 */
const { spawn } = require('node:child_process');
const { getSetting, setSetting } = require('./db');

const DEFAULT_USERS = 'mostafa';
const users = () => getSetting('diag_users', DEFAULT_USERS).split(/[\s,،]+/).map((s) => s.trim().toLowerCase()).filter(Boolean);
const enabledFor = (u) => users().includes(u);
function setUsers(s) {
  const list = [...new Set(String(s || '').split(/[\s,،]+/).map((x) => x.trim().replace(/^@/, '').toLowerCase()).filter(Boolean))];
  if (list.some((x) => !/^[a-z0-9_]{2,20}$/.test(x))) throw new Error('bad_username');
  setSetting('diag_users', list.join(','));
  return list;
}
/** What /api/me adds for the user. */
const meInfo = (u) => (enabledFor(u) ? { diag: true } : {});

/** "::ffff:1.2.3.4" -> "1.2.3.4" */
const cleanIp = (ip) => String(ip || '').replace(/^::ffff:/, '');
const isIp = (ip) => /^\d{1,3}(\.\d{1,3}){3}$/.test(ip) || /^[0-9a-f:]+$/i.test(ip);

function run(cmd, args, ms) {
  return new Promise((resolve) => {
    let out = '';
    let p;
    try { p = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] }); } catch { return resolve(null); }
    const t = setTimeout(() => { try { p.kill('SIGKILL'); } catch { } }, ms);
    p.stdout.on('data', (d) => { out += d; });
    p.on('error', () => { clearTimeout(t); resolve(null); });
    p.on('close', () => { clearTimeout(t); resolve(out); });
  });
}

/** Parses traceroute -n / tracepath -n output into [{ n, ip, ms }] (ip null = the hop did not answer). */
function parseHops(text) {
  const hops = new Map();
  for (const line of String(text || '').split('\n')) {
    const m = /^\s*(\d+)\??:?\s+(.*)$/.exec(line);
    if (!m) continue;
    const n = Number(m[1]);
    const rest = m[2];
    const ip = (/(\d{1,3}(?:\.\d{1,3}){3}|[0-9a-f]*:[0-9a-f:]+)/i.exec(rest) || [])[1] || null;
    const ms = (/([\d.]+)\s*ms/.exec(rest) || [])[1];
    if (/no reply|^\s*\*/.test(rest) && !ip) { if (!hops.has(n)) hops.set(n, { n, ip: null, ms: null }); continue; }
    if (!ip || /^\[?LOCALHOST\]?/i.test(rest)) continue;
    const prev = hops.get(n);
    if (!prev || !prev.ip) hops.set(n, { n, ip, ms: ms != null ? Math.round(Number(ms) * 10) / 10 : null });
  }
  return [...hops.values()].sort((a, b) => a.n - b.n);
}

const cache = new Map(); // ip -> { t, result }
let running = 0;
/** Route from this server to ip: { ip, hops, tool } or { ip, error }. Cached for a minute, at most 4 at once. */
async function trace(ipRaw) {
  const ip = cleanIp(ipRaw);
  if (!isIp(ip)) return { ip, error: 'no_ip' };
  const c = cache.get(ip);
  if (c && Date.now() - c.t < 60e3) return c.result;
  if (running >= 4) return { ip, error: 'busy' };
  running++;
  try {
    let out = await run('traceroute', ['-n', '-q', '1', '-w', '1', '-m', '24', ip], 45e3);
    let tool = 'traceroute';
    if (out == null) { out = await run('tracepath', ['-n', '-m', '24', ip], 45e3); tool = 'tracepath'; }
    const result = out == null ? { ip, error: 'no_traceroute' } : { ip, tool, hops: parseHops(out) };
    cache.set(ip, { t: Date.now(), result });
    return result;
  } finally { running--; }
}

module.exports = { users, enabledFor, setUsers, meInfo, cleanIp, parseHops, trace };
