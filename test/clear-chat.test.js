'use strict';
// 1.27: delete a whole private chat for both sides (/api/clear-chat): the server forgets every message
// of the pair, and both people's devices get a 'clear' change, live and on reconnect via csince.
const test = require('node:test');
const assert = require('node:assert/strict');
const { startServer } = require('./helpers/server');

let S, ali, bob, cy;

test.before(async () => {
  S = await startServer();
  ali = await S.user('ali');
  bob = await S.user('bob');
  cy = await S.user('cy');
  S.db.prepare("INSERT INTO visibility(viewer,target) VALUES('ali','bob'),('bob','ali'),('ali','cy'),('cy','ali')").run();
});
test.after(() => S && S.stop());

async function events(tok, query) {
  const ctl = new AbortController();
  const r = await fetch(S.base + '/api/events?' + query, { headers: { authorization: 'Bearer ' + tok }, signal: ctl.signal });
  const out = [];
  const reader = r.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  const stop = setTimeout(() => ctl.abort(), 400);
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
    }
  } catch { } finally { clearTimeout(stop); }
  for (const block of buf.split('\n\n')) {
    const ev = /^event: (.+)$/m.exec(block);
    const data = /^data: (.+)$/m.exec(block);
    if (ev && data) out.push({ event: ev[1], data: JSON.parse(data[1]) });
  }
  return out;
}

const send = async (tok, target, payload) => (await S.api(tok, 'POST', '/api/send', { target, payload })).data.id;

test('clearing a chat removes both sides\' messages on the server and reaches both, also after being offline', async () => {
  const cs = (await events(bob, 'since=0&csince=-1')).find((e) => e.event === 'cseq').data.seq;
  const a = await send(ali, 'bob', 'a');
  const b = await send(bob, 'ali', 'b');
  const other = await send(ali, 'cy', 'keep');

  const r = await S.api(bob, 'POST', '/api/clear-chat', { peer: 'ali' });
  assert.equal(r.status, 200);
  assert.equal(r.data.upto, b);
  assert.equal(r.data.removed, 2);

  // a new device of either side gets none of them; the chat with cy is untouched
  const fresh = await events(ali, 'since=0');
  assert.ok(!fresh.some((e) => e.event === 'msg' && (e.data.id === a || e.data.id === b)));
  assert.ok(fresh.some((e) => e.event === 'msg' && e.data.id === other));
  assert.ok(!fresh.some((e) => e.event === 'msg' && e.data.kind === 'sig_clear'), 'the marker is never delivered as a message');

  // a device that was offline (already had message b) learns about the clear through csince
  const evs = await events(ali, `since=${other}&csince=${cs}`);
  const ch = evs.filter((e) => e.event === 'change').map((e) => e.data).find((c) => c.kind === 'clear');
  assert.ok(ch, 'clear change replayed');
  assert.equal(ch.from, 'bob');
  assert.equal(ch.target, 'ali');
  assert.equal(ch.upto, b);
  assert.ok(ch.ts > 0);

  // also replayed when the client's message number is older than the marker
  const evs2 = await events(ali, `since=${a}&csince=${cs}`);
  assert.ok(evs2.some((e) => e.event === 'change' && e.data.kind === 'clear'));
});

test('clear-chat only works for a real other user', async () => {
  assert.equal((await S.api(ali, 'POST', '/api/clear-chat', { peer: 'ali' })).status, 404);
  assert.equal((await S.api(ali, 'POST', '/api/clear-chat', { peer: 'nobody' })).status, 404);
  assert.equal((await S.api(ali, 'POST', '/api/clear-chat', { peer: 'all' })).status, 404);
  assert.equal((await S.api(ali, 'POST', '/api/clear-chat', { peer: 'g:1' })).status, 404);
});
