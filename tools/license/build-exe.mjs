// Builds sepan-license.exe (Windows x64) from sepan-license.js as a Node single executable, with the same
// Node version as the one running this script. Output: dist/sepan-license-win/ (exe + the two .bat files).
//   node tools/license/build-exe.mjs [--out DIR]
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..', '..');
const require = createRequire(path.join(root, 'tools', 'package', 'package.json'));
const args = process.argv.slice(2);
const i = args.indexOf('--out');
const OUT = path.resolve(i >= 0 ? args[i + 1] : path.join(root, 'dist', 'sepan-license-win'));
const TMP = path.join(root, 'build', 'license-exe');
fs.rmSync(TMP, { recursive: true, force: true });
fs.mkdirSync(TMP, { recursive: true });
fs.mkdirSync(OUT, { recursive: true });

const v = process.version;
const zip = path.join(TMP, 'node.zip');
const url = `https://nodejs.org/dist/${v}/node-${v}-win-x64.zip`;
console.log('downloading ' + url);
const r = await fetch(url);
if (!r.ok) throw new Error('download failed: ' + r.status);
fs.writeFileSync(zip, Buffer.from(await r.arrayBuffer()));
execFileSync('unzip', ['-q', '-j', zip, `node-${v}-win-x64/node.exe`, '-d', TMP]);

const cfg = path.join(TMP, 'sea.json');
const blob = path.join(TMP, 'sea.blob');
fs.writeFileSync(cfg, JSON.stringify({ main: path.join(here, 'sepan-license.js'), output: blob, disableExperimentalSEAWarning: true, useSnapshot: false, useCodeCache: false }));
execFileSync(process.execPath, ['--experimental-sea-config', cfg], { stdio: 'inherit' });
const exe = path.join(OUT, 'sepan-license.exe');
// node.exe is signed by the Node.js project; the signature would no longer match after the injection, so it is
// removed first (osslsigncode, apt package) when available, as the Node docs advise for signtool on Windows
try {
  execFileSync('osslsigncode', ['remove-signature', '-in', path.join(TMP, 'node.exe'), '-out', exe], { stdio: 'inherit' });
} catch {
  console.warn('osslsigncode not found: keeping the (now invalid) Node.js signature');
  fs.copyFileSync(path.join(TMP, 'node.exe'), exe);
}
execFileSync(process.execPath, [require.resolve('postject/dist/cli.js'), exe, 'NODE_SEA_BLOB', blob,
  '--sentinel-fuse', 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2'], { stdio: 'inherit' });
for (const b of ['make-key.bat', 'activate.bat']) fs.copyFileSync(path.join(here, b), path.join(OUT, b));
fs.writeFileSync(path.join(OUT, 'README.txt'),
  'Sepan install approval (runs only on the owner\'s computer)\r\n\r\n' +
  '1. Once: double-click make-key.bat. It makes sepan-license.key here (PRIVATE: keep it, back it up, never send it)\r\n' +
  '   and shows the public key, which goes into the repository (tools/license/public-key.txt).\r\n' +
  '2. For each new server: double-click activate.bat, paste the request code the server installer shows,\r\n' +
  '   answer the questions and paste the activation code back into the installer.\r\n');
console.log('built ' + exe);
