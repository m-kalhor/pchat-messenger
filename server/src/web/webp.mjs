// Minimal lossless WebP (VP8L) encoder for profile photos. Safari cannot encode WebP from a canvas,
// and the server only accepts WebP avatars, so the web app writes the file itself.
// Every colour channel uses a fixed 8-bit prefix code and alpha is a single-symbol code (opaque),
// so the output is 3 bytes per pixel plus a small header: a 320x320 photo is about 300 KB.

class BitWriter {
  constructor(size) { this.buf = new Uint8Array(size); this.pos = 0; this.acc = 0; this.n = 0; }
  bits(v, n) { // LSB first, n <= 24
    this.acc |= v << this.n; this.n += n;
    while (this.n >= 8) { this.buf[this.pos++] = this.acc & 0xff; this.acc >>>= 8; this.n -= 8; }
  }
  done() { if (this.n > 0) this.buf[this.pos++] = this.acc & 0xff; return this.buf.subarray(0, this.pos); }
}

const REV = new Uint8Array(256);
for (let i = 0; i < 256; i++) { let r = 0; for (let b = 0; b < 8; b++) if (i & (1 << b)) r |= 1 << (7 - b); REV[i] = r; }

/** Normal prefix code where symbols 0..255 have length 8 and the rest of the alphabet length 0. */
function flat8(w, alphabet) {
  w.bits(0, 1);              // normal (not simple) code
  w.bits(12 - 4, 4);         // 12 code-length-code lengths, in kCodeLengthCodeOrder {17,18,0,1,2,3,4,5,16,6,7,8}
  for (let i = 0; i < 12; i++) w.bits(i === 2 || i === 11 ? 1 : 0, 3); // symbols "0" and "8" get 1-bit codes: 0 -> 0, 8 -> 1
  w.bits(0, 1);              // max_symbol = alphabet size
  for (let s = 0; s < alphabet; s++) w.bits(s < 256 ? 1 : 0, 1);
}
/** Simple prefix code with one 8-bit symbol (costs no bits per pixel). */
function single(w, sym) { w.bits(1, 1); w.bits(0, 1); w.bits(1, 1); w.bits(sym, 8); }

/** rgba: Uint8ClampedArray from getImageData (alpha is ignored: the photo is opaque). Returns the .webp bytes. */
export function encodeWebp(rgba, width, height) {
  const w = new BitWriter(width * height * 3 + 1024);
  w.bits(0x2f, 8);
  w.bits(width - 1, 14); w.bits(height - 1, 14);
  w.bits(0, 1);              // alpha_is_used
  w.bits(0, 3);              // version
  w.bits(0, 1);              // no transforms
  w.bits(0, 1);              // no colour cache
  w.bits(0, 1);              // no meta prefix codes
  flat8(w, 256 + 24);        // green + length prefixes
  flat8(w, 256);             // red
  flat8(w, 256);             // blue
  single(w, 255);            // alpha
  w.bits(1, 1); w.bits(0, 1); w.bits(0, 1); w.bits(0, 1); // distance: single symbol 0 (unused)
  for (let i = 0; i < width * height * 4; i += 4) {
    w.bits(REV[rgba[i + 1]], 8); w.bits(REV[rgba[i]], 8); w.bits(REV[rgba[i + 2]], 8);
  }
  const data = w.done();
  const pad = data.length & 1;
  const out = new Uint8Array(20 + data.length + pad);
  const dv = new DataView(out.buffer);
  out.set([0x52, 0x49, 0x46, 0x46], 0); dv.setUint32(4, 12 + data.length + pad, true);
  out.set([0x57, 0x45, 0x42, 0x50, 0x56, 0x50, 0x38, 0x4c], 8); dv.setUint32(16, data.length, true);
  out.set(data, 20);
  return out;
}
