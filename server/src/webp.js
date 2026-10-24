'use strict';
/**
 * Validates a WebP avatar (max 512x512, not animated) and rebuilds the container
 * WITHOUT any metadata chunks (EXIF / XMP / ICC). Returns a Buffer or null if invalid.
 */
function sanitizeWebp(buf, maxDim = 512) {
  if (buf.length < 30 || buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WEBP') return null;
  const end = buf.readUInt32LE(4) + 8;
  if (end > buf.length || end < 20) return null;
  let pos = 12, w = 0, h = 0, hasImage = false;
  const kept = [];
  while (pos + 8 <= end) {
    const fourcc = buf.toString('ascii', pos, pos + 4);
    const size = buf.readUInt32LE(pos + 4);
    const ds = pos + 8;
    if (ds + size > end) return null;
    let data = buf.subarray(ds, ds + size);
    if (fourcc === 'VP8X') {
      if (size < 10) return null;
      if (data[0] & 0x02) return null; // animated
      w = Math.max(w, 1 + data.readUIntLE(4, 3));
      h = Math.max(h, 1 + data.readUIntLE(7, 3));
      data = Buffer.from(data);
      data[0] &= ~0x2c; // clear ICC, EXIF, XMP flags
      kept.push([fourcc, data]);
    } else if (fourcc === 'VP8 ') {
      if (size < 10 || data[3] !== 0x9d || data[4] !== 0x01 || data[5] !== 0x2a) return null;
      w = Math.max(w, data.readUInt16LE(6) & 0x3fff);
      h = Math.max(h, data.readUInt16LE(8) & 0x3fff);
      hasImage = true;
      kept.push([fourcc, data]);
    } else if (fourcc === 'VP8L') {
      if (size < 5 || data[0] !== 0x2f) return null;
      const b = data.readUInt32LE(1);
      w = Math.max(w, (b & 0x3fff) + 1);
      h = Math.max(h, ((b >>> 14) & 0x3fff) + 1);
      hasImage = true;
      kept.push([fourcc, data]);
    } else if (fourcc === 'ALPH') {
      kept.push([fourcc, data]);
    } else if (fourcc === 'ANIM' || fourcc === 'ANMF') {
      return null;
    } // EXIF, XMP , ICCP and unknown chunks are dropped
    pos += 8 + size + (size & 1);
  }
  if (!hasImage || w < 1 || h < 1 || w > maxDim || h > maxDim) return null;
  const parts = [];
  for (const [fourcc, data] of kept) {
    const head = Buffer.alloc(8);
    head.write(fourcc, 0, 'ascii');
    head.writeUInt32LE(data.length, 4);
    parts.push(head, data);
    if (data.length & 1) parts.push(Buffer.alloc(1));
  }
  const body = Buffer.concat(parts);
  const out = Buffer.alloc(12);
  out.write('RIFF', 0, 'ascii');
  out.writeUInt32LE(body.length + 4, 4);
  out.write('WEBP', 8, 'ascii');
  return Buffer.concat([out, body]);
}
module.exports = { sanitizeWebp };
