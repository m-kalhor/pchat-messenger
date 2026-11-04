// State and logic of the web app (the counterpart of android/.../Engine.kt): login, live events,
// decrypting and storing messages, the send queue, files and profile. The UI (app.mjs) only reads
// `S` and calls these functions; every change is announced with emit(kind).
import * as api from './api.mjs';
import * as C from './crypto.mjs';
import * as store from './store.mjs';

/** Largest file the web version sends or opens (the browser keeps the whole file in memory). */
export const MAX_FILE_BYTES = 200 * 1024 * 1024;
const td = new TextDecoder();

export const S = {
  me: '', identity: null, ready: false,
  keyStep: null, keyBackup: null, // see checkKey()
  users: [], groups: [], pins: {}, read: {}, typing: {},
  gtyping: {},                // group -> { username: when they last typed }
  receipts: {},               // convo -> { username: { d: delivered up to id, s: seen up to id } }
  rseq: -1,                   // last reaction change seen (-1 = none yet)
  privacy: { hide_seen: false, hide_last_seen: false, findable: true, allow_requests: true },
  meInfo: { diag: false, requests_on: true }, // from /api/me: call diagnostics (admin test feature), message requests on
  convos: new Map(),          // convo -> array of messages, oldest first
  lastId: 0,
  cseq: -1,                   // last edit/delete number seen (-1 = none yet)
  conn: 'offline',            // offline | connecting | online
  requests: { incoming: [], declined: [], blocked: [], outgoing: [] },
  progress: new Map(),        // message id -> 0..1 (upload / download)
  failures: new Map(),        // message id -> error text
  openConvo: null,            // convo on screen
};

const listeners = new Set();
export const on = (fn) => { listeners.add(fn); return () => listeners.delete(fn); };
function emit(kind, data) { for (const fn of listeners) { try { fn(kind, data); } catch (e) { console.error(e); } } }

export let onSignal = () => { };
export const setSignalHandler = (fn) => { onSignal = fn; };
/** 1.8 direct transfer on the same Wi-Fi (lan.mjs): { offer(m), signal(from, payload) } */
let lanHook = null;
export const setLanHook = (o) => { lanHook = o; };

// ---------------- names ----------------
export const isGroup = (c) => c === 'all' || /^g:\d+$/.test(c);
export const user = (u) => S.users.find((x) => x.username === u);
export const nameOf = (u) => (user(u) && user(u).display_name) || u;
export const groupName = (k) => (S.groups.find((g) => g.key === k) || {}).name || (k === 'all' ? 'همه' : 'گروه');
export const titleOf = (c) => (isGroup(c) ? groupName(c) : nameOf(c));
const pubOf = (u) => (u === S.me ? S.identity.pubB64 : (user(u) || {}).pubkey || null);

export function preview(m) {
  if (m.type === 'image') return '🖼 عکس';
  if (m.type === 'voice') return '🎤 پیام صوتی';
  if (m.type === 'location') return '📍 موقعیت مکانی';
  if (m.type === 'file') return '📎 ' + (m.name || 'فایل');
  if (m.type === 'call') return '📞 ' + m.text;
  return m.text || '';
}

export function errText(e) {
  const code = e && (e.body && e.body.error ? e.body.error : e.message);
  switch (code) {
    case 'bad_credentials': return 'نام کاربری یا رمز عبور اشتباه است';
    case 'rate_limited': return 'تلاش زیاد؛ چند دقیقه بعد دوباره امتحان کنید';
    case 'not_allowed': return 'اجازهٔ گفتگو با این کاربر را ندارید';
    case 'not_member': return 'عضو این گروه نیستید';
    case 'no_such_user': return 'کاربری با این نام پیدا نشد';
    case 'file_too_large': return 'حجم فایل بیش از حد مجاز سرور است';
    case 'storage_full': case 'disk_full': return 'فضای سرور پر است';
    case 'avatar_too_large': case 'bad_avatar': return 'عکس پروفایل پذیرفته نشد';
    case 'unauthorized': return 'نشست شما منقضی شده؛ دوباره وارد شوید';
    case 'bad_code': return 'کد درست نیست یا منقضی شده';
    case 'bad_phone': return 'شمارهٔ موبایل درست نیست';
    case 'sms_unavailable': return 'پیامک در دسترس نیست. کد را از دستگاه دیگرتان (تنظیمات › ورود دستگاه تازه) یا از مدیر بگیرید و «کد را دارم» را بزنید.';
    case 'password_login_disabled': return 'ورود با رمز خاموش است؛ با شمارهٔ موبایل وارد شوید';
    case 'no_phone': return 'برای حساب شما شمارهٔ موبایل ثبت نشده؛ از مدیر بخواهید';
    case 'wait': return 'کمی صبر کنید و دوباره بخواهید';
    case 'request_limit': return 'تا وقتی درخواست شما را نپذیرد، بیش از ۳ پیام نمی‌شود فرستاد';
    case 'request_text_only': return 'تا پذیرفته شدن درخواست فقط پیام متنی می‌شود فرستاد';
    case 'not_connected': return 'تماس بعد از پذیرفتن درخواست ممکن است؛ تماس شما به او خبر داده شد';
    case 'sms_foreign': return 'پیامک فقط به شماره‌های ایران (‎+98) فرستاده می‌شود. کد را از دستگاه دیگرتان یا از مدیر بگیرید و «کد را دارم» را بزنید.';
    case 'bad_username': return 'نام کاربری درست نیست';
    case 'bad_password': return 'رمز فعلی (یا کد پیامکی) درست نیست';
    case 'weak_password': return 'رمز تازه باید دست‌کم ۸ نویسه باشد';
    default: break;
  }
  if (e instanceof api.HttpError) return 'خطای سرور (' + e.status + ')';
  if (e && e.userText) return e.userText;
  return 'اتصال به سرور برقرار نشد';
}
const userError = (t) => Object.assign(new Error(t), { userText: t });

// ---------------- start / login ----------------
export async function init() {
  await store.persist();
  S.identity = (await store.kvGet('identity')) || null;
  const token = await store.kvGet('token');
  S.me = (await store.kvGet('me')) || '';
  if (!token || !S.identity || !S.me) { S.ready = true; return false; }
  api.setToken(token);
  S.lastId = (await store.kvGet('last_id')) || 0;
  const cs = await store.kvGet('cseq');
  S.cseq = typeof cs === 'number' ? cs : -1;
  S.users = (await store.kvGet('users')) || [];
  S.groups = (await store.kvGet('groups')) || [];
  S.read = (await store.kvGet('read')) || {};
  const rs = await store.kvGet('rseq');
  S.rseq = typeof rs === 'number' ? rs : -1;
  S.receipts = (await store.kvGet('receipts')) || {};
  S.privacy = (await store.kvGet('privacy')) || S.privacy;
  for (const m of await store.allMsgs()) addLocal(m);
  for (const list of S.convos.values()) list.sort(byOrder);
  for (const m of [...S.convos.values()].flat()) if (m.status === 1 && m.type !== 'text') { m.status = 2; S.failures.set(m.id, 'ارسال قطع شد'); }
  S.ready = true;
  let step = null;
  try { step = await checkKey(); } catch { }
  if (step !== 'choose') startStream();
  refreshAll();
  refreshPush();
  return true;
}

/**
 * Logs in. The account's key lives on the server as a backup locked with the user's key password
 * (v2) or, for accounts from 1.1-1.2, with the login password (v1), so every device uses the same key
 * and old messages stay readable. After the login checkKey() decides whether the user must first
 * restore the key, make a new one or set a key password (S.keyStep); the key screen handles that.
 */
export async function login(username, password) {
  username = username.trim().toLowerCase();
  return finishLogin(await api.login(username, password), password);
}

/** Signs in with a one-time code (SMS, another device of the user, or the admin). */
export async function codeLogin(phone, code) {
  const r = await api.codeLogin(phone.trim(), code.trim(), DEVICE);
  // a new number with open sign-up: the caller asks for a username and calls signup(ticket, …)
  if (r.signup) return { signup: true, ticket: r.ticket, phone: r.phone };
  // no login password here: right after a code sign-in the server accepts the key backup without one
  return finishLogin(r, '');
}

/** Open sign-up: opens the account for a number proven by SMS. Returns null or an error text. */
export async function signup(ticket, username, displayName) {
  try { await finishLogin(await api.signup(ticket, username.trim().toLowerCase(), displayName.trim(), DEVICE), ''); return null; }
  catch (e) {
    const err = e instanceof api.HttpError ? e.body.error : null;
    if (err === 'user_exists') return 'این نام کاربری گرفته شده؛ نام دیگری انتخاب کنید';
    if (err === 'invalid_username') return 'نام کاربری: ۲ تا ۲۰ حرف انگلیسی کوچک، رقم یا _ (فقط رقم نباشد)';
    if (err === 'bad_ticket') return 'زمان ثبت‌نام گذشت؛ دوباره کد بگیرید';
    if (err === 'phone_taken') return 'این شماره همین حالا حساب دارد؛ دوباره وارد شوید';
    return errText(e);
  }
}

/** Members with these mobile numbers (who allow it): [{ phone, username, display_name, connected }]. */
export async function lookup(phones) {
  try { return { matches: (await api.lookup(phones)).matches }; } catch (e) { return { error: errText(e) }; }
}
const isIOS = /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const DEVICE = isIOS ? 'iPhone (وب)' : 'مرورگر (وب)';

async function finishLogin(r, password) {
  let id = S.identity || (await C.newIdentity());
  api.setToken(r.token);
  // a v1 backup opens with the login password: take that key silently (then only a key password is missing)
  if (password && r.key_backup && r.key_backup.v === 1 && r.key_backup.pub !== id.pubB64) {
    try { id = await C.importBackup(r.key_backup, r.username, password); } catch { }
  }
  S.identity = id;
  await store.kvSet('identity', id);
  if (S.me && S.me !== r.username) { await store.wipeAccountData(); resetState(); }
  S.me = r.username;
  await store.kvSet('me', S.me);
  await store.kvSet('token', r.token);
  loginPass = password;
  S.users = (await api.users()).map((u) => (u.username === S.me ? { ...u, pubkey: id.pubB64 } : u));
  await store.kvSet('users', S.users);
  try { await checkKey(r.key_backup); } catch { }
  emit('login');
  if (S.keyStep !== 'choose') startStream();
  refreshAll();
  refreshPush();
  return { ok: true };
}

// ---------------- identity key: restore / new / key password ----------------
// kept in memory only, so the key step right after login needs no second password ('' = signed in by a code)
let loginPass = null;
export const needsAccountPassword = () => loginPass === null;
/** Sends an SMS code that confirms the account instead of the login password. */
/** 1.9: change the login password (current one or an SMS code); other devices are logged out */
export async function changePassword(current, password) { try { await api.changePassword(current, password); return null; } catch (e) { return errText(e); } }
export async function reauthSms() { try { await api.reauthSms(); return null; } catch (e) { return errText(e); } }
/** A one-time code for signing in on a new device: { code, ttl, phone } or { error }. */
export async function deviceCode() { try { return await api.deviceCode(); } catch (e) { return { error: errText(e) }; } }

/**
 * S.keyStep: 'choose' = this device's key is not the account's key (restore it with the key password,
 * or make a new one); 'setpass' = the key is right but has no key password yet (mandatory);
 * null = all good. `kb` is the server's backup when the caller already has it.
 */
export async function checkKey(kb) {
  if (kb === undefined) kb = (await api.getKeyBackup()).key_backup;
  const self = (await api.users()).find((u) => u.username === S.me);
  const serverPub = self ? self.pubkey : null;
  const mine = S.identity.pubB64;
  let step = null;
  if (kb && kb.pub !== mine) step = 'choose';
  else if (!kb && serverPub && serverPub !== mine) step = 'choose';
  else if (!kb || kb.v !== 2) step = 'setpass';
  S.keyBackup = kb || null;
  if (step !== S.keyStep) { S.keyStep = step; emit('key'); }
  if (step === 'choose') stopStream();
  return step;
}

async function uploadBackup(id, keyPassword, accountPassword) {
  const kb = await C.exportBackup(id, S.me, keyPassword);
  await api.saveKeyBackup(kb, accountPassword || loginPass || '');
  if (accountPassword) loginPass = accountPassword;
  S.keyBackup = kb;
}

/** Messages that arrived while the wrong key was in use are fetched and opened again. */
async function retryLocked() {
  let from = 0;
  for (const list of S.convos.values()) {
    for (const m of [...list]) if (m.locked && m.id > 0) { if (!from || m.id < from) from = m.id; removeLocal(m); await store.delMsg(m.id); }
  }
  if (from && from - 1 < S.lastId) { S.lastId = from - 1; await store.kvSet('last_id', S.lastId); }
}

async function keyDone(id) {
  S.identity = id;
  await store.kvSet('identity', id);
  S.users = S.users.map((u) => (u.username === S.me ? { ...u, pubkey: id.pubB64 } : u));
  await retryLocked();
  S.keyStep = null;
  emit('key');
  emit('msg', null);
  startStream();
  refreshAll();
}

/** Restores the account key from the server backup. Returns an error text or null. */
export async function restoreKey(secret) {
  const kb = S.keyBackup;
  if (!kb) return 'پشتیبانی از کلید روی سرور نیست';
  let id;
  try { id = await C.importBackup(kb, S.me, secret); } catch { return kb.v === 1 ? 'رمز درست نیست (برای این حساب رمز ورود قبلی را بزنید)' : 'رمز کلید درست نیست'; }
  await keyDone(id);
  if (kb.v !== 2) { S.keyStep = 'setpass'; emit('key'); }
  return null;
}

/** Replaces the account key with a new one (old messages cannot be opened with it). */
export async function newKey(keyPassword, accountPassword) {
  const id = await C.newIdentity();
  try { await uploadBackup(id, keyPassword, accountPassword); } catch (e) { return keyErr(e); }
  await keyDone(id);
  return null;
}

/** Locks this device's key with a (new) key password. */
export async function setKeyPassword(keyPassword, accountPassword) {
  try { await uploadBackup(S.identity, keyPassword, accountPassword); } catch (e) { return keyErr(e); }
  if (S.keyStep === 'setpass') { S.keyStep = null; emit('key'); }
  return null;
}
function keyErr(e) {
  if (e instanceof api.HttpError && e.status === 403) { loginPass = null; return 'رمز ورود حساب یا کد پیامکی درست نیست'; }
  return errText(e);
}

function resetState() {
  S.users = []; S.groups = []; S.pins = {}; S.read = {}; S.typing = {}; S.gtyping = {}; S.receipts = {}; S.rseq = -1;
  S.convos = new Map(); S.lastId = 0; S.cseq = -1; S.progress.clear(); S.failures.clear();
}

export async function logout() {
  await disablePush().catch(() => { });
  try { await api.logout(); } catch { }
  await endSession();
}
async function endSession(reason) {
  stopStream();
  dropBrowserPush();
  api.setToken(null);
  await store.kvDel('token');
  await store.kvDel('me');
  await store.wipeAccountData();
  S.me = '';
  S.keyStep = null; S.keyBackup = null; loginPass = null;
  resetState();
  emit('logout', reason || null);
}

// ---------------- directory ----------------
export async function refreshUsers() {
  const list = await api.users();
  // someone found by @username stays known until the server lists them (after the first message)
  const found = S.users.filter((u) => u.found && !list.some((x) => x.username === u.username));
  S.users = [...list.map((u) => (u.username === S.me ? { ...u, pubkey: S.identity.pubB64 } : u)), ...found];
  const self = list.find((u) => u.username === S.me);
  if (self && self.pubkey && self.pubkey !== S.identity.pubB64 && S.keyStep !== 'choose') {
    // another device made a new key for this account: stop until the user restores it here
    await checkKey();
    if (S.keyStep === 'choose') return;
  }
  await store.kvSet('users', S.users);
  emit('users');
}
export async function refreshGroups() {
  S.groups = await api.groups();
  await store.kvSet('groups', S.groups);
  emit('groups');
}
export async function refreshRequests() {
  S.requests = await api.contactRequests();
  emit('requests');
}
export async function refreshMe() {
  const r = await api.me();
  S.privacy = { hide_seen: !!r.hide_seen, hide_last_seen: !!r.hide_last_seen, findable: r.findable !== false, allow_requests: r.allow_requests !== false };
  S.meInfo = { diag: !!r.diag, requests_on: r.requests_on !== false };
  await store.kvSet('privacy', S.privacy);
  emit('privacy');
}
function refreshAll() {
  refreshUsers().catch(handleAuth);
  refreshGroups().catch(handleAuth);
  refreshRequests().catch(handleAuth);
  refreshMe().catch(handleAuth);
}
function handleAuth(e) { if (e instanceof api.HttpError && e.status === 401 && api.getToken()) endSession(); }

// ---------------- live events ----------------
let abort = null;
let streamRunning = false;
let lastData = 0;

export function startStream() {
  if (streamRunning) return;
  streamRunning = true;
  (async () => {
    let backoff = 1000;
    while (streamRunning && api.getToken()) {
      abort = new AbortController();
      const ctl = abort;
      setConn('connecting');
      let opened = 0, replayed = 0;
      try {
        await api.stream(S.lastId, S.cseq, S.rseq, await deviceId(), document.visibilityState === 'visible', ctl.signal, () => {
          setConn('online'); backoff = 1000; opened = lastData = Date.now(); flush();
          setTimeout(syncReceipts, 2500);
        }, (ev, data) => {
          lastData = Date.now();
          if (ev !== 'ping') queueEvent(ev, data);
          // the server replays at most 2000 old messages per connection: reconnect for the rest
          if (ev === 'msg' && ++replayed >= 2000 && Date.now() - opened < 10000) { replayed = -1e9; chain.then(() => ctl.abort()); backoff = 0; }
        });
      } catch (e) {
        if (e instanceof api.HttpError && e.status === 401) { streamRunning = false; await endSession(); return; }
      }
      setConn('offline');
      if (!streamRunning) break;
      if (backoff) await wait(backoff, true); else backoff = 1000;
      backoff = Math.min(backoff * 2, 15000);
    }
    streamRunning = false;
  })();
}
function stopStream() { streamRunning = false; if (abort) abort.abort(); wake(); }
function setConn(c) { if (S.conn !== c) { S.conn = c; emit('conn'); } }

let wakeFn = null;
const wait = (ms, wakeable) => new Promise((r) => { const t = setTimeout(r, ms); if (wakeable) wakeFn = () => { clearTimeout(t); r(); }; });
function wake() { if (wakeFn) { const f = wakeFn; wakeFn = null; f(); } }

/** The server pings every 15 s; a silent stream is dead (typical after the phone slept). */
setInterval(() => { if (S.conn === 'online' && Date.now() - lastData > 40000 && abort) abort.abort(); }, 5000);
export function resume() {
  if (!api.getToken()) return;
  if (S.conn !== 'online') { if (abort) abort.abort(); wake(); startStream(); }
  else if (Date.now() - lastData > 20000 && abort) abort.abort();
  refreshAll();
}
addEventListener('online', () => resume());

let chain = Promise.resolve();
function queueEvent(ev, data) { chain = chain.then(() => handleEvent(ev, data)).catch((e) => console.error('event', ev, e)); }

async function handleEvent(ev, data) {
  const o = JSON.parse(data);
  switch (ev) {
    case 'msg': return handleMsg(o);
    case 'change': return handleChange(o);
    case 'cseq': S.cseq = o.seq; return store.kvSet('cseq', S.cseq);
    case 'presence': {
      const u = user(o.user);
      if (!u || o.online) { try { await refreshUsers(); } catch { } }
      const x = user(o.user);
      if (x) { x.online = o.online; if ('last_seen' in o) { x.last_seen = o.last_seen; x.recently = !!o.recently; } }
      return emit('users');
    }
    case 'typing': {
      (S.gtyping[o.convo] = S.gtyping[o.convo] || {})[o.from] = Date.now();
      emit('typing', o.convo); setTimeout(() => emit('typing', o.convo), 4500);
      return;
    }
    case 'receipt': setReceipt(o); saveReceipts(); return emit('receipts', o.convo);
    case 'receipts': for (const r of o.list || []) setReceipt(r); saveReceipts(); return emit('receipts', null);
    case 'react': return handleReact(o);
    case 'rseq': S.rseq = o.seq; return store.kvSet('rseq', S.rseq);
    case 'profile': {
      const u = user(o.username);
      if (!u) { try { await refreshUsers(); } catch { } return; }
      Object.assign(u, { display_name: o.display_name, avatar_ver: o.avatar_ver, bio: o.bio });
      return emit('users');
    }
    case 'refresh': try { await refreshUsers(); await refreshGroups(); } catch { } return;
    case 'contacts': try { await refreshRequests(); } catch { } return;
    case 'login_alert': return emit('login_alert', o);
    case 'pin':
      if (o.messageId == null) delete S.pins[o.convo]; else S.pins[o.convo] = o.messageId;
      return emit('pins', o.convo);
    case 'sig':
      if (o.kind === 'sig_typing') { S.typing[o.from] = Date.now(); emit('typing', o.from); setTimeout(() => emit('typing', o.from), 4500); return; }
      if (o.kind === 'sig_lan') { if (lanHook) lanHook.signal(o.from, o.payload); return; }
      return onSignal(o.from, o.kind, o.payload);
    default: return;
  }
}

const byOrder = (a, b) => (a.id > 0 && b.id > 0 ? a.id - b.id : a.ts - b.ts || a.id - b.id);
function addLocal(m) {
  let list = S.convos.get(m.convo);
  if (!list) S.convos.set(m.convo, (list = []));
  const i = list.findIndex((x) => x.id === m.id);
  if (i >= 0) list[i] = m; else list.push(m);
  return i < 0;
}
function removeLocal(m) {
  const list = S.convos.get(m.convo);
  if (list) { const i = list.findIndex((x) => x.id === m.id); if (i >= 0) list.splice(i, 1); }
}

async function handleMsg(o) {
  const mine = o.from === S.me;
  const convo = isGroup(o.target) ? o.target : mine ? o.target : o.from;
  let m, lx = null;
  try {
    let pub = pubOf(o.from);
    if (!pub && !mine) { try { await refreshUsers(); } catch { } pub = pubOf(o.from); }
    const plain = JSON.parse(td.decode(await C.decryptFrom(S.identity, S.me, o.from, o.target, pub, o.payload)));
    const r = plain.r || null;
    if (typeof plain.lx === 'string' && !mine) lx = plain.lx;
    // a voice message travels as a file with v:1 (older apps show it as an audio file)
    const voice = plain.t === 'file' && plain.v === 1;
    m = {
      id: o.id, convo, sender: o.from, mine, ts: o.ts, type: voice ? 'voice' : plain.t || 'text', text: plain.x || '', edited: o.edited || 0,
      ...(voice ? { dur: Number(plain.d) || 0, wave: Array.isArray(plain.wf) ? plain.wf.slice(0, 100).map((x) => Math.max(0, Math.min(31, x | 0))) : [] } : {}),
      ...(locOf(plain) ? { type: 'location', loc: locOf(plain) } : {}),
      fwFrom: plain.f ? plain.f.u || null : null, fwName: plain.f ? plain.f.n || null : null,
      fileId: o.fileId || null, name: plain.n || null, mime: plain.m || null, size: plain.s || 0, fk: plain.fk || null,
      w: plain.w || 0, h: plain.h || 0, replyId: r ? r.id || 0 : 0, replyUser: r ? r.u || null : null, replyText: r ? r.x || null : null, status: 0,
    };
  } catch {
    m = { id: o.id, convo, sender: o.from, mine, ts: o.ts, type: 'text', text: '🔒 این پیام قابل رمزگشایی نیست (کلید قدیمی یا مشکل رمزنگاری)', status: 0, locked: true };
  }
  if (o.reactions) m.reactions = { ...o.reactions };
  if (lx && m.fileId) { if (lanFiles.has(lx)) lanTakeOver(lx, m); else lanReal.set(lx, m); }
  if (!mine) ack(convo, 'delivered', o.id);
  const isNew = addLocal(m);
  if (isNew) S.convos.get(convo).sort(byOrder);
  await store.putMsg(m);
  if (o.id > S.lastId) { S.lastId = o.id; await store.kvSet('last_id', S.lastId); }
  if (isNew) {
    if (mine || (S.openConvo === convo && document.visibilityState === 'visible')) markRead(convo);
    emit('msg', m);
  }
}

/** An edit or a delete-for-everyone of a message we may already have. */
async function handleChange(o) {
  const list = S.convos.get(isGroup(o.target) ? o.target : o.from === S.me ? o.target : o.from) || [];
  const m = list.find((x) => x.id === o.id);
  if (m && o.kind === 'del') {
    removeLocal(m);
    await store.delMsg(m.id);
    for (const [c, id] of Object.entries(S.pins)) if (id === m.id) delete S.pins[c];
    emit('msg', m);
  } else if (m && o.kind === 'edit') {
    try {
      const plain = JSON.parse(td.decode(await C.decryptFrom(S.identity, S.me, o.from, o.target, pubOf(o.from), o.payload)));
      m.text = plain.x || '';
      m.edited = o.edited || Date.now();
      await store.putMsg(m);
      emit('msg', m);
    } catch { }
  }
  if (o.seq > S.cseq) { S.cseq = o.seq; await store.kvSet('cseq', S.cseq); }
}

// ---------------- location ----------------
/**
 * A location travels as a text message with an extra "loc" field, so apps before 1.4 still show it as
 * text with a map link. Only the point is sent (no live updates).
 */
function locOf(plain) {
  const l = plain && plain.t === 'text' && plain.loc;
  if (!l || !isFinite(l.lat) || !isFinite(l.lon) || Math.abs(l.lat) > 90 || Math.abs(l.lon) > 180) return null;
  return { lat: +l.lat, lon: +l.lon, acc: Math.max(0, Math.round(+l.acc || 0)) };
}
export const fmtCoord = (l) => l.lat.toFixed(5) + ', ' + l.lon.toFixed(5);
const locText = (l) => '📍 موقعیت مکانی: https://www.openstreetmap.org/?mlat=' + l.lat.toFixed(6) + '&mlon=' + l.lon.toFixed(6) + '#map=17/' + l.lat.toFixed(6) + '/' + l.lon.toFixed(6);
const locJson = (m) => (m.type === 'location' && m.loc ? { t: 'text', x: locText(m.loc), loc: { lat: m.loc.lat, lon: m.loc.lon, acc: m.loc.acc || 0 } } : {});

/** Reads this device's position (asks for permission the first time). Resolves to { lat, lon, acc }. */
export function currentLocation() {
  return new Promise((resolve, reject) => {
    if (!navigator.geolocation) return reject(userError('این مرورگر موقعیت مکانی ندارد'));
    navigator.geolocation.getCurrentPosition(
      (p) => resolve({ lat: p.coords.latitude, lon: p.coords.longitude, acc: Math.round(p.coords.accuracy || 0) }),
      (e) => reject(userError(e.code === 1 ? 'اجازهٔ دسترسی به موقعیت مکانی داده نشد' : 'موقعیت مکانی پیدا نشد؛ GPS را روشن کنید و دوباره امتحان کنید')),
      { enableHighAccuracy: true, timeout: 20000, maximumAge: 30000 });
  });
}
export async function sendLocation(convo, loc, reply) {
  const m = { id: localId(), convo, sender: S.me, mine: true, ts: Date.now(), type: 'location', text: '', loc, status: 1, ...replyOf(reply) };
  addLocal(m);
  await store.putMsg(m);
  markRead(convo);
  emit('msg', m);
  flush();
}

// ---------------- delivered / seen ticks ----------------
/** Receipts are watermarks: everything up to id `delivered` reached a device of that user, up to `seen` was read. */
function setReceipt(r) {
  const c = (S.receipts[r.convo] = S.receipts[r.convo] || {});
  const old = c[r.user] || { d: 0, s: 0 };
  c[r.user] = { d: Math.max(old.d, r.delivered || 0), s: Math.max(old.s, r.seen || 0) };
  // read on another of my devices: read here too
  if (r.user === S.me && (r.seen || 0) > (S.read[r.convo] || 0)) { S.read[r.convo] = r.seen; store.kvSet('read', S.read); emit('read', r.convo); }
}
let saveTimer = null;
function saveReceipts() { if (!saveTimer) saveTimer = setTimeout(() => { saveTimer = null; store.kvSet('receipts', S.receipts); }, 1000); }

/** 'sent' (grey ✓) · 'delivered' (blue ✓) · 'seen' (blue ✓✓) for my message, null for others. In a group: all members. */
export function tickOf(m) {
  if (!m.mine || m.id <= 0 || m.status !== 0 || m.type === 'call') return null;
  const rc = S.receipts[m.convo] || {};
  const d = (u) => Math.max((rc[u] || {}).d || 0, (rc[u] || {}).s || 0), s = (u) => (rc[u] || {}).s || 0;
  if (isGroup(m.convo)) {
    const g = S.groups.find((x) => x.key === m.convo);
    const others = (g ? g.members : []).filter((u) => u !== S.me);
    if (!others.length) return 'sent';
    if (others.every((u) => s(u) >= m.id)) return 'seen';
    return others.every((u) => d(u) >= m.id) ? 'delivered' : 'sent';
  }
  if (!S.privacy.hide_seen && s(m.convo) >= m.id) return 'seen';
  return d(m.convo) >= m.id ? 'delivered' : 'sent';
}

/** Group members by how far they got with my message: { seen, delivered, sent } (lists of usernames). */
export function readersOf(m) {
  const rc = S.receipts[m.convo] || {};
  const g = S.groups.find((x) => x.key === m.convo);
  const out = { seen: [], delivered: [], sent: [] };
  for (const u of (g ? g.members : [m.convo]).filter((x) => x !== S.me)) {
    const r = rc[u] || { d: 0, s: 0 };
    out[r.s >= m.id ? 'seen' : Math.max(r.d, r.s) >= m.id ? 'delivered' : 'sent'].push(u);
  }
  return out;
}

const acks = {};
let ackTimer = null;
function ack(convo, kind, id, delay = 700) {
  if (!(id > 0)) return;
  const a = (acks[convo] = acks[convo] || {});
  if ((a[kind] || 0) < id) a[kind] = id;
  if (!ackTimer) ackTimer = setTimeout(sendAcks, delay);
}
async function sendAcks() {
  ackTimer = null;
  const items = Object.entries(acks).map(([target, a]) => ({ target, delivered: a.delivered || 0, seen: a.seen || 0 }));
  for (const k of Object.keys(acks)) delete acks[k];
  if (!items.length || !api.getToken()) return;
  try { await api.receipts(items); } catch {
    for (const it of items) { ack(it.target, 'delivered', it.delivered, 10000); ack(it.target, 'seen', it.seen, 10000); }
  }
}
const lastIncoming = (convo, upTo = Infinity) => {
  const list = S.convos.get(convo) || [];
  for (let i = list.length - 1; i >= 0; i--) if (!list[i].mine && list[i].id > 0 && list[i].id <= upTo) return list[i].id;
  return 0;
};
/** After (re)connecting: report what this device has, so lost acks and messages from before 1.4 get ticks too. */
function syncReceipts() {
  for (const convo of S.convos.keys()) {
    ack(convo, 'delivered', lastIncoming(convo));
    ack(convo, 'seen', lastIncoming(convo, S.read[convo] || 0));
  }
}

// ---------------- reactions ----------------
export const QUICK_REACTIONS = ['👍', '❤️', '😂', '😮', '😢', '🙏'];
const convoOfMsg = (from, target) => (isGroup(target) ? target : from === S.me ? target : from);
async function handleReact(o) {
  if (o.seq > S.rseq) { S.rseq = o.seq; store.kvSet('rseq', S.rseq); }
  const m = (S.convos.get(convoOfMsg(o.from, o.target)) || []).find((x) => x.id === o.id);
  if (!m) return;
  const r = { ...(m.reactions || {}) };
  if (o.emoji) r[o.user] = o.emoji; else delete r[o.user];
  m.reactions = r;
  await store.putMsg(m);
  emit('react', m);
}
/** Sets (or with null removes) my reaction to m. Returns an error text or null. */
export async function react(m, emoji) {
  const before = m.reactions || {};
  const r = { ...before };
  if (emoji) r[S.me] = emoji; else delete r[S.me];
  m.reactions = r;
  emit('react', m);
  try { await api.react(m.id, emoji || null); await store.putMsg(m); return null; } catch (e) { m.reactions = before; emit('react', m); return errText(e); }
}
/** [[emoji, [usernames]]] most used first. */
export function reactionsOf(m) {
  const by = new Map();
  for (const [u, e] of Object.entries(m.reactions || {})) { if (!by.has(e)) by.set(e, []); by.get(e).push(u); }
  return [...by.entries()].sort((a, b) => b[1].length - a[1].length);
}

// ---------------- presence / privacy ----------------
let devId = null;
async function deviceId() {
  if (devId) return devId;
  devId = await store.kvGet('dev');
  if (!devId) { devId = [...crypto.getRandomValues(new Uint8Array(8))].map((b) => b.toString(16).padStart(2, '0')).join(''); await store.kvSet('dev', devId); }
  return devId;
}
/** The app came to the screen or left it (others see "online" / "last seen"). */
export async function setActive(active) {
  if (S.conn === 'online' && api.getToken()) api.presence(await deviceId(), active).catch(() => { });
}
export async function setPrivacy(p) {
  try {
    S.privacy = await api.privacy(p);
    await store.kvSet('privacy', S.privacy);
    emit('privacy');
    await refreshUsers();
    return null;
  } catch (e) { return errText(e); }
}

// ---------------- notifications while closed (Web Push) ----------------
export const pushSupported = () => 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
const b64uBytes = (s) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(s.length / 4) * 4, '=')), (c) => c.charCodeAt(0));
async function currentSub() {
  const reg = await navigator.serviceWorker.getRegistration();
  return reg ? reg.pushManager.getSubscription() : null;
}
/** 'unsupported' | 'denied' | 'on' | 'off' */
export async function pushState() {
  if (!pushSupported()) return 'unsupported';
  if (Notification.permission === 'denied') return 'denied';
  return Notification.permission === 'granted' && (await currentSub().catch(() => null)) ? 'on' : 'off';
}
export async function enablePush() {
  if (!pushSupported()) return 'این مرورگر اعلان پس‌زمینه ندارد (در آیفون: iOS ۱۶٫۴ به بالا و باز کردن سپن از صفحهٔ اصلی)';
  try {
    if ((await Notification.requestPermission()) !== 'granted') return 'اجازهٔ اعلان داده نشد';
    const reg = await navigator.serviceWorker.ready;
    const key = b64uBytes((await api.pushKey()).key);
    let sub = await reg.pushManager.getSubscription();
    const old = sub && sub.options && sub.options.applicationServerKey ? new Uint8Array(sub.options.applicationServerKey) : null;
    if (sub && (!old || old.length !== key.length || old.some((b, i) => b !== key[i]))) { await sub.unsubscribe(); sub = null; }
    if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key });
    await api.pushSubscribe(sub.toJSON());
    return null;
  } catch (e) { return e instanceof api.HttpError ? errText(e) : 'فعال کردن اعلان ناموفق بود (' + (e.message || e) + ')'; }
}
export async function disablePush() {
  const sub = await currentSub().catch(() => null);
  if (!sub) return;
  await api.pushUnsubscribe(sub.endpoint).catch(() => { });
  await sub.unsubscribe().catch(() => { });
}
function dropBrowserPush() { if (pushSupported()) currentSub().then((s) => s && s.unsubscribe()).catch(() => { }); }
/** Re-attaches this browser's subscription to the current session (after a login or an app start). */
async function refreshPush() {
  if (!pushSupported() || Notification.permission !== 'granted') return;
  const sub = await currentSub().catch(() => null);
  if (sub) api.pushSubscribe(sub.toJSON()).catch(() => { });
}
/** Sends a test notification; returns a sentence about how it went. */
export async function testPush() {
  try {
    const { results } = await api.pushTest();
    if (!results.length) return 'این دستگاه برای اعلان ثبت نشده';
    const ok = results.filter((r) => r.status >= 200 && r.status < 300).length;
    if (ok) return 'اعلان آزمایشی فرستاده شد؛ اگر تا چند ثانیه نرسید، سپن را ببندید و دوباره امتحان کنید';
    return results.some((r) => r.status === 0) ? 'سرور به سرویس اعلان (' + results[0].host + ') دسترسی ندارد' : 'سرویس اعلان پاسخ خطا داد (' + results.map((r) => r.status).join('، ') + ')';
  } catch (e) { return errText(e); }
}

// ---------------- edit / delete for everyone / forward ----------------
export const EDIT_WINDOW = 48 * 3600e3;
export const canEdit = (m) => m.mine && m.type === 'text' && m.id > 0 && m.status === 0 && Date.now() - m.ts < EDIT_WINDOW;
const forwardJson = (m) => (m.fwFrom ? { f: { u: m.fwFrom, n: m.fwName || '' } } : {});
/** File fields of the plaintext; a voice message is a file with v:1, its duration (ms) and waveform (0..31). */
const fileJson = (m) => ({
  t: m.type === 'voice' ? 'file' : m.type, n: m.name, m: m.mime, s: m.size, fk: m.fk, w: m.w || 0, h: m.h || 0,
  ...(m.type === 'voice' ? { v: 1, d: m.dur || 0, wf: m.wave || [] } : {}),
});
function plainOf(m, text = m.text) {
  const p = { t: m.type, x: text, ...replyJson(m), ...forwardJson(m) };
  if (m.type === 'location') return { ...p, ...locJson(m) };
  if (m.type !== 'text') Object.assign(p, fileJson(m));
  return p;
}

/** Edits my text message; the old version stays on the server encrypted for me only. */
export async function editMessage(m, text) {
  try {
    const payload = await encryptFor(m.convo, plainOf(m, text));
    const prev = await C.encryptFor(S.identity, S.me, m.convo, {}, JSON.stringify(plainOf(m)));
    const r = await api.editMessage(m.id, payload, prev);
    m.text = text; m.edited = r.edited;
    await store.putMsg(m);
    emit('msg', m);
    return null;
  } catch (e) {
    if (e instanceof api.HttpError && e.body && e.body.error === 'edit_window_passed') return 'فقط تا ۴۸ ساعت بعد از ارسال می‌شود پیام را ویرایش کرد';
    return errText(e);
  }
}

export async function deleteForAll(m) {
  try { await api.deleteMessage(m.id); } catch (e) { return errText(e); }
  removeLocal(m);
  await store.delMsg(m.id);
  emit('msg', m);
  return null;
}

/** Earlier texts of my edited message, oldest first: [{ text, ts }] (ts = when it was replaced). */
export async function editHistory(m) {
  const out = [];
  for (const v of (await api.messageHistory(m.id)).versions) {
    try { out.push({ text: JSON.parse(td.decode(await C.decryptFrom(S.identity, S.me, S.me, m.convo, null, v.payload))).x || '', ts: v.ts }); } catch { }
  }
  return out;
}

/** Forwards messages to other chats; files are not uploaded again. hideSender sends a plain copy. */
export async function forward(msgs, targets, hideSender) {
  let n = 0;
  for (const t of targets) {
    for (const src of [...msgs].sort((a, b) => a.ts - b.ts)) {
      if (src.status !== 0 || src.type === 'call' || src.id <= 0 || (src.type !== 'text' && !src.fileId)) continue;
      const fw = hideSender ? null : src.fwFrom || src.sender;
      const m = {
        id: localId(), convo: t, sender: S.me, mine: true, ts: Date.now() + n++, type: src.type, text: src.text || '',
        name: src.name || null, mime: src.mime || null, size: src.size || 0, fk: src.fk || null, w: src.w || 0, h: src.h || 0,
        ...(src.type === 'voice' ? { dur: src.dur || 0, wave: src.wave || [] } : {}),
        ...(src.type === 'location' ? { loc: src.loc } : {}),
        status: 1, replyId: 0, replyUser: null, replyText: null,
        fwFrom: fw, fwName: fw ? src.fwName || nameOf(src.sender) : null,
      };
      addLocal(m);
      if (m.type === 'text' || m.type === 'location') await store.putMsg(m);
      else {
        Object.defineProperty(m, '_fileId', { value: src.fileId, enumerable: false, writable: true });
        const blob = blobs.get(src.fileId);
        if (blob) Object.defineProperty(m, '_file', { value: blob, enumerable: false, writable: true });
        uploadFile(m);
      }
      emit('msg', m);
    }
  }
  flush();
}

// ---------------- reading ----------------
export function unread(convo) {
  const list = S.convos.get(convo) || [];
  const r = S.read[convo] || 0;
  let n = 0;
  for (let i = list.length - 1; i >= 0; i--) { const m = list[i]; if (m.id <= r) break; if (!m.mine && m.id > 0) n++; }
  return n;
}
export function markRead(convo) {
  const list = S.convos.get(convo) || [];
  let max = S.read[convo] || 0;
  for (const m of list) if (m.id > max) max = m.id;
  if (max !== (S.read[convo] || 0)) { S.read[convo] = max; store.kvSet('read', S.read); emit('read', convo); }
  ack(convo, 'seen', lastIncoming(convo));
}

export function summaries() {
  const keys = new Set([...S.convos.keys()].filter((k) => (S.convos.get(k) || []).length));
  for (const g of S.groups) keys.add(g.key);
  return [...keys].map((k) => {
    const list = S.convos.get(k) || [];
    const last = list[list.length - 1] || null;
    return { convo: k, last, unread: unread(k), ts: last ? last.ts : 0 };
  }).sort((a, b) => b.ts - a.ts);
}

export function deleteLocal(m) { removeLocal(m); store.delMsg(m.id); emit('msg', m); }

// ---------------- sending ----------------
async function encryptFor(convo, plain) {
  const rec = {};
  if (isGroup(convo)) {
    const g = S.groups.find((x) => x.key === convo);
    const members = g ? g.members : S.users.map((u) => u.username);
    for (const u of members) { const pk = pubOf(u); if (u !== S.me && pk) rec[u] = pk; }
  } else {
    let pk = pubOf(convo);
    if (!pk) { try { await refreshUsers(); } catch { } pk = pubOf(convo); }
    if (!pk) throw userError('این کاربر هنوز وارد برنامه نشده و کلید امنیتی ندارد');
    rec[convo] = pk;
  }
  return C.encryptFor(S.identity, S.me, convo, rec, typeof plain === 'string' ? plain : JSON.stringify(plain));
}
export const encryptSignal = (peer, obj) => encryptFor(peer, obj);
export async function decryptSignal(from, payload) {
  try { return JSON.parse(td.decode(await C.decryptFrom(S.identity, S.me, from, S.me, pubOf(from), payload))); } catch { return null; }
}

const replyOf = (r) => (r ? { replyId: r.id > 0 ? r.id : 0, replyUser: r.sender, replyText: preview(r).slice(0, 80) } : { replyId: 0, replyUser: null, replyText: null });
const replyJson = (m) => (m.replyId ? { r: { id: m.replyId, u: m.replyUser || '', x: m.replyText || '' } } : {});
let localSeq = 0;
const localId = () => -(Date.now() * 1000 + (localSeq++ % 1000));

export async function sendText(convo, text, reply) {
  const m = { id: localId(), convo, sender: S.me, mine: true, ts: Date.now(), type: 'text', text, status: 1, ...replyOf(reply) };
  addLocal(m);
  await store.putMsg(m);
  markRead(convo);
  emit('msg', m);
  flush();
}

let flushing = false;
export async function flush() {
  if (flushing || !api.getToken()) return;
  flushing = true;
  try {
    const pending = [...S.convos.values()].flat().filter((m) => m.status === 1 && (m.type === 'text' || m.type === 'location')).sort((a, b) => a.ts - b.ts);
    for (const m of pending) {
      try {
        const payload = await encryptFor(m.convo, { t: 'text', x: m.text, ...replyJson(m), ...forwardJson(m), ...locJson(m) });
        const r = await api.send(m.convo, payload);
        await swapLocal(m, { ...m, id: r.id, ts: r.ts, status: 0 });
      } catch (e) {
        if (e instanceof api.HttpError && e.status >= 400 && e.status < 500 && e.status !== 429 && e.status !== 401) {
          m.status = 2; S.failures.set(m.id, errText(e)); await store.putMsg(m); emit('msg', m);
        } else if (e.userText) { m.status = 2; S.failures.set(m.id, e.userText); await store.putMsg(m); emit('msg', m); }
        else break; // offline: retried when the connection comes back
      }
    }
  } finally { flushing = false; }
}
setInterval(() => { if (S.conn === 'online') flush(); }, 20000);

async function swapLocal(local, real) {
  removeLocal(local);
  await store.delMsg(local.id);
  const isNew = addLocal(real);
  S.convos.get(real.convo).sort(byOrder);
  if (isNew) await store.putMsg(real);
  S.progress.delete(local.id);
  emit('msg', real);
}

export function retry(m) {
  S.failures.delete(m.id);
  if (m.type === 'text' || m.type === 'location') { m.status = 1; store.putMsg(m); emit('msg', m); flush(); }
  else if (m._file) { m.status = 1; emit('msg', m); uploadFile(m); }
}

const sentTyping = {};
export function sendTyping(convo) {
  if (S.conn !== 'online' || reqOf(convo) === 'out') return; // no "typing…" to someone who has not accepted yet
  if (Date.now() - (sentTyping[convo] || 0) < 3000) return;
  sentTyping[convo] = Date.now();
  (isGroup(convo) ? api.typing(convo) : api.signal(convo, 'sig_typing', '1')).catch(() => { });
}
/** Who is typing in a group right now (usernames). */
export const typingIn = (convo) => Object.entries(S.gtyping[convo] || {}).filter(([u, t]) => u !== S.me && Date.now() - t < 4500).map(([u]) => u);

export async function pinMessage(convo, messageId) {
  try { await api.pin(convo, messageId); return null; } catch (e) { return errText(e); }
}

// ---------------- files ----------------
function imageSize(file) {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => { resolve([img.naturalWidth, img.naturalHeight]); URL.revokeObjectURL(url); };
    img.onerror = () => { resolve(null); URL.revokeObjectURL(url); };
    img.src = url;
  });
}

export async function sendFile(convo, file, reply) {
  if (file.size > MAX_FILE_BYTES) return 'در نسخهٔ وب حداکثر حجم فایل ۲۰۰ مگابایت است';
  let type = 'file', w = 0, h = 0;
  if (/^image\/(jpeg|png|gif|webp|heic|heif|avif)$/.test(file.type)) {
    const d = await imageSize(file);
    if (d) { type = 'image'; [w, h] = d; }
  }
  const m = {
    id: localId(), convo, sender: S.me, mine: true, ts: Date.now(), type, text: '', name: file.name || 'file',
    mime: file.type || 'application/octet-stream', size: file.size, fk: C.newFileKey(), w, h, status: 1, ...replyOf(reply),
  };
  Object.defineProperty(m, '_file', { value: file, enumerable: false, writable: true });
  if (type === 'image') { blobUrls.set(m.id, URL.createObjectURL(file)); blobs.set(m.id, file); }
  addLocal(m);
  markRead(convo);
  emit('msg', m);
  if (lanHook) lanHook.offer(m);
  uploadFile(m);
  return null;
}

/** Queues a recorded voice message (blob from MediaRecorder, duration in ms, waveform 0..31). */
export async function sendVoice(convo, blob, dur, wave, reply) {
  const ext = /mp4|aac|m4a/.test(blob.type) ? 'm4a' : /ogg/.test(blob.type) ? 'ogg' : 'webm';
  const m = {
    id: localId(), convo, sender: S.me, mine: true, ts: Date.now(), type: 'voice', text: '', name: 'voice.' + ext,
    mime: blob.type || 'audio/mp4', size: blob.size, fk: C.newFileKey(), w: 0, h: 0, dur, wave, status: 1, ...replyOf(reply),
  };
  Object.defineProperty(m, '_file', { value: blob, enumerable: false, writable: true });
  blobUrls.set(m.id, URL.createObjectURL(blob)); blobs.set(m.id, blob);
  addLocal(m);
  markRead(convo);
  emit('msg', m);
  if (lanHook) lanHook.offer(m);
  uploadFile(m);
}

async function uploadFile(m) {
  const file = m._file;
  const total = C.cipherSize(m.size);
  const chunks = C.chunkCount(m.size);
  try {
    let fileId = m._fileId || null;
    if (!fileId) {
      let up = m._upload || null, off = 0;
      if (up) { try { off = (await api.uploadStatus(up)).offset; } catch { up = null; } }
      if (up && off % C.CIPHER_CHUNK !== 0) { up = null; off = 0; }
      if (!up) { up = (await api.createUpload(total)).uploadId; off = 0; m._upload = up; }
      setProgress(m.id, off / total);
      let netErrors = 0;
      while (!fileId) {
        let idx = off / C.CIPHER_CHUNK;
        const parts = [];
        let len = 0;
        for (let k = 0; k < 4 && idx < chunks; k++, idx++) {
          const plain = new Uint8Array(await file.slice(idx * C.FILE_CHUNK, Math.min(m.size, (idx + 1) * C.FILE_CHUNK)).arrayBuffer());
          const sealed = await C.sealChunk(m.fk, idx, idx === chunks - 1, plain);
          parts.push(sealed); len += sealed.length;
        }
        const body = new Uint8Array(len);
        let p = 0;
        for (const s of parts) { body.set(s, p); p += s.length; }
        let r;
        try { r = await api.patchUpload(up, off, body); } catch (e) {
          if (e instanceof api.HttpError && e.status === 409) { off = (await api.uploadStatus(up)).offset; continue; }
          if (!(e instanceof api.HttpError) && ++netErrors <= 200) { await netBack(Math.min(15000, 3000 * netErrors)); try { off = (await api.uploadStatus(up)).offset; } catch { } continue; }
          throw e;
        }
        off = r.offset;
        netErrors = 0;
        setProgress(m.id, off / total);
        if (r.done) fileId = r.fileId;
      }
      m._fileId = fileId;
    }
    const plain = { ...fileJson(m), ...replyJson(m), ...forwardJson(m), ...(m._lanX ? { lx: m._lanX } : {}) };
    const r = await api.send(m.convo, await encryptFor(m.convo, plain), fileId);
    const real = { ...m, id: r.id, ts: r.ts, status: 0, fileId };
    if (file && (m.type === 'image' || m.type === 'voice') && m.size <= 25 * 1024 * 1024) await store.putMedia(fileId, file).catch(() => { });
    const url = blobUrls.get(m.id);
    if (url) { blobUrls.delete(m.id); blobUrls.set(fileId, url); blobs.delete(m.id); blobs.set(fileId, file); }
    setProgress(m.id, null);
    await swapLocal(m, real);
  } catch (e) {
    setProgress(m.id, null);
    m.status = 2;
    S.failures.set(m.id, errText(e));
    emit('msg', m);
  }
}

function setProgress(id, v) {
  if (v == null) S.progress.delete(id); else S.progress.set(id, v);
  emit('progress', id);
}

const blobUrls = new Map(); // fileId (or local id) -> object URL of the decrypted file
const blobs = new Map();    // same keys -> the Blob itself (for "share / save to Files")
const downloading = new Map();
export const mediaUrl = (m) => blobUrls.get(m.fileId || m.id) || null;
export const mediaBlob = (m) => blobs.get(m.fileId || m.id) || null;

/** Waits `ms`, but no longer than until the browser is back online (and while offline, until it is). */
function netBack(ms) {
  return new Promise((resolve) => {
    let t = null;
    const done = () => { clearTimeout(t); removeEventListener('online', done); resolve(); };
    addEventListener('online', done);
    t = setTimeout(() => { if (navigator.onLine !== false) done(); else t = setTimeout(done, 10 * 60e3); }, ms);
  });
}

// ---------------- direct transfer on the same Wi-Fi (1.8) ----------------
const lanFiles = new Map(); // transfer id -> { blob, m } (the file arrived over Wi-Fi before the server message)
const lanReal = new Map();  // transfer id -> the server message, when that came first

/** A file arrived directly over the local network: show it now, as a message that the server copy replaces later. */
export function lanShow(from, meta, x, blob) {
  const real = lanReal.get(x);
  if (real) { // the server message was quicker: it just gets the file without downloading it
    lanReal.delete(x);
    if (!blobUrls.has(real.fileId)) {
      blobUrls.set(real.fileId, URL.createObjectURL(blob)); blobs.set(real.fileId, blob);
      if (blob.size <= 50 * 1024 * 1024) store.putMedia(real.fileId, blob).catch(() => { });
      emit('media', real);
    }
    return;
  }
  const voice = meta.t === 'file' && meta.v === 1;
  const m = {
    id: localId(), convo: from, sender: from, mine: false, ts: Date.now(), type: voice ? 'voice' : meta.t === 'image' ? 'image' : 'file', text: '', edited: 0,
    ...(voice ? { dur: Number(meta.d) || 0, wave: Array.isArray(meta.wf) ? meta.wf.slice(0, 100).map((v) => Math.max(0, Math.min(31, v | 0))) : [] } : {}),
    fileId: null, name: meta.n || 'file', mime: meta.m || null, size: meta.s || blob.size, fk: meta.fk, w: meta.w || 0, h: meta.h || 0,
    replyId: 0, replyUser: null, replyText: null, status: 0, lan: true,
  };
  blobUrls.set(m.id, URL.createObjectURL(blob)); blobs.set(m.id, blob);
  lanFiles.set(x, { blob, m });
  setTimeout(() => lanFiles.delete(x), 6 * 3600e3);
  addLocal(m);
  S.convos.get(from).sort(byOrder);
  emit('msg', m);
}

/** The server message of a file that already came over Wi-Fi: it takes the file, the temporary message goes. */
function lanTakeOver(x, m) {
  const l = lanFiles.get(x);
  lanFiles.delete(x);
  const url = blobUrls.get(l.m.id);
  blobUrls.delete(l.m.id); blobs.delete(l.m.id);
  blobUrls.set(m.fileId, url || URL.createObjectURL(l.blob)); blobs.set(m.fileId, l.blob);
  if (l.blob.size <= 50 * 1024 * 1024) store.putMedia(m.fileId, l.blob).catch(() => { });
  removeLocal(l.m);
  emit('msg', l.m);
}

/** Downloads and decrypts a file or image. Resolves to an object URL. */
export function download(m) {
  const id = m.fileId;
  if (!id || !m.fk) return Promise.reject(userError('فایل در دسترس نیست'));
  if (blobUrls.has(id)) return Promise.resolve(blobUrls.get(id));
  if (downloading.has(id)) return downloading.get(id);
  const p = (async () => {
    let blob = await store.getMedia(id).catch(() => null);
    if (!blob) {
      if (m.size > MAX_FILE_BYTES) throw userError('این فایل برای نسخهٔ وب بزرگ است (بیش از ۲۰۰ مگابایت)');
      const type = m.mime || 'application/octet-stream';
      if (!C.isChunked(m.fk)) {
        const enc = await api.fileRange(id, 0, 64 * 1024 * 1024);
        blob = new Blob([await C.openLegacyFile(m.fk, enc)], { type });
      } else {
        const total = C.cipherSize(m.size), n = C.chunkCount(m.size), out = [];
        let off = 0, tries = 0;
        while (off < total) {
          const end = Math.min(total, off + 4 * C.CIPHER_CHUNK) - 1;
          let enc;
          try { enc = await api.fileRange(id, off, end); tries = 0; } catch (e) {
            // 1.8: a network cut does not lose what is already here: wait for the network and go on from `off`
            if (e instanceof api.HttpError || ++tries > 200) throw e;
            await netBack(Math.min(15000, 2000 * tries)); continue;
          }
          for (let p = 0; p < enc.length; p += C.CIPHER_CHUNK) {
            const idx = (off + p) / C.CIPHER_CHUNK;
            out.push(await C.openChunk(m.fk, idx, idx === n - 1, enc.subarray(p, p + C.CIPHER_CHUNK)));
          }
          off = end + 1;
          setProgress(m.id, off / total);
        }
        blob = new Blob(out, { type });
      }
      if (m.size <= 50 * 1024 * 1024) await store.putMedia(id, blob).catch(() => { });
    }
    setProgress(m.id, null);
    const url = URL.createObjectURL(blob);
    blobUrls.set(id, url);
    blobs.set(id, blob);
    emit('media', m);
    return url;
  })();
  downloading.set(id, p);
  p.catch((e) => { setProgress(m.id, null); S.failures.set(m.id, errText(e)); emit('media', m); }).finally(() => downloading.delete(id));
  return p;
}

export async function clearMediaCache() {
  await store.clearMedia();
  for (const u of blobUrls.values()) URL.revokeObjectURL(u);
  blobUrls.clear();
  blobs.clear();
  emit('media');
}

// ---------------- avatars and profile ----------------
const avatars = new Map(); // username -> { ver, url }
const loadingAv = new Set();
export function avatarUrl(u) {
  const info = user(u);
  const ver = info ? info.avatar_ver : 0;
  if (!ver || ver <= 0) return null;
  const a = avatars.get(u);
  if (a && a.ver === ver) return a.url;
  if (!loadingAv.has(u + ver)) {
    loadingAv.add(u + ver);
    api.avatar(u).then((b) => {
      const old = avatars.get(u);
      if (old) URL.revokeObjectURL(old.url);
      avatars.set(u, { ver, url: URL.createObjectURL(b) });
      emit('avatar', u);
    }).catch(() => { });
  }
  return a ? a.url : null;
}

export async function saveProfile(name, bio) {
  try { await api.setProfile(name, bio); await refreshUsers(); return null; } catch (e) { return errText(e); }
}
export async function saveAvatar(webp) {
  try { await api.uploadAvatar(webp); await refreshUsers(); return null; } catch (e) { return errText(e); }
}
export async function removeAvatar() {
  try { await api.deleteAvatar(); await refreshUsers(); return null; } catch (e) { return errText(e); }
}

/** The message-request state of a private chat: 'in' / 'declined' (to me), 'out' (mine, or a new chat with a stranger), or null. */
export function reqOf(convo) {
  if (isGroup(convo)) return null;
  const u = user(convo);
  return u ? u.req || null : null;
}

/** Finds a member by exact @username: { username, display_name, connected, req, can_message } or { error }. */
export async function findUser(name) {
  try {
    const r = await api.findUser(String(name).trim().replace(/^@/, '').toLowerCase());
    if (r.me) return r;
    if (!user(r.username)) {
      S.users = [...S.users, { username: r.username, display_name: r.display_name, pubkey: r.pubkey, bio: r.bio, avatar_ver: 0,
        dm: r.can_message, req: r.connected ? undefined : r.req || 'out', online: false, last_seen: null, recently: false, hidden: true, found: true }];
      emit('users');
    }
    return r;
  } catch (e) { return { error: errText(e) }; }
}

export async function contactAction(what, username, accept = false) {
  try {
    const r = await api.contactAction(what, username.trim().toLowerCase(), accept);
    await refreshRequests();
    if (r.result === 'connected' || what !== 'request') { await refreshUsers(); await refreshGroups(); }
    return { result: r.result };
  } catch (e) { return { error: errText(e) }; }
}

/** Adds a local "call" line to a private chat (not sent anywhere). */
export function addCallLog(peer, text, mine) {
  const m = { id: localId(), convo: peer, sender: mine ? S.me : peer, mine, ts: Date.now(), type: 'call', text, status: 0 };
  addLocal(m);
  store.putMsg(m);
  emit('msg', m);
}
