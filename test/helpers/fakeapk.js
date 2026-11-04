'use strict';
// A minimal APK for tests: a zip holding a binary AndroidManifest.xml with versionCode / versionName.
const zlib = require('node:zlib');

function axml(code, name) {
  const strings = ['versionCode', 'versionName', 'manifest', name];
  const strBufs = strings.map((s) => { const b = Buffer.alloc(2 + s.length * 2 + 2); b.writeUInt16LE(s.length, 0); b.write(s, 2, 'utf16le'); return b; });
  let data = Buffer.concat(strBufs);
  if (data.length % 4) data = Buffer.concat([data, Buffer.alloc(4 - (data.length % 4))]);
  const offs = Buffer.alloc(4 * strings.length);
  let o = 0; strBufs.forEach((b, i) => { offs.writeUInt32LE(o, i * 4); o += b.length; });
  const spHead = Buffer.alloc(28);
  const spSize = 28 + offs.length + data.length;
  spHead.writeUInt16LE(0x0001, 0); spHead.writeUInt16LE(28, 2); spHead.writeUInt32LE(spSize, 4);
  spHead.writeUInt32LE(strings.length, 8); spHead.writeUInt32LE(0, 12); spHead.writeUInt32LE(0, 16);
  spHead.writeUInt32LE(28 + offs.length, 20); spHead.writeUInt32LE(0, 24);
  const rm = Buffer.alloc(16); rm.writeUInt16LE(0x0180, 0); rm.writeUInt16LE(8, 2); rm.writeUInt32LE(16, 4);
  rm.writeUInt32LE(0x0101021b, 8); rm.writeUInt32LE(0x0101021c, 12);
  const el = Buffer.alloc(16 + 20 + 2 * 20);
  el.writeUInt16LE(0x0102, 0); el.writeUInt16LE(16, 2); el.writeUInt32LE(el.length, 4); el.writeUInt32LE(1, 8); el.writeInt32LE(-1, 12);
  el.writeInt32LE(-1, 16); el.writeUInt32LE(2, 20); el.writeUInt16LE(20, 24); el.writeUInt16LE(20, 26); el.writeUInt16LE(2, 28);
  const attr = (at, nameIdx, raw, type, val) => { el.writeInt32LE(-1, at); el.writeUInt32LE(nameIdx, at + 4); el.writeInt32LE(raw, at + 8); el.writeUInt16LE(8, at + 12); el[at + 15] = type; el.writeUInt32LE(val, at + 16); };
  attr(36, 0, -1, 0x10, code);
  attr(56, 1, 3, 0x03, 3);
  const body = Buffer.concat([spHead, offs, data, rm, el]);
  const head = Buffer.alloc(8); head.writeUInt16LE(0x0003, 0); head.writeUInt16LE(8, 2); head.writeUInt32LE(8 + body.length, 4);
  return Buffer.concat([head, body]);
}

function zip(files) {
  const locals = [], centrals = []; let off = 0;
  for (const [name, content] of files) {
    const comp = zlib.deflateRawSync(content), nb = Buffer.from(name);
    const l = Buffer.alloc(30); l.writeUInt32LE(0x04034b50, 0); l.writeUInt16LE(20, 4); l.writeUInt16LE(8, 8);
    l.writeUInt32LE(comp.length, 18); l.writeUInt32LE(content.length, 22); l.writeUInt16LE(nb.length, 26);
    const c = Buffer.alloc(46); c.writeUInt32LE(0x02014b50, 0); c.writeUInt16LE(20, 6); c.writeUInt16LE(8, 10);
    c.writeUInt32LE(comp.length, 20); c.writeUInt32LE(content.length, 24); c.writeUInt16LE(nb.length, 28); c.writeUInt32LE(off, 42);
    locals.push(l, nb, comp); centrals.push(c, nb); off += 30 + nb.length + comp.length;
  }
  const cd = Buffer.concat(centrals);
  const e = Buffer.alloc(22); e.writeUInt32LE(0x06054b50, 0); e.writeUInt16LE(files.length, 8); e.writeUInt16LE(files.length, 10);
  e.writeUInt32LE(cd.length, 12); e.writeUInt32LE(off, 16);
  return Buffer.concat([...locals, cd, e]);
}

/** an APK-like zip, padded past the panel's 1 KB minimum */
const fakeApk = (code, name) => zip([['classes.dex', Buffer.alloc(4000, 1)], ['AndroidManifest.xml', axml(code, name)]]);
module.exports = { fakeApk };
