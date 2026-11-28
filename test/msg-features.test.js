'use strict';
// 1.29: «پیام‌های ذخیره‌شده» (a chat with oneself), «ارسال زمان‌دار» (scheduled), «ارسال بی‌صدا» (silent)
// and per-user synced settings (/api/prefs: folders and the archive, sealed by the client).
const test = require('node:test');
const assert = require('node:assert/strict');
const { startServer } = require('./helpers/server');

let S, ali, bob, cy;

test.before(async () => {
  S = await startServer({ SCHED_TICK_MS: '200', SCHED_MAX: '3' });
  ali = await S.user('ali');
  bob = await S.user('bob');
  cy = await S.user('cy');
  S.db.prepare("INSERT INTO visibility(viewer,target) VALUES('ali','bob'),('bob','ali')").run();
});
test.after(() => S && S.stop());

async function events(tok, query, ms = 400) {
  const ctl = new AbortController();
  const r = await fetch(S.base + '/api/events?' + query, { headers: { authorization: 'Bearer ' + tok }, signal: ctl.signal });
  const reader = r.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  const stop = setTimeout(() => ctl.abort(), ms);
  try { for (;;) { const { value, done } = await reader.read(); if (done) break; buf += dec.decode(value, { stream: true }); } } catch { } finally { clearTimeout(stop); }
  const out = [];
  for (const block of buf.split('\n\n')) {
    const ev = /^event: (.+)$/m.exec(block);
    const data = /^data: (.+)$/m.exec(block);
    if (ev && data) out.push({ event: ev[1], data: JSON.parse(data[1]) });
  }
  return out;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test('saved messages: a chat with oneself, only for oneself, not removed after 90 days', async () => {
  const r = await S.api(ali, 'POST', '/api/send', { target: 'ali', payload: 'note' });
  assert.equal(r.status, 200);
  const id = r.data.id;
  const mine = await events(ali, 'since=0');
  assert.ok(mine.some((e) => e.event === 'msg' && e.data.id === id && e.data.target === 'ali' && e.data.from === 'ali'));
  const theirs = await events(bob, 'since=0');
  assert.ok(!theirs.some((e) => e.event === 'msg' && e.data.id === id));
  // edit and delete work like in any chat
  assert.equal((await S.api(ali, 'POST', '/api/edit', { id, payload: 'note2' })).status, 200);
  // receipts and typing for oneself are ignored, not errors
  assert.equal((await S.api(ali, 'POST', '/api/receipts', { items: [{ target: 'ali', delivered: id, seen: id }] })).status, 200);
  assert.equal((await S.api(ali, 'POST', '/api/typing', { target: 'ali' })).status, 200);
  // the 90-day cleanup keeps it (old normal messages go)
  const old = Date.now() - 100 * 864e5;
  S.db.prepare('UPDATE messages SET ts=? WHERE id=?').run(old, id);
  const other = (await S.api(ali, 'POST', '/api/send', { target: 'bob', payload: 'x' })).data.id;
  S.db.prepare('UPDATE messages SET ts=? WHERE id=?').run(old, other);
  const me = (await S.api(ali, 'GET', '/api/me')).data;
  assert.deepEqual({ saved: me.feats.saved, sched: me.feats.sched }, { saved: true, sched: true });
});

test('saved messages can be switched off by the admin', async () => {
  S.db.prepare("INSERT OR REPLACE INTO settings(key,value) VALUES('feat_saved','0')").run();
  assert.equal((await S.api(bob, 'POST', '/api/send', { target: 'bob', payload: 'n' })).status, 403);
  S.db.prepare("INSERT OR REPLACE INTO settings(key,value) VALUES('feat_saved','1')").run();
  assert.equal((await S.api(bob, 'POST', '/api/send', { target: 'bob', payload: 'n' })).status, 200);
});

test('silent messages carry silent:1 to the receiver', async () => {
  const id = (await S.api(ali, 'POST', '/api/send', { target: 'bob', payload: 'shh', silent: 1 })).data.id;
  const evs = await events(bob, 'since=' + (id - 1));
  const m = evs.find((e) => e.event === 'msg' && e.data.id === id);
  assert.equal(m.data.silent, 1);
  const id2 = (await S.api(ali, 'POST', '/api/send', { target: 'bob', payload: 'loud' })).data.id;
  const m2 = (await events(bob, 'since=' + (id2 - 1))).find((e) => e.event === 'msg' && e.data.id === id2);
  assert.equal(m2.data.silent, undefined);
});

test('a scheduled message waits on the server and goes out at its time', async () => {
  const at = Date.now() + 600;
  const r = await S.api(ali, 'POST', '/api/send', { target: 'bob', payload: 'later', at, silent: 1 });
  assert.equal(r.status, 200);
  assert.ok(r.data.scheduled > 0);
  const list = (await S.api(ali, 'GET', '/api/scheduled')).data.list;
  assert.equal(list.length, 1);
  assert.equal(list[0].payload, 'later');
  assert.equal(list[0].silent, 1);
  // bob sees nothing yet, and cannot see ali's queue
  assert.equal((await S.api(bob, 'GET', '/api/scheduled')).data.list.length, 0);
  assert.ok(!(await events(bob, 'since=0', 200)).some((e) => e.event === 'msg' && e.data.payload === 'later'));
  await sleep(1200);
  const got = (await events(bob, 'since=0')).find((e) => e.event === 'msg' && e.data.payload === 'later');
  assert.ok(got, 'delivered');
  assert.equal(got.data.from, 'ali');
  assert.equal(got.data.silent, 1);
  assert.ok(got.data.ts >= at);
  assert.equal((await S.api(ali, 'GET', '/api/scheduled')).data.list.length, 0);
});

test('scheduled messages: edit time, send now, delete, limits', async () => {
  const far = Date.now() + 864e5;
  const a = (await S.api(ali, 'POST', '/api/send', { target: 'bob', payload: 's1', at: far })).data.scheduled;
  const b = (await S.api(ali, 'POST', '/api/send', { target: 'bob', payload: 's2', at: far })).data.scheduled;
  const c = (await S.api(ali, 'POST', '/api/send', { target: 'bob', payload: 's3', at: far })).data.scheduled;
  // SCHED_MAX=3 in this test server
  assert.equal((await S.api(ali, 'POST', '/api/send', { target: 'bob', payload: 's4', at: far })).status, 429);
  // too far ahead / in the past / to a stranger / a signal
  assert.equal((await S.api(bob, 'POST', '/api/send', { target: 'ali', payload: 'x', at: Date.now() + 40 * 864e5 })).status, 400);
  assert.equal((await S.api(bob, 'POST', '/api/send', { target: 'ali', payload: 'x', at: Date.now() - 3600e3 })).status, 400);
  assert.equal((await S.api(cy, 'POST', '/api/send', { target: 'ali', payload: 'x', at: far })).status, 403);
  assert.equal((await S.api(bob, 'POST', '/api/send', { target: 'ali', kind: 'sig_typing', payload: 'x', at: far })).status, 400);
  // somebody else's scheduled message is not theirs to touch
  assert.equal((await S.api(bob, 'POST', '/api/scheduled/delete', { id: a })).status, 404);

  const r = await S.api(ali, 'POST', '/api/scheduled/update', { id: a, at: far + 1000, payload: 's1b' });
  assert.equal(r.status, 200);
  assert.equal(r.data.list.find((x) => x.id === a).payload, 's1b');
  assert.equal((await S.api(ali, 'POST', '/api/scheduled/delete', { id: b })).status, 200);
  assert.equal((await S.api(ali, 'POST', '/api/scheduled/now', { id: c })).status, 200);
  const left = (await S.api(ali, 'GET', '/api/scheduled')).data.list;
  assert.deepEqual(left.map((x) => x.id), [a]);
  assert.ok((await events(bob, 'since=0')).some((e) => e.event === 'msg' && e.data.payload === 's3'));
  await S.api(ali, 'POST', '/api/scheduled/delete', { id: a });
});

test('a scheduled message that can no longer go out is kept as failed for its sender', async () => {
  const id = (await S.api(ali, 'POST', '/api/send', { target: 'bob', payload: 'gone', at: Date.now() + 300 })).data.scheduled;
  S.db.prepare("DELETE FROM visibility WHERE (viewer='ali' AND target='bob') OR (viewer='bob' AND target='ali')").run();
  S.db.prepare("DELETE FROM messages WHERE sender='bob' AND target='ali'").run();
  await sleep(900);
  const l = (await S.api(ali, 'GET', '/api/scheduled')).data.list;
  assert.equal(l.find((x) => x.id === id).failed, 'not_allowed');
  S.db.prepare("INSERT INTO visibility(viewer,target) VALUES('ali','bob'),('bob','ali')").run();
  await S.api(ali, 'POST', '/api/scheduled/delete', { id });
});

test('scheduled messages can be switched off by the admin', async () => {
  S.db.prepare("INSERT OR REPLACE INTO settings(key,value) VALUES('feat_sched','0')").run();
  assert.equal((await S.api(ali, 'POST', '/api/send', { target: 'bob', payload: 'x', at: Date.now() + 864e5 })).status, 403);
  S.db.prepare("INSERT OR REPLACE INTO settings(key,value) VALUES('feat_sched','1')").run();
});

test('prefs: stored per user and key, a change reaches the user\'s other devices', async () => {
  assert.deepEqual((await S.api(ali, 'GET', '/api/prefs?k=chatlist')).data, { v: null, ts: 0 });
  assert.equal((await S.api(ali, 'GET', '/api/prefs?k=other')).status, 400);
  const w = await S.api(ali, 'POST', '/api/prefs', { k: 'chatlist', v: 'sealed-blob', dev: 'd1' });
  assert.equal(w.status, 200);
  const r = (await S.api(ali, 'GET', '/api/prefs?k=chatlist')).data;
  assert.equal(r.v, 'sealed-blob');
  assert.equal(r.ts, w.data.ts);
  assert.deepEqual((await S.api(bob, 'GET', '/api/prefs?k=chatlist')).data, { v: null, ts: 0 });
  assert.equal((await S.api(ali, 'POST', '/api/prefs', { k: 'chatlist', v: 'x'.repeat(65537) })).status, 400);
});
