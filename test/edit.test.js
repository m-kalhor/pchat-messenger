'use strict';
// Edit (48 h window, history for the sender only), delete for everyone, and how both reach clients:
// live 'change' events, and on reconnect via csince (the last change number the client has seen).
const test = require('node:test');
const assert = require('node:assert/strict');
const { startServer } = require('./helpers/server');

let S, ali, bob, cy;

test.before(async () => {
  S = await startServer();
  ali = await S.user('ali');
  bob = await S.user('bob');
  cy = await S.user('cy');
  S.db.prepare("INSERT INTO visibility(viewer,target) VALUES('ali','bob'),('bob','ali')").run();
});
test.after(() => S && S.stop());

/** Reads the event stream for a moment and returns the parsed events. */
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

test('the sender edits within 48 hours; the edit time is kept and history is for the sender only', async () => {
  const id = await send(ali, 'bob', 'v1');
  assert.equal((await S.api(bob, 'POST', '/api/edit', { id, payload: 'x' })).status, 404, 'only the sender edits');
  const r = await S.api(ali, 'POST', '/api/edit', { id, payload: 'v2', prev: 'self-encrypted v1' });
  assert.equal(r.status, 200);
  assert.ok(r.data.edited >= Date.now() - 5000);

  const row = S.db.prepare('SELECT payload, edited FROM messages WHERE id=?').get(id);
  assert.equal(row.payload, 'v2');
  assert.equal(row.edited, r.data.edited);

  assert.deepEqual((await S.api(ali, 'GET', '/api/history?id=' + id)).data.versions.map((v) => v.payload), ['self-encrypted v1']);
  assert.equal((await S.api(bob, 'GET', '/api/history?id=' + id)).status, 404, 'the recipient never sees old versions');

  // a fresh device gets the edited text with its edit time
  const msg = (await events(bob, 'since=0')).find((e) => e.event === 'msg' && e.data.id === id);
  assert.equal(msg.data.payload, 'v2');
  assert.equal(msg.data.edited, r.data.edited);

  S.db.prepare('UPDATE messages SET ts=? WHERE id=?').run(Date.now() - 49 * 3600e3, id);
  assert.equal((await S.api(ali, 'POST', '/api/edit', { id, payload: 'v3' })).data.error, 'edit_window_passed');
  assert.equal((await S.api(ali, 'POST', '/api/edit', { id: 999999, payload: 'v3' })).status, 404);
});

test('delete for everyone removes the message and its history; new devices never get it', async () => {
  const id = await send(ali, 'bob', 'secret');
  await S.api(ali, 'POST', '/api/edit', { id, payload: 'secret2', prev: 'p' });
  assert.equal((await S.api(bob, 'POST', '/api/delete', { id })).status, 404, 'only the sender deletes for everyone');
  assert.equal((await S.api(ali, 'POST', '/api/delete', { id })).status, 200);
  assert.equal(S.db.prepare('SELECT payload FROM messages WHERE id=?').get(id).payload, '');
  assert.equal(S.db.prepare('SELECT COUNT(*) AS n FROM msg_history WHERE msg_id=?').get(id).n, 0);
  assert.ok(!(await events(bob, 'since=0')).some((e) => e.event === 'msg' && e.data.id === id));
  assert.equal((await S.api(ali, 'POST', '/api/edit', { id, payload: 'again' })).status, 404, 'a deleted message cannot be edited');
});

test('clients that were offline catch up on edits and deletions with csince', async () => {
  const before = (await events(bob, 'since=0&csince=-1')).find((e) => e.event === 'cseq').data.seq;
  const a = await send(ali, 'bob', 'a1');
  const b = await send(ali, 'bob', 'b1');
  const lastId = b;
  await S.api(ali, 'POST', '/api/edit', { id: a, payload: 'a2' });
  await S.api(ali, 'POST', '/api/delete', { id: b });

  const evs = await events(bob, `since=${lastId}&csince=${before}`);
  const changes = evs.filter((e) => e.event === 'change').map((e) => e.data);
  assert.deepEqual(changes.map((c) => [c.kind, c.id]), [['edit', a], ['del', b]]);
  assert.equal(changes[0].payload, 'a2');
  assert.ok(changes[0].edited);
  const cseq = evs.find((e) => e.event === 'cseq').data.seq;
  assert.equal(cseq, changes[1].seq);

  assert.equal((await events(bob, `since=${lastId}&csince=${cseq}`)).filter((e) => e.event === 'change').length, 0);
  assert.equal((await events(cy, `since=0&csince=0`)).filter((e) => e.event === 'change').length, 0, 'outsiders get nothing');
  assert.ok(!(await events(bob, `since=${lastId}`)).some((e) => e.event === 'change' || e.event === 'cseq'), 'old clients see no new events');
});

test('live change events reach both sides of the chat', async () => {
  const id = await send(ali, 'bob', 'hi');
  const ctl = new AbortController();
  const r = await fetch(S.base + '/api/events?since=' + id + '&csince=-1', { headers: { authorization: 'Bearer ' + bob }, signal: ctl.signal });
  const reader = r.body.getReader();
  await reader.read();
  await S.api(ali, 'POST', '/api/edit', { id, payload: 'hello' });
  let buf = '';
  const dec = new TextDecoder();
  const t = setTimeout(() => ctl.abort(), 1500);
  try {
    while (!buf.includes('event: change')) { const { value, done } = await reader.read(); if (done) break; buf += dec.decode(value, { stream: true }); }
  } catch { }
  clearTimeout(t);
  ctl.abort();
  const block = buf.slice(buf.indexOf('event: change'));
  const data = JSON.parse(/data: (.+)/.exec(block)[1]);
  assert.equal(data.kind, 'edit');
  assert.equal(data.id, id);
  assert.equal(data.payload, 'hello');
});
