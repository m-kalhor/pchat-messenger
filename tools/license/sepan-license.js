#!/usr/bin/env node
'use strict';
/**
 * Sepan install approval tool (1.25). Runs ONLY on the owner's own computer, next to the private key.
 *
 *   sepan-license keygen                 makes the key pair once: sepan-license.key (PRIVATE, keep + back up)
 *                                        and prints the public key for tools/license/public-key.txt
 *   sepan-license sign                   asks for a request code (shown by the server installer) and prints
 *                                        the activation code (copied to the clipboard on Windows)
 *   sepan-license sign --request SR1... [--users N] [--days N] [--yes]
 *   sepan-license pubkey                 prints the public key again
 *
 * Built into a Windows program (sepan-license.exe) by the "Package" GitHub workflow; Node.js is not needed.
 * Every activation code is logged in licenses-issued.csv next to the key.
 */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const readline = require('node:readline');

const isSea = (() => { try { return require('node:sea').isSea(); } catch { return false; } })();
const HOME = process.env.SEPAN_LICENSE_DIR || (isSea ? path.dirname(process.execPath) : process.cwd());
const KEY = path.join(HOME, 'sepan-license.key');
const LOG = path.join(HOME, 'licenses-issued.csv');

const args = process.argv.slice(2);
const sub = args[0];
const opt = (k) => { const i = args.indexOf('--' + k); return i >= 0 ? args[i + 1] || '' : ''; };
const flag = (k) => args.includes('--' + k);

function ask(q) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((r) => rl.question(q, (a) => { rl.close(); r(a.trim()); }));
}
function pause() { if (isSea && !flag('yes')) return ask('\nPress Enter to close...'); }

function rawPub(priv) {
  const der = crypto.createPublicKey(priv).export({ format: 'der', type: 'spki' });
  return der.subarray(der.length - 32).toString('base64');
}
function loadKey() {
  if (!fs.existsSync(KEY)) { console.error('Private key not found: ' + KEY + '\nRun "keygen" first (once), or put sepan-license.key next to this program.'); process.exit(1); }
  return crypto.createPrivateKey(fs.readFileSync(KEY));
}

async function main() {
  if (sub === 'keygen') {
    if (fs.existsSync(KEY)) { console.error('A key already exists: ' + KEY + '\nNot overwritten (every server activated with it would stop at its next update).'); return 1; }
    const { privateKey } = crypto.generateKeyPairSync('ed25519');
    fs.writeFileSync(KEY, privateKey.export({ format: 'pem', type: 'pkcs8' }), { mode: 0o600 });
    console.log('Private key saved: ' + KEY);
    console.log('KEEP IT SECRET and make a backup copy (USB stick). Without it no new server can be activated.\n');
    console.log('Public key (goes into the repository, tools/license/public-key.txt):');
    console.log(rawPub(privateKey));
    return 0;
  }
  if (sub === 'pubkey') { console.log(rawPub(loadKey())); return 0; }
  if (sub === 'sign') {
    const priv = loadKey();
    let req = opt('request') || await ask('Paste the request code from the server (starts with SR1.):\n> ');
    req = req.replace(/\s+/g, '');
    if (!req.startsWith('SR1.')) { console.error('This is not a request code.'); return 1; }
    let r;
    try { r = JSON.parse(Buffer.from(req.slice(4), 'base64url').toString('utf8')); } catch { console.error('The request code is damaged (copy it again).'); return 1; }
    if (!r.hw || !r.bin) { console.error('The request code is incomplete.'); return 1; }
    console.log('\nServer address : ' + r.ip);
    console.log('App id         : ' + (r.id || '-'));
    console.log('Program version: ' + r.ver + '  (' + String(r.bin).slice(0, 12) + ')');
    console.log('Machine        : ' + String(r.hw).slice(0, 12));
    console.log('Requested at   : ' + new Date(r.t || 0).toISOString().replace('T', ' ').slice(0, 16) + ' UTC');
    const usersIn = opt('users') || (flag('yes') ? '' : await ask('\nMaximum number of users (Enter = unlimited): '));
    const daysIn = opt('days') || (flag('yes') ? '' : await ask('Valid for how many days (Enter = no expiry): '));
    const users = Math.max(0, parseInt(usersIn, 10) || 0);
    const days = Math.max(0, parseInt(daysIn, 10) || 0);
    if (!flag('yes')) {
      const ok = await ask(`\nApprove this server (${r.ip}, users ${users || 'unlimited'}, ${days ? days + ' days' : 'no expiry'})? [y/N] `);
      if (!/^y(es)?$/i.test(ok)) { console.log('Not approved.'); return 1; }
    }
    const lic = { v: 1, hw: r.hw, bin: r.bin, ip: r.ip || '', app: r.app || '', id: r.id || '', ver: r.ver || '', users, exp: days ? Date.now() + days * 86400e3 : 0, iat: Date.now() };
    const head = 'SA1.' + Buffer.from(JSON.stringify(lic)).toString('base64url');
    const code = head + '.' + crypto.sign(null, Buffer.from(head), priv).toString('base64url');
    console.log('\nActivation code (paste it into the installer on the server):\n');
    console.log(code + '\n');
    try { fs.appendFileSync(LOG, [new Date().toISOString(), r.ip, r.id || '', r.ver, users, lic.exp ? new Date(lic.exp).toISOString().slice(0, 10) : '', String(r.hw).slice(0, 12)].join(',') + '\n'); } catch { }
    if (process.platform === 'win32') {
      try { require('node:child_process').execSync('clip', { input: code }); console.log('(It is also copied to the clipboard.)'); } catch { }
    }
    return 0;
  }
  console.log('usage: sepan-license keygen | sign [--request CODE --users N --days N --yes] | pubkey');
  return sub ? 1 : 0;
}

main().then(async (c) => { await pause(); process.exit(c || 0); }, async (e) => { console.error(e.message); await pause(); process.exit(1); });
