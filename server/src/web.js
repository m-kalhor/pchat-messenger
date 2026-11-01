'use strict';
/**
 * Web version (PWA, mainly for iPhone): a second HTTPS listener that serves the web app from ./web
 * and the same /api as the Android port. It has its own certificate (WEB_CERT_DIR), issued by the
 * private "Sepan Root CA" that iPhones install once as a profile, so the Android app's pinned
 * certificate on PORT is never touched. Replacing cert.pem/key.pem (e.g. with a Let's Encrypt
 * certificate for a domain later) needs no code change: the files are re-read every hour.
 *
 * A small plain-HTTP listener (WEB_HTTP_PORT, default 80) serves only the setup page and the CA
 * profile (public data) and redirects everything else to https.
 */
const https = require('node:https');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const qrcode = require('./vendor/qrcode');

const WEB_DIR = path.join(__dirname, 'web');
const TYPES = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8', '.webmanifest': 'application/manifest+json', '.png': 'image/png', '.svg': 'image/svg+xml',
};
const CSP = "default-src 'self'; img-src 'self' blob: data:; media-src 'self' blob:; connect-src 'self'; style-src 'self'; " +
  "script-src 'self'; worker-src 'self'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

/** Every file of ./web, read once at start (the whole app is a few hundred KB). */
function loadStatic() {
  const files = new Map();
  if (!fs.existsSync(WEB_DIR)) return files;
  for (const n of fs.readdirSync(WEB_DIR)) {
    const type = TYPES[path.extname(n)];
    const fp = path.join(WEB_DIR, n);
    if (!type || !fs.statSync(fp).isFile()) continue;
    const body = fs.readFileSync(fp);
    files.set('/' + n, { body, type, etag: '"' + crypto.createHash('sha1').update(body).digest('hex').slice(0, 16) + '"' });
  }
  if (files.has('/index.html')) files.set('/', files.get('/index.html'));
  return files;
}

function serveFile(req, res, f) {
  const h = {
    'Content-Type': f.type, 'ETag': f.etag, 'Cache-Control': 'no-cache', 'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer', 'Content-Security-Policy': CSP, 'X-Frame-Options': 'DENY',
  };
  if (req.headers['if-none-match'] === f.etag) { res.writeHead(304, h); return res.end(); }
  h['Content-Length'] = f.body.length;
  res.writeHead(200, h);
  res.end(req.method === 'HEAD' ? undefined : f.body);
}

// ---------- the CA certificate as a download / iOS configuration profile ----------
function caInfo(certDir) {
  try {
    const pem = fs.readFileSync(path.join(certDir, 'ca.pem'), 'utf8');
    const x = new crypto.X509Certificate(pem);
    const h = crypto.createHash('sha256').update(x.raw).digest('hex');
    // stable UUIDs derived from the certificate, so re-downloading replaces instead of duplicating
    const uuid = (salt) => {
      const d = crypto.createHash('sha256').update(salt + h).digest('hex');
      return `${d.slice(0, 8)}-${d.slice(8, 12)}-4${d.slice(13, 16)}-a${d.slice(17, 20)}-${d.slice(20, 32)}`.toUpperCase();
    };
    const profile = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>PayloadContent</key>
  <array>
    <dict>
      <key>PayloadCertificateFileName</key><string>sepan-ca.cer</string>
      <key>PayloadContent</key><data>${x.raw.toString('base64')}</data>
      <key>PayloadDescription</key><string>Sepan Root CA</string>
      <key>PayloadDisplayName</key><string>Sepan Root CA</string>
      <key>PayloadIdentifier</key><string>sepan.ca.cert.${h.slice(0, 12)}</string>
      <key>PayloadType</key><string>com.apple.security.root</string>
      <key>PayloadUUID</key><string>${uuid('cert')}</string>
      <key>PayloadVersion</key><integer>1</integer>
    </dict>
  </array>
  <key>PayloadDescription</key><string>گواهی امنیتی پیام‌رسان سپن برای اتصال امن نسخهٔ وب</string>
  <key>PayloadDisplayName</key><string>سپن</string>
  <key>PayloadIdentifier</key><string>sepan.ca.${h.slice(0, 12)}</string>
  <key>PayloadRemovalDisallowed</key><false/>
  <key>PayloadType</key><string>Configuration</string>
  <key>PayloadUUID</key><string>${uuid('profile')}</string>
  <key>PayloadVersion</key><integer>1</integer>
</dict>
</plist>
`;
    return { der: x.raw, profile: Buffer.from(profile), fingerprint: h.toUpperCase().match(/../g).join(':') };
  } catch { return null; }
}

/** Routes shared by both listeners: setup page, CA downloads, fingerprint. Returns true if handled. */
function setupRoute(req, res, p, files, certDir) {
  if (p === '/setup' || p === '/setup.html') {
    // the guide shows the CA fingerprint so it can be compared with the one install.sh printed
    const f = files.get('/setup.html');
    const ca = caInfo(certDir);
    if (!f) return false;
    const body = Buffer.from(f.body.toString().replace('{{CA_FINGERPRINT}}', ca ? ca.fingerprint : '—'));
    serveFile(req, res, { ...f, body, etag: '"' + crypto.createHash('sha1').update(body).digest('hex').slice(0, 16) + '"' });
    return true;
  }
  if (p === '/setup.css' || p === '/icon-180.png') {
    const f = files.get(p);
    if (f) { serveFile(req, res, f); return true; }
  }
  if (p === '/sepan-ca.mobileconfig' || p === '/sepan-ca.crt' || p === '/api/web/ca') {
    const ca = caInfo(certDir);
    if (!ca) { res.writeHead(404, { 'Content-Type': 'text/plain' }); res.end('CA not installed'); return true; }
    if (p === '/api/web/ca') {
      const b = Buffer.from(JSON.stringify({ fingerprint: ca.fingerprint }));
      res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': b.length, 'Cache-Control': 'no-store' });
      res.end(b);
    } else if (p.endsWith('.mobileconfig')) {
      res.writeHead(200, { 'Content-Type': 'application/x-apple-aspen-config', 'Content-Length': ca.profile.length, 'Content-Disposition': 'attachment; filename="sepan-ca.mobileconfig"', 'Cache-Control': 'no-store' });
      res.end(ca.profile);
    } else {
      res.writeHead(200, { 'Content-Type': 'application/x-x509-ca-cert', 'Content-Length': ca.der.length, 'Content-Disposition': 'attachment; filename="sepan-ca.crt"', 'Cache-Control': 'no-store' });
      res.end(ca.der);
    }
    return true;
  }
  return false;
}

/** A QR code as SVG (black on white, so it scans in dark mode too). */
function qrSvg(text) {
  const qr = qrcode(0, 'M');
  qr.addData(text);
  qr.make();
  const n = qr.getModuleCount(), m = 4;
  let d = '';
  for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) if (qr.isDark(r, c)) d += `M${c + m} ${r + m}h1v1h-1z`;
  return Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${n + 2 * m} ${n + 2 * m}" shape-rendering="crispEdges">` +
    `<rect width="100%" height="100%" fill="#fff"/><path fill="#000" d="${d}"/></svg>`);
}

/**
 * The Android app download (both listeners). The QR code points at the plain-HTTP listener: an Android
 * phone does not have the private web certificate, and the APK is checked by its signature anyway.
 */
function apkRoute(req, res, p, opts) {
  if (p === '/download/sepan.apk') { opts.serveApk(req, res); return true; }
  if (p === '/download/sepan-qr.svg') {
    const host = opts.publicHost || String(req.headers.host || '').replace(/:\d+$/, '').replace(/[^\w.\-[\]:]/g, '');
    if (!opts.apkInfo() || !host) { res.writeHead(404, { 'Content-Type': 'text/plain' }); res.end('no apk'); return true; }
    const body = qrSvg(`http://${host}${opts.httpPort === 80 ? '' : ':' + opts.httpPort}/download/sepan.apk`);
    res.writeHead(200, { 'Content-Type': 'image/svg+xml', 'Content-Length': body.length, 'Cache-Control': 'no-cache', 'X-Content-Type-Options': 'nosniff' });
    res.end(body);
    return true;
  }
  return false;
}

function readTls(certDir) {
  return {
    key: fs.readFileSync(path.join(certDir, 'key.pem')),
    cert: fs.readFileSync(path.join(certDir, 'cert.pem')),
    minVersion: 'TLSv1.2',
  };
}

/**
 * apiHandler: the messenger's request handler (same /api as the Android port).
 * plain: serve plain HTTP instead of TLS (tests only).
 */
function start(apiHandler, { plain = false, certDir, publicHost = '', serveApk, apkInfo } = {}) {
  if (process.env.WEB_DISABLE === '1') return null;
  const port = +(process.env.WEB_PORT || 443);
  const httpPort = +(process.env.WEB_HTTP_PORT ?? 80);
  certDir = process.env.WEB_CERT_DIR || certDir;
  const files = loadStatic();
  const apk = { serveApk, apkInfo, publicHost, httpPort: httpPort || 80 };
  if (!files.has('/index.html')) { console.log('web app: ./web not found, web version disabled'); return null; }

  const handler = (req, res) => {
    const p = new URL(req.url, 'http://x').pathname;
    if (p.startsWith('/api/') && p !== '/api/web/ca') return apiHandler(req, res);
    if (setupRoute(req, res, p, files, certDir)) return;
    if (serveApk && apkRoute(req, res, p, apk)) return;
    const f = (req.method === 'GET' || req.method === 'HEAD') && files.get(p);
    if (f) return serveFile(req, res, f);
    res.writeHead(404, { 'Content-Type': 'text/plain', 'X-Content-Type-Options': 'nosniff' });
    res.end('not found');
  };

  let srv;
  if (plain) srv = http.createServer(handler);
  else {
    let tls;
    try { tls = readTls(certDir); } catch (e) {
      console.log(`web app: no certificate in ${certDir} (${e.code || e.message}), web version disabled. Re-run install.sh to create it.`);
      return null;
    }
    srv = https.createServer(tls, handler);
    // pick up a renewed or replaced certificate without a restart
    let last = tls.cert.toString() + tls.key.toString();
    setInterval(() => {
      try {
        const t = readTls(certDir);
        const now = t.cert.toString() + t.key.toString();
        if (now !== last) { srv.setSecureContext(t); last = now; console.log('web app: certificate reloaded'); }
      } catch (e) { console.error('web app: certificate reload failed', e.message); }
    }, 3600e3).unref();
  }
  srv.requestTimeout = 15 * 60 * 1000;
  srv.keepAliveTimeout = 65000;
  srv.on('error', (e) => console.error(`web app: cannot listen on ${port}: ${e.message}`));
  srv.listen(port, '0.0.0.0', () => console.log(`web app on ${port} (${plain ? 'plain http' : 'TLS'})`));

  let redirect = null;
  if (httpPort) {
    redirect = http.createServer((req, res) => {
      const p = new URL(req.url, 'http://x').pathname;
      if (setupRoute(req, res, p, files, certDir)) return;
      if (serveApk && apkRoute(req, res, p, apk)) return;
      const host = publicHost || String(req.headers.host || '').replace(/:\d+$/, '').replace(/[^\w.\-[\]:]/g, '');
      if (!host) { res.writeHead(400); return res.end(); }
      res.writeHead(302, { Location: `https://${host}${port === 443 ? '' : ':' + port}/`, 'Cache-Control': 'no-store' });
      res.end();
    });
    redirect.on('error', (e) => console.error(`web setup page: cannot listen on ${httpPort}: ${e.message}`));
    redirect.listen(httpPort, '0.0.0.0', () => console.log(`web setup page on ${httpPort} (http)`));
  }
  return { srv, redirect };
}

module.exports = { start, caInfo, qrSvg };
