'use strict';
// Web version (PWA): its WebCrypto port must interoperate with the Android format (via the Node port in
// helpers/pchat-crypto.js), and the web listener must serve the app, the API and the iPhone setup files.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const https = require('node:https');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const N = require('./helpers/pchat-crypto');
const { startServer } = require('./helpers/server');

const WEB = path.join(__dirname, '..', 'server', 'src', 'web');
const W = () => import(path.join(WEB, 'crypto.mjs'));
const td = new TextDecoder();

test('web -> Android: private message decrypts with the Android crypto', async () => {
  const C = await W();
  const web = await C.newIdentity(), phone = N.newIdentity();
  const payload = await C.encryptFor(web, 'mina', 'reza', { reza: phone.pubB64 }, JSON.stringify({ t: 'text', x: 'سلام' }));
  assert.equal(N.decryptFrom(phone, 'reza', 'mina', 'reza', web.pubB64, payload).toString(), '{"t":"text","x":"سلام"}');
  // the sender can read its own message (it is also wrapped for itself)
  assert.equal(td.decode(await C.decryptFrom(web, 'mina', 'mina', 'reza', null, payload)), '{"t":"text","x":"سلام"}');
});

test('Android -> web: group message decrypts in the browser; tampering is rejected', async () => {
  const C = await W();
  const web = await C.newIdentity(), phone = N.newIdentity();
  const payload = N.encryptFor(phone, 'reza', 'g:3', { reza: phone.pubB64, mina: web.pubB64 }, 'جلسه ساعت ۵');
  assert.equal(td.decode(await C.decryptFrom(web, 'mina', 'reza', 'g:3', phone.pubB64, payload)), 'جلسه ساعت ۵');
  await assert.rejects(C.decryptFrom(web, 'mina', 'reza', 'g:4', phone.pubB64, payload), 'target is bound into the AAD');
  await assert.rejects(C.decryptFrom(web, 'sara', 'reza', 'g:3', phone.pubB64, payload), /not addressed/);
});

test('fingerprint matches the Android format', async () => {
  const C = await W();
  const id = N.newIdentity();
  assert.equal(await C.fingerprint(id.pubB64), N.fingerprint(id.pubB64));
});

test('chunked files: web and Android seal / open each other', async () => {
  const C = await W();
  assert.equal(C.FILE_CHUNK, N.FILE_CHUNK);
  assert.equal(C.cipherSize(5 * 1048576 + 3), N.cipherSize(5 * 1048576 + 3));
  const data = crypto.randomBytes(2 * 1048576 + 1234);
  const fk = C.newFileKey();
  const n = C.chunkCount(data.length);
  const parts = [];
  for (let i = 0; i < n; i++) parts.push(await C.sealChunk(fk, i, i === n - 1, data.subarray(i * C.FILE_CHUNK, (i + 1) * C.FILE_CHUNK)));
  const blob = Buffer.concat(parts);
  assert.deepEqual(blob, N.sealFileChunks(fk, data), 'same deterministic ciphertext as Crypto.kt, so uploads can resume');
  assert.deepEqual(N.openFileChunks(fk, blob), data);
  const back = [];
  for (let i = 0; i < n; i++) back.push(await C.openChunk(fk, i, i === n - 1, blob.subarray(i * C.CIPHER_CHUNK, (i + 1) * C.CIPHER_CHUNK)));
  assert.deepEqual(Buffer.concat(back), data);
  await assert.rejects(C.openChunk(fk, 1, true, blob.subarray(C.CIPHER_CHUNK, 2 * C.CIPHER_CHUNK)), 'a middle chunk cannot pass as the last one');
});

test('key backup: web and Android restore each other', async () => {
  const C = await W();
  const web = await C.newIdentity();
  const kb = await C.exportBackup(web, 'mina', 'pw-1');
  assert.equal(kb.v, 2, 'the web app writes v2 (key password) backups');
  const onPhone = N.importBackup(kb, 'mina', 'pw-1');
  assert.equal(onPhone.pubB64, web.pubB64);
  const phone = N.newIdentity();
  const restored = await C.importBackup(N.exportBackup(phone, 'reza', 'pw-2', 100000, 2), 'reza', 'pw-2');
  assert.equal(restored.pubB64, phone.pubB64);
  assert.equal((await C.importBackup(N.exportBackup(phone, 'reza', 'old-login-pw'), 'reza', 'old-login-pw')).pubB64, phone.pubB64, 'v1 backups still open');
  // the restored key really is the same key: a message to the phone opens in the browser
  const payload = N.encryptFor(onPhone, 'mina', 'reza', { mina: onPhone.pubB64, reza: phone.pubB64 }, 'ok');
  assert.equal(td.decode(await C.decryptFrom(restored, 'reza', 'mina', 'reza', onPhone.pubB64, payload)), 'ok');
  await assert.rejects(C.importBackup(kb, 'mina', 'wrong'));
  await assert.rejects(C.importBackup(kb, 'reza', 'pw-1'), 'the username is bound into the backup');
});

test('WebP avatar encoder output is accepted by the server', async () => {
  const { encodeWebp } = await import(path.join(WEB, 'webp.mjs'));
  const { sanitizeWebp } = require('../server/src/webp');
  const w = 320, h = 320, px = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < px.length; i++) px[i] = (i * 37) & 255;
  const out = Buffer.from(encodeWebp(px, w, h));
  assert.equal(out.toString('ascii', 12, 16), 'VP8L');
  assert.equal(out.readUInt32LE(4) + 8, out.length);
  assert.ok(out.length < 400 * 1024, 'fits the 400 KB avatar limit');
  assert.ok(sanitizeWebp(out), 'server accepts it');
});

// ---------------- the web listener ----------------
function get(url, opts = {}) {
  return new Promise((resolve, reject) => {
    const lib = url.startsWith('https') ? https : require('node:http');
    lib.get(url, opts, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    }).on('error', reject);
  });
}
const freePort = () => new Promise((resolve) => { const s = require('node:net').createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); }); });

test('web listener: app, API, setup page and CA profile (plain mode)', async (t) => {
  const certDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pchat-web-'));
  const ca = makeCa(certDir);
  if (!ca) return t.skip('openssl not available');
  const [webPort, httpPort] = [await freePort(), await freePort()];
  const S = await startServer({ WEB_DISABLE: '0', WEB_PORT: String(webPort), WEB_HTTP_PORT: String(httpPort), WEB_CERT_DIR: certDir });
  t.after(() => { S.stop(); fs.rmSync(certDir, { recursive: true, force: true }); });
  await waitFor(`http://127.0.0.1:${webPort}/`);
  const base = `http://127.0.0.1:${webPort}`;

  const index = await get(base + '/');
  assert.equal(index.status, 200);
  assert.match(index.body.toString(), /app\.mjs/);
  assert.match(index.headers['content-security-policy'], /script-src 'self'/);
  assert.equal((await get(base + '/app.mjs')).headers['content-type'], 'text/javascript; charset=utf-8');
  assert.equal((await get(base + '/manifest.webmanifest')).status, 200);
  assert.equal((await get(base + '/nope.js')).status, 404);
  assert.equal((await get(base + '/../server.js')).status, 404);
  assert.equal((await get(base + '/api/health')).body.toString(), '{"ok":true}', 'same API on the web port');
  assert.equal((await get(base + '/', { headers: { 'if-none-match': index.headers.etag } })).status, 304);

  // setup page and profile on the plain-http port; everything else redirects to https
  const setup = await get(`http://127.0.0.1:${httpPort}/setup`);
  assert.equal(setup.status, 200);
  assert.ok(setup.body.toString().includes(ca.fingerprint), 'setup page shows the CA fingerprint');
  const prof = await get(`http://127.0.0.1:${httpPort}/sepan-ca.mobileconfig`);
  assert.equal(prof.headers['content-type'], 'application/x-apple-aspen-config');
  assert.ok(prof.body.toString().includes(ca.der.toString('base64')));
  assert.match(prof.body.toString(), /com\.apple\.security\.root/);
  assert.deepEqual((await get(`http://127.0.0.1:${httpPort}/sepan-ca.crt`)).body, ca.der);
  const red = await get(`http://127.0.0.1:${httpPort}/`, { headers: { host: '10.1.2.3' } });
  assert.equal(red.status, 302);
  assert.equal(red.headers.location, `https://10.1.2.3:${webPort}/`);
  assert.equal((await get(`http://127.0.0.1:${httpPort}/api/health`)).status, 302, 'no API over plain http');
});

test('a domain name: intro page at /, the app at /app, http stays on the name, ACME challenge', async (t) => {
  const certDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pchat-web-'));
  const ca = makeCa(certDir);
  if (!ca) return t.skip('openssl not available');
  const [webPort, httpPort] = [await freePort(), await freePort()];
  const S = await startServer({ WEB_DISABLE: '0', WEB_PORT: String(webPort), WEB_HTTP_PORT: String(httpPort), WEB_CERT_DIR: certDir, PUBLIC_HOST: '10.9.9.9' });
  t.after(() => { S.stop(); fs.rmSync(certDir, { recursive: true, force: true }); });
  await waitFor(`http://127.0.0.1:${webPort}/`);
  const base = `http://127.0.0.1:${webPort}`;
  const dom = { headers: { host: 'sepan.example.ir' } };
  S.db.prepare("INSERT INTO settings(key,value) VALUES('site_contact','info@example.ir <b>') ON CONFLICT(key) DO UPDATE SET value=excluded.value").run();

  const intro = await get(base + '/', dom);
  assert.equal(intro.status, 200);
  const html = intro.body.toString();
  assert.doesNotMatch(html, /href="\/app"/, 'no login link on the intro page (1.8): the app is only at /app');
  assert.match(html, /فقط برای فرستادن کد یک‌بارمصرف/, 'says what the SMS is for');
  assert.match(html, /info@example\.ir &lt;b&gt;/, 'contact shown, escaped');
  assert.doesNotMatch(html, /<script/);
  assert.match((await get(base + '/app', dom)).body.toString(), /app\.mjs/, 'the app itself');
  assert.equal((await get(base + '/welcome.css', dom)).status, 200);
  assert.match((await get(base + '/')).body.toString(), /app\.mjs/, 'by IP / is still the app');
  assert.match((await get(base + '/', { headers: { host: '10.9.9.9:443' } })).body.toString(), /app\.mjs/);

  // plain http: a name stays a name, an IP goes to PUBLIC_HOST
  const red = await get(`http://127.0.0.1:${httpPort}/`, dom);
  assert.equal(red.headers.location, `https://sepan.example.ir:${webPort}/`);
  assert.equal((await get(`http://127.0.0.1:${httpPort}/`, { headers: { host: '1.2.3.4' } })).headers.location, `https://10.9.9.9:${webPort}/`);
  // Let's Encrypt HTTP-01 challenge files
  const ch = path.join(S.app.dataDir, 'acme', '.well-known', 'acme-challenge');
  fs.mkdirSync(ch, { recursive: true });
  fs.writeFileSync(path.join(ch, 'tok_ABC-1234567'), 'tok_ABC-1234567.thumb');
  const acme = await get(`http://127.0.0.1:${httpPort}/.well-known/acme-challenge/tok_ABC-1234567`, dom);
  assert.equal(acme.status, 200);
  assert.equal(acme.body.toString(), 'tok_ABC-1234567.thumb');
  assert.equal((await get(`http://127.0.0.1:${httpPort}/.well-known/acme-challenge/nope_nope_nope`, dom)).status, 404);
  assert.equal((await get(`http://127.0.0.1:${httpPort}/.well-known/acme-challenge/..%2F..%2Fx`, dom)).status, 302);
});

test('web listener over TLS: certificate chains to the Sepan Root CA', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pchat-tls-'));
  const ca = makeCa(path.join(dir, 'web'));
  if (!ca) return t.skip('openssl not available');
  // the Android port still needs its own (self-signed) certificate
  execFileSync('openssl', ['req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-nodes', '-keyout', path.join(dir, 'key.pem'),
    '-out', path.join(dir, 'cert.pem'), '-days', '1', '-subj', '/CN=messenger', '-addext', 'subjectAltName=IP:127.0.0.1'], { stdio: 'ignore' });
  const webPort = await freePort();
  const S = await startServer({ PLAIN_HTTP: '0', CERT_DIR: dir, WEB_DISABLE: '0', WEB_PORT: String(webPort), WEB_HTTP_PORT: '0' });
  t.after(() => { S.stop(); fs.rmSync(dir, { recursive: true, force: true }); });
  const opts = { ca: ca.pem };
  await waitFor(`https://127.0.0.1:${webPort}/api/health`, opts);
  const r = await get(`https://127.0.0.1:${webPort}/api/health`, opts);
  assert.equal(r.body.toString(), '{"ok":true}');
  await assert.rejects(get(`https://127.0.0.1:${webPort}/api/health`), 'not trusted without the CA');
  // a domain with its own certificate (as domain.sh copies it from Let's Encrypt) is picked by SNI
  const le = path.join(dir, 'le', 'sepan.test');
  fs.mkdirSync(le, { recursive: true });
  execFileSync('openssl', ['req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-nodes', '-keyout', path.join(le, 'key.pem'),
    '-out', path.join(le, 'cert.pem'), '-days', '1', '-subj', '/CN=sepan.test', '-addext', 'subjectAltName=DNS:sepan.test'], { stdio: 'ignore' });
  const peer = (servername) => new Promise((resolve, reject) => {
    const sock = require('node:tls').connect({ host: '127.0.0.1', port: webPort, servername, rejectUnauthorized: false }, () => {
      const c = sock.getPeerCertificate(); sock.end(); resolve(c.subject.CN);
    });
    sock.on('error', reject);
  });
  assert.equal(await peer('sepan.test'), 'sepan.test');
  assert.equal(await peer('other.test'), '127.0.0.1', 'unknown names keep the private CA certificate');
});

/** Root CA + server certificate for 127.0.0.1, made the same way as install.sh (sepan-web-cert). */
function makeCa(dir) {
  try { execFileSync('openssl', ['version'], { stdio: 'ignore' }); } catch { return null; }
  fs.mkdirSync(dir, { recursive: true });
  const o = (args) => execFileSync('openssl', args, { cwd: dir, stdio: 'ignore' });
  o(['req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-nodes', '-keyout', 'ca.key', '-out', 'ca.pem', '-days', '30',
    '-subj', '/CN=Sepan Root CA/O=Sepan', '-addext', 'basicConstraints=critical,CA:TRUE,pathlen:0', '-addext', 'keyUsage=critical,keyCertSign,cRLSign']);
  o(['req', '-new', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-nodes', '-keyout', 'key.pem', '-out', 'req.csr', '-subj', '/CN=127.0.0.1']);
  fs.writeFileSync(path.join(dir, 'ext'), 'basicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature\nextendedKeyUsage=serverAuth\nsubjectAltName=IP:127.0.0.1\n');
  o(['x509', '-req', '-in', 'req.csr', '-CA', 'ca.pem', '-CAkey', 'ca.key', '-set_serial', '0x' + crypto.randomBytes(8).toString('hex'), '-days', '30', '-sha256', '-extfile', 'ext', '-out', 'cert.pem']);
  const pem = fs.readFileSync(path.join(dir, 'ca.pem'));
  const x = new crypto.X509Certificate(pem);
  return { pem, der: x.raw, fingerprint: crypto.createHash('sha256').update(x.raw).digest('hex').toUpperCase().match(/../g).join(':') };
}

async function waitFor(url, opts) {
  for (let i = 0; i < 50; i++) {
    try { await get(url, opts); return; } catch { await new Promise((r) => setTimeout(r, 100)); }
  }
  throw new Error('web listener did not start: ' + url);
}
