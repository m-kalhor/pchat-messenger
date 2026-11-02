// Call diagnostics (1.7, TEST FEATURE, only for the users listed in the admin panel; see server/src/diag.js).
// During a call: ping (round-trip time of the media path), jitter, packet loss, bitrate, codec and whether
// the call goes directly or through the server's TURN relay, read from WebRTC's own statistics once a
// second. The «مسیر» button asks the server for traceroute from it to both people of the call.
import * as api from './api.mjs';

let box = null, timer = null, prev = null, peerName = '', getPc = null, routeEl = null, statsEl = null;

const ms = (s) => (s == null || !isFinite(s) ? '–' : Math.round(s * 1000) + ' ms');
const kbps = (b) => (b == null ? '–' : b >= 1000 ? (b / 1000).toFixed(1) + ' Mb/s' : Math.round(b) + ' kb/s');
const TYPE = { host: 'local', srflx: 'public', prflx: 'public', relay: 'TURN relay' };

function el(tag, text, cls) { const e = document.createElement(tag); if (text != null) e.textContent = text; if (cls) e.className = cls; return e; }

async function sample() {
  const pc = getPc && getPc();
  if (!pc || !statsEl) return;
  let rep;
  try { rep = await pc.getStats(); } catch { return; }
  const all = new Map();
  rep.forEach((r) => all.set(r.id, r));
  let pair = null;
  rep.forEach((r) => { if (r.type === 'transport' && r.selectedCandidatePairId) pair = all.get(r.selectedCandidatePairId); });
  if (!pair) rep.forEach((r) => { if (!pair && r.type === 'candidate-pair' && r.state === 'succeeded' && (r.nominated || r.selected)) pair = r; });
  const loc = pair && all.get(pair.localCandidateId), rem = pair && all.get(pair.remoteCandidateId);
  let jitter = null, lost = 0, recv = 0, codec = '', video = '';
  rep.forEach((r) => {
    if (r.type !== 'inbound-rtp') return;
    if (r.kind === 'audio') { jitter = r.jitter; lost += r.packetsLost || 0; recv += r.packetsReceived || 0; const c = all.get(r.codecId); if (c) codec = (c.mimeType || '').split('/')[1] || ''; }
    if (r.kind === 'video' && r.frameWidth) video = r.frameWidth + '×' + r.frameHeight + (r.framesPerSecond ? ' @' + Math.round(r.framesPerSecond) + 'fps' : '');
  });
  const now = performance.now();
  let down = null, up = null;
  if (pair && prev && prev.id === pair.id) {
    const dt = (now - prev.t) / 1000;
    if (dt > 0) { down = ((pair.bytesReceived - prev.rx) * 8) / 1000 / dt; up = ((pair.bytesSent - prev.tx) * 8) / 1000 / dt; }
  }
  if (pair) prev = { id: pair.id, t: now, rx: pair.bytesReceived || 0, tx: pair.bytesSent || 0 };
  const relay = (loc && loc.candidateType === 'relay') || (rem && rem.candidateType === 'relay');
  const addr = (c) => (c ? (c.address || c.ip || '?') + ':' + c.port + ' (' + (TYPE[c.candidateType] || c.candidateType) + ', ' + (c.protocol || '') + ')' : '–');
  const lossPct = recv + lost > 0 ? ((100 * lost) / (recv + lost)).toFixed(1) + '%' : '–';
  const ping = el('div');
  ping.append(el('b', 'ping ' + ms(pair && pair.currentRoundTripTime)));
  statsEl.replaceChildren(
    ping,
    el('div', 'jitter ' + ms(jitter) + ' · loss ' + lossPct),
    el('div', '↓ ' + kbps(down) + ' ↑ ' + kbps(up) + (codec ? ' · ' + codec : '') + (video ? ' · ' + video : '')),
    el('div', pair ? (relay ? 'via Sepan TURN server' : 'direct (peer to peer)') : 'connecting…'),
    el('div', 'me   ' + addr(loc)),
    el('div', 'peer ' + addr(rem)));
}

function hopList(title, hops, reverse) {
  const wrap = el('div');
  wrap.append(el('div', title));
  const ol = el('ol');
  const list = reverse ? [...hops].reverse() : hops;
  for (const x of list) {
    const li = el('li', (x.ip || '*') + (x.ms != null ? '  ' + x.ms + ' ms' : ''));
    li.value = x.n;
    ol.append(li);
  }
  wrap.append(ol);
  return wrap;
}

async function trace() {
  if (!routeEl) return;
  routeEl.replaceChildren(el('div', 'tracing… (up to ~40 s)'));
  try {
    const r = await api.diagTrace(peerName);
    const part = (who, t) => (t.error ? el('div', who + ': ' + (t.error === 'no_traceroute' ? 'traceroute is not installed on the server' : t.error === 'offline' ? 'not connected' : t.error))
      : hopList(who + ' ' + t.ip + ' — ' + t.hops.length + ' hops (' + t.tool + ')', t.hops, false));
    routeEl.replaceChildren(
      el('div', 'server → me / server → peer' + (r.server ? ' (server ' + r.server + ')' : '')),
      part('server → me', r.me), part('server → peer', r.peer));
  } catch (e) {
    routeEl.replaceChildren(el('div', 'trace failed: ' + ((e && e.body && e.body.error) || e.message || e)));
  }
}

/** Shows the panel inside the call screen `callEl` for the call with `peer`. Safe to call on every render. */
export function attach(callEl, peer, pcGetter) {
  if (box && box.isConnected && peerName === peer) return;
  detach();
  peerName = peer; getPc = pcGetter; prev = null;
  box = el('div', null, 'diag');
  statsEl = el('div', 'connecting…');
  routeEl = el('div');
  const btn = el('button', 'مسیر (traceroute)');
  btn.onclick = (e) => { e.stopPropagation(); trace(); };
  box.append(statsEl, btn, routeEl);
  callEl.append(box);
  sample();
  timer = setInterval(sample, 1000);
}

export function detach() {
  clearInterval(timer); timer = null;
  if (box) box.remove();
  box = null; statsEl = null; routeEl = null; prev = null;
}
