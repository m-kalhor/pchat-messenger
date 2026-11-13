// 1-to-1 voice/video calls over WebRTC, compatible with android/.../CallManager.kt: the same
// encrypted "sig_*" signals (invite / accept / ice / reject / hangup) and our own TURN server.
import * as api from './api.mjs';
import * as E from './engine.mjs';

export const C = {
  phase: 'idle',            // idle | outgoing | incoming | connecting | active
  peer: '', video: false, callId: '', incoming: false,
  muted: false, camOff: false, front: true, startedAt: 0, note: '',
  local: null, remote: null, // MediaStreams
  // 1.15: call path chosen by the user (only users the admin ticked in the panel, column «مسیر تماس»)
  canRoute: false,          // this user may choose (from /api/turn)
  peerRoute: false,         // the other app understands it (1.15 or newer)
  route: 'auto',            // auto | direct | udp | tcp | tls
  routes: [],               // the modes this server offers
  routing: false,           // a path change is under way
  path: '',                 // the path in use now, e.g. «مستقیم · UDP»
};
export const ROUTE_NAMES = { auto: 'خودکار', direct: 'مستقیم (UDP)', udp: 'سرور · UDP', tcp: 'سرور · TCP', tls: 'سرور · TLS' };
const ROUTE_KEY = 'sepan_call_route';
/** 1.15: the path every call of this browser switches to once connected (Settings), 'auto' = none. */
export function defaultRoute() { try { const v = localStorage.getItem(ROUTE_KEY); return ROUTE_NAMES[v] ? v : 'auto'; } catch { return 'auto'; } }
export function setDefaultRoute(v) { try { localStorage.setItem(ROUTE_KEY, ROUTE_NAMES[v] ? v : 'auto'); } catch { } }

const listeners = new Set();
export const onCall = (fn) => { listeners.add(fn); return () => listeners.delete(fn); };
const changed = () => { for (const fn of listeners) { try { fn(C); } catch (e) { console.error(e); } } };
function set(p) { Object.assign(C, p); changed(); }

let pc = null, offerSdp = null, remoteSet = false, timer = null, discTimer = null, wakeLock = null;
let pendingIce = [];      // remote candidates that arrived before the remote description: { callId, cand }
let localIce = [], inviteSent = false;
// 1.10.1: call path settings from /api/turn and the switch to the server relay when the direct path is bad
let turnCfg = null, pcConfig = null, peerRelay = false, switching = false, relayed = false, watch = null;
let iceHold = false, heldIce = [];
let guard = null, guardUntil = 0, pathTimer = null, peerPref = 'auto';
let ring = null;
/** The live RTCPeerConnection (the admins' call diagnostics read its stats), or null. */
export const peerConnection = () => pc;

export async function startCall(peer, video) {
  if (C.phase !== 'idle') return;
  const callId = Math.random().toString(16).slice(2, 14);
  stopTone(); unlockAudio();
  set({ phase: 'outgoing', peer, video, callId, incoming: false, muted: false, camOff: false, front: true, note: 'در حال برقراری تماس…', remote: null });
  try {
    const turn = await api.turn();
    const stream = await media(video);
    if (C.callId !== callId) { stopTracks(stream); return; }
    createPeer(turn, stream);
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    const delivered = await signal('sig_invite', { callId, video, sdp: offer.sdp, relay: 1, route: 1 });
    if (!delivered) return end('کاربر الان آنلاین نیست', false, 'unreachable');
    inviteSent = true;
    for (const c of localIce.splice(0)) signal('sig_ice', c).catch(() => { });
    if (C.phase === 'outgoing' && C.callId === callId) playTone('ringback'); // 1.13: the caller hears it ring
    arm(45000, 'پاسخی داده نشد', 'unreachable');
  } catch (e) {
    end(e && e.name === 'NotAllowedError' ? 'اجازهٔ دسترسی به میکروفون/دوربین داده نشد'
      : e && e.body && e.body.error === 'not_connected' ? 'تماس بعد از پذیرفتن درخواست ممکن است؛ تماس شما به او خبر داده شد' : 'خطا در برقراری تماس', false);
  }
}

export async function accept() {
  if (C.phase !== 'incoming' || !offerSdp) return;
  stopRing(); disarm();
  const { callId } = C;
  set({ phase: 'connecting', note: 'در حال اتصال…' });
  try {
    const turn = await api.turn();
    const stream = await media(C.video);
    if (C.callId !== callId) { stopTracks(stream); return; }
    createPeer(turn, stream);
    inviteSent = true;
    await pc.setRemoteDescription({ type: 'offer', sdp: offerSdp });
    remoteSet = true;
    await flushIce(callId);
    const ans = await pc.createAnswer();
    await pc.setLocalDescription(ans);
    await signal('sig_accept', { callId, sdp: ans.sdp, relay: 1, route: 1, route_pref: C.canRoute ? defaultRoute() : 'auto' });
  } catch (e) {
    end(e && e.name === 'NotAllowedError' ? 'اجازهٔ دسترسی به میکروفون/دوربین داده نشد' : 'خطا در اتصال تماس', true);
  }
}
export const decline = () => end('', true);
export const hangup = () => end('', true);

export function toggleMute() {
  const m = !C.muted;
  if (C.local) for (const t of C.local.getAudioTracks()) t.enabled = !m;
  set({ muted: m });
}
export function toggleCamera() {
  const off = !C.camOff;
  if (C.local) for (const t of C.local.getVideoTracks()) t.enabled = !off;
  set({ camOff: off });
}
export async function switchCamera() {
  if (!C.local || !pc) return;
  const old = C.local.getVideoTracks()[0];
  if (!old) return;
  try {
    const s = await navigator.mediaDevices.getUserMedia({ video: { facingMode: C.front ? 'environment' : 'user' } });
    const t = s.getVideoTracks()[0];
    const sender = pc.getSenders().find((x) => x.track && x.track.kind === 'video');
    if (sender) await sender.replaceTrack(t);
    old.stop();
    C.local.removeTrack(old); C.local.addTrack(t);
    t.enabled = !C.camOff;
    set({ front: !C.front, local: C.local });
  } catch { }
}

// ---------------- incoming signals ----------------
E.setSignalHandler(async (from, kind, enc) => {
  const j = await E.decryptSignal(from, enc);
  if (!j) return;
  const callId = j.callId || '';
  if (kind === 'sig_invite') onInvite(from, callId, !!j.video, j.sdp || '', !!j.relay, !!j.route);
  else if (kind === 'sig_accept') onAccepted(from, callId, j.sdp || '', !!j.relay, !!j.route, j.route_pref);
  else if (kind === 'sig_route') { if (matches(from, callId) && !C.incoming && ROUTE_NAMES[j.mode]) restartTo(j.mode); }
  else if (kind === 'sig_relay') { if (matches(from, callId) && !C.incoming) switchToRelay(); }
  else if (kind === 'sig_reoffer') { if (matches(from, callId)) onReoffer(callId, j.sdp || '', ROUTE_NAMES[j.mode] ? j.mode : null, ROUTE_NAMES[j.failed] ? j.failed : null); }
  else if (kind === 'sig_reanswer') { if (matches(from, callId)) onReanswer(callId, j.sdp || ''); }
  else if (kind === 'sig_ice') onIce(callId, { candidate: j.cand, sdpMid: j.mid, sdpMLineIndex: j.idx });
  else if (kind === 'sig_reject') { if (matches(from, callId)) end(j.reason === 'busy' ? 'طرف مقابل در تماس دیگری است' : 'تماس رد شد', false, 'busy'); }
  else if (kind === 'sig_hangup') { if (matches(from, callId)) end('تماس پایان یافت', false); }
});

const matches = (from, callId) => C.phase !== 'idle' && C.peer === from && C.callId === callId;

function onInvite(from, callId, video, sdp, relay, route) {
  if (!callId || !sdp) return;
  if (C.phase !== 'idle') {
    if (!(C.peer === from && C.callId === callId)) sendTo(from, 'sig_reject', { callId, reason: 'busy' });
    return;
  }
  offerSdp = sdp;
  peerRelay = relay;
  pendingIce = pendingIce.filter((p) => p.callId === callId);
  set({ phase: 'incoming', peer: from, video, callId, incoming: true, muted: false, camOff: false, front: true, note: 'تماس ورودی', remote: null, peerRoute: route });
  startRing();
  arm(45000, 'تماس بی‌پاسخ ماند');
}

async function onAccepted(from, callId, sdp, relay, route, pref) {
  if (!matches(from, callId) || C.phase !== 'outgoing' || !pc) return;
  peerRelay = relay;
  peerPref = ROUTE_NAMES[pref] ? pref : 'auto';
  set({ peerRoute: route });
  disarm(); stopTone();
  set({ phase: 'connecting', note: 'در حال اتصال…' });
  try {
    await pc.setRemoteDescription({ type: 'answer', sdp });
    remoteSet = true;
    await flushIce(callId);
  } catch { end('خطا در اتصال تماس', true); }
}

async function onIce(callId, cand) {
  if (!cand.candidate) return;
  if (pc && remoteSet && C.callId === callId) { try { await pc.addIceCandidate(cand); } catch { } }
  else pendingIce.push({ callId, cand });
}
async function flushIce(callId) {
  const list = pendingIce.filter((p) => p.callId === callId);
  pendingIce = [];
  for (const p of list) { try { await pc.addIceCandidate(p.cand); } catch { } }
}

// ---------------- WebRTC ----------------
async function media(video) {
  if (!navigator.mediaDevices) throw Object.assign(new Error('no media'), { name: 'NotAllowedError' });
  try {
    return await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true }, video: video ? { facingMode: 'user', width: { ideal: 1280 }, height: { ideal: 720 } } : false });
  } catch (e) {
    if (video && e.name !== 'NotAllowedError') return navigator.mediaDevices.getUserMedia({ audio: true }); // no camera: voice only
    throw e;
  }
}

function createPeer(turn, stream) {
  remoteSet = false; localIce = []; inviteSent = false;
  turnCfg = turn; switching = false; relayed = turn.policy === 'relay'; iceHold = false; heldIce = [];
  // 1.10.1: «همیشه از طریق سرور» in the admin panel: only relay candidates from the start
  pcConfig = { iceServers: [{ urls: turn.urls, username: turn.username, credential: turn.credential }], bundlePolicy: 'max-bundle', iceTransportPolicy: relayed ? 'relay' : 'all' };
  const routes = ['auto', 'direct', 'udp', 'tcp', 'tls'].filter((m) => urlsFor(m).length > 0);
  set({ canRoute: !!turn.user_route, routes, route: 'auto', routing: false, path: '' });
  pc = new RTCPeerConnection(pcConfig);
  for (const t of stream.getTracks()) pc.addTrack(t, stream);
  set({ local: stream });
  const { callId, peer } = C;
  pc.onicecandidate = (ev) => {
    if (!ev.candidate || !ev.candidate.candidate) return;
    const c = { callId, mid: ev.candidate.sdpMid, idx: ev.candidate.sdpMLineIndex, cand: ev.candidate.candidate };
    if (iceHold) heldIce.push(c); else if (inviteSent) sendTo(peer, 'sig_ice', c); else localIce.push(c);
  };
  pc.ontrack = (ev) => {
    const s = C.remote || new MediaStream();
    if (!s.getTracks().includes(ev.track)) s.addTrack(ev.track);
    set({ remote: s });
  };
  pc.onconnectionstatechange = () => {
    const st = pc && pc.connectionState;
    if (st === 'connected') {
      clearTimeout(discTimer);
      if (C.phase !== 'active') { set({ phase: 'active', startedAt: Date.now(), note: '' }); keepAwake(); limitVideo(); startWatch(); startPath(); applyPref(); }
    } else if (st === 'disconnected') {
      clearTimeout(discTimer);
      const check = () => {
        if (!pc || pc.connectionState === 'connected') return;
        if (Date.now() < guardUntil) { discTimer = setTimeout(check, 3000); return; } // 1.15: a path change is being tried
        end('اتصال قطع شد', true);
      };
      discTimer = setTimeout(check, 12000);
    } else if (st === 'failed') {
      if (Date.now() < guardUntil) return; // 1.15: the path change falls back to the previous path (see armGuard)
      end('اتصال برقرار نشد', true);
    }
  };
}

// ---------------- 1.10.1: bad direct path -> server relay, video bitrate cap ----------------
/** Caps the video a call sends (admin panel, 0 = no cap) and gives the audio priority on a weak network. */
async function limitVideo() {
  if (!pc) return;
  const kbps = (turnCfg && turnCfg.video_kbps) || 0;
  for (const sender of pc.getSenders()) {
    const k = sender.track && sender.track.kind;
    if (!k) continue;
    try {
      const p = sender.getParameters();
      if (!p.encodings || !p.encodings.length) p.encodings = [{}];
      if (k === 'video' && kbps > 0) p.encodings[0].maxBitrate = kbps * 1000;
      if (k === 'audio') { p.encodings[0].priority = 'high'; p.encodings[0].networkPriority = 'high'; }
      await sender.setParameters(p);
    } catch { }
  }
}

/** Every 2 s in «خودکار» mode: ~6 s of ping or packet loss over the panel's limits on a direct path -> relay. */
function startWatch() {
  stopWatch();
  if (!turnCfg || turnCfg.policy !== 'auto' || relayed || !peerRelay || C.route !== 'auto') return;
  const rttMax = turnCfg.switch_rtt || 400, lossMax = turnCfg.switch_loss || 8;
  let bad = 0, prevLost = null, prevRecv = null, n = 0;
  watch = setInterval(async () => {
    if (!pc || relayed || switching) return stopWatch();
    let rep; try { rep = await pc.getStats(); } catch { return; }
    let pair = null, lost = 0, recv = 0;
    const byId = new Map(); rep.forEach((s) => byId.set(s.id, s));
    rep.forEach((s) => { if (s.type === 'transport' && s.selectedCandidatePairId) pair = byId.get(s.selectedCandidatePairId); });
    if (!pair) rep.forEach((s) => { if (!pair && s.type === 'candidate-pair' && s.state === 'succeeded' && s.nominated) pair = s; });
    rep.forEach((s) => { if (s.type === 'inbound-rtp' && (s.kind || s.mediaType) === 'audio') { lost += s.packetsLost || 0; recv += s.packetsReceived || 0; } });
    if (!pair) return;
    const lc = byId.get(pair.localCandidateId), rc = byId.get(pair.remoteCandidateId);
    if ((lc && lc.candidateType === 'relay') || (rc && rc.candidateType === 'relay')) { relayed = true; return stopWatch(); }
    const rtt = (pair.currentRoundTripTime || 0) * 1000;
    let loss = 0;
    if (prevRecv !== null) { const dl = lost - prevLost, dr = recv - prevRecv; if (dl + dr > 0) loss = 100 * Math.max(0, dl) / (dl + dr); }
    prevLost = lost; prevRecv = recv;
    if (++n < 2) return; // the first seconds after connecting are often rough
    bad = rtt > rttMax || loss > lossMax ? bad + 1 : 0;
    if (bad >= 3) {
      stopWatch();
      if (C.incoming) signal('sig_relay', { callId: C.callId }); else switchToRelay();
    }
  }, 2000);
}
function stopWatch() { clearInterval(watch); watch = null; }

function holdIce() { iceHold = true; heldIce = []; }
function releaseIce() { iceHold = false; for (const c of heldIce.splice(0)) signal('sig_ice', c); }

/** The caller restarts ICE with relay candidates only; the call goes on over the old path meanwhile. */
async function switchToRelay() {
  if (!pc || switching || relayed || C.incoming) return;
  switching = true; stopWatch();
  const { callId } = C;
  try {
    pc.setConfiguration({ ...pcConfig, iceTransportPolicy: 'relay' });
    holdIce(); remoteSet = false;
    const offer = await pc.createOffer({ iceRestart: true });
    await pc.setLocalDescription(offer);
    await signal('sig_reoffer', { callId, sdp: offer.sdp });
    releaseIce();
    relayed = true;
  } catch { iceHold = false; remoteSet = true; } finally { switching = false; }
}
async function onReanswer(callId, sdp) {
  if (!pc || !sdp) return;
  try { await pc.setRemoteDescription({ type: 'answer', sdp }); } catch { }
  remoteSet = true;
  await flushIce(callId);
}

// ---------------- 1.15: the user picks the call path ----------------
/** The ICE server URLs for a path: direct = STUN only; udp/tcp/tls = that one TURN URL; auto = all. */
function urlsFor(mode) {
  const u = (turnCfg && turnCfg.urls) || [];
  if (mode === 'direct') return u.filter((x) => x.startsWith('stun:'));
  if (mode === 'udp') return u.filter((x) => x.startsWith('turn:') && x.includes('transport=udp'));
  if (mode === 'tcp') return u.filter((x) => x.startsWith('turn:') && x.includes('transport=tcp'));
  if (mode === 'tls') return u.filter((x) => x.startsWith('turns:'));
  return u;
}
function cfgFor(mode) {
  const urls = urlsFor(mode);
  const policy = mode === 'auto' ? (turnCfg.policy === 'relay' ? 'relay' : 'all') : mode === 'direct' ? 'all' : 'relay';
  return { ...pcConfig, iceServers: urls.length ? [{ urls, username: turnCfg.username, credential: turnCfg.credential }] : [], iceTransportPolicy: policy };
}
function applyMode(mode) {
  relayed = mode === 'auto' ? turnCfg.policy === 'relay' : mode !== 'direct';
  guardUntil = Date.now() + 20000;
  set({ route: mode, routing: true });
}

/** Called by the call screen. The caller restarts ICE itself; the callee asks the caller to. */
export function setRoute(mode) {
  if (!pc || C.phase !== 'active' || !C.canRoute || !C.peerRoute || C.routing || switching) return;
  if (!ROUTE_NAMES[mode] || !C.routes.includes(mode) || mode === C.route) return;
  if (C.incoming) { set({ routing: true }); guardUntil = Date.now() + 20000; armGuard(mode, null); signal('sig_route', { callId: C.callId, mode }); }
  else restartTo(mode);
}

/** After connecting: the caller switches to the caller's default path, or else to the callee's. */
function applyPref() {
  if (C.incoming || !C.peerRoute) return;
  const mine = C.canRoute ? defaultRoute() : 'auto';
  const want = mine !== 'auto' ? mine : peerPref;
  if (want !== 'auto' && C.routes.includes(want)) setTimeout(() => { if (C.phase === 'active' && C.route === 'auto') restartTo(want); }, 1500);
}

/** ICE restart onto another path; the call goes on over the old path meanwhile. failed: the path given up on. */
async function restartTo(mode, failed) {
  if (!pc || switching || C.incoming) return;
  switching = true; stopWatch();
  const { callId } = C, before = C.route;
  try {
    pc.setConfiguration(cfgFor(mode));
    holdIce(); remoteSet = false;
    const offer = await pc.createOffer({ iceRestart: true });
    await pc.setLocalDescription(offer);
    await signal('sig_reoffer', { callId, sdp: offer.sdp, mode, ...(failed ? { failed } : {}) });
    releaseIce();
    applyMode(mode);
    armGuard(mode, failed ? null : before);
  } catch { iceHold = false; remoteSet = true; set({ routing: false }); } finally { switching = false; }
}

/** Whether the selected candidate pair is on the wanted path. */
function onPath(mode, lc, rc) {
  const relay = (lc && lc.candidateType === 'relay') || (rc && rc.candidateType === 'relay');
  if (mode === 'auto') return true;
  if (mode === 'direct') return !relay;
  if (!relay) return false;
  return !(lc && lc.candidateType === 'relay' && lc.relayProtocol) || lc.relayProtocol === mode;
}

async function selected() {
  if (!pc) return null;
  let rep; try { rep = await pc.getStats(); } catch { return null; }
  const byId = new Map(); rep.forEach((s) => byId.set(s.id, s));
  let pair = null;
  rep.forEach((s) => { if (s.type === 'transport' && s.selectedCandidatePairId) pair = byId.get(s.selectedCandidatePairId); });
  if (!pair) rep.forEach((s) => { if (!pair && s.type === 'candidate-pair' && s.state === 'succeeded' && s.nominated) pair = s; });
  if (!pair) return null;
  return { lc: byId.get(pair.localCandidateId), rc: byId.get(pair.remoteCandidateId) };
}

/**
 * Waits up to 12 s for the new path. back: the path to return to if it doesn't come up (only the side that
 * restarted ICE has it); without it a path that never comes up ends the call like before.
 */
function armGuard(mode, back) {
  clearInterval(guard);
  const t0 = Date.now();
  guard = setInterval(async () => {
    if (!pc) { clearInterval(guard); guard = null; return; }
    const sel = pc.connectionState === 'connected' ? await selected() : null;
    if (sel && onPath(C.route, sel.lc, sel.rc)) {
      clearInterval(guard); guard = null; guardUntil = 0;
      set({ routing: false }); updatePath(); startWatch();
      return;
    }
    if (Date.now() - t0 < 12000) return;
    clearInterval(guard); guard = null;
    if (back && !C.incoming) {
      set({ note: '«' + ROUTE_NAMES[mode] + '» برقرار نشد؛ تماس روی مسیر قبلی ماند' }); noteLater();
      restartTo(back, mode);
    } else {
      guardUntil = 0; set({ routing: false });
      if (pc && pc.connectionState === 'failed') end('اتصال برقرار نشد', true);
    }
  }, 1500);
}

async function onReoffer(callId, sdp, mode, failed) {
  if (!pc || !sdp) return;
  stopWatch(); switching = true;
  try {
    // 1.15: the path the caller chose; an older app (no mode) only ever switches to the relay
    pc.setConfiguration(mode ? cfgFor(mode) : { ...pcConfig, iceTransportPolicy: 'relay' });
    remoteSet = false;
    await pc.setRemoteDescription({ type: 'offer', sdp });
    remoteSet = true;
    await flushIce(callId);
    holdIce();
    const ans = await pc.createAnswer();
    await pc.setLocalDescription(ans);
    await signal('sig_reanswer', { callId, sdp: ans.sdp });
    releaseIce();
    if (mode) {
      applyMode(mode); armGuard(mode, null);
      if (failed) { set({ note: '«' + ROUTE_NAMES[failed] + '» برقرار نشد؛ تماس روی مسیر قبلی ماند' }); noteLater(); }
    } else relayed = true;
  } catch { iceHold = false; remoteSet = true; } finally { switching = false; }
}
function noteLater() { const n = C.note; setTimeout(() => { if (C.note === n && C.phase === 'active') set({ note: '' }); }, 5000); }

/** The path in use, for the call screen (users allowed to choose only). */
async function updatePath() {
  if (!C.canRoute) return;
  const sel = await selected();
  if (!sel || !sel.lc) return;
  const { lc, rc } = sel;
  let path;
  if (lc.candidateType === 'relay') path = 'سرور · ' + String(lc.relayProtocol || 'udp').toUpperCase();
  else if (rc && rc.candidateType === 'relay') path = 'سرور' + (['udp', 'tcp', 'tls'].includes(C.route) ? ' · ' + C.route.toUpperCase() : '');
  else path = 'مستقیم · ' + String(lc.protocol || 'udp').toUpperCase();
  if (path !== C.path) set({ path });
}
function startPath() { clearInterval(pathTimer); if (C.canRoute) { updatePath(); pathTimer = setInterval(updatePath, 3000); } }

const signal = (kind, body) => sendTo(C.peer, kind, body);
async function sendTo(peer, kind, body) {
  try { return await api.signal(peer, kind, await E.encryptSignal(peer, body)); } catch { return false; }
}

/** tone (1.13): 'busy' / 'unreachable'…; left out, a connected call ends with the short end tone. */
function end(note, sendHangup, tone) {
  if (C.phase === 'idle') return;
  const { peer, callId, phase, incoming, startedAt } = C;
  if (sendHangup) sendTo(peer, phase === 'incoming' ? 'sig_reject' : 'sig_hangup', { callId });
  stopRing(); disarm(); clearTimeout(discTimer); stopWatch();
  clearInterval(guard); guard = null; guardUntil = 0; clearInterval(pathTimer); pathTimer = null; peerPref = 'auto';
  stopTone();
  const endTone = tone || (phase === 'active' ? 'end' : null);
  if (endTone) playTone(endTone);
  iceHold = false; heldIce = []; switching = false; relayed = false; peerRelay = false;
  if (pc) { try { pc.close(); } catch { } pc = null; }
  stopTracks(C.local);
  offerSdp = null; remoteSet = false; pendingIce = []; localIce = [];
  if (wakeLock) { wakeLock.release().catch(() => { }); wakeLock = null; }
  let log;
  if (phase === 'active') {
    const s = Math.round((Date.now() - startedAt) / 1000);
    log = `تماس ${C.video ? 'تصویری' : 'صوتی'} (${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')})`;
  } else log = incoming ? 'تماس از دست رفته' : 'تماس ناموفق';
  E.addCallLog(peer, log, !incoming);
  set({ phase: 'idle', note, local: null, remote: null, callId: '', canRoute: false, peerRoute: false, route: 'auto', routing: false, path: '' });
  if (note) setTimeout(() => { if (C.phase === 'idle' && C.note === note) set({ note: '' }); }, 3500);
}

function stopTracks(s) { if (s) for (const t of s.getTracks()) t.stop(); }
function arm(ms, note, tone) { disarm(); timer = setTimeout(() => end(note, true, tone), ms); }
function disarm() { clearTimeout(timer); timer = null; }
async function keepAwake() { try { if ('wakeLock' in navigator) wakeLock = await navigator.wakeLock.request('screen'); } catch { } }

// ---------------- ringing (WebAudio; may stay silent until the user has touched the page once) ----------------
let actx = null;
export function unlockAudio() {
  try { if (!actx) actx = new (window.AudioContext || window.webkitAudioContext)(); if (actx.state === 'suspended') actx.resume(); } catch { }
}
function beep(f1, f2) {
  if (!actx) return;
  const t = actx.currentTime;
  for (const [f, d] of [[f1, 0], [f2, 0.45]]) {
    const o = actx.createOscillator(), g = actx.createGain();
    o.frequency.value = f; o.connect(g); g.connect(actx.destination);
    g.gain.setValueAtTime(0.0001, t + d); g.gain.exponentialRampToValueAtTime(0.25, t + d + 0.03); g.gain.exponentialRampToValueAtTime(0.0001, t + d + 0.4);
    o.start(t + d); o.stop(t + d + 0.42);
  }
}
// 1.13: call tones made with WebAudio (no sound files), Iranian phone style: 425 Hz ringback 1 s on / 4 s off,
// busy 0.5 / 0.5, three rising notes when the user can't be reached, a short end tone, and a soft ring.
const rep = (n, a) => Array.from({ length: n }, () => a).flat();
const TONES = {
  ringback: { loop: true, segs: [[1000, 425], [4000]] },
  busy: { segs: rep(4, [[500, 425], [500]]) },
  unreachable: { segs: rep(2, [[330, 950], [330, 1400], [330, 1800], [900]]) },
  end: { segs: [[180, 425], [120], [180, 425], [120], [180, 425]] },
  ring: { loop: true, segs: [[400, 784, 1568], [400, 659, 1318], [400, 784, 1568], [400, 659, 1318], [2000]] },
};
let toneTimer = null, toneNodes = new Set();
function playTone(name) {
  stopTone();
  const p = TONES[name];
  if (!p || !actx) return;
  const len = p.segs.reduce((a, s) => a + s[0], 0);
  const once = () => {
    let t = actx.currentTime + 0.03;
    for (const [ms, ...hz] of p.segs) {
      const d = ms / 1000;
      for (const f of hz) {
        const o = actx.createOscillator(), g = actx.createGain(), v = 0.2 / hz.length;
        o.frequency.value = f; o.connect(g); g.connect(actx.destination);
        g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(v, t + 0.008);
        g.gain.setValueAtTime(v, t + d - 0.008); g.gain.linearRampToValueAtTime(0, t + d);
        o.onended = () => toneNodes.delete(o);
        toneNodes.add(o); o.start(t); o.stop(t + d);
      }
      t += d;
    }
  };
  once();
  if (p.loop) toneTimer = setInterval(once, len);
}
function stopTone() {
  clearInterval(toneTimer); toneTimer = null;
  for (const o of toneNodes) { try { o.stop(); } catch { } }
  toneNodes.clear();
}
function startRing() { stopRing(); playTone('ring'); ring = setInterval(() => { if (navigator.vibrate) navigator.vibrate([800, 1200]); }, 2000); if (navigator.vibrate) navigator.vibrate([800, 1200]); }
function stopRing() { if (ring) { clearInterval(ring); ring = null; stopTone(); if (navigator.vibrate) navigator.vibrate(0); } }
export function notifySound() { beep(880, 990); }
