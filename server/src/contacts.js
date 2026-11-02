'use strict';
// Connection requests between users: A asks, B accepts, and both matrix directions are ticked
// automatically (no admin needed).
//
// 1.7, message requests (like Telegram): A may also write to B by username before B accepts: up to
// REQ_MSGS messages without attachments, which B finds under "requests". A call from A does not ring;
// it is noted on the request as a missed call. B accepts (or simply replies), declines, or blocks.
// A decline is never shown to A (the request just stays "waiting") and B can still accept it later
// from the declined list; a block stops A's messages, and B can lift it from the same list.
const { db, getSetting } = require('./db');
const core = require('./core');

const REQ_MSGS = 3;
const NEW_PER_DAY = +(process.env.REQUESTS_PER_DAY || 30);
const DAY = 864e5;
const q = {
  get: db.prepare('SELECT * FROM contact_requests WHERE from_user=? AND to_user=?'),
  put: db.prepare('INSERT INTO contact_requests(from_user,to_user,status,ts) VALUES(?,?,?,?) ON CONFLICT(from_user,to_user) DO UPDATE SET status=excluded.status, ts=excluded.ts'),
  setStatus: db.prepare('UPDATE contact_requests SET status=? WHERE from_user=? AND to_user=?'),
  addMsg: db.prepare('UPDATE contact_requests SET msgs=msgs+1, ts=? WHERE from_user=? AND to_user=?'),
  addCall: db.prepare('UPDATE contact_requests SET calls=calls+1, last_call=?, ts=? WHERE from_user=? AND to_user=?'),
  del: db.prepare('DELETE FROM contact_requests WHERE (from_user=? AND to_user=?) OR (from_user=? AND to_user=?)'),
  incoming: db.prepare('SELECT from_user AS user, status, ts, msgs, calls, last_call FROM contact_requests WHERE to_user=? ORDER BY ts DESC'),
  outgoing: db.prepare('SELECT to_user AS user, status, ts, msgs FROM contact_requests WHERE from_user=? ORDER BY ts DESC'),
  visOn: db.prepare('INSERT OR IGNORE INTO visibility(viewer,target) VALUES(?,?)'),
  visOff: db.prepare('DELETE FROM visibility WHERE (viewer=? AND target=?) OR (viewer=? AND target=?)'),
  uncut: db.prepare('DELETE FROM disconnects WHERE a=? AND b=?'),
  cut: db.prepare('INSERT OR IGNORE INTO disconnects(a,b) VALUES(?,?)'),
};

const connected = (a, b) => !!core.q.vis.get(a, b) && !!core.q.vis.get(b, a);
/** The admin's switch for writing to strangers (panel, on by default). */
const requestsOn = () => getSetting('msg_requests', '1') === '1';
/** B takes messages from people who are not connected to them (their own privacy setting). */
const takesRequests = (b) => { const u = core.activeUser(b); return !!u && u.allow_requests !== 0; };

const newToday = new Map(); // user -> { n, t }: new people written to today (spam brake)
function countNew(from) {
  const d = newToday.get(from);
  const day = d && Date.now() - d.t < DAY ? d : { n: 0, t: Date.now() };
  if (day.n >= NEW_PER_DAY) throw new Error('rate_limited');
  newToday.set(from, { n: day.n + 1, t: day.t });
}

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
  if (back) { connect(from, to); return 'connected'; } // they had asked me (even if I declined or blocked it): writing back accepts
  const mine = q.get.get(from, to);
  if (mine) return 'sent'; // still waiting, declined or blocked: the sender is never told which
  countNew(from);
  q.put.run(from, to, 'pending', Date.now());
  return 'sent';
}

/**
 * `from` writes to `to` without a connection. Returns 'connected' when `to` had already asked `from`
 * (the message is then an ordinary one), else { status, first } of the request it rides on.
 */
function requestMessage(from, to, hasFile) {
  if (!core.NAME_RE.test(to) || to === from || !core.activeUser(to) || core.isBlocked(from, to)) throw new Error('not_allowed');
  const back = q.get.get(to, from);
  if (back) { connect(from, to); return 'connected'; } // they had asked me (even if I declined or blocked it): writing back accepts
  if (!requestsOn() || !takesRequests(to)) throw new Error('not_allowed');
  if (hasFile) throw new Error('request_text_only');
  let mine = q.get.get(from, to);
  if (mine && mine.status === 'blocked') throw new Error('not_allowed');
  if (mine && mine.msgs >= REQ_MSGS) throw new Error('request_limit');
  if (!mine) { countNew(from); q.put.run(from, to, 'pending', Date.now()); mine = q.get.get(from, to); }
  q.addMsg.run(Date.now(), from, to);
  return { status: mine.status, first: mine.msgs === 0 };
}

/** A call from someone who is not connected: noted on the request instead of ringing. Returns the request status or null. */
function missedCall(from, to) {
  try {
    if (!core.NAME_RE.test(to) || to === from || !core.activeUser(to) || core.isBlocked(from, to) || connected(from, to)) return null;
    if (!requestsOn() || !takesRequests(to)) return null;
    let mine = q.get.get(from, to);
    if (mine && mine.status === 'blocked') return null;
    if (!mine) { countNew(from); q.put.run(from, to, 'pending', Date.now()); mine = q.get.get(from, to); }
    q.addCall.run(Date.now(), Date.now(), from, to);
    return mine.status;
  } catch { return null; }
}

/** `me` writes to someone whose request is open: that is an answer, so it accepts the request. */
function acceptByReply(me, other) {
  const r = q.get.get(other, me);
  if (!r || connected(me, other)) return false;
  connect(me, other);
  return true;
}

function respond(me, from, accept) {
  const r = q.get.get(from, me);
  if (!r) throw new Error('no_request');
  if (accept) {
    if (core.isBlocked(me, from) || !core.activeUser(from)) throw new Error('not_allowed');
    connect(me, from);
  } else if (r.status === 'pending') {
    q.setStatus.run('declined', from, me);
  }
}

/** Blocks the person behind a request (or anyone who wrote): no more messages or missed calls from them. */
function block(me, other) {
  if (!core.NAME_RE.test(other) || other === me || !core.q.user.get(other)) throw new Error('no_such_user');
  if (connected(me, other)) remove(me, other);
  q.del.run(me, other, me, other); // my own request to them goes
  const r = q.get.get(other, me);
  if (r) q.setStatus.run('blocked', other, me);
  else q.put.run(other, me, 'blocked', Date.now());
}
/** Lifts a block: the request goes back to the declined list (it can still be accepted from there). */
function unblock(me, other) {
  const r = q.get.get(other, me);
  if (!r || r.status !== 'blocked') throw new Error('no_request');
  q.setStatus.run('declined', other, me);
}

function cancel(me, to) { q.del.run(me, to, me, to); }

/** Either side ends the connection: both matrix directions go and old messages no longer let them reply. */
function remove(me, other) {
  q.visOff.run(me, other, other, me);
  q.del.run(me, other, other, me);
  q.cut.run(...core.pairKey(me, other));
}

/**
 * incoming: open requests to me (status pending), declined: the ones I declined (can still accept),
 * blocked: the ones I blocked. outgoing: mine to others, always shown as 'pending' (a decline or a
 * block is not told).
 */
function lists(me) {
  const info = (u) => { const x = core.q.user.get(u); return x ? { display_name: x.display_name || null } : null; };
  const inc = q.incoming.all(me).filter((r) => core.activeUser(r.user) && !connected(me, r.user))
    .map((r) => ({ username: r.user, ts: r.ts, msgs: r.msgs, calls: r.calls, last_call: r.last_call || null, status: r.status, ...info(r.user) }));
  return {
    incoming: inc.filter((r) => r.status === 'pending'),
    declined: inc.filter((r) => r.status === 'declined'),
    blocked: inc.filter((r) => r.status === 'blocked'),
    outgoing: q.outgoing.all(me).filter((r) => core.activeUser(r.user) && !connected(me, r.user))
      .map((r) => ({ username: r.user, status: 'pending', ts: r.ts, msgs: r.msgs })),
  };
}

module.exports = {
  REQ_MSGS, request, requestMessage, missedCall, acceptByReply, respond, block, unblock, cancel, remove, lists, connected, requestsOn, takesRequests,
};
