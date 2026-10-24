// WebCrypto port of android/app/src/main/java/com/pchat/app/Crypto.kt (same algorithms, same byte layout):
//  - identity key: EC P-256 (public key as base64 X.509/SPKI DER, like Java's PublicKey.encoded)
//  - per message: random AES-256 key K encrypts the content (AES-GCM, 12-byte IV prefix, 16-byte tag suffix)
//  - K is wrapped for every recipient with a key from ECDH(sender, recipient) + HKDF-SHA256
//  - files (v2): 1 MiB chunks, nonce = 8-byte prefix + 4-byte big-endian index, AAD "fc|i|last"
// test/web.test.js checks this file against test/helpers/pchat-crypto.js (the Node port used by the server tests).
const subtle = globalThis.crypto.subtle;
const te = new TextEncoder();
const EC = { name: 'ECDH', namedCurve: 'P-256' };

export const FILE_CHUNK = 1 << 20;
export const TAG = 16;
export const CIPHER_CHUNK = FILE_CHUNK + TAG;

export function b64(u8) {
  u8 = u8 instanceof Uint8Array ? u8 : new Uint8Array(u8);
  let s = '';
  for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000));
  return btoa(s);
}
export function unb64(s) {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
export const randomBytes = (n) => globalThis.crypto.getRandomValues(new Uint8Array(n));

/**
 * New identity. The private key is extractable only so that it can later be moved to a new web
 * address (for example when the server gets a domain); it is stored as a CryptoKey in IndexedDB.
 */
export async function newIdentity() {
  const kp = await subtle.generateKey(EC, true, ['deriveBits']);
  return { priv: kp.privateKey, pubB64: b64(await subtle.exportKey('spki', kp.publicKey)) };
}

export async function fingerprint(pubB64) {
  const h = new Uint8Array(await subtle.digest('SHA-256', unb64(pubB64)));
  return [...h.subarray(0, 16)].map((x) => x.toString(16).padStart(2, '0')).join('').toUpperCase().match(/.{4}/g).join(' ');
}

const pairCache = new Map();
/** AES key shared by a and b: HKDF-SHA256(ECDH, salt = 32 zero bytes, info = "pchat-v1|" + sorted names). */
export async function pairKey(my, otherPub, a, b) {
  const ck = my.pubB64 + '|' + otherPub + '|' + [a, b].sort().join('|');
  const hit = pairCache.get(ck);
  if (hit) return hit;
  const p = (async () => {
    const pub = await subtle.importKey('spki', unb64(otherPub), EC, false, []);
    const bits = await subtle.deriveBits({ name: 'ECDH', public: pub }, my.priv, 256);
    const ikm = await subtle.importKey('raw', bits, 'HKDF', false, ['deriveKey']);
    return subtle.deriveKey(
      { name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(32), info: te.encode('pchat-v1|' + [a, b].sort().join('|')) },
      ikm, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
  })();
  pairCache.set(ck, p);
  p.catch(() => pairCache.delete(ck));
  return p;
}

const aesKey = (raw, usage) => subtle.importKey('raw', raw, { name: 'AES-GCM' }, false, usage);

async function seal(key, plain, aad) {
  const iv = randomBytes(12);
  const ct = new Uint8Array(await subtle.encrypt({ name: 'AES-GCM', iv, additionalData: aad, tagLength: 128 }, key, plain));
  const out = new Uint8Array(12 + ct.length);
  out.set(iv); out.set(ct, 12);
  return out;
}
async function open(key, blob, aad) {
  return new Uint8Array(await subtle.decrypt({ name: 'AES-GCM', iv: blob.subarray(0, 12), additionalData: aad, tagLength: 128 }, key, blob.subarray(12)));
}

/** recipients: { username: pubB64 } (the sender itself is added). Returns the JSON payload string. */
export async function encryptFor(my, me, target, recipients, plain) {
  const aad = te.encode(`${me}|${target}`);
  const raw = randomBytes(32);
  const k = await aesKey(raw, ['encrypt']);
  const keys = {};
  const all = { ...recipients, [me]: my.pubB64 };
  for (const [u, pub] of Object.entries(all)) {
    const sk = u === me ? await pairKey(my, my.pubB64, me, me) : await pairKey(my, pub, me, u);
    keys[u] = b64(await seal(sk, raw, aad));
  }
  const body = typeof plain === 'string' ? te.encode(plain) : plain;
  return JSON.stringify({ v: 1, c: b64(await seal(k, body, aad)), k: keys });
}

/** Returns the plaintext bytes; throws if the message is not addressed to `me` or was tampered with. */
export async function decryptFrom(my, me, sender, target, senderPub, payload) {
  const o = JSON.parse(payload);
  const wrapped = o.k && o.k[me];
  if (!wrapped) throw new Error('not addressed to me');
  const aad = te.encode(`${sender}|${target}`);
  if (sender !== me && !senderPub) throw new Error('no sender key');
  const sk = sender === me ? await pairKey(my, my.pubB64, me, me) : await pairKey(my, senderPub, sender, me);
  const k = await aesKey(await open(sk, unb64(wrapped), aad), ['decrypt']);
  return open(k, unb64(o.c), aad);
}

// ---------------- files ----------------
export const chunkCount = (plain) => (plain <= 0 ? 1 : Math.ceil(plain / FILE_CHUNK));
export const cipherSize = (plain) => plain + TAG * chunkCount(plain);
/** v2 file key: base64(key) + "." + base64(8-byte nonce prefix). Legacy keys have no dot. */
export const newFileKey = () => b64(randomBytes(32)) + '.' + b64(randomBytes(8));
export const isChunked = (fkey) => fkey.includes('.');

const fileKeys = new Map();
function chunkKey(fkey) {
  let k = fileKeys.get(fkey);
  if (!k) {
    const [kb, np] = fkey.split('.');
    k = aesKey(unb64(kb), ['encrypt', 'decrypt']).then((key) => ({ key, prefix: unb64(np) }));
    fileKeys.set(fkey, k);
    if (fileKeys.size > 64) fileKeys.delete(fileKeys.keys().next().value);
  }
  return k;
}
function chunkNonce(prefix, index) {
  const n = new Uint8Array(12);
  n.set(prefix.subarray(0, 8));
  new DataView(n.buffer).setUint32(8, index >>> 0);
  return n;
}
const chunkAad = (index, last) => te.encode(`fc|${index}|${last ? 1 : 0}`);

export async function sealChunk(fkey, index, last, buf) {
  const { key, prefix } = await chunkKey(fkey);
  return new Uint8Array(await subtle.encrypt({ name: 'AES-GCM', iv: chunkNonce(prefix, index), additionalData: chunkAad(index, last), tagLength: 128 }, key, buf));
}
export async function openChunk(fkey, index, last, buf) {
  const { key, prefix } = await chunkKey(fkey);
  return new Uint8Array(await subtle.decrypt({ name: 'AES-GCM', iv: chunkNonce(prefix, index), additionalData: chunkAad(index, last), tagLength: 128 }, key, buf));
}
/** Legacy single-blob files (fkey without a dot, AAD "file"). */
export async function openLegacyFile(fkey, blob) {
  return open(await aesKey(unb64(fkey), ['decrypt']), blob, te.encode('file'));
}

// ---------------- key backup (same format as the server tests and the Android app) ----------------
// {v:1, kdf:"pbkdf2-sha256", iter, salt, iv, ct, pub}: the PKCS#8 private key sealed with
// AES-256-GCM under PBKDF2-HMAC-SHA256(account password), AAD "sepan-keybackup-v1|<username>".
// Stored on the server so every login (any device) gets the same key and old messages stay readable.
const BACKUP_ITER = 310000;
async function backupKek(password, salt, iter) {
  const base = await subtle.importKey('raw', te.encode(password), 'PBKDF2', false, ['deriveKey']);
  return subtle.deriveKey({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations: iter }, base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}
export async function exportBackup(my, username, password) {
  const salt = randomBytes(16), iv = randomBytes(12);
  const kek = await backupKek(password, salt, BACKUP_ITER);
  const der = await subtle.exportKey('pkcs8', my.priv);
  const ct = await subtle.encrypt({ name: 'AES-GCM', iv, additionalData: te.encode('sepan-keybackup-v1|' + username), tagLength: 128 }, kek, der);
  return { v: 1, kdf: 'pbkdf2-sha256', iter: BACKUP_ITER, salt: b64(salt), iv: b64(iv), ct: b64(ct), pub: my.pubB64 };
}
/** Returns the identity, or throws if the password does not open the backup. */
export async function importBackup(backup, username, password) {
  if (!backup || backup.v !== 1 || backup.kdf !== 'pbkdf2-sha256') throw new Error('unknown backup format');
  const kek = await backupKek(password, unb64(backup.salt), backup.iter);
  const der = await subtle.decrypt({ name: 'AES-GCM', iv: unb64(backup.iv), additionalData: te.encode('sepan-keybackup-v1|' + username), tagLength: 128 }, kek, unb64(backup.ct));
  const priv = await subtle.importKey('pkcs8', der, EC, true, ['deriveBits']);
  return { priv, pubB64: backup.pub };
}
