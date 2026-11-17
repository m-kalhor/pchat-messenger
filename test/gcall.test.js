'use strict';
// 1.19: group calls — rooms, who may start / join / be invited, ringing, signalling between participants,
// the starter's mute / remove, the admin settings, and that nothing reaches people outside the call.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { startServer } = require('./helpers/server');

const freePort = () => new Promise((resolve) => { const s = net.createServer().listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); }); });

let S, base, cookie = '', csrf = '', T = {}, grp, big;

async function adm(method, p, body) {
  const r = await fetch(base + '/admin/api' + p, { method, headers: { 'content-type': 'application/json', cookie, 'x-csrf': csrf }, body: body ? JSON.stringify(body) : undefined });
  const set = r.headers.get('set-cookie');
  if (set) cookie = set.split(';')[0];
  return { status: r.status, data: await r.json() };
}

/** Keeps an event stream open and collects its events (also makes the user "connected"). */
async function listen(tok) {
  const ctl = new AbortController();
  const r = await fetch(S.base + '/api/events?since=0', { headers: { authorization: 'Bearer ' + tok }, signal: ctl.signal });
  const reader = r.body.getReader();
  const dec = new TextDecoder();
  const out = [];
  let buf = '';
  (async () => {
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let i;
        while ((i = buf.indexOf('\n\n')) >= 0) {
          const block = buf.slice(0, i); buf = buf.slice(i + 2);
          const ev = /^event: (.+)$/m.exec(block), data = /^data: (.+)$/m.exec(block);
          if (ev && data) out.push({ event: ev[1], data: JSON.parse(data[1]) });
        }
      }
    } catch { }
  })();
  await new Promise((r) => setTimeout(r, 150));
  return { out, stop: () => ctl.abort(), of: (name) => out.filter((e) => e.event === name) };
}
const wait = (ms = 150) => new Promise((r) => setTimeout(r, ms));
const call = (who, op, body) => S.api(T[who], 'POST', '/api/gcall/' + op, body);

test.before(async () => {
  const port = await freePort();
  const secret = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'turn-')), 'secret');
  fs.writeFileSync(secret, 'test-secret');
  S = await startServer({ ADMIN_DISABLE: '0', ADMIN_PORT: String(port), TURN_SECRET_FILE: secret, PUBLIC_HOST: '203.0.113.5' });
  base = `http://127.0.0.1:${port}`;
  const { setSetting, hashPassword } = require(path.join(S.app.appDir, 'db.js'));
  setSetting('admin_pass', hashPassword('first-pass-1'));
  csrf = (await adm('POST', '/login', { username: 'admin', password: 'first-pass-1' })).data.csrf;
  grp = S.core.createCategory('تیم');
  big = S.core.createCategory('بزرگ');
  for (const n of ['ali', 'bob', 'cy']) T[n] = await S.user(n, [1, grp]);
  T.dan = await S.user('dan');           // in no group, not connected to anyone
  T.eve = await S.user('eve');           // a contact of ali only
  S.db.prepare("INSERT INTO visibility(viewer,target) VALUES('ali','eve'),('eve','ali'),('ali','bob'),('bob','ali')").run();
  for (let i = 0; i < 9; i++) T['m' + i] = await S.user('m' + i, [big]);
  for (const n of Object.keys(T)) S.db.prepare('UPDATE users SET pubkey=? WHERE username=?').run('PK-' + n, n);
});
test.after(() => S && S.stop());

const gkey = () => 'g:' + grp;

test('a member starts a call in a small group: everyone else rings and sees it; outsiders see nothing', async () => {
  const L = { bob: await listen(T.bob), cy: await listen(T.cy), dan: await listen(T.dan), ali: await listen(T.ali) };
  const r = await call('ali', 'start', { group: gkey() });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  const room = r.data.room;
  assert.equal(room.host, 'ali');
  assert.deepEqual(room.parts.map((p) => p.u), ['ali']);
  assert.deepEqual(room.ringing.sort(), ['bob', 'cy']);
  assert.equal(room.keys.bob, 'PK-bob');
  assert.equal(room.video, false);
  await wait();
  assert.ok(L.bob.of('gcall').some((e) => e.data.ring && e.data.room.id === room.id));
  assert.ok(L.cy.of('gcall').some((e) => e.data.ring));
  assert.ok(!L.ali.of('gcall').some((e) => e.data.ring), 'the caller does not ring');
  assert.equal(L.dan.of('gcall').length, 0);

  // a second call in the same group is refused and points to the running one
  const dup = await call('bob', 'start', { group: gkey() });
  assert.equal(dup.status, 409);
  assert.equal(dup.data.room.id, room.id);

  // outsiders can neither join nor signal
  assert.equal((await call('dan', 'join', { id: room.id })).status, 403);
  assert.equal((await S.api(T.dan, 'GET', '/api/gcall')).data.rooms.length, 0);

  // bob joins; signalling flows only between participants
  const j = await call('bob', 'join', { id: room.id });
  assert.equal(j.status, 200);
  assert.deepEqual(j.data.room.parts.map((p) => p.u).sort(), ['ali', 'bob']);
  assert.ok(!j.data.room.ringing.includes('bob'));
  const s1 = await call('bob', 'sig', { id: room.id, to: 'ali', kind: 'offer', payload: 'ENC' });
  assert.equal(s1.status, 200);
  assert.equal(s1.data.delivered, true);
  assert.equal((await call('bob', 'sig', { id: room.id, to: 'cy', kind: 'offer', payload: 'x' })).status, 403, 'cy is not in the call');
  assert.equal((await call('bob', 'sig', { id: room.id, to: 'ali', kind: 'weird', payload: 'x' })).status, 400);
  await wait();
  assert.ok(L.ali.of('gsig').some((e) => e.data.from === 'bob' && e.data.kind === 'offer' && e.data.payload === 'ENC'));

  // cy declines: no longer ringing, but may still join from the bar
  await call('cy', 'decline', { id: room.id });
  const list = (await S.api(T.cy, 'GET', '/api/gcall')).data;
  assert.equal(list.cfg.on, true);
  assert.equal(list.rooms[0].ringing.length, 0);

  // hand + reaction
  await call('bob', 'act', { id: room.id, hand: true });
  assert.equal((await call('bob', 'act', { id: room.id, react: 'abc' })).status, 400);
  await call('bob', 'act', { id: room.id, react: '👍' });
  await wait();
  assert.ok(L.ali.of('gcall_react').some((e) => e.data.emoji === '👍' && e.data.from === 'bob'));
  assert.ok(L.ali.of('gcall').some((e) => e.data.room.parts.find((p) => p.u === 'bob' && p.hand > 0)));

  // only the starter mutes / removes
  assert.equal((await call('bob', 'host', { id: room.id, user: 'ali', action: 'mute' })).status, 403);
  const m = await call('ali', 'host', { id: room.id, user: 'bob', action: 'mute' });
  assert.equal(m.status, 200);
  assert.ok(m.data.room.parts.find((p) => p.u === 'bob').muted);
  await wait();
  assert.ok(L.bob.of('gcall_host').some((e) => e.data.action === 'mute'));
  const rm = await call('ali', 'host', { id: room.id, user: 'bob', action: 'remove' });
  assert.deepEqual(rm.data.room.parts.map((p) => p.u), ['ali']);

  // the last one leaves: the call ends for everyone who could see it
  await call('ali', 'leave', { id: room.id });
  await wait();
  assert.ok(L.cy.of('gcall_end').some((e) => e.data.id === room.id));
  assert.equal((await S.api(T.ali, 'GET', '/api/gcall')).data.rooms.length, 0);
  for (const l of Object.values(L)) l.stop();
});

test('a big group rings nobody unless the starter picks people', async () => {
  const L = await listen(T.m1);
  let r = await S.api(T.m0, 'POST', '/api/gcall/start', { group: 'g:' + big });
  assert.equal(r.status, 200);
  assert.equal(r.data.room.ringing.length, 0);
  await S.api(T.m0, 'POST', '/api/gcall/leave', { id: r.data.room.id });
  r = await S.api(T.m0, 'POST', '/api/gcall/start', { group: 'g:' + big, ring: ['m1', 'm2', 'dan'] });
  assert.deepEqual(r.data.room.ringing.sort(), ['m1', 'm2'], 'only members can be rung from a group');
  await wait();
  assert.ok(L.of('gcall').some((e) => e.data.ring));
  // the call is full at 8 (default)
  for (let i = 1; i < 8; i++) assert.equal((await S.api(T['m' + i], 'POST', '/api/gcall/join', { id: r.data.room.id })).status, 200);
  const full = await S.api(T.m8, 'POST', '/api/gcall/join', { id: r.data.room.id });
  assert.equal(full.status, 409);
  assert.equal(full.data.error, 'gcall_full');
  for (let i = 0; i < 8; i++) await S.api(T['m' + i], 'POST', '/api/gcall/leave', { id: r.data.room.id });
  L.stop();
});

test('a call with chosen people (Calls tab): only contacts can be called and invited', async () => {
  assert.equal((await call('ali', 'start', { users: ['dan'] })).status, 403, 'ali is not connected to dan');
  const L = await listen(T.eve);
  const r = await call('ali', 'start', { users: ['eve', 'bob'] });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.room.group, null);
  assert.deepEqual(r.data.room.members.sort(), ['ali', 'bob', 'eve']);
  await wait();
  assert.ok(L.of('gcall').some((e) => e.data.ring));
  // eve joins; she may not invite dan (not her contact), ali may invite cy (group mate)
  assert.equal((await call('eve', 'join', { id: r.data.room.id })).status, 200);
  assert.equal((await call('eve', 'invite', { id: r.data.room.id, users: ['dan'] })).status, 403);
  assert.equal((await call('cy', 'join', { id: r.data.room.id })).status, 403, 'not invited yet');
  assert.equal((await call('ali', 'invite', { id: r.data.room.id, users: ['cy'] })).status, 403, 'a group mate is not a contact');
  S.db.prepare("INSERT INTO visibility(viewer,target) VALUES('ali','cy'),('cy','ali')").run();
  const inv = await call('ali', 'invite', { id: r.data.room.id, users: ['cy'] });
  assert.equal(inv.status, 200);
  assert.ok(inv.data.room.ringing.includes('cy'));
  assert.equal((await call('cy', 'join', { id: r.data.room.id })).status, 200);
  // starting another call takes you out of this one
  const other = await call('cy', 'start', { users: ['ali'] });
  assert.equal(other.status, 200);
  const rooms = (await S.api(T.ali, 'GET', '/api/gcall')).data.rooms;
  assert.ok(!rooms.find((x) => x.id === r.data.room.id).parts.some((p) => p.u === 'cy'));
  for (const n of ['ali', 'eve', 'cy']) for (const x of rooms) await call(n, 'leave', { id: x.id });
  L.stop();
});

test('admin settings: off, the group «همه», groups turned off, limits; /api/groups and /api/me tell the apps', async () => {
  let a = await adm('GET', '/auth');
  assert.deepEqual({ on: a.data.gcall.on, all: a.data.gcall.all, max_voice: a.data.gcall.max_voice, max_rooms: a.data.gcall.max_rooms }, { on: true, all: false, max_voice: 8, max_rooms: 5 });
  assert.equal((await call('ali', 'start', { group: 'all' })).status, 403, '«همه» is off by default');
  let g = (await S.api(T.ali, 'GET', '/api/groups')).data;
  assert.equal(g.find((x) => x.key === 'all').call, false);
  assert.equal(g.find((x) => x.key === gkey()).call, true);

  for (const bad of [{ max_voice: 9 }, { max_voice: 1 }, { max_rooms: 0 }, { on: 'yes' }, { off_groups: ['x'] }]) {
    assert.equal((await adm('POST', '/auth', { gcall: bad })).status, 400, JSON.stringify(bad));
  }
  a = await adm('POST', '/auth', { gcall: { off_groups: [gkey()], max_voice: 3 } });
  assert.equal(a.status, 200);
  assert.equal((await call('ali', 'start', { group: gkey() })).status, 403);
  g = (await S.api(T.ali, 'GET', '/api/groups')).data;
  assert.equal(g.find((x) => x.key === gkey()).call, false);
  assert.equal((await S.api(T.ali, 'GET', '/api/me')).data.gcall.max_voice, 3);
  assert.equal((await call('ali', 'start', { users: ['bob', 'cy', 'eve'] })).status, 400, '4 people > 3');

  await adm('POST', '/auth', { gcall: { on: false } });
  assert.equal((await call('ali', 'start', { users: ['bob'] })).status, 403);
  assert.equal((await S.api(T.ali, 'GET', '/api/me')).data.gcall.on, false);
  await adm('POST', '/auth', { gcall: { on: true, off_groups: [], max_voice: 8, max_rooms: 1, all: true } });
  const r1 = await call('ali', 'start', { group: 'all' });
  assert.equal(r1.status, 200);
  assert.equal((await call('m0', 'start', { group: 'g:' + big })).status, 429, 'one call at a time');
  await call('ali', 'leave', { id: r1.data.room.id });
  await adm('POST', '/auth', { gcall: { max_rooms: 5, all: false } });
  assert.equal((await call('ali', 'start', { users: ['bob'], video: true })).status, 403, 'video is off until the admin turns it on');
});

test('1.23 video: cameras on and off, at most max_video at once, a video call rings as one', async () => {
  const r0 = await call('ali', 'start', { group: gkey() });
  assert.equal((await call('ali', 'act', { id: r0.data.room.id, cam: true })).status, 403, 'video off');
  await call('ali', 'leave', { id: r0.data.room.id });

  await adm('POST', '/auth', { gcall: { video: true, max_video: 2 } });
  assert.equal((await adm('POST', '/auth', { gcall: { max_video: 5 } })).status, 400);
  const me = (await S.api(T.ali, 'GET', '/api/me')).data.gcall;
  assert.deepEqual({ video: me.video, max_video: me.max_video }, { video: true, max_video: 2 });

  const L = await listen(T.bob);
  const r = await call('ali', 'start', { group: gkey(), video: true });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  const id = r.data.room.id;
  assert.equal(r.data.room.video, true);
  assert.equal(r.data.room.max, 8, 'a video call still takes up to max_voice people');
  assert.equal(r.data.room.max_cam, 2);
  assert.equal(r.data.room.parts[0].cam, true, 'the starter of a video call has the camera on');
  await wait();
  const ringing = L.of('gcall').find((e) => e.data.ring);
  assert.ok(ringing && ringing.data.room.video, 'rings as a video call');
  L.stop();

  let j = await call('bob', 'join', { id, cam: true });
  assert.equal(j.data.room.parts.find((p) => p.u === 'bob').cam, true);
  j = await call('cy', 'join', { id, cam: true });
  assert.equal(j.status, 200, 'joins anyway');
  assert.equal(j.data.room.parts.find((p) => p.u === 'cy').cam, false, 'no camera slot left: voice only');
  assert.equal((await call('cy', 'act', { id, cam: true })).status, 409);
  assert.equal((await call('cy', 'act', { id, cam: true })).data.error, 'gcall_video_full');
  // bob turns his camera off: now cy may
  assert.equal((await call('bob', 'act', { id, cam: false })).data.room.parts.find((p) => p.u === 'bob').cam, false);
  const c = await call('cy', 'act', { id, cam: true });
  assert.equal(c.status, 200);
  assert.deepEqual(c.data.room.parts.filter((p) => p.cam).map((p) => p.u).sort(), ['ali', 'cy']);
  // leaving frees the slot
  await call('ali', 'leave', { id });
  assert.equal((await call('bob', 'act', { id, cam: true })).status, 200);
  for (const n of ['bob', 'cy']) await call(n, 'leave', { id });
  await adm('POST', '/auth', { gcall: { video: false, max_video: 4 } });
});
