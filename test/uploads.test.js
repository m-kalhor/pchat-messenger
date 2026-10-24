'use strict';
// Resumable chunked uploads (POST /api/uploads, PATCH with Upload-Offset) and Range downloads,
// driven the same way android/app/src/main/java/com/pchat/app/Engine.kt does it: encrypted 1 MiB chunks.
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const C = require('./helpers/pchat-crypto');
const { startServer } = require('./helpers/server');

const MB = 1024 * 1024;
let S, alice, bob;

test.before(async () => {
  S = await startServer({ MAX_UPLOAD_MB: '8', MAX_TOTAL_MB: '20' });
  alice = await S.user('alice');
  bob = await S.user('bob');
  S.db.prepare("INSERT INTO visibility(viewer,target) VALUES('alice','bob')").run();
});
test.after(() => S && S.stop());

const create = (tok, size) => S.api(tok, 'POST', '/api/uploads', { size });
/** PATCH over raw http: on 409/400 the server answers before reading the body and closes, which fetch() reports as a failure. */
function patch(tok, id, off, buf) {
  return new Promise((resolve, reject) => {
    const req = http.request(S.base + '/api/uploads/' + id, {
      method: 'PATCH',
      headers: { 'upload-offset': String(off), 'content-length': buf.length, ...(tok ? { authorization: 'Bearer ' + tok } : {}) },
    });
    let answered = false;
    req.on('response', (r) => {
      answered = true;
      const chunks = [];
      r.on('data', (d) => chunks.push(d));
      r.on('end', () => resolve({ status: r.statusCode, data: JSON.parse(Buffer.concat(chunks).toString()) }));
    });
    // the server may close before we finish writing (EPIPE); give its already-sent answer a moment to be parsed
    req.on('error', (e) => setTimeout(() => { if (!answered) reject(e); }, 500));
    req.end(buf);
  });
}
const status = async (tok, id) => (await S.api(tok, 'GET', '/api/uploads/' + id)).data;
const abandon = (id) => S.db.prepare('DELETE FROM uploads WHERE id=?').run(id);

/** Starts a PATCH that announces `len` bytes but dies after sending `sent` of them. */
function interruptedPatch(tok, id, off, buf, sent) {
  return new Promise((resolve) => {
    const req = http.request(S.base + '/api/uploads/' + id, {
      method: 'PATCH',
      headers: { authorization: 'Bearer ' + tok, 'upload-offset': String(off), 'content-length': buf.length },
    });
    req.on('error', () => resolve());
    req.on('response', (r) => { r.resume(); resolve(); });
    req.write(buf.subarray(0, sent), () => setTimeout(() => { req.destroy(); setTimeout(resolve, 200); }, 100));
  });
}

test('encrypted file uploads in chunks, survives an interruption, and downloads with Range', async () => {
  const fkey = C.newFileKey();
  const plain = crypto.randomBytes(3 * MB + 777);
  const blob = C.sealFileChunks(fkey, plain);
  assert.equal(blob.length, C.cipherSize(plain.length));

  const c = await create(alice, blob.length);
  assert.equal(c.status, 200);
  assert.equal(c.data.offset, 0);
  assert.equal(c.data.chunkMax, 16 * MB);
  const id = c.data.uploadId;
  const piece = (i) => blob.subarray(i * C.CIPHER_CHUNK, (i + 1) * C.CIPHER_CHUNK);

  let r = await patch(alice, id, 0, piece(0));
  assert.deepEqual(r.data, { offset: C.CIPHER_CHUNK, done: false });

  // connection drops half way through chunk 1: the committed offset must not move
  await interruptedPatch(alice, id, C.CIPHER_CHUNK, piece(1), 300 * 1024);
  assert.equal((await status(alice, id)).offset, C.CIPHER_CHUNK);

  // app resumes: asks the server where it is, re-seals the same chunk (deterministic) and continues
  let off = (await status(alice, id)).offset;
  for (let i = off / C.CIPHER_CHUNK; off < blob.length; i++) {
    r = await patch(alice, id, off, piece(i));
    assert.equal(r.status, 200, JSON.stringify(r.data));
    off = r.data.offset;
  }
  assert.equal(r.data.done, true);
  assert.equal(r.data.fileId, id);
  assert.equal(r.data.size, blob.length);
  assert.equal((await S.api(alice, 'GET', '/api/uploads/' + id)).status, 404, 'upload record is gone once complete');
  assert.ok(!fs.existsSync(path.join(S.app.dataDir, 'uploads', id + '.part')));

  // full download
  const full = await S.api(bob, 'GET', '/api/file/' + id);
  assert.equal(full.status, 200);
  assert.equal(full.headers.get('accept-ranges'), 'bytes');
  assert.deepEqual(full.data, blob);

  // resumed download from the middle of chunk 2
  const start = 2 * C.CIPHER_CHUNK + 100;
  const part = await S.api(bob, 'GET', '/api/file/' + id, undefined, { range: `bytes=${start}-` });
  assert.equal(part.status, 206);
  assert.equal(part.headers.get('content-range'), `bytes ${start}-${blob.length - 1}/${blob.length}`);
  const joined = Buffer.concat([full.data.subarray(0, start), part.data]);
  assert.deepEqual(C.openFileChunks(fkey, joined), plain);

  assert.equal((await S.api(bob, 'GET', '/api/file/' + id, undefined, { range: `bytes=${blob.length}-` })).status, 416);

  // only the owner may attach it to a message
  const payload = C.b64(Buffer.from('meta'));
  assert.equal((await S.api(bob, 'POST', '/api/send', { target: 'alice', payload, fileId: id })).data.error, 'not_allowed');
  assert.equal((await S.api(alice, 'POST', '/api/send', { target: 'bob', kind: 'file', payload, fileId: id })).status, 200);
  S.db.prepare("INSERT INTO visibility(viewer,target) VALUES('bob','alice')").run();
  assert.equal((await S.api(bob, 'POST', '/api/send', { target: 'alice', payload, fileId: id })).data.error, 'bad_file');
});

test('wrong offset gets 409 with the real offset so the client can resync', async (t) => {
  const c = await create(alice, 3 * MB);
  const id = c.data.uploadId;
  t.after(() => abandon(id));
  await patch(alice, id, 0, Buffer.alloc(MB, 1));
  // small bodies: the server answers 409 without reading the body, so keep it within socket buffers
  let r = await patch(alice, id, 0, Buffer.alloc(16, 1));
  assert.equal(r.status, 409);
  assert.deepEqual(r.data, { error: 'offset_mismatch', offset: MB });
  r = await patch(alice, id, 2 * MB, Buffer.alloc(16, 1));
  assert.equal(r.status, 409);
  assert.equal(r.data.offset, MB);
});

test('chunks past the declared size or over the chunk limit are rejected', async () => {
  const id = (await create(alice, 100)).data.uploadId;
  const r = await patch(alice, id, 0, Buffer.alloc(101));
  assert.equal(r.status, 400);
  assert.equal(r.data.error, 'bad_chunk');
  assert.equal((await patch(alice, id, 'x', Buffer.alloc(10))).status, 400);
  assert.equal((await status(alice, id)).offset, 0);
  assert.deepEqual((await patch(alice, id, 0, Buffer.alloc(100))).data.done, true);
});

test('uploads are private to their owner', async () => {
  const id = (await create(alice, 10)).data.uploadId;
  assert.equal((await S.api(bob, 'GET', '/api/uploads/' + id)).status, 404);
  assert.equal((await patch(bob, id, 0, Buffer.alloc(10))).status, 404);
  assert.equal((await S.api(null, 'GET', '/api/uploads/' + id)).status, 401);
  abandon(id);
});

test('size limits: bad size, per-file maximum and total quota (reserved space counts)', async () => {
  for (const size of [0, -1, 1.5, 'abc']) assert.equal((await create(alice, size)).data.error, 'bad_size');
  const big = await create(alice, 8 * MB + 1);
  assert.equal(big.status, 413);
  assert.equal(big.data.maxBytes, 8 * MB);

  // quota is 20 MB; the finished ~3 MB file from the first test already counts
  const a = await create(alice, 8 * MB);
  const b = await create(alice, 8 * MB);
  assert.equal(a.status, 200);
  assert.equal(b.status, 200);
  const c = await create(bob, 8 * MB);
  assert.equal(c.status, 507);
  assert.equal(c.data.error, 'storage_full');
  abandon(a.data.uploadId);
  abandon(b.data.uploadId);
  assert.equal((await create(bob, 8 * MB)).status, 200);
});

test('a second concurrent PATCH on the same upload is refused as busy', async () => {
  const id = (await create(alice, 2 * MB)).data.uploadId;
  const req = http.request(S.base + '/api/uploads/' + id, {
    method: 'PATCH', headers: { authorization: 'Bearer ' + alice, 'upload-offset': '0', 'content-length': MB },
  });
  req.on('error', () => { });
  req.write(Buffer.alloc(64 * 1024));
  await new Promise((r) => setTimeout(r, 150));
  const r = await patch(alice, id, 0, Buffer.alloc(16));
  assert.equal(r.status, 409);
  assert.equal(r.data.error, 'busy');
  req.destroy();
  await new Promise((r) => setTimeout(r, 200));
  assert.equal((await patch(alice, id, 0, Buffer.alloc(MB))).status, 200, 'lock is released after the first request dies');
  abandon(id);
});
