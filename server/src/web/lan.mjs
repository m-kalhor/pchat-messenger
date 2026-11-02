// Direct file transfer on the same Wi-Fi (1.8).
//
// When I send a file in a private chat to a contact who is online, Sepan also tries to hand it over
// directly through a WebRTC data channel with NO STUN/TURN servers: only local (host) addresses are
// offered, so it can only connect when both devices are on the same local network. The normal upload to
// the server goes on at the same time (the server copy keeps history, other devices and offline cases
// working). The receiver shows the file as soon as it arrived over Wi-Fi; when the server message comes
// it carries the same transfer id (`lx`) and takes the file over, so nothing is downloaded twice.
//
// What travels: the same encrypted chunks that go to the server (AES-GCM per 1 MB chunk with the file
// key), and the signalling plus the file key go through the server end-to-end encrypted (sig_lan).
// Protocol (sig_lan payload, encrypted): {t:'offer', x, sdp, meta} | {t:'answer', x, sdp} | {t:'bye', x}
// Data channel "f": binary frames of the cipher stream in order, then the text frame "done".
import * as api from './api.mjs';
import * as C from './crypto.mjs';
import * as E from './engine.mjs';

const MIN_SIZE = 64 * 1024;     // smaller files are not worth a connection
const CONNECT_MS = 8000;        // no local path within this time: give up quietly (the server copy remains)
const FRAME = 16 * 1024;
const HIGH = 4 * 1024 * 1024, LOW = 1024 * 1024;

const sending = new Map();      // x -> { pc, peer }
const receiving = new Map();    // x -> { pc }

const rid = () => [...crypto.getRandomValues(new Uint8Array(12))].map((b) => b.toString(16).padStart(2, '0')).join('');

async function signal(peer, obj) {
  try { return await api.signal(peer, 'sig_lan', await E.encryptSignal(peer, obj)); } catch { return false; }
}

/** Local candidates only, gathered before the offer/answer is sent (no trickle). */
function gathered(pc) {
  if (pc.iceGatheringState === 'complete') return Promise.resolve();
  return new Promise((resolve) => {
    const t = setTimeout(resolve, 2500);
    pc.addEventListener('icegatheringstatechange', () => { if (pc.iceGatheringState === 'complete') { clearTimeout(t); resolve(); } });
  });
}

function close(map, x) {
  const s = map.get(x);
  if (!s) return;
  map.delete(x);
  clearTimeout(s.timer);
  try { s.pc.close(); } catch { }
}

// ---------------- sender ----------------
/** Called for a file I am about to upload; marks it with a transfer id and tries the direct path. */
function offer(m) {
  if (E.isGroup(m.convo) || !m._file || m.size < MIN_SIZE || E.reqOf(m.convo) || typeof RTCPeerConnection === 'undefined') return;
  const x = rid();
  Object.defineProperty(m, '_lanX', { value: x, enumerable: false, writable: true });
  start(m, x).catch(() => close(sending, x));
}

async function start(m, x) {
  const pc = new RTCPeerConnection({ iceServers: [] });
  const s = { pc, peer: m.convo, timer: setTimeout(() => close(sending, x), CONNECT_MS) };
  sending.set(x, s);
  const dc = pc.createDataChannel('f', { ordered: true });
  dc.binaryType = 'arraybuffer';
  dc.bufferedAmountLowThreshold = LOW;
  dc.onopen = () => { clearTimeout(s.timer); pump(m, dc).catch(() => close(sending, x)); };
  dc.onclose = () => close(sending, x);
  await pc.setLocalDescription(await pc.createOffer());
  await gathered(pc);
  const meta = { t: m.type === 'voice' ? 'file' : m.type, n: m.name, m: m.mime, s: m.size, fk: m.fk, w: m.w || 0, h: m.h || 0,
    ...(m.type === 'voice' ? { v: 1, d: m.dur || 0, wf: m.wave || [] } : {}) };
  const delivered = await signal(m.convo, { t: 'offer', x, sdp: pc.localDescription.sdp, meta });
  if (!delivered) close(sending, x);
}

async function onAnswer(from, j) {
  const s = sending.get(j.x);
  if (!s || s.peer !== from || s.answered || !j.sdp) return; // another device of theirs answered first
  s.answered = true;
  await s.pc.setRemoteDescription({ type: 'answer', sdp: j.sdp });
}

async function pump(m, dc) {
  const file = m._file, n = C.chunkCount(m.size);
  const drained = () => new Promise((r) => { dc.onbufferedamountlow = () => { dc.onbufferedamountlow = null; r(); }; });
  for (let i = 0; i < n; i++) {
    const plain = new Uint8Array(await file.slice(i * C.FILE_CHUNK, Math.min(m.size, (i + 1) * C.FILE_CHUNK)).arrayBuffer());
    const sealed = await C.sealChunk(m.fk, i, i === n - 1, plain);
    for (let p = 0; p < sealed.length; p += FRAME) {
      if (dc.readyState !== 'open') throw new Error('closed');
      if (dc.bufferedAmount > HIGH) await drained();
      dc.send(sealed.subarray(p, Math.min(sealed.length, p + FRAME)));
    }
  }
  dc.send('done');
  // the receiver closes the channel when it has everything; do not leave the connection open forever
  setTimeout(() => close(sending, m._lanX), 120000);
}

// ---------------- receiver ----------------
async function onOffer(from, j) {
  const meta = j.meta || {};
  // only from my contacts, never from a message request; and nothing silly
  if (E.reqOf(from) || !j.x || !j.sdp || !meta.fk || !C.isChunked(meta.fk) || !(meta.s > 0) || meta.s > 200 * 1024 * 1024) return;
  if (receiving.has(j.x)) return;
  const pc = new RTCPeerConnection({ iceServers: [] });
  const r = { pc, timer: setTimeout(() => close(receiving, j.x), CONNECT_MS) };
  receiving.set(j.x, r);
  pc.ondatachannel = (ev) => {
    clearTimeout(r.timer);
    r.timer = setTimeout(() => close(receiving, j.x), 30 * 60e3);
    take(from, j.x, meta, ev.channel).catch(() => close(receiving, j.x));
  };
  await pc.setRemoteDescription({ type: 'offer', sdp: j.sdp });
  await pc.setLocalDescription(await pc.createAnswer());
  await gathered(pc);
  await signal(from, { t: 'answer', x: j.x, sdp: pc.localDescription.sdp });
}

function take(from, x, meta, dc) {
  return new Promise((resolve, reject) => {
    dc.binaryType = 'arraybuffer';
    const total = C.cipherSize(meta.s), n = C.chunkCount(meta.s);
    let buf = new Uint8Array(C.CIPHER_CHUNK), fill = 0, got = 0, idx = 0;
    const out = [];
    let work = Promise.resolve();
    const flushChunk = (bytes) => {
      const i = idx++;
      work = work.then(async () => { out.push(await C.openChunk(meta.fk, i, i === n - 1, bytes)); });
    };
    dc.onmessage = (ev) => {
      if (typeof ev.data === 'string') {
        if (ev.data !== 'done') return;
        if (fill > 0) flushChunk(buf.slice(0, fill));
        work.then(() => {
          if (got !== total || out.length !== n) throw new Error('incomplete');
          E.lanShow(from, meta, x, new Blob(out, { type: meta.m || 'application/octet-stream' }));
          dc.close(); close(receiving, x); resolve();
        }).catch(reject);
        return;
      }
      let data = new Uint8Array(ev.data);
      got += data.length;
      if (got > total) { reject(new Error('too much')); return; }
      while (data.length) {
        const k = Math.min(data.length, C.CIPHER_CHUNK - fill);
        buf.set(data.subarray(0, k), fill);
        fill += k; data = data.subarray(k);
        if (fill === C.CIPHER_CHUNK) { flushChunk(buf); buf = new Uint8Array(C.CIPHER_CHUNK); fill = 0; }
      }
    };
    dc.onclose = () => { if (receiving.has(x)) reject(new Error('closed')); };
  });
}

E.setLanHook({
  offer,
  async signal(from, enc) {
    const j = await E.decryptSignal(from, enc);
    if (!j || typeof j.x !== 'string') return;
    try {
      if (j.t === 'offer') await onOffer(from, j);
      else if (j.t === 'answer') await onAnswer(from, j);
      else if (j.t === 'bye') { close(sending, j.x); close(receiving, j.x); }
    } catch { close(sending, j.x); close(receiving, j.x); }
  },
});
