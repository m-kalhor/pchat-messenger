'use strict';
// 1.14: per-user usage for the admin panel's «مصرف کاربران» tab.
// Two things are counted live from this version on (nothing older exists): the bytes each signed-in user moves
// through the server (up = request bodies, down = response bodies incl. downloads and the live event stream) and
// calls (the signalling is end-to-end encrypted, so voice and video look the same; the length is from the accept to
// the hang-up as seen by the server). Everything else in the report is read from the tables that already exist.
const fs = require('node:fs');
const path = require('node:path');
const { db, DATA_DIR } = require('./db');

db.exec(`
CREATE TABLE IF NOT EXISTS usage_daily (
  username TEXT NOT NULL, day TEXT NOT NULL, up INTEGER NOT NULL DEFAULT 0, down INTEGER NOT NULL DEFAULT 0,
  calls_out INTEGER NOT NULL DEFAULT 0, calls_in INTEGER NOT NULL DEFAULT 0, call_secs INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (username, day));
`);

const DAY = 86400e3;
const KEEP_DAYS = 400;
const FIELDS = ['up', 'down', 'calls_out', 'calls_in', 'call_secs'];
const dayOf = (t) => new Date(t).toISOString().slice(0, 10);

// counted in memory, written to the database every 30 s (and when the server stops)
let pending = new Map(); // "user\nday" -> { up, down, ... }
function add(user, field, n) {
  if (!user || !n) return;
  const k = user + '\n' + dayOf(Date.now());
  let e = pending.get(k);
  if (!e) pending.set(k, (e = { up: 0, down: 0, calls_out: 0, calls_in: 0, call_secs: 0 }));
  e[field] += n;
}
const upsert = db.prepare(`INSERT INTO usage_daily(username,day,up,down,calls_out,calls_in,call_secs) VALUES(?,?,?,?,?,?,?)
  ON CONFLICT(username,day) DO UPDATE SET up=up+excluded.up, down=down+excluded.down, calls_out=calls_out+excluded.calls_out,
  calls_in=calls_in+excluded.calls_in, call_secs=call_secs+excluded.call_secs`);
function flush() {
  if (!pending.size) return;
  const batch = pending; pending = new Map();
  try {
    db.exec('BEGIN');
    for (const [k, e] of batch) { const [u, d] = k.split('\n'); upsert.run(u, d, ...FIELDS.map((f) => e[f])); }
    db.exec('COMMIT');
  } catch (e) { try { db.exec('ROLLBACK'); } catch { } console.error('usage flush', e.message); }
}

/** Counts the body bytes of one signed-in request and its response (file transfers, the event stream, the API). */
function track(user, req, res) {
  const push = req.push;
  req.push = function (chunk, enc) { if (chunk) add(user, 'up', chunk.length); return push.call(this, chunk, enc); };
  const len = (c, enc) => (!c || typeof c === 'function' ? 0 : typeof c === 'string' ? Buffer.byteLength(c, typeof enc === 'string' ? enc : 'utf8') : c.length);
  const write = res.write, end = res.end;
  res.write = function (c, enc, cb) { add(user, 'down', len(c, enc)); return write.call(this, c, enc, cb); };
  res.end = function (c, enc, cb) { add(user, 'down', len(c, enc)); return end.call(this, c, enc, cb); };
}

// ---- calls, from the (encrypted) signalling: invite -> accept -> hang-up/reject, per pair of users ----
const calls = new Map(); // "a\nb" (sorted) -> { from, to, t, start }
const pairKey = (a, b) => (a < b ? a + '\n' + b : b + '\n' + a);
function endCall(k) {
  const c = calls.get(k);
  if (!c) return;
  calls.delete(k);
  if (c.start) {
    const secs = Math.round((Date.now() - c.start) / 1000);
    add(c.from, 'call_secs', secs); add(c.to, 'call_secs', secs);
  }
}
function signal(from, to, kind, delivered) {
  const k = pairKey(from, to);
  if (kind === 'sig_invite') {
    const c = calls.get(k);
    if (c && c.from === from && !c.start && Date.now() - c.t < 120e3) return; // the same call, invited again
    endCall(k);
    calls.set(k, { from, to, t: Date.now(), start: 0 });
    add(from, 'calls_out', 1);
    if (delivered) add(to, 'calls_in', 1);
  } else if (kind === 'sig_accept') {
    const c = calls.get(k);
    if (c && c.to === from && !c.start) c.start = Date.now();
  } else if (kind === 'sig_hangup' || kind === 'sig_reject') {
    endCall(k);
  }
}
function sweepCalls() { // a call left open (an app died) stops counting after 6 hours
  const t = Date.now();
  for (const [k, c] of calls) if (t - (c.start || c.t) > 6 * 3600e3) calls.delete(k);
}

function deleteUser(name) {
  for (const k of pending.keys()) if (k.startsWith(name + '\n')) pending.delete(k);
  db.prepare('DELETE FROM usage_daily WHERE username=?').run(name);
}
function cleanup() { db.prepare('DELETE FROM usage_daily WHERE day<?').run(dayOf(Date.now() - KEEP_DAYS * DAY)); }

/** One row per user for the admin panel (bytes, counts, unix-ms times). */
function report(ctx = {}) {
  flush();
  const t = Date.now();
  const d7 = t - 7 * DAY, d30 = t - 30 * DAY, day30 = dayOf(d30);
  const by = (sql, ...args) => { const m = new Map(); for (const r of db.prepare(sql).all(...args)) m.set(r.u, r); return m; };
  const sent = by(`SELECT sender AS u, COUNT(*) AS n, SUM(ts>=?) AS n7, SUM(ts>=?) AS n30,
    SUM(target='all' OR target LIKE 'g:%') AS grp, SUM(file_id IS NOT NULL) AS withfile, COALESCE(SUM(LENGTH(payload)),0) AS bytes
    FROM messages WHERE deleted=0 GROUP BY sender`, d7, d30);
  const recv = by(`SELECT target AS u, COUNT(*) AS n FROM messages WHERE deleted=0 AND target<>'all' AND target NOT LIKE 'g:%' GROUP BY target`);
  const files = by('SELECT owner AS u, COUNT(*) AS n, COALESCE(SUM(size),0) AS bytes FROM files GROUP BY owner');
  let stk = new Map();
  try { stk = by('SELECT p.owner AS u, COUNT(*) AS n, COALESCE(SUM(s.size),0) AS bytes FROM stickers s JOIN sticker_packs p ON p.id=s.pack_id WHERE p.owner IS NOT NULL GROUP BY p.owner'); } catch { }
  const sess = new Map();
  for (const r of db.prepare('SELECT username AS u, device, via FROM sessions').all()) {
    if (!sess.has(r.u)) sess.set(r.u, []);
    sess.get(r.u).push(r.device || r.via || '?');
  }
  const reqs = by('SELECT from_user AS u, COUNT(*) AS n FROM contact_requests GROUP BY from_user');
  const blocked = by('SELECT target AS u, COUNT(*) AS n FROM blocks GROUP BY target');
  const traffic = by(`SELECT username AS u, SUM(up) AS up, SUM(down) AS down, SUM(CASE WHEN day>=? THEN up+down ELSE 0 END) AS t30,
    SUM(calls_out) AS calls_out, SUM(calls_in) AS calls_in, SUM(call_secs) AS call_secs FROM usage_daily GROUP BY username`, day30);
  const since = db.prepare('SELECT MIN(day) AS d FROM usage_daily').get().d;

  const users = db.prepare('SELECT username, display_name, phone, disabled, created, last_seen FROM users ORDER BY username').all();
  const rows = users.map((u) => {
    const s = sent.get(u.username) || {}, f = files.get(u.username) || {}, st = stk.get(u.username) || {}, tr = traffic.get(u.username) || {};
    let avatar = 0;
    try { avatar = fs.statSync(path.join(DATA_DIR, 'avatars', u.username + '.webp')).size; } catch { }
    const text = Number(s.bytes || 0);
    const storage = Number(f.bytes || 0) + text + avatar + Number(st.bytes || 0);
    return {
      username: u.username, display_name: u.display_name || '', phone: u.phone || '', disabled: !!u.disabled,
      online: ctx.isOnline ? !!ctx.isOnline(u.username) : false, created: u.created, last_seen: u.last_seen || null,
      sent: Number(s.n || 0), sent7: Number(s.n7 || 0), sent30: Number(s.n30 || 0), sent_group: Number(s.grp || 0),
      received: Number((recv.get(u.username) || {}).n || 0),
      files: Number(f.n || 0), files_bytes: Number(f.bytes || 0), text_bytes: text, avatar_bytes: avatar,
      stickers: Number(st.n || 0), stickers_bytes: Number(st.bytes || 0), storage,
      devices: (sess.get(u.username) || []).length, device_names: sess.get(u.username) || [],
      requests: Number((reqs.get(u.username) || {}).n || 0), blocked_by: Number((blocked.get(u.username) || {}).n || 0),
      up: Number(tr.up || 0), down: Number(tr.down || 0), traffic: Number(tr.up || 0) + Number(tr.down || 0), traffic30: Number(tr.t30 || 0),
      calls_out: Number(tr.calls_out || 0), calls_in: Number(tr.calls_in || 0), call_secs: Number(tr.call_secs || 0),
    };
  });
  return { rows, since, now: t };
}

function start() {
  setInterval(flush, 30e3).unref();
  setInterval(sweepCalls, 3600e3).unref(); // old days are pruned by the server's hourly cleanup()
  process.on('exit', flush);
}

module.exports = { start, track, signal, report, flush, deleteUser, cleanup, _calls: calls };
