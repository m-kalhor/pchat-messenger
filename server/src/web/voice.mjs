// Voice messages in the web app: recording with MediaRecorder (plus a waveform from an AnalyserNode)
// and one shared player. Same format as the Android app: AAC in MP4 when the browser can record it
// (Safari, newer Chrome), otherwise Opus in WebM; waveform = 50 bars of 0..31.

export const canRecord = () => !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia && window.MediaRecorder);

function pickMime() {
  for (const t of ['audio/mp4', 'audio/aac', 'audio/webm;codecs=opus', 'audio/ogg;codecs=opus', 'audio/webm']) {
    try { if (MediaRecorder.isTypeSupported(t)) return t; } catch { }
  }
  return '';
}

/** Squeezes the 100 ms loudness samples into `bars` values 0..31. */
export function waveform(levels, bars = 50) {
  if (!levels.length) return new Array(bars).fill(0);
  const max = Math.max(...levels, 0.02);
  const out = [];
  for (let i = 0; i < bars; i++) {
    const a = Math.floor((i * levels.length) / bars), b = Math.max(a + 1, Math.floor(((i + 1) * levels.length) / bars));
    let m = 0;
    for (let j = a; j < b && j < levels.length; j++) m = Math.max(m, levels[j]);
    out.push(Math.round(Math.min(1, m / max) * 31));
  }
  return out;
}

/** Starts recording; resolves to a handle with elapsed(), level(), stop() -> { blob, dur, wave } and cancel(). */
export async function startRecording() {
  const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
  const mime = pickMime();
  let rec;
  try { rec = new MediaRecorder(stream, mime ? { mimeType: mime, audioBitsPerSecond: 32000 } : undefined); } catch { rec = new MediaRecorder(stream); }
  const chunks = [];
  rec.ondataavailable = (e) => { if (e.data && e.data.size) chunks.push(e.data); };
  const levels = [];
  let ctx = null, timer = null;
  try {
    ctx = new (window.AudioContext || window.webkitAudioContext)();
    const an = ctx.createAnalyser();
    an.fftSize = 1024;
    ctx.createMediaStreamSource(stream).connect(an);
    const buf = new Uint8Array(an.fftSize);
    timer = setInterval(() => {
      an.getByteTimeDomainData(buf);
      let sum = 0;
      for (const v of buf) { const x = (v - 128) / 128; sum += x * x; }
      levels.push(Math.sqrt(sum / buf.length));
    }, 100);
  } catch { }
  const started = Date.now();
  rec.start(250);
  const cleanup = () => { clearInterval(timer); stream.getTracks().forEach((t) => t.stop()); if (ctx) ctx.close().catch(() => { }); };
  return {
    elapsed: () => Date.now() - started,
    level: () => (levels.length ? levels[levels.length - 1] : 0),
    stop: () => new Promise((resolve) => {
      const dur = Date.now() - started;
      rec.onstop = () => {
        cleanup();
        const type = (rec.mimeType || mime || (chunks[0] && chunks[0].type) || 'audio/mp4').split(';')[0];
        resolve({ blob: new Blob(chunks, { type }), dur, wave: waveform(levels) });
      };
      try { rec.stop(); } catch { cleanup(); resolve(null); }
    }),
    cancel: () => { rec.onstop = null; try { rec.stop(); } catch { } cleanup(); },
  };
}

// ---------------- player ----------------
const audio = new Audio();
audio.preload = 'auto';
let current = null;
const subs = new Set();
const tell = () => { for (const f of subs) { try { f(current); } catch { } } };
audio.addEventListener('timeupdate', tell);
audio.addEventListener('play', tell);
audio.addEventListener('pause', tell);
audio.addEventListener('ended', () => { current = null; tell(); });

export const onPlayer = (fn) => { subs.add(fn); return () => subs.delete(fn); };

// iOS only lets a media element play after it was started inside a tap; downloading the voice
// message first loses the tap, so the element is started (silently) right in the tap handler.
let primed = false, silent = null;
export function prime() {
  if (primed) return;
  primed = true;
  if (!silent) {
    const b = new Uint8Array(44 + 800), v = new DataView(b.buffer);
    const w = (o, s) => { for (let i = 0; i < s.length; i++) b[o + i] = s.charCodeAt(i); };
    w(0, 'RIFF'); v.setUint32(4, 36 + 800, true); w(8, 'WAVEfmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
    v.setUint32(24, 8000, true); v.setUint32(28, 8000, true); v.setUint16(32, 1, true); v.setUint16(34, 8, true); w(36, 'data'); v.setUint32(40, 800, true);
    b.fill(128, 44);
    silent = URL.createObjectURL(new Blob([b], { type: 'audio/wav' }));
  }
  if (!current) { audio.src = silent; audio.play().catch(() => { }); }
}

/** Plays / pauses voice message `id` from `url`. */
export function toggle(id, url) {
  if (current === id && !audio.paused) { audio.pause(); return; }
  if (current !== id) { current = id; audio.src = url; }
  audio.play().catch(() => { current = null; tell(); });
  tell();
}
/** { playing, pos (ms) } of message `id`. */
export function state(id) {
  return current === id ? { playing: !audio.paused, pos: audio.currentTime * 1000 } : { playing: false, pos: 0 };
}
/** Jumps to a fraction 0..1 of the message that is playing. */
export function seek(id, frac) {
  if (current !== id || !isFinite(audio.duration)) return;
  audio.currentTime = Math.max(0, Math.min(1, frac)) * audio.duration;
  tell();
}
export function stopAll() { if (current) { audio.pause(); current = null; tell(); } }
