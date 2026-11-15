'use strict';
// 1.19: relayed call traffic read from coturn's log (server/src/turnlog.js).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { start, parse } = require('../server/src/turnlog');

test('parses coturn usage and peer usage lines', () => {
  assert.deepEqual(parse('1234: : session 001000000000000001: usage: realm=<messenger>, username=<1763200000:Ali>, rp=10, rb=2000, sp=12, sb=3000'),
    { user: 'ali', bytes: 5000, peer: false });
  assert.deepEqual(parse('session 001000000000000001: peer usage: realm=<messenger>, username=<1763200000:bob>, rp=1, rb=7, sp=1, sb=3'),
    { user: 'bob', bytes: 10, peer: true });
  assert.equal(parse('session 001: closed (2nd stage), user <1763200000:ali> realm <messenger>'), null);
});

test('counts only new lines, follows a truncated (rotated) file, keeps half-written lines for later', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'turnlog-'));
  const f = path.join(dir, 'turn.log');
  const line = (u, n) => `session 1: usage: realm=<messenger>, username=<1:${u}>, rp=1, rb=${n}, sp=1, sb=0\n`;
  fs.writeFileSync(f, line('old', 999));
  const got = [];
  const t = start(f, (u, field, n) => got.push([u, field, n]), 1e9);
  assert.deepEqual(got, []); // what was there before the server started is not counted
  fs.appendFileSync(f, line('ali', 100) + 'session 1: usage: realm=<messenger>, user');
  t.pass();
  assert.deepEqual(got, [['ali', 'turn', 100]]);
  fs.appendFileSync(f, 'name=<1:bob>, rp=1, rb=5, sp=1, sb=5\n');
  t.pass();
  assert.deepEqual(got.at(-1), ['bob', 'turn', 10]);
  fs.writeFileSync(f, line('cy', 7)); // logrotate copytruncate
  t.pass();
  assert.deepEqual(got.at(-1), ['cy', 'turn', 7]);
  t.stop();
  fs.rmSync(dir, { recursive: true, force: true });
});
