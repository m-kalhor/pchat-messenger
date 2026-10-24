'use strict';
// E2E crypto path: P-256 ECDH -> HKDF-SHA256 -> AES-256-GCM, mirroring android/app/src/main/java/com/pchat/app/Crypto.kt.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const C = require('./helpers/pchat-crypto');

test('Crypto.kt still uses the parameters this port mirrors', () => {
  const kt = fs.readFileSync(path.join(__dirname, '..', 'android', 'app', 'src', 'main', 'java', 'com', 'pchat', 'app', 'Crypto.kt'), 'utf8');
  for (const s of [
    'ECGenParameterSpec("secp256r1")', 'KeyAgreement.getInstance("ECDH")', 'Mac.getInstance("HmacSHA256")',
    'SecretKeySpec(ByteArray(32), "HmacSHA256")', 'mac.update(1.toByte())', '"pchat-v1|" + listOf(a, b).sorted().joinToString("|")',
    'Cipher.getInstance("AES/GCM/NoPadding")', 'GCMParameterSpec(128, iv)', 'randomBytes(12)', 'randomBytes(32)',
    'const val FILE_CHUNK = 1 shl 20', 'const val TAG = 16', '"fc|$index|${if (last) 1 else 0}"',
    'val aad = "$me|$target".toByteArray()', 'put("v", 1)',
  ]) assert.ok(kt.includes(s), `Crypto.kt changed: expected to find ${s} — update test/helpers/pchat-crypto.js`);
});

test('HKDF matches RFC 5869 (test case 3, zero salt, empty info)', () => {
  const ikm = Buffer.alloc(22, 0x0b);
  // RFC 5869 A.3, first 32 bytes of OKM
  assert.equal(C.hkdf(ikm, Buffer.alloc(0)).toString('hex'), '8da4e775a563c18f715f802a063c5a31b8a11f5c5ee1879ec3454e5f3c738d2d');
});

test('HKDF matches node:crypto hkdfSync for the pchat info string', () => {
  const ikm = crypto.randomBytes(32);
  const info = Buffer.from('pchat-v1|alice|bob');
  assert.deepEqual(C.hkdf(ikm, info), Buffer.from(crypto.hkdfSync('sha256', ikm, Buffer.alloc(32), info, 32)));
});

test('ECDH pair key is symmetric and order-independent', () => {
  const a = C.newIdentity(), b = C.newIdentity(), c = C.newIdentity();
  const ab = C.pairKey(a, b.pubB64, 'alice', 'bob');
  assert.equal(ab.length, 32);
  assert.deepEqual(C.pairKey(b, a.pubB64, 'bob', 'alice'), ab);
  assert.deepEqual(C.pairKey(b, a.pubB64, 'alice', 'bob'), ab);
  assert.notDeepEqual(C.pairKey(a, c.pubB64, 'alice', 'carol'), ab);
  // usernames are bound into the key
  assert.notDeepEqual(C.pairKey(a, b.pubB64, 'alice', 'mallory'), ab);
});

test('public key is X.509 SPKI DER (91 bytes for P-256) and fingerprint format', () => {
  const a = C.newIdentity();
  assert.equal(C.unb64(a.pubB64).length, 91);
  assert.match(C.fingerprint(a.pubB64), /^([0-9A-F]{4} ){7}[0-9A-F]{4}$/);
});

test('message: sender, recipient and group members can decrypt; others cannot', () => {
  const ids = { alice: C.newIdentity(), bob: C.newIdentity(), carol: C.newIdentity(), eve: C.newIdentity() };
  const pubs = Object.fromEntries(Object.entries(ids).map(([u, i]) => [u, i.pubB64]));

  const dm = C.encryptFor(ids.alice, 'alice', 'bob', { alice: pubs.alice, bob: pubs.bob }, 'سلام bob');
  assert.equal(JSON.parse(dm).v, 1);
  assert.equal(C.decryptFrom(ids.bob, 'bob', 'alice', 'bob', pubs.alice, dm).toString(), 'سلام bob');
  assert.equal(C.decryptFrom(ids.alice, 'alice', 'alice', 'bob', null, dm).toString(), 'سلام bob');
  assert.throws(() => C.decryptFrom(ids.eve, 'eve', 'alice', 'bob', pubs.alice, dm), /not addressed to me/);

  const grp = C.encryptFor(ids.alice, 'alice', 'g:2', { alice: pubs.alice, bob: pubs.bob, carol: pubs.carol }, 'hi all');
  for (const u of ['bob', 'carol']) assert.equal(C.decryptFrom(ids[u], u, 'alice', 'g:2', pubs.alice, grp).toString(), 'hi all');
});

test('message: tampering or re-addressing fails authentication', () => {
  const a = C.newIdentity(), b = C.newIdentity();
  const pubs = { alice: a.pubB64, bob: b.pubB64 };
  const payload = C.encryptFor(a, 'alice', 'bob', pubs, 'secret');

  // server replays it as if sent to another conversation (AAD = sender|target)
  assert.throws(() => C.decryptFrom(b, 'bob', 'alice', 'g:1', a.pubB64, payload));
  // wrong claimed sender key
  assert.throws(() => C.decryptFrom(b, 'bob', 'alice', 'bob', C.newIdentity().pubB64, payload));
  // flipped ciphertext bit
  const o = JSON.parse(payload);
  const c = C.unb64(o.c); c[c.length - 1] ^= 1; o.c = C.b64(c);
  assert.throws(() => C.decryptFrom(b, 'bob', 'alice', 'bob', a.pubB64, JSON.stringify(o)));
});

test('seal/open round trip and fresh IV per call', () => {
  const k = crypto.randomBytes(32), aad = Buffer.from('file');
  const x = C.seal(k, Buffer.from('data'), aad), y = C.seal(k, Buffer.from('data'), aad);
  assert.notDeepEqual(x, y);
  assert.equal(x.length, 12 + 4 + 16);
  assert.equal(C.open(k, x, aad).toString(), 'data');
  assert.throws(() => C.open(k, x, Buffer.from('other')));
});

test('chunk sizes match Crypto.chunkCount / cipherSize', () => {
  const M = C.FILE_CHUNK;
  assert.equal(C.chunkCount(0), 1);
  assert.equal(C.chunkCount(1), 1);
  assert.equal(C.chunkCount(M), 1);
  assert.equal(C.chunkCount(M + 1), 2);
  assert.equal(C.cipherSize(0), 16);
  assert.equal(C.cipherSize(3 * M + 5), 3 * M + 5 + 4 * 16);
  assert.ok(C.isChunked(C.newFileKey()));
  assert.ok(!C.isChunked(C.b64(crypto.randomBytes(32))));
});

test('chunked file encryption is deterministic and round-trips', () => {
  const fkey = C.newFileKey();
  const plain = crypto.randomBytes(2 * C.FILE_CHUNK + 1234);
  const blob = C.sealFileChunks(fkey, plain);
  assert.equal(blob.length, C.cipherSize(plain.length));
  assert.deepEqual(C.sealFileChunks(fkey, plain), blob, 'same key+index must give same bytes so uploads can resume');
  assert.deepEqual(C.openFileChunks(fkey, blob), plain);
  assert.deepEqual(C.openFileChunks(fkey, C.sealFileChunks(fkey, Buffer.alloc(0))), Buffer.alloc(0));
});

test('chunked file: reordering, truncation and wrong key are rejected', () => {
  const fkey = C.newFileKey();
  const plain = crypto.randomBytes(3 * C.FILE_CHUNK);
  const blob = C.sealFileChunks(fkey, plain);
  const ch = (i) => blob.subarray(i * C.CIPHER_CHUNK, (i + 1) * C.CIPHER_CHUNK);

  assert.throws(() => C.openChunk(fkey, 0, false, ch(1)), 'swapped chunk');
  assert.throws(() => C.openFileChunks(fkey, blob.subarray(0, 2 * C.CIPHER_CHUNK)), 'truncated file: chunk 1 was not sealed as last');
  assert.throws(() => C.openChunk(fkey, 2, false, ch(2)), 'last flag stripped');
  assert.throws(() => C.openFileChunks(C.newFileKey(), blob), 'wrong key');
  assert.deepEqual(C.openChunk(fkey, 2, true, ch(2)), plain.subarray(2 * C.FILE_CHUNK));
});
