'use strict';
// Connection requests between users: A asks, B accepts, and both matrix directions are ticked
// automatically (no admin needed). Declined requests can be repeated after a day.
const { db } = require('./db');
const core = require('./core');

const RETRY_MS = 24 * 3600 * 1000;
const q = {
  get: db.prepare('SELECT * FROM contact_requests WHERE from_user=? AND to_user=?'),
  put: db.prepare('INSERT INTO contact_requests(from_user,to_user,status,ts) VALUES(?,?,?,?) ON CONFLICT(from_user,to_user) DO UPDATE SET status=excluded.status, ts=excluded.ts'),
  del: db.prepare('DELETE FROM contact_requests WHERE (from_user=? AND to_user=?) OR (from_user=? AND to_user=?)'),
  incoming: db.prepare("SELECT from_user AS user, ts FROM contact_requests WHERE to_user=? AND status='pending' ORDER BY ts DESC"),
  outgoing: db.prepare('SELECT to_user AS user, status, ts FROM contact_requests WHERE from_user=? ORDER BY ts DESC'),
  visOn: db.prepare('INSERT OR IGNORE INTO visibility(viewer,target) VALUES(?,?)'),
  visOff: db.prepare('DELETE FROM visibility WHERE (viewer=? AND target=?) OR (viewer=? AND target=?)'),
  uncut: db.prepare('DELETE FROM disconnects WHERE a=? AND b=?'),
  cut: db.prepare('INSERT OR IGNORE INTO disconnects(a,b) VALUES(?,?)'),
};

const connected = (a, b) => !!core.q.vis.get(a, b) && !!core.q.vis.get(b, a);

function connect(a, b) {
  q.visOn.run(a, b);
  q.visOn.run(b, a);
  q.uncut.run(...core.pairKey(a, b));
  q.del.run(a, b, b, a);
}

/** Returns 'sent' or 'connected' (the other side had already asked), or throws an error code. */
function request(from, to) {
  if (!core.NAME_RE.test(to) || to === from) throw new Error('bad_username');
  if (!core.activeUser(to)) throw new Error('no_such_user');
  if (core.isBlocked(from, to)) throw new Error('not_allowed');
  if (connected(from, to)) throw new Error('already_connected');
  const back = q.get.get(to, from);
  if (back && back.status === 'pending') { connect(from, to); return 'connected'; }
  const mine = q.get.get(from, to);
  if (mine && mine.status === 'declined' && Date.now() - mine.ts < RETRY_MS) throw new Error('declined_recently');
  q.put.run(from, to, 'pending', Date.now());
  return 'sent';
}

function respond(me, from, accept) {
  const r = q.get.get(from, me);
  if (!r || r.status !== 'pending') throw new Error('no_request');
  if (accept) {
    if (core.isBlocked(me, from) || !core.activeUser(from)) throw new Error('not_allowed');
    connect(me, from);
  } else {
    q.put.run(from, me, 'declined', Date.now());
  }
}

function cancel(me, to) { q.del.run(me, to, me, to); }

/** Either side ends the connection: both matrix directions go and old messages no longer let them reply. */
function remove(me, other) {
  q.visOff.run(me, other, other, me);
  q.del.run(me, other, other, me);
  q.cut.run(...core.pairKey(me, other));
}

function lists(me) {
  const info = (u) => { const x = core.q.user.get(u); return x ? { display_name: x.display_name || null } : null; };
  return {
    incoming: q.incoming.all(me).filter((r) => core.activeUser(r.user)).map((r) => ({ username: r.user, ts: r.ts, ...info(r.user) })),
    outgoing: q.outgoing.all(me).filter((r) => core.activeUser(r.user)).map((r) => ({ username: r.user, status: r.status, ts: r.ts })),
  };
}

module.exports = { request, respond, cancel, remove, lists, connected };
