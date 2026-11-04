'use strict';
// Reads versionCode and versionName from an APK (a zip with a binary AndroidManifest.xml), so the app can
// offer an update when the admin uploads a newer APK in the panel. No npm packages: a tiny zip reader + AXML.
const fs = require('fs');
const zlib = require('zlib');

function manifestBytes(buf) {
  // end of central directory: the last 22..65557 bytes
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('not_a_zip');
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  for (let n = 0; n < count; n++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error('bad_zip');
    const method = buf.readUInt16LE(p + 10);
    const csize = buf.readUInt32LE(p + 20);
    const nlen = buf.readUInt16LE(p + 28), elen = buf.readUInt16LE(p + 30), clen = buf.readUInt16LE(p + 32);
    const local = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nlen);
    if (name === 'AndroidManifest.xml') {
      if (buf.readUInt32LE(local) !== 0x04034b50) throw new Error('bad_zip');
      const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
      const data = buf.subarray(start, start + csize);
      if (method === 0) return data;
      if (method === 8) return zlib.inflateRawSync(data);
      throw new Error('bad_method');
    }
    p += 46 + nlen + elen + clen;
  }
  throw new Error('no_manifest');
}

function readStringPool(b, off) {
  const count = b.readUInt32LE(off + 8);
  const flags = b.readUInt32LE(off + 16);
  const strStart = off + b.readUInt32LE(off + 20);
  const utf8 = (flags & 0x100) !== 0;
  const out = [];
  for (let i = 0; i < count; i++) {
    let s = strStart + b.readUInt32LE(off + 28 + i * 4);
    if (utf8) {
      s += (b[s] & 0x80) ? 2 : 1; // utf16 length
      let len = b[s]; s++;
      if (len & 0x80) { len = ((len & 0x7f) << 8) | b[s]; s++; }
      out.push(b.toString('utf8', s, s + len));
    } else {
      let len = b.readUInt16LE(s); s += 2;
      if (len & 0x8000) { len = ((len & 0x7fff) << 16) | b.readUInt16LE(s); s += 2; }
      out.push(b.toString('utf16le', s, s + len * 2));
    }
  }
  return out;
}

const ATTR_VERSION_CODE = 0x0101021b, ATTR_VERSION_NAME = 0x0101021c;

/** { code, name } from the APK bytes; throws on anything that is not a readable APK. */
function parseApk(buf) {
  const b = manifestBytes(buf);
  if (b.readUInt16LE(0) !== 0x0003) throw new Error('bad_axml');
  let strings = [], resIds = [];
  let p = b.readUInt16LE(2);
  while (p + 8 <= b.length) {
    const type = b.readUInt16LE(p), hsize = b.readUInt16LE(p + 2), size = b.readUInt32LE(p + 4);
    if (size < 8) break;
    if (type === 0x0001) strings = readStringPool(b, p);
    else if (type === 0x0180) { for (let i = p + 8; i < p + size; i += 4) resIds.push(b.readUInt32LE(i)); }
    else if (type === 0x0102) { // first start tag = <manifest>
      const ext = p + hsize;
      const attrStart = b.readUInt16LE(ext + 8), attrSize = b.readUInt16LE(ext + 10), attrCount = b.readUInt16LE(ext + 12);
      let code = null, name = null;
      for (let i = 0; i < attrCount; i++) {
        const a = ext + attrStart + i * attrSize;
        const nameIdx = b.readUInt32LE(a + 4), raw = b.readInt32LE(a + 8);
        const dtype = b[a + 15], data = b.readUInt32LE(a + 16);
        const id = resIds[nameIdx], an = strings[nameIdx];
        if (id === ATTR_VERSION_CODE || an === 'versionCode') code = dtype === 0x03 ? Number(strings[data]) : data;
        if (id === ATTR_VERSION_NAME || an === 'versionName') name = dtype === 0x03 ? strings[data] : (raw >= 0 ? strings[raw] : String(data));
      }
      if (!Number.isInteger(code)) throw new Error('no_version');
      return { code, name: name || String(code) };
    }
    p += size;
  }
  throw new Error('no_manifest_tag');
}

let cache = { key: '', info: null };
/** version of the APK file on disk, cached by size and mtime; null when there is none or it cannot be read */
function apkVersion(file) {
  try {
    const st = fs.statSync(file);
    const key = st.size + ':' + st.mtimeMs;
    if (cache.key !== key) cache = { key, info: (() => { try { return parseApk(fs.readFileSync(file)); } catch { return null; } })() };
    return cache.info;
  } catch { return null; }
}

module.exports = { parseApk, apkVersion };
