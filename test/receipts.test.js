'use strict';
// 1.4: delivered / seen ticks (watermarks per user and conversation), "seen" privacy that works both
// ways, online / last seen with the app in the foreground or background, typing in groups, reactions.
const test = require('node:test');
const assert = require('node:assert/strict');
const { startServer } = require('./helpers/server');

let S, ali, bob, cy, grp;

test.before(async () => {
  S = await startServer();
  grp = S.core.createCategory('تیم');
  ali = await S.user('ali', [grp]);
  bob = await S.user('bob', [grp]);
  cy = await S.user('cy', [grp]);
  S.db.prepare("INSERT INTO visibility(viewer,target) VALUES('ali','bob'),('bob','ali'),('ali','cy'),('cy','ali')").run();
});
test.after(() => S && S.stop());

const gkey = () => 'g:' + grp;
const send = async (tok, target, payload = 'x') => (await S.api(tok, 'POST', '/api/send', { target, payload })).data.id;
const receipts = (tok, items) => S.api(tok, 'POST', '/api/receipts', { items });
const rcptRow = (u, convo) => { const r = S.db.prepare('SELECT delivered, seen FROM receipts WHERE username=? AND convo=?').get(u, convo); return r && { ...r }; };

/** Reads the event stream for a moment and returns the parsed events. */
async function events(tok, query, ms = 400) {
  const ctl = new AbortController();
  const r = await fetch(S.base + '/api/events?' + query, { headers: { authorization: 'Bearer ' + tok }, signal: ctl.signal });
  const reader = r.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  const stop = setTimeout(() => ctl.abort(), ms);
  try { for (;;) { const { value, done } = await reader.read(); if (done) break; buf += dec.decode(value, { stream: true }); } } catch { } finally { clearTimeout(stop); }
  return parse(buf);
}
function parse(buf) {
  const out = [];
  for (const block of buf.split('\n\n')) {
    const ev = /^event: (.+)$/m.exec(block);
    const data = /^data: (.+)$/m.exec(block);
    if (ev && data) out.push({ event: ev[1], data: JSON.parse(data[1]) });
  }
  return out;
}
/** A live connection: collects events until close(). */
async function live(tok, query = 'since=999999999') {
  const ctl = new AbortController();
  const r = await fetch(S.base + '/api/events?' + query, { headers: { authorization: 'Bearer ' + tok }, signal: ctl.signal });
  const reader = r.body.getReader();
  const dec = new TextDecoder();
  const c = { buf: '', events: () => parse(c.buf), close: () => ctl.abort() };
  (async () => { try { for (;;) { const { value, done } = await reader.read(); if (done) break; c.buf += dec.decode(value, { stream: true }); } } catch { } })();
  c.waitFor = async (pred, ms = 2000) => {
    const end = Date.now() + ms;
    while (Date.now() < end) { const e = c.events().find(pred); if (e) return e; await new Promise((r2) => setTimeout(r2, 20)); }
    throw new Error('event not seen; got ' + JSON.stringify(c.events().map((e) => e.event)));
  };
  await c.waitFor(() => true, 2000).catch(() => { });
  return c;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test('delivered and seen are watermarks that only grow and never pass the newest message', async () => {
  const a = await send(ali, 'bob');
  const b = await send(ali, 'bob');
  const key = 'dm:ali:bob';
  const al = await live(ali);
  assert.equal((await receipts(bob, [{ target: 'ali', delivered: b }])).status, 200);
  const ev = await al.waitFor((e) => e.event === 'receipt' && e.data.user === 'bob');
  assert.deepEqual(ev.data, { convo: 'bob', user: 'bob', delivered: b, seen: 0 });
  await receipts(bob, [{ target: 'ali', seen: a }]);
  assert.deepEqual(rcptRow('bob', key), { delivered: b, seen: a });
  await receipts(bob, [{ target: 'ali', delivered: a, seen: 1 }]);
  assert.deepEqual(rcptRow('bob', key), { delivered: b, seen: a }, 'going back is ignored');
  await receipts(bob, [{ target: 'ali', seen: b + 1000 }]);
  assert.deepEqual(rcptRow('bob', key), { delivered: b, seen: b }, 'capped at the newest message from ali');
  al.close();

  // a reconnecting (new) client gets every receipt of its chats, old clients get no new events
  const evs = await events(ali, 'since=999999999&csince=0&rsince=0');
  const list = evs.find((e) => e.event === 'receipts').data.list;
  assert.deepEqual(list.find((r) => r.user === 'bob' && r.convo === 'bob'), { convo: 'bob', user: 'bob', delivered: b, seen: b });
  assert.ok(!(await events(ali, 'since=999999999')).some((e) => e.event === 'receipts'));
  assert.ok(!(await events(cy, 'since=999999999&rsince=0')).find((e) => e.event === 'receipts').data.list.some((r) => r.convo === 'bob' || r.user === 'bob'), 'outsiders see nothing');
});

test('receipts reach the reader\'s other devices (read on one = read on all) and are refused for strangers', async () => {
  const id = await send(ali, 'bob');
  const bobPhone = await live(bob);
  await receipts(bob, [{ target: 'ali', seen: id }]);
  const own = await bobPhone.waitFor((e) => e.event === 'receipt' && e.data.user === 'bob');
  assert.equal(own.data.convo, 'ali');
  assert.equal(own.data.seen, id);
  bobPhone.close();
  await receipts(cy, [{ target: 'bob', delivered: id }]);
  assert.equal(rcptRow('cy', 'dm:bob:cy'), undefined, 'no chat between cy and bob');
});

test('groups: every member reports separately; all of them see each other\'s receipts', async () => {
  const id = await send(ali, gkey());
  const al = await live(ali);
  await receipts(bob, [{ target: gkey(), delivered: id, seen: id }]);
  await receipts(cy, [{ target: gkey(), delivered: id }]);
  await al.waitFor((e) => e.event === 'receipt' && e.data.user === 'cy');
  const got = al.events().filter((e) => e.event === 'receipt' && e.data.convo === gkey()).map((e) => e.data);
  assert.deepEqual(got.find((r) => r.user === 'bob'), { convo: gkey(), user: 'bob', delivered: id, seen: id });
  assert.deepEqual(got.find((r) => r.user === 'cy'), { convo: gkey(), user: 'cy', delivered: id, seen: 0 });
  al.close();
  const list = (await events(cy, 'since=999999999&rsince=0')).find((e) => e.event === 'receipts').data.list;
  assert.ok(list.some((r) => r.convo === gkey() && r.user === 'bob' && r.seen === id));
});

test('hiding "seen" works both ways in private chats, and never in groups', async () => {
  const id = await send(ali, 'bob');
  assert.deepEqual((await S.api(bob, 'POST', '/api/privacy', { hide_seen: true })).data, { hide_seen: true, hide_last_seen: false });
  assert.equal((await S.api(bob, 'GET', '/api/me')).data.hide_seen, true);
  const before = rcptRow('bob', 'dm:ali:bob').seen;
  await receipts(bob, [{ target: 'ali', seen: id }]);
  const row = rcptRow('bob', 'dm:ali:bob');
  assert.equal(row.seen, before, 'bob\'s reading is not recorded');
  assert.equal(row.delivered, id, 'delivery still is');

  // bob does not see ali's "seen" either
  const back = await send(bob, 'ali');
  await receipts(ali, [{ target: 'bob', seen: back }]);
  assert.equal(rcptRow('ali', 'dm:ali:bob').seen, back);
  const list = (await events(bob, 'since=999999999&rsince=0')).find((e) => e.event === 'receipts').data.list;
  const fromAli = list.find((r) => r.user === 'ali' && r.convo === 'ali');
  assert.equal(fromAli.seen, 0);
  assert.equal(fromAli.delivered, back);

  const g = await send(ali, gkey());
  await receipts(bob, [{ target: gkey(), seen: g }]);
  assert.equal(rcptRow('bob', gkey()).seen, g, 'groups always show who read');
  await S.api(bob, 'POST', '/api/privacy', { hide_seen: false });
});

test('online means "app on screen"; last seen is kept and hiding it works both ways', async () => {
  const userOf = async (tok, who) => (await S.api(tok, 'GET', '/api/users')).data.find((u) => u.username === who);
  // Android: connected in the background, then the app is opened
  const phone = await live(bob, 'since=999999999&dev=p1&active=0');
  assert.equal((await userOf(ali, 'bob')).online, false);
  const al = await live(ali, 'since=999999999&dev=w1');
  await S.api(bob, 'POST', '/api/presence', { dev: 'p1', active: true });
  await al.waitFor((e) => e.event === 'presence' && e.data.user === 'bob' && e.data.online);
  assert.equal((await userOf(ali, 'bob')).online, true);
  const t0 = Date.now();
  await S.api(bob, 'POST', '/api/presence', { dev: 'p1', active: false });
  const off = await al.waitFor((e) => e.event === 'presence' && e.data.user === 'bob' && !e.data.online);
  assert.ok(off.data.last_seen >= t0 - 1000);
  const u = await userOf(ali, 'bob');
  assert.equal(u.online, false);
  assert.ok(u.last_seen >= t0 - 1000);
  assert.equal(u.recently, false);

  // bob hides it: ali only sees "recently", and bob sees nobody's last seen either
  await S.api(bob, 'POST', '/api/privacy', { hide_last_seen: true });
  await sleep(100);
  const seenBefore = al.events().filter((e) => e.event === 'presence' && e.data.user === 'bob').length;
  const hidden = await userOf(ali, 'bob');
  assert.deepEqual([hidden.online, hidden.last_seen, hidden.recently], [false, null, true]);
  await S.api(bob, 'POST', '/api/presence', { dev: 'p1', active: true });
  await sleep(150);
  assert.equal(al.events().filter((e) => e.event === 'presence' && e.data.user === 'bob').length, seenBefore, 'no presence events for hidden users');
  assert.equal((await userOf(ali, 'bob')).online, false);
  const aliSeenByBob = await userOf(bob, 'ali');
  assert.equal(aliSeenByBob.online, false, 'ali is online, but bob hides his own, so he cannot see others');
  assert.equal(aliSeenByBob.recently, true);
  assert.equal((await userOf(bob, 'bob')).online, true, 'one always sees oneself');
  await S.api(bob, 'POST', '/api/privacy', { hide_last_seen: false });
  assert.equal((await userOf(ali, 'bob')).online, true);
  phone.close(); al.close();

  // old clients (no `active`) count as online while connected, like before
  const old = await live(cy);
  assert.equal((await userOf(ali, 'cy')).online, true);
  old.close();
  await sleep(150);
  assert.equal((await userOf(ali, 'cy')).online, false);
});

test('typing in groups reaches the other members only', async () => {
  const b = await live(bob), a = await live(ali);
  assert.equal((await S.api(cy, 'POST', '/api/typing', { target: gkey() })).status, 200);
  const ev = await b.waitFor((e) => e.event === 'typing');
  assert.deepEqual(ev.data, { convo: gkey(), from: 'cy' });
  await a.waitFor((e) => e.event === 'typing');
  const c = await live(cy);
  await S.api(cy, 'POST', '/api/typing', { target: gkey() });
  await sleep(150);
  assert.ok(!c.events().some((e) => e.event === 'typing'), 'not echoed to the typist');
  assert.equal((await S.api(cy, 'POST', '/api/typing', { target: 'bob' })).status, 403);
  a.close(); b.close(); c.close();
});

test('reactions: one per person, change or remove it, live and on reconnect', async () => {
  const id = await send(ali, 'bob');
  const start = (await events(bob, 'since=999999999&rsince=-1')).find((e) => e.event === 'rseq').data.seq;
  const al = await live(ali);
  assert.equal((await S.api(bob, 'POST', '/api/react', { id, emoji: '👍' })).status, 200);
  const ev = await al.waitFor((e) => e.event === 'react');
  assert.deepEqual({ ...ev.data, seq: 0 }, { seq: 0, id, from: 'ali', target: 'bob', user: 'bob', emoji: '👍' });
  await S.api(bob, 'POST', '/api/react', { id, emoji: '❤️' });
  await S.api(ali, 'POST', '/api/react', { id, emoji: '😂' });
  for (const bad of ['a', 'ok', '👍 ', '<b>', '1', 'x'.repeat(20), 42]) assert.equal((await S.api(bob, 'POST', '/api/react', { id, emoji: bad })).status, 400, String(bad));
  assert.equal((await S.api(cy, 'POST', '/api/react', { id, emoji: '👍' })).status, 404, 'outsiders cannot react');
  al.close();

  // a fresh device gets them with the message, a reconnecting one as changes
  const msg = (await events(bob, 'since=0')).find((e) => e.event === 'msg' && e.data.id === id);
  assert.deepEqual(msg.data.reactions, { bob: '❤️', ali: '😂' });
  const ch = (await events(bob, `since=${id}&rsince=${start}`)).filter((e) => e.event === 'react').map((e) => [e.data.user, e.data.emoji]);
  assert.deepEqual(ch, [['bob', '❤️'], ['ali', '😂']], 'only the latest reaction of each person');

  await S.api(bob, 'POST', '/api/react', { id, emoji: null });
  const msg2 = (await events(ali, 'since=0')).find((e) => e.event === 'msg' && e.data.id === id);
  assert.deepEqual(msg2.data.reactions, { ali: '😂' });
  const last = (await events(ali, `since=${id}&rsince=${start}`)).filter((e) => e.event === 'react').at(-1).data;
  assert.deepEqual([last.user, last.emoji], ['bob', null]);

  // group members react too; deleting the message drops its reactions
  const g = await send(ali, gkey());
  assert.equal((await S.api(cy, 'POST', '/api/react', { id: g, emoji: '🔥' })).status, 200);
  await S.api(ali, 'POST', '/api/delete', { id: g });
  assert.equal(S.db.prepare('SELECT COUNT(*) AS n FROM reactions WHERE msg_id=?').get(g).n, 0);
  assert.equal((await S.api(cy, 'POST', '/api/react', { id: g, emoji: '🔥' })).status, 404);
});
