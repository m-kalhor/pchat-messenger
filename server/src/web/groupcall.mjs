// 1.19: group voice calls (mesh), compatible with android/.../GroupCall.kt.
// The server keeps the "room" (who is in, who rings, hands, mutes) and relays the signalling; every pair of
// participants has its own WebRTC connection, and the SDP / ICE between them is end-to-end encrypted with the
// pair's keys. The newcomer sends the offers; the people already in the call answer.
// 1.23: video. Every connection between two 1.23+ apps carries one video line from the start (the offer says
// v:1), so turning a camera on or off only swaps the track that is sent, with no new offer/answer. An older app
// (no v:1) gets no video from us. The server keeps who has the camera on (part.cam, at most max_cam at once).
import * as api from './api.mjs';
import * as E from './engine.mjs';
import * as Call from './call.mjs';

export const G = {
  phase: 'idle',      // idle | incoming | joining | active
  room: null,         // the room this browser rings for or is in (server view)
  rooms: new Map(),   // id -> view of every call I may see (the «پیوستن» bars)
  by: '',             // who started the call that rings
  muted: false, hand: false, joinedAt: 0, note: '',
  levels: {},         // username -> 0..1 (who is speaking)
  volume: {},         // username -> 0..1 (per person, like Telegram)
  reacts: [],         // [{ from, emoji, t }]
  cam: false,         // 1.23: my camera is on
  front: true,        // front camera (mirror my own picture)
  videos: {},         // username -> MediaStream with their video (mine too, while the camera is on)
  pin: '',            // the person shown big
};
const GROUP_KBPS = 500; // the video each phone sends to each other phone (~360p)
const listeners = new Set();
export const onGcall = (fn) => { listeners.add(fn); return () => listeners.delete(fn); };
const changed = () => { for (const fn of listeners) { try { fn(G); } catch (e) { console.error(e); } } };
function set(p) { Object.assign(G, p); changed(); }

const peers = new Map(); // username -> { pc, audio, ice: [], remoteSet }
let local = null, cam = null, turnCfg = null, ringTimer = null, levelTimer = null;

export const cfg = () => (E.S.meInfo && E.S.meInfo.gcall) || { on: false };
export const busy = () => G.phase === 'active' || G.phase === 'joining';
Call.setBusyHook(busy);
Call.setUpgradeHook({
  join: (id) => join(id),
  // my 1:1 call became this room (I started it from the call screen)
  adopt: async (room) => { try { local = await mic(); await enter(room); } catch (e) { toast(errText(e)); api.gcall('leave', { id: room.id }).catch(() => { }); } },
});
export const roomOf = (convo) => [...G.rooms.values()].find((r) => r.group === convo) || null;
export const videoOn = () => !!cfg().video && !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia);
const myPart = (r) => r && r.parts.find((p) => p.u === me());
const me = () => E.S.me;
const inRoom = (r, u) => !!r && r.parts.some((p) => p.u === u);

// ---------------- actions ----------------

/** From a group chat (ring: who rings in a big group) or with chosen people (users). */
export async function start(opts) {
  if (busy() || Call.C.phase !== 'idle') return toast('اول تماس فعلی را تمام کنید');
  Call.unlockAudio();
  try {
    local = await mic();
    const r = await api.gcall('start', opts);
    await enter(r.room);
    Call.playTone('ringback');
    setTimeout(() => { if (G.room && G.room.parts.length <= 1) Call.stopTone(); }, 45000);
  } catch (e) {
    stopLocal();
    if (e && e.body && e.body.error === 'gcall_running' && e.body.room) { G.rooms.set(e.body.room.id, e.body.room); changed(); return join(e.body.room.id); }
    toast(errText(e));
  }
}

export async function join(id) {
  if (busy() || Call.C.phase !== 'idle') return toast('اول تماس فعلی را تمام کنید');
  const known = G.rooms.get(id) || (G.room && G.room.id === id ? G.room : null);
  const wantCam = !!(known && known.video) && videoOn();
  Call.unlockAudio(); Call.stopRing(); clearTimeout(ringTimer);
  set({ phase: 'joining', note: 'در حال پیوستن…' });
  try {
    if (!local) local = await mic();
    const r = await api.gcall('join', { id, cam: wantCam });
    await enter(r.room);
    // the newcomer calls everyone already in the call
    for (const p of r.room.parts) if (p.u !== me()) offerTo(p.u).catch(() => { });
  } catch (e) {
    stopLocal();
    set({ phase: 'idle', room: null, note: '' });
    toast(errText(e));
  }
}
export const accept = () => G.room && join(G.room.id);
export function decline() {
  if (G.phase !== 'incoming' || !G.room) return;
  const id = G.room.id;
  Call.stopRing(); clearTimeout(ringTimer);
  api.gcall('decline', { id }).catch(() => { });
  set({ phase: 'idle', room: null });
}

export async function leave(note) {
  if (!G.room || G.phase === 'idle') return;
  const r = G.room;
  api.gcall('leave', { id: r.id }).catch(() => { });
  finish(note || '');
}

export function toggleMute() {
  const m = !G.muted;
  if (local) for (const t of local.getAudioTracks()) t.enabled = !m;
  set({ muted: m });
  if (G.room) api.gcall('act', { id: G.room.id, muted: m }).catch(() => { });
}
export function toggleHand() {
  const h = !G.hand;
  set({ hand: h });
  if (G.room) api.gcall('act', { id: G.room.id, hand: h }).catch(() => { });
}
export function react(emoji) { if (G.room) api.gcall('act', { id: G.room.id, react: emoji }).catch((e) => toast(errText(e))); }
export async function invite(users) {
  if (!G.room || !users.length) return;
  try { const r = await api.gcall('invite', { id: G.room.id, users }); update(r.room); } catch (e) { toast(errText(e)); }
}
export async function host(u, action) {
  if (!G.room) return;
  try { const r = await api.gcall('host', { id: G.room.id, user: u, action }); update(r.room); } catch (e) { toast(errText(e)); }
}
export function setVolume(u, v) {
  G.volume[u] = v;
  const p = peers.get(u);
  if (p && p.audio) p.audio.volume = v;
  changed();
}

// ---------------- room state ----------------

async function enter(room) {
  turnCfg = await api.turn();
  set({ phase: 'active', room, muted: false, hand: false, joinedAt: Date.now(), note: '', levels: {}, reacts: [] });
  G.rooms.set(room.id, room);
  keepAwake();
  startLevels();
  const mine = myPart(room);
  if (mine && mine.cam) {
    try { await camOn(); } catch (e) { toast(camErr(e)); api.gcall('act', { id: room.id, cam: false }).then((x) => update(x.room)).catch(() => { }); }
  }
}

// ---------------- 1.23: camera ----------------

async function camOn() {
  if (cam) return;
  cam = await navigator.mediaDevices.getUserMedia({ video: { width: { ideal: 640 }, height: { ideal: 360 }, frameRate: { ideal: 15, max: 20 }, facingMode: G.front ? 'user' : 'environment' }, audio: false });
  if (!G.room) { stopCam(); return; }
  G.cam = true;
  G.videos[me()] = cam;
  for (const p of peers.values()) applyVideo(p);
  changed();
}
function stopCam() {
  if (cam) for (const t of cam.getTracks()) t.stop();
  cam = null;
  G.cam = false;
  delete G.videos[me()];
  for (const p of peers.values()) applyVideo(p);
}
function camErr(e) { return e && e.name === 'NotAllowedError' ? 'اجازهٔ دسترسی به دوربین داده نشد' : (e && e.body ? errText(e) : 'دوربین روشن نشد'); }

/** Camera on / off (the server keeps the count: at most max_cam cameras at once). */
export async function toggleCam() {
  if (!G.room || G.phase !== 'active') return;
  const id = G.room.id;
  if (G.cam) {
    stopCam(); changed();
    try { update((await api.gcall('act', { id, cam: false })).room); } catch { }
    return;
  }
  if (!videoOn()) return toast(ERRS.gcall_video_off);
  try {
    update((await api.gcall('act', { id, cam: true })).room);
    await camOn();
  } catch (e) {
    toast(camErr(e));
    if (!(e && e.body)) api.gcall('act', { id, cam: false }).then((x) => update(x.room)).catch(() => { });
  }
}
/** Front / back camera (phones). */
export async function switchCam() {
  if (!cam) return;
  G.front = !G.front;
  const old = cam;
  try {
    cam = null;
    await camOn();
    for (const t of old.getTracks()) t.stop();
  } catch (e) { cam = old; G.front = !G.front; G.videos[me()] = old; toast('دوربین دیگری پیدا نشد'); }
  changed();
}
export function pin(u) { set({ pin: G.pin === u ? '' : u }); }

/** What this connection sends on its video line: my camera, if it is on and the other app shows video. */
function applyVideo(p) {
  if (!p.vt) return;
  const track = G.cam && cam && p.v ? cam.getVideoTracks()[0] || null : null;
  try {
    p.vt.sender.replaceTrack(track).catch(() => { });
    if (track) {
      const prm = p.vt.sender.getParameters();
      if (!prm.encodings || !prm.encodings.length) prm.encodings = [{}];
      prm.encodings[0].maxBitrate = GROUP_KBPS * 1000;
      p.vt.sender.setParameters(prm).catch(() => { });
    }
  } catch { }
}

function update(room) {
  G.rooms.set(room.id, room);
  if (G.room && G.room.id === room.id) {
    G.room = room;
    if (G.phase === 'active') {
      if (room.parts.length > 1) Call.stopTone();
      for (const u of [...peers.keys()]) if (!inRoom(room, u)) dropPeer(u);
      if (!inRoom(room, me())) return finish('شما از تماس بیرون رفتید');
    }
  }
  changed();
}

function finish(note) {
  const r = G.room;
  const was = G.phase === 'active';
  for (const u of [...peers.keys()]) dropPeer(u);
  stopLocal(); stopCam(); stopLevels(); Call.stopRing(); Call.stopTone(); clearTimeout(ringTimer);
  if (wake) { wake.release().catch(() => { }); wake = null; }
  if (was && r) {
    const s = Math.round((Date.now() - G.joinedAt) / 1000);
    E.addCallLog(r.group || r.host, `تماس گروهی (${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')})`, r.host === me());
    Call.playTone('end');
  }
  set({ phase: 'idle', room: null, muted: false, hand: false, levels: {}, note, videos: {}, pin: '' });
  if (note) toast(note);
}

async function refresh() {
  try {
    const r = await api.gcallList();
    if (E.S.meInfo) E.S.meInfo.gcall = r.cfg;
    G.rooms = new Map(r.rooms.map((x) => [x.id, x]));
    if (G.room && !G.rooms.has(G.room.id) && G.phase !== 'idle') finish('تماس گروهی پایان یافت');
    else if (G.room && G.rooms.has(G.room.id)) update(G.rooms.get(G.room.id));
    changed();
  } catch { }
}

E.setGcallHook((ev, o) => {
  if (ev === 'refresh') return refresh();
  if (ev === 'gcall') {
    const room = o.room;
    if (o.ring && G.phase === 'idle' && Call.C.phase === 'idle' && !inRoom(room, me())) {
      G.rooms.set(room.id, room);
      set({ phase: 'incoming', room, by: o.by || room.host });
      Call.unlockAudio(); Call.startRing();
      notify(room);
      ringTimer = setTimeout(() => {
        if (G.phase === 'incoming' && G.room && G.room.id === room.id) {
          Call.stopRing();
          E.addCallLog(room.group || room.host, 'تماس گروهی از دست رفته', false);
          set({ phase: 'idle', room: null });
        }
      }, 45000);
      return;
    }
    return update(room);
  }
  if (ev === 'gcall_end') {
    G.rooms.delete(o.id);
    if (G.room && G.room.id === o.id) {
      if (G.phase === 'incoming') { Call.stopRing(); clearTimeout(ringTimer); E.addCallLog(G.room.group || G.room.host, 'تماس گروهی از دست رفته', false); set({ phase: 'idle', room: null }); }
      else finish('');
    }
    return changed();
  }
  if (ev === 'gsig') return onSig(o);
  if (ev === 'gcall_react') {
    if (!G.room || o.id !== G.room.id) return;
    G.reacts.push({ from: o.from, emoji: o.emoji, t: Date.now() });
    changed();
    setTimeout(() => { G.reacts = G.reacts.filter((x) => Date.now() - x.t < 3000); changed(); }, 3100);
    return;
  }
  if (ev === 'gcall_host') {
    if (!G.room || o.id !== G.room.id) return;
    if (o.action === 'mute') {
      if (local) for (const t of local.getAudioTracks()) t.enabled = false;
      set({ muted: true });
      toast(E.nameOf(o.by) + ' صدای شما را بست؛ هر وقت خواستید خودتان باز کنید');
    } else if (o.action === 'remove') finish(E.nameOf(o.by) + ' شما را از تماس بیرون برد');
  }
});

// ---------------- WebRTC mesh ----------------

function keyOf(u) { return (G.room && G.room.keys && G.room.keys[u]) || null; }
async function send(u, kind, body) {
  if (!G.room) return;
  const pub = keyOf(u);
  if (!pub) return;
  try { await api.gcall('sig', { id: G.room.id, to: u, kind, payload: await E.encryptTo(u, pub, body) }); } catch { }
}

function peer(u, offerer = false) {
  let p = peers.get(u);
  if (p) return p;
  const servers = [{ urls: turnCfg.urls, username: turnCfg.username, credential: turnCfg.credential }];
  const pc = new RTCPeerConnection({ iceServers: servers, iceTransportPolicy: turnCfg.policy === 'relay' ? 'relay' : 'all', bundlePolicy: 'max-bundle' });
  const audio = new Audio();
  audio.autoplay = true;
  audio.volume = G.volume[u] != null ? G.volume[u] : 1;
  p = { pc, audio, ice: [], remoteSet: false, vt: null, v: false };
  peers.set(u, p);
  if (local) for (const t of local.getTracks()) pc.addTrack(t, local);
  // 1.23: the offer always has a video line (an older app answers it but gets nothing)
  if (offerer) p.vt = pc.addTransceiver('video', { direction: 'sendrecv' });
  pc.onicecandidate = (e) => { if (e.candidate) send(u, 'ice', { cand: e.candidate.candidate, mid: e.candidate.sdpMid, idx: e.candidate.sdpMLineIndex }); };
  pc.ontrack = (e) => {
    if (e.track.kind === 'video') { G.videos[u] = new MediaStream([e.track]); changed(); return; }
    audio.srcObject = new MediaStream([e.track]); audio.play().catch(() => { });
  };
  pc.onconnectionstatechange = () => {
    if (pc.connectionState === 'failed' && peers.get(u) === p && G.room && inRoom(G.room, u)) {
      // try again once from scratch; the side with the smaller name makes the new offer
      dropPeer(u);
      if (me() < u) offerTo(u).catch(() => { });
    }
    changed();
  };
  return p;
}

async function offerTo(u) {
  const p = peer(u, true);
  const o = await p.pc.createOffer();
  await p.pc.setLocalDescription(o);
  await send(u, 'offer', { sdp: o.sdp, v: 1 });
}

function dropPeer(u) {
  const p = peers.get(u);
  if (!p) return;
  peers.delete(u);
  try { p.pc.close(); } catch { }
  try { p.audio.srcObject = null; } catch { }
  delete G.levels[u];
  delete G.videos[u];
}

async function onSig(o) {
  if (!G.room || o.id !== G.room.id || G.phase !== 'active') return;
  const u = o.from;
  if (o.kind === 'bye') { dropPeer(u); return changed(); }
  const j = await E.decryptWith(u, keyOf(u), o.payload);
  if (!j) return;
  try {
    if (o.kind === 'offer') {
      if (peers.has(u)) { const old = peers.get(u).pc; if (old.signalingState !== 'stable' || ['failed', 'closed'].includes(old.connectionState) || old.remoteDescription) dropPeer(u); }
      const p = peer(u);
      p.v = j.v === 1;
      await p.pc.setRemoteDescription({ type: 'offer', sdp: j.sdp });
      p.remoteSet = true;
      if (p.v && !p.vt) {
        p.vt = p.pc.getTransceivers().find((t) => t.receiver && t.receiver.track && t.receiver.track.kind === 'video') || null;
        if (p.vt) p.vt.direction = 'sendrecv';
      }
      applyVideo(p);
      for (const c of p.ice.splice(0)) await p.pc.addIceCandidate(c).catch(() => { });
      const a = await p.pc.createAnswer();
      await p.pc.setLocalDescription(a);
      await send(u, 'answer', { sdp: a.sdp, v: 1 });
    } else if (o.kind === 'answer') {
      const p = peers.get(u);
      if (!p) return;
      await p.pc.setRemoteDescription({ type: 'answer', sdp: j.sdp });
      p.remoteSet = true;
      p.v = j.v === 1;
      applyVideo(p);
      for (const c of p.ice.splice(0)) await p.pc.addIceCandidate(c).catch(() => { });
    } else if (o.kind === 'ice') {
      const c = { candidate: j.cand, sdpMid: j.mid, sdpMLineIndex: j.idx };
      const p = peers.get(u) || peer(u);
      if (p.remoteSet) await p.pc.addIceCandidate(c).catch(() => { });
      else p.ice.push(c);
    }
  } catch (e) { console.error('gcall sig', e); }
}

/** Who is speaking: the audio level of every connection, twice a second. */
function startLevels() {
  stopLevels();
  levelTimer = setInterval(async () => {
    const lv = {};
    for (const [u, p] of peers) {
      try {
        const st = await p.pc.getStats();
        st.forEach((r) => {
          if (r.type === 'inbound-rtp' && r.kind === 'audio' && r.audioLevel != null) lv[u] = r.audioLevel;
          if (r.type === 'media-source' && r.kind === 'audio' && r.audioLevel != null) lv[me()] = Math.max(lv[me()] || 0, r.audioLevel);
        });
      } catch { }
    }
    if (G.muted) lv[me()] = 0;
    G.levels = lv;
    changed();
  }, 500);
}
function stopLevels() { clearInterval(levelTimer); levelTimer = null; }

async function mic() {
  return navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true }, video: false });
}
function stopLocal() { if (local) for (const t of local.getTracks()) t.stop(); local = null; }

let wake = null;
async function keepAwake() { try { if ('wakeLock' in navigator) wake = await navigator.wakeLock.request('screen'); } catch { } }

function notify(room) {
  try {
    if (document.visibilityState === 'visible' || !('Notification' in window) || Notification.permission !== 'granted') return;
    new Notification('تماس گروهی', { body: (room.title || E.nameOf(room.host)) + ' — ' + E.nameOf(room.host), tag: 'gcall' });
  } catch { }
}

const ERRS = {
  gcall_off: 'تماس گروهی در این سرور خاموش است', gcall_off_here: 'تماس گروهی در این گروه خاموش است',
  gcall_full: 'تماس پر است', gcall_busy: 'الان تماس‌های گروهی زیادی در جریان است؛ کمی بعد دوباره امتحان کنید',
  not_invited: 'شما به این تماس دعوت نشده‌اید', no_such_call: 'این تماس تمام شده است', not_allowed: 'فقط با مخاطبان خودتان می‌توانید تماس بگیرید',
  too_many: 'تعداد نفرات بیش از حد مجاز است', gcall_video_off: 'ویدیو گروهی در این سرور خاموش است', no_users: 'کسی انتخاب نشده',
  gcall_video_full: 'ظرفیت ویدیو پر است؛ وقتی کسی دوربینش را خاموش کند می‌توانید روشن کنید',
};
function errText(e) {
  if (e && e.name === 'NotAllowedError') return 'اجازهٔ دسترسی به میکروفون داده نشد';
  const code = e && e.body && e.body.error;
  return ERRS[code] || E.errText(e);
}
let toastFn = (t) => console.log(t);
export const setToast = (fn) => { toastFn = fn; };
function toast(t) { toastFn(t); }
