// A small valid lossless WebP made with the web app's own encoder (server/src/web/webp.mjs).
import { encodeWebp } from '../../server/src/web/webp.mjs';

export function webpFile(w, h) {
  const rgba = new Uint8ClampedArray(w * h * 4).fill(200);
  return Buffer.from(encodeWebp(rgba, w, h));
}
