'use strict';
// Who-can-see-whom: visibility matrix, reply-to-first-sender, category groups, disabled users.
const test = require('node:test');
const assert = require('node:assert/strict');
const { startServer } = require('./helpers/server');

let S, tok, grp;
const see = (viewer, target, on = true) => (on
  ? S.db.prepare('INSERT OR IGNORE INTO visibility(viewer,target) VALUES(?,?)').run(viewer, target)
  : S.db.prepare('DELETE FROM visibility WHERE viewer=? AND target=?').run(viewer, target));
const names = async (u) => {
  const r = await S.api(tok[u], 'GET', '/api/users');
  assert.equal(r.status, 200);
  return Object.fromEntries(r.data.map((x) => [x.username, x.dm]));
};
const send = (from, target, extra = {}) => S.api(tok[from], 'POST', '/api/send', { target, kind: 'text', payload: 'x', ...extra });

test.before(async () => {
  S = await startServer();
  grp = S.core.createCategory('تیم');
  tok = {};
  for (const u of ['alice', 'bob', 'carol', 'dave']) tok[u] = await S.user(u, u === 'dave' ? [] : [grp]);
  tok.erin = await S.user('erin', []);
  // the matrix rules alone: message requests to strangers (1.7, see requests.test.js) are switched off here
  S.db.prepare("INSERT OR REPLACE INTO settings(key,value) VALUES('msg_requests','0')").run();
});
test.after(() => S && S.stop());

test('fresh users see nobody and cannot start a chat', async () => {
  assert.deepEqual(await names('erin'), { erin: false });
  assert.equal(S.core.canDM('erin', 'dave'), false);
  const r = await send('erin', 'dave');
  assert.equal(r.status, 403);
  assert.equal(r.data.error, 'not_allowed');
});

test('nobody can DM themselves; unknown user is 404', async () => {
  assert.equal(S.core.canDM('alice', 'alice'), false);
  assert.equal((await send('alice', 'nobody_here')).status, 404);
});

test('matrix is one-directional until the first message, then the other side can reply', async () => {
  see('dave', 'erin');
  assert.equal(S.core.canDM('dave', 'erin'), true);
  assert.equal(S.core.canDM('erin', 'dave'), false);
  assert.equal((await names('dave')).erin, true);
  assert.equal((await names('erin')).dave, undefined, 'erin must not even learn dave exists');

  assert.equal((await send('dave', 'erin')).status, 200);
  assert.equal(S.core.canDM('erin', 'dave'), true, 'replying to whoever wrote first is always allowed');
  assert.equal((await names('erin')).dave, true);
  assert.equal((await send('erin', 'dave')).status, 200);
});

test('group mates are visible but not DM-able without the matrix', async () => {
  const n = await names('alice');
  assert.equal(n.bob, false);
  assert.equal(n.carol, false);
  assert.equal(n.dave, undefined);
  assert.equal(S.core.canDM('alice', 'bob'), false);
  assert.equal((await send('alice', 'bob')).status, 403);

  see('alice', 'bob');
  assert.equal((await names('alice')).bob, true);
  assert.equal((await send('alice', 'bob')).status, 200);
});

test('only members can post to a category group', async () => {
  const key = 'g:' + grp;
  assert.equal((await send('carol', key)).status, 200);
  const r = await send('dave', key);
  assert.equal(r.status, 403);
  assert.equal(r.data.error, 'not_member');
  assert.equal((await send('dave', 'g:9999')).status, 404);
  assert.equal((await send('dave', 'all')).status, 403, 'dave is not in the default category either');

  const g = await S.api(tok.alice, 'GET', '/api/groups');
  assert.deepEqual(g.data.map((x) => x.key), [key]);
  assert.deepEqual(g.data[0].members, ['alice', 'bob', 'carol']);
  assert.deepEqual((await S.api(tok.dave, 'GET', '/api/groups')).data, []);
});

test('live signalling (typing, calls) only goes to permitted private chats', async () => {
  assert.equal((await send('alice', 'g:' + grp, { kind: 'sig_typing' })).status, 400);
  assert.equal((await send('carol', 'alice', { kind: 'sig_call' })).status, 403);
  assert.equal((await send('alice', 'bob', { kind: 'sig_typing' })).status, 200);
});

test('avatars of strangers are hidden', async () => {
  assert.equal((await S.api(tok.erin, 'GET', '/api/avatar/alice')).data.error, 'not_found');
  assert.equal((await S.api(tok.alice, 'GET', '/api/avatar/bob')).data.error, 'no_avatar');
});

test('a disabled user disappears, cannot be messaged and is logged out', async () => {
  see('carol', 'alice');
  assert.equal(S.core.canDM('carol', 'alice'), true);
  S.db.prepare('UPDATE users SET disabled=1 WHERE username=?').run('alice');
  try {
    assert.equal(S.core.canDM('carol', 'alice'), false);
    assert.equal((await names('carol')).alice, undefined);
    assert.equal((await send('carol', 'alice')).status, 404);
    assert.equal((await S.api(tok.alice, 'GET', '/api/me')).status, 401);
    assert.ok(!(await S.api(tok.bob, 'GET', '/api/groups')).data[0].members.includes('alice'));
  } finally {
    S.db.prepare('UPDATE users SET disabled=0 WHERE username=?').run('alice');
  }
});

test('removing a matrix cell revokes starting a chat', async () => {
  see('carol', 'alice', false);
  assert.equal(S.core.canDM('carol', 'alice'), false);
  assert.equal((await send('carol', 'alice')).status, 403);
});

test('deleting a user removes them from every matrix row', async () => {
  see('bob', 'erin');
  see('erin', 'bob');
  assert.equal(S.core.deleteUser('erin'), true);
  assert.equal(S.db.prepare("SELECT COUNT(*) AS n FROM visibility WHERE viewer='erin' OR target='erin'").get().n, 0);
  assert.equal(S.core.canDM('bob', 'erin'), false);
  assert.equal((await S.api(tok.erin, 'GET', '/api/me')).status, 401);
});

test('pins only accept messages from that conversation', async () => {
  const mine = (await send('alice', 'bob')).data.id;
  const other = (await send('carol', 'g:' + grp)).data.id;
  assert.equal((await S.api(tok.alice, 'POST', '/api/pin', { target: 'bob', messageId: mine })).status, 200);
  const r = await S.api(tok.alice, 'POST', '/api/pin', { target: 'bob', messageId: other });
  assert.equal(r.status, 400);
  assert.equal(r.data.error, 'bad_message');
});

test('groups created or assigned after a user exists show up for old and new members', async () => {
  const late = S.core.createCategory('بعدی');
  S.core.setUserCategories('dave', [late]); // dave existed before the group
  tok.frank = await S.user('frank', []); // frank is created first, added to the group afterwards
  S.core.setUserCategories('frank', [late]);
  for (const u of ['dave', 'frank']) {
    const r = await S.api(tok[u], 'GET', '/api/groups');
    assert.equal(r.status, 200);
    const g = r.data.find((x) => x.id === late);
    assert.ok(g, `${u} must see the new group`);
    assert.deepEqual(g.members, ['dave', 'frank']);
  }
  assert.equal((await send('frank', 'g:' + late)).status, 200);
});
