'use strict';
/**
 * 1.19: group calls (voice now, video later), modelled on WhatsApp and Telegram.
 *
 * A call is a "room" held in memory only. Every phone opens a direct WebRTC connection to every other
 * participant (mesh), through the same TURN server as 1:1 calls; the media stays end-to-end encrypted
 * (DTLS-SRTP between each pair) and the SDP/ICE signalling between each pair is encrypted with the pair's keys,
 * so the server only learns who is in which call and when. Nothing about a group call is stored.
 *
 * A room starts from a group chat (key all / g:<id>) or from a list of people (the Calls tab, or a 1:1 call
 * that gets a third person). Group members may all see and join a group room; anyone else must be invited.
 * Only the person who started the call may mute others or remove them. The call ends when the last one leaves.
 *
 * Admin panel settings (card «تماس گروهی»): on/off, the group «همه» on/off, groups turned off one by one,
 * the most people in a voice / video call, the most calls at the same time.
 */
const crypto = require('node:crypto');
const { getSetting, setSetting } = require('./db');

const RING_MS = 45e3;          // an unanswered ring stops after this (like a 1:1 call)
const GONE_MS = 30e3;          // a participant whose app lost its connection this long is taken out
const ADHOC_MAX_INVITE = 16;   // most people one invite may name

const DEFAULTS = { on: true, all: false, off_groups: '', max_voice: 8, max_video: 4, max_rooms: 5, video: false };

function int(key, def, min, max) {
  const n = Number(getSetting(key, String(def)));
  return Number.isFinite(n) ? Math.min(max, Math.max(min, Math.round(n))) : def;
}
const offGroups = () => getSetting('gcall_off_groups', DEFAULTS.off_groups).split(/[\s,]+/).filter((k) => /^g:\d+$|^all$/.test(k));

function cfg() {
  return {
    on: getSetting('gcall_on', DEFAULTS.on ? '1' : '0') === '1',
    all: getSetting('gcall_all', DEFAULTS.all ? '1' : '0') === '1',
    off_groups: offGroups(),
    max_voice: int('gcall_max_voice', DEFAULTS.max_voice, 2, 8),
    max_video: int('gcall_max_video', DEFAULTS.max_video, 2, 4),
    max_rooms: int('gcall_max_rooms', DEFAULTS.max_rooms, 1, 50),
    // video group calls come in a later release; until then the apps only offer voice
    video: getSetting('gcall_video', DEFAULTS.video ? '1' : '0') === '1',
  };
}

/** Saves the fields present in b (admin panel); throws Error('bad_gcall_settings'). */
function setCfg(b) {
  const bad = () => { throw new Error('bad_gcall_settings'); };
  const out = [];
  const bool = (k, v) => { if (typeof v !== 'boolean') bad(); out.push([k, v ? '1' : '0']); };
  const num = (k, v, min, max) => { const n = Number(v); if (!Number.isInteger(n) || n < min || n > max) bad(); out.push([k, String(n)]); };
  if (b.on !== undefined) bool('gcall_on', b.on);
  if (b.all !== undefined) bool('gcall_all', b.all);
  if (b.video !== undefined) bool('gcall_video', b.video);
  if (b.max_voice !== undefined) num('gcall_max_voice', b.max_voice, 2, 8);
  if (b.max_video !== undefined) num('gcall_max_video', b.max_video, 2, 4);
  if (b.max_rooms !== undefined) num('gcall_max_rooms', b.max_rooms, 1, 50);
  if (b.off_groups !== undefined) {
    const list = Array.isArray(b.off_groups) ? b.off_groups : String(b.off_groups).split(/[\s,]+/).filter(Boolean);
    if (list.some((k) => !/^g:\d+$|^all$/.test(k))) bad();
    out.push(['gcall_off_groups', [...new Set(list)].join(',')]);
  }
  for (const [k, v] of out) setSetting(k, v);
  return cfg();
}

/** May a call be started in this group? (the group «همه» only when the admin allows it) */
function groupAllowed(gkey, c = cfg()) {
  if (!c.on) return false;
  if (gkey === 'all' && !c.all) return false;
  if (c.off_groups.includes(gkey)) return false;
  // 1.20: a group a user made: the panel switch for user groups, and the owner's own switch
  const g = require('./core').groupByKey(gkey);
  if (g && g.kind === 'user') return getSetting('ugroups_calls', '1') === '1' && !!g.call_on && !g.frozen;
  return true;
}

/**
 * deps: { core, emit(user, event, data), isConnected(user), usage }
 */
function create(deps) {
  const { core, emit, isConnected } = deps;
  const rooms = new Map(); // id -> room

  const now = () => Date.now();
  const pub = (u) => { const r = core.q.user.get(u); return r && r.pubkey ? r.pubkey : null; };
  const nameOf = (gkey) => { const g = core.groupByKey(gkey); return g ? g.name : ''; };

  /** Everyone who may see the room (and get its updates). */
  function audience(r) {
    const s = new Set(r.extra);
    if (r.gkey) { const g = core.groupByKey(r.gkey); if (g) for (const u of core.membersOf(g.id)) s.add(u); }
    for (const u of r.parts.keys()) s.add(u);
    return s;
  }
  const mayJoin = (r, u) => audience(r).has(u);

  function view(r) {
    const keys = {};
    const ringing = [];
    const t = now();
    for (const [u, at] of r.invited) if (t - at < RING_MS && !r.parts.has(u)) ringing.push(u);
    for (const u of [...r.parts.keys(), ...ringing]) { const k = pub(u); if (k) keys[u] = k; }
    return {
      id: r.id, group: r.gkey, title: r.gkey ? nameOf(r.gkey) : '', host: r.host, video: r.video, started: r.started,
      parts: [...r.parts.entries()].map(([u, p]) => ({ u, muted: !!p.muted, hand: p.hand || 0, joined: p.joined })),
      ringing, members: r.gkey ? [] : [...r.extra], keys, max: r.max,
    };
  }
  function announce(r) {
    const v = view(r);
    for (const u of audience(r)) emit(u, 'gcall', { room: v });
  }
  function ring(r, users) {
    const v = view(r);
    for (const u of users) emit(u, 'gcall', { room: v, ring: true, by: r.host });
  }
  function end(r) {
    if (!rooms.has(r.id)) return;
    rooms.delete(r.id);
    for (const [u, p] of r.parts) count(u, p);
    r.parts.clear();
    for (const u of audience(r)) emit(u, 'gcall_end', { id: r.id, group: r.gkey });
  }
  function count(u, p) {
    if (deps.usage && p.joined) deps.usage.add(u, 'call_secs', Math.round((now() - p.joined) / 1000));
  }

  const err = (code, error) => { const e = new Error(error); e.code = code; return e; };

  function inCall(u) { for (const r of rooms.values()) if (r.parts.has(u)) return r; return null; }

  /**
   * Starts a call. b: { group?: gkey, users?: [names], video?: bool, ring?: [names] }.
   * From a group: ring = who rings (default everyone when the group has up to 8 members, nobody otherwise:
   * then the others see only the «پیوستن» bar). From a list of people: they all ring.
   */
  function start(user, b) {
    const c = cfg();
    if (!c.on) throw err(403, 'gcall_off');
    const video = !!b.video;
    if (video && !c.video) throw err(403, 'gcall_video_off');
    if (rooms.size >= c.max_rooms) throw err(429, 'gcall_busy');
    const r = {
      id: crypto.randomBytes(8).toString('hex'), gkey: null, host: user, video, started: now(),
      parts: new Map(), invited: new Map(), extra: new Set([user]), max: video ? c.max_video : c.max_voice, gone: new Map(),
    };
    let toRing = [];
    if (b.group != null) {
      const gkey = String(b.group);
      const g = core.groupByKey(gkey);
      if (!g) throw err(404, 'no_such_group');
      if (!core.isMember(user, g.id)) throw err(403, 'not_member');
      if (!groupAllowed(gkey, c)) throw err(403, 'gcall_off_here');
      for (const o of rooms.values()) if (o.gkey === gkey) throw Object.assign(err(409, 'gcall_running'), { room: view(o) });
      r.gkey = gkey;
      const members = core.membersOf(g.id).filter((u) => u !== user);
      if (Array.isArray(b.ring)) toRing = b.ring.map((x) => String(x).toLowerCase()).filter((u) => members.includes(u));
      else if (members.length + 1 <= 8) toRing = members; // a group of up to 8 people rings everyone
      toRing = toRing.slice(0, ADHOC_MAX_INVITE);
    } else {
      const list = [...new Set((Array.isArray(b.users) ? b.users : []).map((x) => String(x).toLowerCase()))].filter((u) => u !== user);
      if (!list.length) throw err(400, 'no_users');
      if (list.length > ADHOC_MAX_INVITE || list.length + 1 > r.max) throw err(400, 'too_many');
      for (const u of list) {
        if (!core.activeUser(u)) throw err(404, 'no_such_user');
        if (!core.canDM(user, u)) throw err(403, 'not_allowed');
      }
      for (const u of list) r.extra.add(u);
      toRing = list;
    }
    if (inCall(user)) leave(user, inCall(user).id);
    rooms.set(r.id, r);
    r.parts.set(user, { joined: now(), muted: false, hand: 0 });
    if (deps.usage) deps.usage.add(user, 'calls_out', 1);
    for (const u of toRing) r.invited.set(u, now());
    announce(r);
    ring(r, toRing);
    return view(r);
  }

  function get(id) {
    const r = rooms.get(String(id || ''));
    if (!r) throw err(404, 'no_such_call');
    return r;
  }

  function join(user, id) {
    const r = get(id);
    if (!mayJoin(r, user)) throw err(403, 'not_invited');
    if (r.gkey && !groupAllowed(r.gkey)) throw err(403, 'gcall_off_here');
    if (!r.parts.has(user)) {
      if (r.parts.size >= r.max) throw err(409, 'gcall_full');
      const other = inCall(user);
      if (other) leave(user, other.id);
      r.parts.set(user, { joined: now(), muted: false, hand: 0 });
      r.invited.delete(user);
      if (deps.usage) deps.usage.add(user, 'calls_in', 1);
      announce(r);
    }
    return view(r);
  }

  function leave(user, id) {
    const r = rooms.get(String(id || ''));
    if (!r) return;
    const p = r.parts.get(user);
    if (p) { count(user, p); r.parts.delete(user); }
    r.invited.delete(user);
    if (!r.parts.size) return end(r);
    announce(r);
  }

  function decline(user, id) {
    const r = rooms.get(String(id || ''));
    if (!r || !r.invited.has(user)) return;
    r.invited.delete(user);
    announce(r);
  }

  /** A participant asks more people in (WhatsApp «افزودن شرکت‌کننده»); they must be allowed to call them. */
  function invite(user, id, users) {
    const r = get(id);
    if (!r.parts.has(user)) throw err(403, 'not_in_call');
    const list = [...new Set((Array.isArray(users) ? users : []).map((x) => String(x).toLowerCase()))].filter((u) => u !== user && !r.parts.has(u));
    if (!list.length) return view(r);
    if (list.length > ADHOC_MAX_INVITE) throw err(400, 'too_many');
    const members = r.gkey ? new Set(audience(r)) : new Set();
    for (const u of list) {
      if (!core.activeUser(u)) throw err(404, 'no_such_user');
      if (!members.has(u) && !core.canDM(user, u)) throw err(403, 'not_allowed');
    }
    for (const u of list) { r.extra.add(u); r.invited.set(u, now()); }
    announce(r);
    ring(r, list);
    return view(r);
  }

  /** Live signalling between two participants (offer / answer / ice), encrypted by the apps. */
  function sig(user, id, to, kind, payload) {
    const r = get(id);
    to = String(to || '').toLowerCase();
    if (!r.parts.has(user) || !r.parts.has(to) || to === user) throw err(403, 'not_in_call');
    if (!['offer', 'answer', 'ice', 'bye'].includes(kind)) throw err(400, 'bad_kind');
    if (typeof payload !== 'string' || payload.length > 65536) throw err(400, 'bad_payload');
    return emit(to, 'gsig', { id: r.id, from: user, kind, payload });
  }

  /** Own state: muted, hand raised, or a short reaction shown to everyone in the call. */
  function act(user, id, b) {
    const r = get(id);
    const p = r.parts.get(user);
    if (!p) throw err(403, 'not_in_call');
    let changed = false;
    if (typeof b.muted === 'boolean' && b.muted !== p.muted) { p.muted = b.muted; changed = true; }
    if (typeof b.hand === 'boolean') { const h = b.hand ? (p.hand || now()) : 0; if (h !== p.hand) { p.hand = h; changed = true; } }
    if (changed) announce(r);
    if (b.react != null) {
      if (typeof b.react !== 'string' || !deps.okEmoji(b.react)) throw err(400, 'bad_emoji');
      for (const u of r.parts.keys()) emit(u, 'gcall_react', { id: r.id, from: user, emoji: b.react });
    }
    return view(r);
  }

  /** The starter of the call mutes someone (they may unmute themselves) or takes them out. */
  function host(user, id, target, action) {
    const r = get(id);
    if (r.host !== user || !r.parts.has(user)) throw err(403, 'not_host');
    target = String(target || '').toLowerCase();
    const p = r.parts.get(target);
    if (!p || target === user) throw err(404, 'not_in_call');
    if (action === 'mute') {
      p.muted = true;
      emit(target, 'gcall_host', { id: r.id, action: 'mute', by: user });
      announce(r);
    } else if (action === 'remove') {
      emit(target, 'gcall_host', { id: r.id, action: 'remove', by: user });
      count(target, p);
      r.parts.delete(target);
      r.extra.delete(target);
      for (const u of r.parts.keys()) emit(u, 'gsig', { id: r.id, from: target, kind: 'bye', payload: '' });
      announce(r);
    } else throw err(400, 'bad_action');
    return view(r);
  }

  /** The calls this user may see (the «پیوستن» bar after a reconnect). */
  function list(user) {
    const out = [];
    for (const r of rooms.values()) if (mayJoin(r, user)) out.push(view(r));
    return out;
  }

  /** Every 10 s: takes out people whose app is gone, and ends empty rooms. */
  function sweep() {
    const t = now();
    for (const r of [...rooms.values()]) {
      let changed = false;
      for (const u of [...r.parts.keys()]) {
        if (isConnected(u)) { r.gone.delete(u); continue; }
        if (!r.gone.has(u)) { r.gone.set(u, t); continue; }
        if (t - r.gone.get(u) > GONE_MS) {
          count(u, r.parts.get(u)); r.parts.delete(u); r.gone.delete(u); changed = true;
          for (const o of r.parts.keys()) emit(o, 'gsig', { id: r.id, from: u, kind: 'bye', payload: '' });
        }
      }
      for (const [u, at] of [...r.invited]) if (t - at > RING_MS) { r.invited.delete(u); changed = true; }
      if (!r.parts.size) end(r);
      else if (changed) announce(r);
      if (t - r.started > 12 * 3600e3) end(r); // nothing lasts forever
    }
  }

  /** A user was disabled or deleted: out of every call. */
  function dropUser(u) { for (const r of [...rooms.values()]) if (r.parts.has(u) || r.invited.has(u)) leave(u, r.id); }

  return { start, join, leave, decline, invite, sig, act, host, list, sweep, dropUser, inCall, rooms, view };
}

module.exports = { cfg, setCfg, groupAllowed, create, RING_MS, GONE_MS };
