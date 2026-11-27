'use strict';
// 1.28.1: the Bazaar build asks the server which version Café Bazaar publishes (no APK download).
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { startServer } = require('./helpers/server');
const { parsePage } = require('../server/src/bazaar');

test('parsePage reads softwareVersion, else the «نسخه» line with Persian digits', () => {
  assert.equal(parsePage('<script>{"@type":"SoftwareApplication","softwareVersion":"1.28.1","fileSize":1}</script>'), '1.28.1');
  assert.equal(parsePage('x \\"softwareVersion\\":\\"1.8.0\\" y'), '1.8.0');
  assert.equal(parsePage('<div>نسخه ۱.۲۸.۱</div>'), '1.28.1');
  assert.equal(parsePage('<div>no version here</div>'), null);
  assert.equal(parsePage('"softwareVersion":"<b>"'), null);
});

let page = '<html>"softwareVersion":"1.28.1"</html>';
let hits = 0;
const fake = http.createServer((req, res) => { hits++; res.writeHead(200, { 'Content-Type': 'text/html' }); res.end(page); });
let S;
test.before(async () => {
  await new Promise((r) => fake.listen(0, '127.0.0.1', r));
  S = await startServer({ BAZAAR_APP_URL: `http://127.0.0.1:${fake.address().port}/app/com.pchat.app` });
});
test.after(() => { S && S.stop(); fake.close(); });

test('GET /api/app/version?store=bazaar: the version on the Bazaar page, read once and cached', async () => {
  const r = await S.api(null, 'GET', '/api/app/version?store=bazaar');
  assert.equal(r.status, 200);
  assert.equal(r.data.store, 'bazaar');
  assert.equal(r.data.name, '1.28.1');
  assert.match(r.data.url, /\/app\/com\.pchat\.app$/);
  assert.ok(Array.isArray(r.data.notes));
  page = '<html>"softwareVersion":"9.9.9"</html>';
  assert.equal((await S.api(null, 'GET', '/api/app/version?store=bazaar')).data.name, '1.28.1', 'cached');
  assert.equal(hits, 1);
  // the direct build's answer is unchanged
  assert.deepEqual((await S.api(null, 'GET', '/api/app/version')).data, { code: null });
});
