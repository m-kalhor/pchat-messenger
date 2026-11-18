// Builds the packaged Sepan server (1.25): one obfuscated executable + the web files it checks, the installer,
// in dist/sepan-server-<version>.tar.gz. Linux x64, Node.js 22 (the Node running this script is the one packed in).
//   node tools/package/build.mjs [--pubkey FILE] [--out DIR] [--name NAME] [--no-obfuscate]
// --pubkey: the owner's public key (base64, 32 bytes; default tools/license/public-key.txt).
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..', '..');
const require = createRequire(import.meta.url);
const esbuild = require('esbuild');
const Obf = require('javascript-obfuscator');

const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf('--' + k); return i >= 0 ? args[i + 1] : d; };
const SRC = path.join(root, 'server', 'src');
const VERSION = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version;
const OUT = path.resolve(opt('out', path.join(root, 'dist')));
const NAME = opt('name', 'sepan-server-' + VERSION);
const BUILD = path.join(root, 'build', NAME);

const pubFile = opt('pubkey', path.join(root, 'tools', 'license', 'public-key.txt'));
if (!fs.existsSync(pubFile)) { console.error('Public key not found: ' + pubFile + ' (run sepan-license keygen on the owner\'s computer)'); process.exit(2); }
const pub = Buffer.from(fs.readFileSync(pubFile, 'utf8').trim(), 'base64');
if (pub.length !== 32) { console.error('The public key must be 32 bytes in base64'); process.exit(2); }

fs.rmSync(BUILD, { recursive: true, force: true });
const PKG = path.join(BUILD, NAME);
const APP = path.join(PKG, 'app');
fs.mkdirSync(APP, { recursive: true });

// ---- files served next to the executable (copied, then their hashes go into the executable) ----
const ASSETS = ['admin.html', 'release-notes.json', 'web', 'stickers-default'];
for (const a of ASSETS) fs.cpSync(path.join(SRC, a), path.join(APP, a), { recursive: true });
const hashes = {};
(function walk(dir) {
  for (const n of fs.readdirSync(dir).sort()) {
    const fp = path.join(dir, n);
    if (fs.statSync(fp).isDirectory()) walk(fp);
    else hashes[path.relative(APP, fp).split(path.sep).join('/')] = crypto.createHash('sha256').update(fs.readFileSync(fp)).digest('hex');
  }
})(APP);

// ---- the public key, twice, each XOR-masked differently (license.js and core.js decode their own copy) ----
const m1 = [...crypto.randomBytes(16)], m2 = [...crypto.randomBytes(13)];
const k1 = [...pub].map((b, i) => b ^ m1[i % m1.length]);
const k2 = [...pub].map((b, i) => b ^ m2[(i * 7 + 3) % m2.length]);

// ---- one bundle, then obfuscated ----
const bundle = path.join(BUILD, 'bundle.js');
await esbuild.build({
  entryPoints: [path.join(SRC, 'main.js')], bundle: true, platform: 'node', target: 'node22', format: 'cjs', outfile: bundle,
  minify: true, legalComments: 'none', logLevel: 'warning',
  define: {
    __SEPAN_PACKAGED__: 'true', __SEPAN_VERSION__: JSON.stringify(VERSION), __SEPAN_ASSETS__: JSON.stringify(hashes),
    __SEPAN_K1__: JSON.stringify(k1), __SEPAN_M1__: JSON.stringify(m1), __SEPAN_K2__: JSON.stringify(k2), __SEPAN_M2__: JSON.stringify(m2),
  },
});
let code = fs.readFileSync(bundle, 'utf8');
if (!args.includes('--no-obfuscate')) {
  code = Obf.obfuscate(code, {
    target: 'node', seed: crypto.randomInt(1e9), compact: true, simplify: true,
    controlFlowFlattening: true, controlFlowFlatteningThreshold: 0.15,
    deadCodeInjection: false, stringArray: true, stringArrayEncoding: ['base64'], stringArrayThreshold: 0.75,
    stringArrayRotate: true, stringArrayShuffle: true, stringArrayWrappersCount: 2, stringArrayWrappersType: 'function',
    splitStrings: false, identifierNamesGenerator: 'hexadecimal', renameGlobals: false, selfDefending: false,
    numbersToExpressions: true, transformObjectKeys: false, unicodeEscapeSequence: false, log: false,
  }).getObfuscatedCode();
}
fs.writeFileSync(bundle, code);

// ---- Node single executable application ----
const seaCfg = path.join(BUILD, 'sea.json');
const blob = path.join(BUILD, 'sea.blob');
fs.writeFileSync(seaCfg, JSON.stringify({ main: bundle, output: blob, disableExperimentalSEAWarning: true, useSnapshot: false, useCodeCache: false }));
execFileSync(process.execPath, ['--experimental-sea-config', seaCfg], { stdio: 'inherit' });
const exe = path.join(APP, 'sepan-server');
fs.copyFileSync(process.execPath, exe);
fs.chmodSync(exe, 0o755);
execFileSync(process.execPath, [require.resolve('postject/dist/cli.js'), exe, 'NODE_SEA_BLOB', blob,
  '--sentinel-fuse', 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2'], { stdio: 'inherit' });

// ---- installer + helpers ----
fs.copyFileSync(path.join(root, 'deploy', 'installer', 'sepan-setup.sh'), path.join(PKG, 'sepan-setup.sh'));
fs.copyFileSync(path.join(root, 'server', 'domain.sh'), path.join(PKG, 'domain.sh'));
fs.chmodSync(path.join(PKG, 'sepan-setup.sh'), 0o755);
fs.writeFileSync(path.join(PKG, 'VERSION'), VERSION + '\n');
fs.writeFileSync(path.join(PKG, 'README.txt'),
  `Sepan server ${VERSION} - installer for a new Ubuntu 22.04 / 24.04 server (x86_64)\n\n` +
  `  tar xzf ${NAME}.tar.gz && sudo bash ${NAME}/sepan-setup.sh\n\n` +
  'The installer asks for the settings, shows a request code for the owner\'s approval and sets everything up.\n');

fs.mkdirSync(OUT, { recursive: true });
const tgz = path.join(OUT, NAME + '.tar.gz');
execFileSync('tar', ['czf', tgz, '-C', BUILD, NAME]);
const sha = crypto.createHash('sha256').update(fs.readFileSync(exe)).digest('hex');
console.log(`built ${tgz} (${(fs.statSync(tgz).size / 1048576).toFixed(1)} MB)\nexecutable sha256 ${sha}\napp dir ${APP}`);
