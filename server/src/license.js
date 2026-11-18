'use strict';
/**
 * 1.25: install approval (license) for the packaged server.
 *
 * The packaged server (one obfuscated executable built by tools/package) runs only with an activation
 * code that the owner signs on his own computer (tools/license, Ed25519; the private key never leaves
 * that computer). The code is bound to this machine (machine id + network cards), to the exact
 * executable (SHA-256 of the file) and to the server address, and may carry a user limit and an
 * expiry date. The web/admin files next to the executable are checked against hashes built into it.
 *
 * Run from the source tree (tests, the owner's own server installed with install.sh) nothing is checked:
 * the build constants below exist only in the packaged executable.
 */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

/* global __SEPAN_PACKAGED__, __SEPAN_K1__, __SEPAN_M1__, __SEPAN_ASSETS__, __SEPAN_VERSION__ */
const PACKAGED = typeof __SEPAN_PACKAGED__ !== 'undefined' && __SEPAN_PACKAGED__ === true;
const VERSION = typeof __SEPAN_VERSION__ !== 'undefined' ? __SEPAN_VERSION__ : 'src';
const SPKI = Buffer.from('302a300506032b6570032100', 'hex');

const b64u = (b) => Buffer.from(b).toString('base64url');
const unb64u = (s) => Buffer.from(String(s), 'base64url');

/** The public key, kept in the executable XOR-masked (another masked copy lives in core.js). */
function pubKey(k, m) {
  const raw = Buffer.from(k.map((x, i) => x ^ m[i % m.length]));
  return crypto.createPublicKey({ key: Buffer.concat([SPKI, raw]), format: 'der', type: 'spki' });
}

/** This machine: /etc/machine-id + the MAC addresses of its physical network cards (readable without root). */
function hardwareId() {
  let mid = '';
  for (const f of ['/etc/machine-id', '/var/lib/dbus/machine-id']) {
    try { mid = fs.readFileSync(f, 'utf8').trim(); if (mid) break; } catch { }
  }
  const macs = [];
  try {
    for (const n of fs.readdirSync('/sys/class/net')) {
      if (n === 'lo') continue;
      let real = '';
      try { real = fs.realpathSync(path.join('/sys/class/net', n)); } catch { continue; }
      if (real.includes('/virtual/')) continue;
      try {
        const a = fs.readFileSync(path.join('/sys/class/net', n, 'address'), 'utf8').trim().toLowerCase();
        if (a && a !== '00:00:00:00:00:00') macs.push(a);
      } catch { }
    }
  } catch { }
  macs.sort();
  return crypto.createHash('sha256').update('sepan-hw|' + mid + '|' + macs.join(',')).digest('hex').slice(0, 32);
}

let binCache = null;
/** SHA-256 of the running executable ('src' when run from the source tree). */
function binaryHash() {
  if (!PACKAGED) return 'src';
  if (!binCache) {
    const h = crypto.createHash('sha256');
    const fd = fs.openSync(process.execPath, 'r');
    const buf = Buffer.allocUnsafe(1 << 20);
    try { let n; while ((n = fs.readSync(fd, buf, 0, buf.length, null)) > 0) h.update(buf.subarray(0, n)); }
    finally { fs.closeSync(fd); }
    binCache = h.digest('hex');
  }
  return binCache;
}

const appDir = () => path.dirname(process.execPath);

/** The files next to the executable that were built with it (web app, admin panel, stickers...) are unchanged. */
function assetsOk() {
  if (!PACKAGED) return true;
  const want = __SEPAN_ASSETS__;
  for (const rel of Object.keys(want)) {
    let got = '';
    try { got = crypto.createHash('sha256').update(fs.readFileSync(path.join(appDir(), rel))).digest('hex'); } catch { }
    if (got !== want[rel]) return rel;
  }
  return true;
}

const licenseFile = () => process.env.LICENSE_FILE || path.join(process.env.DATA_DIR || '/opt/messenger/data', 'license.txt');

/** The code shown by the installer; the owner turns it into an activation code with tools/license. */
function requestCode({ ip = '', app = '', id = '' } = {}) {
  const p = { v: 1, hw: hardwareId(), ip: String(ip), app: String(app), id: String(id), bin: binaryHash(), ver: VERSION, t: Date.now() };
  return 'SR1.' + b64u(JSON.stringify(p));
}

/** Checks an activation code against this machine and executable. Returns { ok, lic } or { ok: false, why }. */
function verify(code, { ip } = {}) {
  const parts = String(code || '').trim().split('.');
  if (parts.length !== 3 || parts[0] !== 'SA1') return { ok: false, why: 'format' };
  let lic;
  try { lic = JSON.parse(unb64u(parts[1]).toString('utf8')); } catch { return { ok: false, why: 'format' }; }
  let good = false;
  try { good = crypto.verify(null, Buffer.from(parts[0] + '.' + parts[1]), pubKey(__SEPAN_K1__, __SEPAN_M1__), unb64u(parts[2])); } catch { }
  if (!good) return { ok: false, why: 'signature' };
  if (lic.hw !== hardwareId()) return { ok: false, why: 'machine' };
  if (lic.bin !== binaryHash()) return { ok: false, why: 'version' };
  if (ip !== undefined && ip !== '' && lic.ip && lic.ip !== ip) return { ok: false, why: 'address' };
  if (lic.exp && Date.now() > lic.exp) return { ok: false, why: 'expired' };
  return { ok: true, lic };
}

let current = null;
/** The license in force (packaged) or an unlimited one (source tree). */
function check() {
  if (!PACKAGED) return { ok: true, lic: { users: 0, exp: 0, app: '', src: true } };
  const a = assetsOk();
  if (a !== true) return { ok: false, why: 'files', file: a };
  let code = '';
  try { code = fs.readFileSync(licenseFile(), 'utf8'); } catch { return { ok: false, why: 'missing' }; }
  return verify(code, { ip: process.env.PUBLIC_HOST || '' });
}

const WHY = {
  missing: 'no activation code (run the installer again)', format: 'the activation code is damaged', signature: 'the activation code is not genuine',
  machine: 'the activation code belongs to another server', version: 'this server program was changed or updated: a new activation code is needed',
  address: 'the server address differs from the activated one', expired: 'the license has expired', files: 'program files were changed',
};
const EXIT = 78; // systemd: RestartPreventExitStatus=78, so a server without a license does not restart in a loop

/** Called at start: stops the process without a valid license; rechecked every few hours. */
function enforce() {
  if (!PACKAGED) return;
  const r = check();
  if (!r.ok) {
    console.error('LICENSE: ' + (WHY[r.why] || r.why) + (r.file ? ' (' + r.file + ')' : ''));
    process.exit(EXIT);
  }
  current = r.lic;
  if (!enforce.timer) {
    enforce.timer = setInterval(() => { binCache = null; enforce(); }, (4 + Math.random() * 4) * 3600e3);
    enforce.timer.unref();
  }
}

/** The user limit of the license (0 = unlimited). */
const userLimit = () => (PACKAGED && current ? +current.users || 0 : 0);
const info = () => (PACKAGED ? (current ? { app: current.app, id: current.id, ip: current.ip, users: +current.users || 0, exp: current.exp || 0, iat: current.iat || 0 } : null) : null);

/** `sepan-server license request|activate|status` (used by the installer, as root). */
function cli(args) {
  const [sub, ...rest] = args;
  const opt = (k) => { const i = rest.indexOf('--' + k); return i >= 0 ? rest[i + 1] || '' : ''; };
  if (sub === 'request') { console.log(requestCode({ ip: opt('ip'), app: opt('app'), id: opt('id') })); return 0; }
  if (sub === 'activate') {
    const code = opt('code') || fs.readFileSync(0, 'utf8');
    const r = verify(code, { ip: opt('ip') });
    if (!r.ok) { console.error('NOT ACCEPTED: ' + (WHY[r.why] || r.why)); return 2; }
    const f = opt('out') || licenseFile();
    fs.writeFileSync(f, String(code).trim() + '\n', { mode: 0o644 });
    console.log('OK ' + JSON.stringify({ app: r.lic.app, ip: r.lic.ip, users: r.lic.users || 0, exp: r.lic.exp ? new Date(r.lic.exp).toISOString().slice(0, 10) : 'none' }));
    return 0;
  }
  if (sub === 'status') {
    const r = check();
    console.log(r.ok ? 'OK ' + JSON.stringify(r.lic) : 'INVALID: ' + (WHY[r.why] || r.why));
    return r.ok ? 0 : 2;
  }
  if (sub === 'hwid') { console.log(hardwareId()); return 0; }
  console.error('usage: license request --ip IP --app NAME --id ID | activate --code CODE [--ip IP] | status | hwid');
  return 1;
}

module.exports = { PACKAGED, VERSION, enforce, check, verify, requestCode, hardwareId, userLimit, info, cli };
