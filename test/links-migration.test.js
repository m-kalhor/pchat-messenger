'use strict';
// 1.3 turns the old one-way visibility matrix into two-way links, once, when the server starts.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

test('one-way rows become two-way; a one-way block closes the pair both ways', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sepan-links-'));
  try {
    const old = new DatabaseSync(path.join(dir, 'messenger.db'));
    old.exec(`CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      INSERT INTO settings VALUES ('migrated_v2','1');
      CREATE TABLE visibility (viewer TEXT NOT NULL, target TEXT NOT NULL, PRIMARY KEY (viewer, target));
      CREATE TABLE blocks (viewer TEXT NOT NULL, target TEXT NOT NULL, PRIMARY KEY (viewer, target));
      INSERT INTO visibility VALUES ('a','b'),('c','d'),('d','c'),('e','f'),('f','e');
      INSERT INTO blocks VALUES ('e','f');`);
    old.close();

    process.env.DATA_DIR = dir;
    const { db } = require('../server/src/db.js');
    const vis = db.prepare('SELECT viewer||target AS p FROM visibility ORDER BY p').all().map((r) => r.p);
    const blk = db.prepare('SELECT viewer||target AS p FROM blocks ORDER BY p').all().map((r) => r.p);
    assert.deepEqual(vis, ['ab', 'ba', 'cd', 'dc']);
    assert.deepEqual(blk, ['ef', 'fe']);

    // only once: a later one-way row (tests, CLI) is left alone
    db.exec("INSERT INTO visibility VALUES ('x','y')");
    delete require.cache[require.resolve('../server/src/db.js')];
    db.close();
    const again = require('../server/src/db.js').db;
    assert.equal(again.prepare("SELECT COUNT(*) AS n FROM visibility WHERE viewer='y' AND target='x'").get().n, 0);
    again.close();
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
