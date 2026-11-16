'use strict';
// 1.22: a sticker sent with the full-screen effect carries fx:1 outside the E2E payload; the server lets
// each user have one every 5 seconds (a sooner one is stored as a plain message) and replays the flag.
const test = require('node:test');
const assert = require('node:assert/strict');
const { startServer } = require('./helpers/server');

let S, ali, bob;
test.before(async () => {
  S = await startServer();
  ali = await S.user('ali');
  bob = await S.user('bob');
  S.db.prepare("INSERT INTO visibility(viewer,target) VALUES('ali','bob'),('bob','ali')").run();
});
test.after(() => S && S.stop());

async function events(tok, query) {
  const ctl = new AbortController();
  const r = await fetch(S.base + '/api/events?' + query, { headers: { authorization: 'Bearer ' + tok }, signal: ctl.signal });
  const reader = r.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  const stop = setTimeout(() => ctl.abort(), 400);
  try { for (;;) { const { value, done } = await reader.read(); if (done) break; buf += dec.decode(value, { stream: true }); } } catch { } finally { clearTimeout(stop); }
  const out = [];
  for (const block of buf.split('\n\n')) {
    const ev = /^event: (.+)$/m.exec(block);
    const data = /^data: (.+)$/m.exec(block);
    if (ev && data) out.push({ event: ev[1], data: JSON.parse(data[1]) });
  }
  return out;
}

test('one effect per 5 seconds per user; a sooner one is kept as a plain message', async () => {
  const a = await S.api(ali, 'POST', '/api/send', { target: 'bob', kind: 'msg', payload: 'x1', fx: 1 });
  assert.equal(a.status, 200);
  assert.equal(a.data.fx, 1);
  const b = await S.api(ali, 'POST', '/api/send', { target: 'bob', kind: 'msg', payload: 'x2', fx: 1 });
  assert.equal(b.status, 200);
  assert.equal(b.data.fx, 0);
  const c = await S.api(ali, 'POST', '/api/send', { target: 'bob', kind: 'msg', payload: 'x3' });
  assert.equal(c.data.fx, 0);
  // the limit is per user: bob may send one right away
  const d = await S.api(bob, 'POST', '/api/send', { target: 'ali', kind: 'msg', payload: 'y1', fx: 1 });
  assert.equal(d.data.fx, 1);
  const msgs = (await events(bob, 'since=0')).filter((e) => e.event === 'msg');
  assert.equal(msgs.find((e) => e.data.id === a.data.id).data.fx, 1);
  assert.equal(msgs.find((e) => e.data.id === b.data.id).data.fx, undefined);
  assert.equal(msgs.find((e) => e.data.id === c.data.id).data.fx, undefined);
  // after 5 seconds the next one has the effect again
  await new Promise((r) => setTimeout(r, 5100));
  const e = await S.api(ali, 'POST', '/api/send', { target: 'bob', kind: 'msg', payload: 'x4', fx: 1 });
  assert.equal(e.data.fx, 1);
});

test('only fx === 1 asks for the effect', async () => {
  await new Promise((r) => setTimeout(r, 5100));
  const a = await S.api(ali, 'POST', '/api/send', { target: 'bob', kind: 'msg', payload: 'z', fx: 'yes' });
  assert.equal(a.data.fx, 0);
});
