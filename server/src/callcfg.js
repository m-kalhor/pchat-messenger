'use strict';
/**
 * 1.10.1: call path settings, changed in the admin panel (card «تنظیمات تماس») and handed to the apps
 * with every /api/turn answer, so a change works at the next call without an app update.
 *
 *  route       auto   = start direct (peer to peer); when the direct path is bad (ping or packet loss over
 *                       the limits below for ~6 s) the call moves to the server's TURN relay without hanging up
 *              relay  = every call goes through the server from the start
 *              direct = like 1.10.0 and before: direct when possible, never switched
 *  rtt, loss   the limits for "bad" in auto mode (ms, percent)
 *  video_kbps  the most a video call sends (0 = no limit, like before)
 *  tls         also offer TURN over TLS (turns:TURN_TLS_HOST:TURN_TLS_PORT, normally the Let's Encrypt domain
 *              on 5349), for operators that slow down or block plain UDP/TCP 3478. Only when the installer
 *              set coturn up for it (it needs a domain with a real certificate, see domain.sh).
 *
 * Back to the 1.10.0 behaviour: the «مثل نسخهٔ قبل» button in the panel (route=direct, video_kbps=0, tls=off).
 */
const { getSetting, setSetting } = require('./db');

const ROUTES = ['auto', 'relay', 'direct'];
const DEFAULTS = { route: 'auto', rtt: 400, loss: 8, video_kbps: 800, tls: true };
const OLD = { route: 'direct', rtt: 400, loss: 8, video_kbps: 0, tls: false };
const TLS_PORT = Number(process.env.TURN_TLS_PORT || 0) || 0;
const TLS_HOST = /^[a-z0-9.-]+$/i.test(process.env.TURN_TLS_HOST || '') ? process.env.TURN_TLS_HOST : '';

function int(key, def, min, max) {
  const n = Number(getSetting(key, String(def)));
  return Number.isFinite(n) ? Math.min(max, Math.max(min, Math.round(n))) : def;
}

function get() {
  const r = getSetting('call_route', DEFAULTS.route);
  return {
    route: ROUTES.includes(r) ? r : DEFAULTS.route,
    rtt: int('call_switch_rtt', DEFAULTS.rtt, 100, 5000),
    loss: int('call_switch_loss', DEFAULTS.loss, 1, 50),
    video_kbps: int('call_video_kbps', DEFAULTS.video_kbps, 0, 20000),
    tls: getSetting('turn_tls', DEFAULTS.tls ? '1' : '0') === '1',
    tls_available: TLS_PORT > 0 && !!TLS_HOST,
  };
}

/** Saves the fields present in b; throws Error('bad_call_settings') on a bad value. */
function set(b) {
  if (b.reset === 'old' || b.reset === 'default') {
    const v = b.reset === 'old' ? OLD : DEFAULTS;
    setSetting('call_route', v.route); setSetting('call_switch_rtt', String(v.rtt)); setSetting('call_switch_loss', String(v.loss));
    setSetting('call_video_kbps', String(v.video_kbps)); setSetting('turn_tls', v.tls ? '1' : '0');
    return get();
  }
  const bad = () => { throw new Error('bad_call_settings'); };
  const num = (x, min, max) => { const n = Number(x); if (!Number.isInteger(n) || n < min || n > max) bad(); return String(n); };
  const out = [];
  if (b.route !== undefined) { if (!ROUTES.includes(b.route)) bad(); out.push(['call_route', b.route]); }
  if (b.rtt !== undefined) out.push(['call_switch_rtt', num(b.rtt, 100, 5000)]);
  if (b.loss !== undefined) out.push(['call_switch_loss', num(b.loss, 1, 50)]);
  if (b.video_kbps !== undefined) out.push(['call_video_kbps', num(b.video_kbps, 0, 20000)]);
  if (b.tls !== undefined) { if (typeof b.tls !== 'boolean') bad(); out.push(['turn_tls', b.tls ? '1' : '0']); }
  for (const [k, v] of out) setSetting(k, v);
  return get();
}

/**
 * 1.15: users the admin allowed to pick the call path themselves during a call (users tab, column «مسیر تماس»).
 * Nobody by default. Empty the list (untick everyone) to turn the feature off.
 */
const routeUsers = () => getSetting('route_users', '').split(/[\s,،]+/).map((s) => s.trim().toLowerCase()).filter(Boolean);
const routeAllowed = (u) => !!u && routeUsers().includes(String(u).toLowerCase());
function setRouteUsers(s) {
  const list = [...new Set(String(s || '').split(/[\s,،]+/).map((x) => x.trim().replace(/^@/, '').toLowerCase()).filter(Boolean))];
  if (list.some((x) => !/^[a-z0-9_]{2,20}$/.test(x))) throw new Error('bad_username');
  setSetting('route_users', list.join(','));
  return list;
}

/** The ICE server URLs and the call settings for /api/turn (user: who asks, for the 1.15 path choice). */
function turnInfo(host, user) {
  const c = get();
  const urls = [`stun:${host}:3478`, `turn:${host}:3478?transport=udp`, `turn:${host}:3478?transport=tcp`];
  if (c.tls && c.tls_available) urls.push(`turns:${TLS_HOST}:${TLS_PORT}?transport=tcp`);
  return { urls, policy: c.route, switch_rtt: c.rtt, switch_loss: c.loss, video_kbps: c.video_kbps, user_route: routeAllowed(user) };
}

module.exports = { get, set, turnInfo, routeUsers, routeAllowed, setRouteUsers, DEFAULTS, OLD };
