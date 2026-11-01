// Sepan web app: screens and interaction. State and logic live in engine.mjs, calls in call.mjs.
import * as E from './engine.mjs';
import * as Call from './call.mjs';
import * as api from './api.mjs';
import { fingerprint } from './crypto.mjs';
import { encodeWebp } from './webp.mjs';
import * as Emoji from './emoji.mjs';
import * as Voice from './voice.mjs';

const VERSION = '1.6.1';
const S = E.S;
const app = document.getElementById('app');

// ---------------- small helpers ----------------
const PROPS = new Set(['value', 'checked', 'disabled', 'srcObject', 'muted', 'autoplay', 'playsInline', 'multiple', 'accept', 'selected', 'type', 'placeholder', 'rows', 'maxLength', 'autocomplete', 'src', 'alt', 'href', 'download', 'title', 'dir']);
function h(tag, props, ...kids) {
  const el = document.createElement(tag);
  if (props) {
    for (const [k, v] of Object.entries(props)) {
      if (v == null || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k === 'style') Object.assign(el.style, v);
      else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
      else if (PROPS.has(k)) el[k] = v;
      else el.setAttribute(k, v === true ? '' : v);
    }
  }
  for (const k of kids.flat(Infinity)) if (k != null && k !== false) el.append(k instanceof Node ? k : String(k));
  return el;
}
/** replaceChildren that accepts nested arrays and skips null / false, like h() */
const fill = (el, ...kids) => el.replaceChildren(...kids.flat(Infinity).filter((k) => k != null && k !== false));
const pref = (k, d) => { try { const v = localStorage.getItem('pref_' + k); return v == null ? d : JSON.parse(v); } catch { return d; } };
const setPref = (k, v) => { try { localStorage.setItem('pref_' + k, JSON.stringify(v)); } catch { } };
const faNum = (n) => Number(n).toLocaleString('fa-IR');
const isIOS = /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const standalone = () => navigator.standalone === true || matchMedia('(display-mode: standalone)').matches;

const DAY = 864e5;
const startOfDay = (ts) => { const d = new Date(ts); d.setHours(0, 0, 0, 0); return d.getTime(); };
const fmtTime = (ts) => new Date(ts).toLocaleTimeString('fa-IR', { hour: '2-digit', minute: '2-digit' });
function fmtDay(ts) {
  const d0 = startOfDay(Date.now()), d = startOfDay(ts);
  if (d === d0) return 'امروز';
  if (d === d0 - DAY) return 'دیروز';
  const sameYear = new Date(ts).getFullYear() === new Date().getFullYear();
  return new Date(ts).toLocaleDateString('fa-IR-u-ca-persian', sameYear ? { day: 'numeric', month: 'long' } : { day: 'numeric', month: 'long', year: 'numeric' });
}
function fmtListTime(ts) {
  if (!ts) return '';
  const d0 = startOfDay(Date.now());
  if (ts >= d0) return fmtTime(ts);
  if (ts >= d0 - 6 * DAY) return new Date(ts).toLocaleDateString('fa-IR', { weekday: 'long' });
  return new Date(ts).toLocaleDateString('fa-IR-u-ca-persian', { day: 'numeric', month: 'short' });
}
const fmtDur = (ms) => { const t = Math.max(0, Math.round((ms || 0) / 1000)); return faNum(Math.floor(t / 60)) + ':' + faNum(t % 60).padStart(2, '۰'); };
/** «آنلاین», «آخرین بازدید …» or, when hidden, «اخیراً آنلاین بوده». Empty when nothing is known. */
function lastSeenText(u) {
  if (!u) return '';
  if (u.online) return 'آنلاین';
  if (u.last_seen) {
    const d = Date.now() - u.last_seen;
    if (d < 60e3) return 'لحظاتی پیش آنلاین بود';
    if (d < 3600e3) return faNum(Math.floor(d / 60e3)) + ' دقیقه پیش آنلاین بود';
    const day = startOfDay(u.last_seen), today = startOfDay(Date.now());
    if (day === today) return 'آخرین بازدید امروز ' + fmtTime(u.last_seen);
    if (day === today - DAY) return 'آخرین بازدید دیروز ' + fmtTime(u.last_seen);
    return 'آخرین بازدید ' + fmtDay(u.last_seen);
  }
  if (u.hidden) return u.recently ? 'اخیراً آنلاین بوده' : 'مدت‌ها پیش آنلاین بوده';
  return '';
}

// drafts and chats pinned to the top of the list: kept on this device only
const draftOf = (c) => (pref('drafts', {})[c] || '');
function setDraft(c, text) {
  const d = pref('drafts', {});
  if (text.trim()) d[c] = text; else delete d[c];
  setPref('drafts', d);
}
const pinnedChats = () => pref('pinnedChats', []);
const MAX_PINNED = 5;
function togglePinChat(c) {
  const list = pinnedChats();
  if (list.includes(c)) setPref('pinnedChats', list.filter((x) => x !== c));
  else if (list.length >= MAX_PINNED) { toast('حداکثر ' + faNum(MAX_PINNED) + ' گفتگو را می‌شود سنجاق کرد'); return; }
  else setPref('pinnedChats', [c, ...list]);
}

/** Calls fn after a long press (or right click) on el; returns a check to skip the click that follows. */
function onLongPress(el, fn) {
  let t = null, fired = false, x = 0, y = 0;
  el.addEventListener('pointerdown', (e) => { fired = false; x = e.clientX; y = e.clientY; clearTimeout(t); t = setTimeout(() => { fired = true; fn(); }, 550); });
  el.addEventListener('pointermove', (e) => { if (Math.abs(e.clientX - x) > 10 || Math.abs(e.clientY - y) > 10) clearTimeout(t); });
  for (const ev of ['pointerup', 'pointercancel', 'pointerleave']) el.addEventListener(ev, () => clearTimeout(t));
  el.addEventListener('contextmenu', (e) => { e.preventDefault(); clearTimeout(t); fired = true; fn(); });
  return () => { const f = fired; fired = false; return f; };
}

function fmtSize(b) {
  if (b < 1024) return faNum(b) + ' بایت';
  if (b < 1048576) return faNum(Math.round(b / 1024)) + ' کیلوبایت';
  if (b < 1073741824) return (b / 1048576).toLocaleString('fa-IR', { maximumFractionDigits: 1 }) + ' مگابایت';
  return (b / 1073741824).toLocaleString('fa-IR', { maximumFractionDigits: 2 }) + ' گیگابایت';
}

// same colours as the Android app (Java String.hashCode)
const PALETTE = ['#E17076', '#FAA774', '#A695E7', '#7BC862', '#6EC9CB', '#65AADD', '#EE7AAE', '#3C9DC0'];
function colorFor(name) {
  let x = 0;
  for (let i = 0; i < name.length; i++) x = (Math.imul(31, x) + name.charCodeAt(i)) | 0;
  return PALETTE[(x & 0x7fffffff) % PALETTE.length];
}
const initials = (s) => (s || '?').trim().split(/\s+/).slice(0, 2).map((w) => Array.from(w)[0] || '').join('').toUpperCase() || '?';
function avatar(convo, cls = '') {
  const group = E.isGroup(convo);
  const el = h('div', { class: 'av ' + cls });
  el.style.background = colorFor(convo);
  const url = group ? null : E.avatarUrl(convo);
  if (url) el.append(h('img', { src: url, alt: '' }));
  else el.textContent = group ? '👥' : initials(E.nameOf(convo));
  return el;
}
function avatarWithDot(convo, cls) {
  const u = !E.isGroup(convo) && E.user(convo);
  return h('div', { class: 'av-wrap' }, avatar(convo, cls), u && u.online && convo !== S.me ? h('span', { class: 'dot' }) : null);
}

/** grey ✓ = on the server, blue ✓ = on their phone, blue ✓✓ = seen. */
const tickEl = (t) => (t ? h('span', { class: 'tick ' + t, title: TICK_TEXT[t] }, t === 'seen' ? '✓✓' : '✓') : null);

let toastTimer = null;
function toast(text, onclick) {
  document.querySelectorAll('.toast').forEach((t) => t.remove());
  const t = h('div', { class: 'toast', onclick: () => { t.remove(); if (onclick) onclick(); } }, text);
  document.body.append(t);
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.remove(), 3500);
}

function sheet(title, items, top) {
  const v = h('div', { class: 'veil', onclick: (e) => { if (e.target === v) v.remove(); } },
    h('div', { class: 'sheet' }, title ? h('div', { class: 'st' }, title) : null, top ? top(() => v.remove()) : null,
      items.filter(Boolean).map((it) => h('button', { class: 'it' + (it.danger ? ' danger' : ''), onclick: () => { v.remove(); it.run(); } }, it.label)),
      h('button', { class: 'it', onclick: () => v.remove() }, 'انصراف')));
  document.body.append(v);
}
function confirmBox(title, text, okLabel, danger = false) {
  return new Promise((resolve) => {
    const close = (r) => { v.remove(); resolve(r); };
    const v = h('div', { class: 'veil', onclick: (e) => { if (e.target === v) close(false); } },
      h('div', { class: 'dialog' }, h('h3', null, title), h('p', null, text),
        h('div', { class: 'btns' }, h('button', { class: 'btn flat', onclick: () => close(false) }, 'انصراف'),
          h('button', { class: 'btn' + (danger ? ' danger' : ''), onclick: () => close(true) }, okLabel))));
    document.body.append(v);
  });
}

const fmtFull = (ts) => new Date(ts).toLocaleString('fa-IR-u-ca-persian', { dateStyle: 'long', timeStyle: 'short' });

/** Pick one or more chats to forward to, like Telegram; «پنهان کردن فرستنده» sends a plain copy. */
function forwardSheet(msgs, done) {
  const keys = E.summaries().map((x) => x.convo);
  for (const u of S.users) if (u.dm && u.username !== S.me && !keys.includes(u.username)) keys.push(u.username);
  const targets = keys.filter((c) => E.isGroup(c) || (E.user(c) && (E.user(c).dm || (S.convos.get(c) || []).length)));
  const picked = new Set();
  const list = h('div', { class: 'picklist' });
  const q = h('input', { type: 'text', placeholder: 'جستجو…', oninput: () => render() });
  const hide = h('input', { type: 'checkbox' });
  const sendB = h('button', { class: 'btn', disabled: true, onclick: () => { v.remove(); E.forward(msgs, [...picked], hide.checked); toast('فوروارد شد'); if (done) done(); } }, 'ارسال');
  function render() {
    const t = q.value.trim().toLowerCase();
    fill(list, targets.filter((c) => !t || E.titleOf(c).toLowerCase().includes(t) || c.includes(t)).map((c) => {
      const cb = h('input', { type: 'checkbox', checked: picked.has(c), onchange: () => { if (cb.checked) picked.add(c); else picked.delete(c); sendB.disabled = !picked.size; } });
      return h('label', { class: 'pick' }, cb, avatar(c, 'sm'), h('span', null, E.titleOf(c)));
    }));
  }
  const v = h('div', { class: 'veil', onclick: (e) => { if (e.target === v) v.remove(); } },
    h('div', { class: 'dialog' }, h('h3', null, msgs.length === 1 ? 'فوروارد پیام' : 'فوروارد ' + faNum(msgs.length) + ' پیام'),
      q, list,
      h('label', { class: 'pick sw' }, h('span', { class: 'grow' }, h('div', null, 'پنهان کردن فرستنده'), h('small', null, 'پیام بدون «فوروارد از …» فرستاده می‌شود')), hide),
      h('div', { class: 'btns' }, h('button', { class: 'btn flat', onclick: () => v.remove() }, 'انصراف'), sendB)));
  render();
  document.body.append(v);
}

const TICK_TEXT = { sent: 'فرستاده شد (هنوز به گوشی او نرسیده)', delivered: 'به گوشی رسید', seen: 'دیده شد' };

/** Members of a group by how far they got with my message (long press › «دیده شده توسط»). */
function readersSheet(m) {
  const r = E.readersOf(m);
  const part = (title, list) => (list.length ? [h('b', null, title + ' (' + faNum(list.length) + ')'),
    list.map((u) => h('div', { class: 'pick' }, avatar(u, 'sm'), h('span', null, E.nameOf(u))))] : null);
  const v = h('div', { class: 'veil', onclick: (e) => { if (e.target === v) v.remove(); } },
    h('div', { class: 'dialog' }, h('h3', null, 'وضعیت پیام'),
      h('div', { class: 'picklist' }, part('دیده شده توسط', r.seen), part('رسیده به', r.delivered), part('هنوز نرسیده به', r.sent)),
      h('div', { class: 'btns' }, h('button', { class: 'btn flat', onclick: () => v.remove() }, 'بستن'))));
  document.body.append(v);
}

/** Opens a shared location in a map app of the phone (the server never sees the point). */
function openMap(l) {
  const ll = l.lat.toFixed(6) + ',' + l.lon.toFixed(6);
  const open = (url) => { const a = h('a', { href: url, target: '_blank', rel: 'noopener' }); document.body.append(a); a.click(); a.remove(); };
  sheet(E.fmtCoord(l), [
    isIOS && { label: 'Apple Maps', run: () => open('https://maps.apple.com/?ll=' + ll + '&q=' + encodeURIComponent('موقعیت')) },
    { label: 'Google Maps', run: () => open('https://www.google.com/maps/search/?api=1&query=' + ll) },
    { label: 'نشان', run: () => open('https://neshan.org/maps/@' + ll + ',17z') },
    { label: 'OpenStreetMap', run: () => open('https://www.openstreetmap.org/?mlat=' + l.lat.toFixed(6) + '&mlon=' + l.lon.toFixed(6) + '#map=17/' + l.lat.toFixed(6) + '/' + l.lon.toFixed(6)) },
    { label: 'کپی مختصات', run: () => navigator.clipboard.writeText(ll).then(() => toast('کپی شد'), () => toast('کپی نشد')) },
  ]);
}

/** Who reacted with what; my own reaction can be removed here. */
function reactorsSheet(m) {
  const mine = (m.reactions || {})[S.me];
  const v = h('div', { class: 'veil', onclick: (e) => { if (e.target === v) v.remove(); } },
    h('div', { class: 'dialog' }, h('h3', null, 'واکنش‌ها'),
      h('div', { class: 'picklist' }, E.reactionsOf(m).map(([e, us]) => us.map((u) => h('div', { class: 'pick' }, avatar(u, 'sm'), h('span', { class: 'grow' }, u === S.me ? 'شما' : E.nameOf(u)), h('span', { class: 'rbig' }, e))))),
      h('div', { class: 'btns' },
        mine ? h('button', { class: 'btn danger', onclick: async () => { v.remove(); const e = await E.react(m, null); if (e) toast(e); } }, 'برداشتن واکنش من') : null,
        h('button', { class: 'btn flat', onclick: () => v.remove() }, 'بستن'))));
  document.body.append(v);
}

/** All emoji to pick a reaction from. */
function reactionPicker(m) {
  const pick = async (e) => { v.remove(); Emoji.addRecent(e); const err = await E.react(m, e); if (err) toast(err); };
  const rec = Emoji.recent();
  const v = h('div', { class: 'veil', onclick: (e) => { if (e.target === v) v.remove(); } },
    h('div', { class: 'sheet' }, h('div', { class: 'emojis tall' },
      rec.length ? [h('div', { class: 'cap' }, 'اخیر'), rec.map((e) => h('button', { onclick: () => pick(e) }, e))] : [],
      Emoji.GROUPS.map(([name, list]) => [h('div', { class: 'cap' }, name), list.split(' ').map((e) => h('button', { onclick: () => pick(e) }, e))]))));
  document.body.append(v);
}

/** «اطلاعات پیام»: full send and edit date; for my own messages also the earlier versions (only I can see them). */
function infoSheet(m) {
  const hist = h('div', { class: 'hist' });
  const tick = E.tickOf(m);
  const v = h('div', { class: 'veil', onclick: (e) => { if (e.target === v) v.remove(); } },
    h('div', { class: 'dialog' }, h('h3', null, 'اطلاعات پیام'),
      h('p', null, 'ارسال: ' + fmtFull(m.ts)),
      tick && !E.isGroup(m.convo) ? h('p', null, 'وضعیت: ' + TICK_TEXT[tick]) : null,
      tick && E.isGroup(m.convo) ? (() => { const r = E.readersOf(m); return h('p', null, 'دیده: ' + faNum(r.seen.length) + ' · رسیده: ' + faNum(r.delivered.length) + ' · نرسیده: ' + faNum(r.sent.length)); })() : null,
      m.edited ? h('p', null, 'آخرین ویرایش: ' + fmtFull(m.edited)) : null,
      m.fwFrom ? h('p', null, 'فوروارد از: ' + (m.fwName || m.fwFrom)) : null,
      m.mine && m.edited ? [h('b', null, 'نسخه‌های قبلی (فقط شما می‌بینید)'), hist] : null,
      h('div', { class: 'btns' }, h('button', { class: 'btn flat', onclick: () => v.remove() }, 'بستن'))));
  document.body.append(v);
  if (m.mine && m.edited) {
    fill(hist, h('small', null, 'در حال دریافت…'));
    E.editHistory(m).then((list) => fill(hist, list.length ? list.reverse().map((x) => h('div', { class: 'hv' }, h('div', { dir: 'auto' }, x.text), h('small', null, 'تا ' + fmtFull(x.ts))))
      : h('small', null, 'نسخهٔ قبلی‌ای ذخیره نشده')), () => fill(hist, h('small', null, 'دریافت نشد')));
  }
}

function viewer(url, m) {
  const v = h('div', { class: 'viewer' },
    h('div', { class: 'vbar' }, h('button', { class: 'icon', title: 'بستن', onclick: () => v.remove() }, '✕'),
      m ? h('button', { class: 'icon', title: 'ذخیره', onclick: () => saveMedia(m) }, '⤓') : null),
    h('img', { src: url, alt: '' }));
  document.body.append(v);
}

/** Save / share a downloaded file: the iOS share sheet offers "Save Image" and "Save to Files". */
async function saveMedia(m) {
  const blob = E.mediaBlob(m), url = E.mediaUrl(m);
  if (!url) return;
  const name = m.name || (m.type === 'image' ? 'photo.jpg' : 'file');
  if (blob && navigator.canShare) {
    const f = new File([blob], name, { type: blob.type || m.mime || 'application/octet-stream' });
    if (navigator.canShare({ files: [f] })) {
      try { await navigator.share({ files: [f] }); return; } catch (e) { if (e.name === 'AbortError') return; }
    }
  }
  const a = h('a', { href: url, download: name });
  document.body.append(a); a.click(); a.remove();
}

// ---------------- theme / text size / viewport ----------------
function applyLook() {
  const t = pref('theme', 'system');
  if (t === 'system') document.documentElement.removeAttribute('data-theme'); else document.documentElement.dataset.theme = t;
  document.documentElement.style.setProperty('--fs', pref('fontSize', 16) + 'px');
}
applyLook();
if (window.visualViewport) {
  // iOS: keep the composer above the keyboard
  const fit = () => { app.style.height = visualViewport.height + 'px'; if (document.activeElement && document.activeElement.tagName === 'TEXTAREA') window.scrollTo(0, 0); };
  visualViewport.addEventListener('resize', fit);
  fit();
}

// ---------------- routing ----------------
let view = null;
function go(hash) { if (location.hash !== hash) location.hash = hash; else route(); }
function route() {
  if (view && view.destroy) view.destroy();
  S.openConvo = null;
  const hash = decodeURIComponent(location.hash.slice(1) || '/');
  if (!S.me) view = LoginScreen();
  else if (S.keyStep) view = KeyScreen(S.keyStep);
  else if (hash === '/keypass') view = KeyScreen('change');
  else if (hash.startsWith('/c/')) view = ChatScreen(hash.slice(3));
  else if (hash.startsWith('/p/')) view = ProfileScreen(hash.slice(3));
  else if (hash === '/new') view = ContactsScreen();
  else if (hash === '/requests') view = RequestsScreen();
  else if (hash === '/settings') view = SettingsScreen();
  else view = ListScreen();
  fill(app, view.el);
  if (view.mounted) view.mounted();
  updateTitle();
}
addEventListener('hashchange', route);

function updateTitle() {
  const n = S.me ? E.summaries().reduce((a, s) => a + s.unread, 0) : 0;
  document.title = n ? `(${faNum(n)}) سپن` : 'سپن';
}

let logoutReason = null;
E.on((kind, data) => {
  if (kind === 'login') { go('#/'); route(); return; }
  if (kind === 'logout') { logoutReason = data; route(); return; }
  if (kind === 'key') { route(); return; }
  if (kind === 'login_alert') {
    const via = { sms: 'با کد پیامکی', device: 'با کد دستگاه دیگر', admin: 'با کد مدیر', password: 'با رمز' }[data.via] || '';
    toast('🔐 ورود تازه به حساب شما' + (data.device ? ' از ' + data.device : '') + ' ' + via + '. اگر خودتان نبودید، به مدیر خبر دهید.');
  }
  if (kind === 'msg' && data && !data.mine && data.id > 0 && Date.now() - data.ts < 60000 && S.openConvo !== data.convo) {
    const group = E.isGroup(data.convo);
    toast((group ? E.groupName(data.convo) + ' · ' + E.nameOf(data.sender) : E.nameOf(data.sender)) + ': ' + E.preview(data).slice(0, 60), () => go('#/c/' + encodeURIComponent(data.convo)));
    if (pref('sound', true)) Call.notifySound();
  }
  if (kind === 'msg' || kind === 'read') updateTitle();
  if (view && view.update) view.update(kind, data);
});
document.addEventListener('visibilitychange', () => {
  const visible = document.visibilityState === 'visible';
  E.setActive(visible);
  if (visible) { E.resume(); if (S.openConvo) E.markRead(S.openConvo); }
});
addEventListener('pagehide', () => E.setActive(false));
document.addEventListener('pointerdown', () => Call.unlockAudio(), { capture: true });

/** Screens re-render on engine events; this batches several events into one frame. */
function batched(fn) {
  let queued = false;
  return () => { if (queued) return; queued = true; requestAnimationFrame(() => { queued = false; fn(); }); };
}

function connText() {
  if (S.conn === 'online') return '';
  return S.conn === 'connecting' ? 'در حال اتصال…' : 'منتظر شبکه…';
}

// ---------------- login ----------------
/**
 * Sign-in by mobile number: an SMS code, or (SMS down / no internet) a code from another signed-in
 * device of the user or from the admin. Username + password stays as a second way while the admin allows it.
 */
function LoginScreen() {
  const reason = logoutReason || '';
  logoutReason = null;
  const input = (ph, extra) => h('input', { type: 'text', placeholder: ph, class: 'ltr', autocapitalize: 'off', autocorrect: 'off', spellcheck: 'false', ...extra });
  const phone = input('شمارهٔ موبایل', { inputmode: 'tel', autocomplete: 'tel' });
  const code = input('کد', { inputmode: 'numeric', autocomplete: 'one-time-code', maxLength: 8 });
  const user = input('نام کاربری', { autocomplete: 'username' });
  const pass = h('input', { type: 'password', placeholder: 'رمز عبور', autocomplete: 'current-password', class: 'ltr' });
  const err = h('div', { class: 'err' }, reason);
  const info = h('div', { class: 'hint', style: { margin: 0 } });
  const box = h('div', { style: { display: 'flex', flexDirection: 'column', gap: '12px' } });
  const apkBox = h('div');
  let cfg = { sms: true, password: true, apk: false, signup: false }, mode = 'phone', step = 'phone', timer = null, ticket = null;
  const uname = input('نام کاربری (انگلیسی)', { autocomplete: 'username', maxLength: 20 });
  const dname = h('input', { type: 'text', placeholder: 'نام نمایشی', maxLength: 40 });

  const busy = async (btn, fn) => {
    btn.disabled = true; err.textContent = '';
    try { await fn(); } catch (ex) { err.textContent = E.errText(ex); }
    btn.disabled = false;
  };
  const sendBtn = h('button', { class: 'btn', type: 'button' }, 'ارسال کد پیامکی');
  const resend = h('button', { class: 'btn sm flat', type: 'button' });
  const loginBtn = h('button', { class: 'btn', type: 'submit' }, 'ورود');
  function countdown(sec) {
    clearInterval(timer);
    let left = sec;
    const tick = () => {
      resend.disabled = left > 0;
      resend.textContent = left > 0 ? 'ارسال دوباره (' + faNum(left) + ')' : 'ارسال دوباره';
      if (left-- <= 0) clearInterval(timer);
    };
    tick();
    timer = setInterval(tick, 1000);
  }
  async function sendSms(btn) {
    if (!phone.value.trim()) { err.textContent = 'شمارهٔ موبایل را وارد کنید'; return; }
    await busy(btn, async () => {
      try { await api.smsCode(phone.value); }
      catch (ex) {
        if (ex instanceof api.HttpError && ex.body.error === 'wait') { step = 'code'; render(); countdown(ex.body.wait || 60); return; }
        if (ex instanceof api.HttpError && ex.body.error === 'sms_unavailable') { step = 'code'; render(); }
        throw ex;
      }
      step = 'code'; render();
      info.textContent = 'کد ۵ رقمی به ' + phone.value.trim() + ' پیامک شد.';
      countdown(60);
      code.focus();
    });
  }
  sendBtn.addEventListener('click', () => sendSms(sendBtn));
  resend.addEventListener('click', () => sendSms(resend));
  const link = (text, fn) => h('a', { href: '#', class: 'center', style: { display: 'block', fontSize: '14px' }, onclick: (e) => { e.preventDefault(); err.textContent = ''; fn(); } }, text);

  async function submit(e) {
    if (e) e.preventDefault();
    if (mode === 'password') {
      if (!user.value.trim() || !pass.value) { err.textContent = 'نام کاربری و رمز عبور را وارد کنید'; return; }
      return busy(loginBtn, () => E.login(user.value, pass.value));
    }
    if (step === 'phone') return cfg.sms ? sendSms(sendBtn) : null;
    if (step === 'signup') {
      if (!uname.value.trim()) { err.textContent = 'یک نام کاربری انتخاب کنید'; return; }
      return busy(loginBtn, async () => { const e2 = await E.signup(ticket, uname.value, dname.value); if (e2) err.textContent = e2; });
    }
    if (!phone.value.trim() || !code.value.trim()) { err.textContent = 'شمارهٔ موبایل و کد را وارد کنید'; return; }
    return busy(loginBtn, async () => {
      const r = await E.codeLogin(phone.value, code.value);
      if (r && r.signup) { ticket = r.ticket; step = 'signup'; clearInterval(timer); render(); uname.focus(); }
    });
  }

  function render() {
    if (mode === 'password') {
      fill(box, user, pass, err, loginBtn, cfg.sms || !cfg.password ? link('ورود با شمارهٔ موبایل', () => { mode = 'phone'; render(); }) : null);
      return;
    }
    const noSms = !cfg.sms;
    if (step === 'signup') {
      loginBtn.textContent = 'ساخت حساب';
      fill(box,
        h('div', { class: 'hint', style: { margin: 0 } }, 'شمارهٔ ' + phone.value.trim() + ' تأیید شد و هنوز حسابی ندارد. یک نام کاربری انتخاب کنید؛ دیگران با همین نام شما را پیدا می‌کنند.'),
        uname, dname, err, loginBtn,
        link('انصراف', () => { step = 'phone'; ticket = null; loginBtn.textContent = 'ورود'; render(); }));
      return;
    }
    fill(box,
      phone,
      step === 'code' ? [code, info] : null,
      step === 'phone' && cfg.signup ? h('div', { class: 'hint', style: { margin: 0 } }, 'حساب ندارید؟ با همین شماره و کد پیامکی ثبت‌نام می‌شوید.') : null,
      step === 'phone' && noSms ? h('div', { class: 'hint', style: { margin: 0 } }, 'ورود با پیامک روی این سرور فعال نیست. کد ورود را از دستگاه دیگرتان (تنظیمات › ورود دستگاه تازه) یا از مدیر بگیرید.') : null,
      err,
      step === 'phone' && !noSms ? sendBtn : loginBtn,
      step === 'code' && !noSms ? h('div', { class: 'center' }, resend) : null,
      step === 'phone'
        ? link('کد را دارم (از دستگاه دیگر یا مدیر)', () => { step = 'code'; render(); info.textContent = 'کد ۶ رقمی را که روی دستگاه دیگرتان (تنظیمات › ورود دستگاه تازه) یا از مدیر گرفته‌اید وارد کنید.'; code.focus(); })
        : link('پیامک نرسید؟', () => { info.textContent = 'اگر پیامک نمی‌رسد، روی دستگاه دیگری که واردش هستید «تنظیمات › ورود دستگاه تازه» را بزنید و کد ۶ رقمی آن را همین‌جا وارد کنید، یا از مدیر سرور «کد ورود» بخواهید.'; }),
      step === 'code' ? link('تغییر شماره', () => { step = 'phone'; clearInterval(timer); render(); }) : null,
      cfg.password ? link('ورود با نام کاربری و رمز', () => { mode = 'password'; render(); }) : null);
    if (step === 'phone' && noSms) { step = 'code'; render(); info.textContent = 'کد ۶ رقمی از دستگاه دیگرتان یا از مدیر'; }
  }
  render();

  api.authConfig().then((c) => {
    cfg = c;
    if (!c.sms && !c.password) mode = 'phone';
    if (mode === 'password' && !c.password) mode = 'phone';
    render();
    // the Android app for download (from this server, so it works without international internet too)
    fill(apkBox, c.apk ? h('div', { class: 'hint apk' },
      h('b', null, 'برنامهٔ اندروید سپن'), h('br'),
      isIOS ? 'برای گوشی‌های اندروید. روی آیفون از همین نسخهٔ وب استفاده کنید؛ این QR را با دوربین گوشی اندرویدی اسکن کنید:' : 'برای نصب روی گوشی اندروید:',
      isIOS ? h('img', { class: 'qr', src: '/download/sepan-qr.svg', alt: 'QR دانلود برنامهٔ اندروید' }) : null,
      h('a', { class: 'btn sm flat', href: '/download/sepan.apk', download: 'sepan.apk' }, '⬇️ دانلود فایل APK')) : null);
  }).catch(() => { });

  const el = h('div', { class: 'scroll' }, h('div', { class: 'login' },
    h('img', { class: 'logo', src: '/icon-192.png', alt: '' }),
    h('h2', null, 'سپن'),
    h('p', null, 'پیام‌رسان خصوصی و رمزنگاری‌شده'),
    h('form', { class: 'form', onsubmit: submit }, box),
    apkBox,
    isIOS && !standalone() ? h('div', { class: 'hint' }, 'بعد از ورود، از دکمهٔ اشتراک‌گذاری ', h('b', null, '⬆️'), ' گزینهٔ ', h('b', null, '«افزودن به صفحهٔ اصلی»'), ' را بزنید تا سپن مثل یک برنامه باز شود.') : null));
  return { el, mounted: () => phone.focus(), destroy: () => clearInterval(timer) };
}

// ---------------- identity key: restore / new key / key password ----------------
/**
 * mode 'choose': this device does not have the account's key (restore it with the key password or make
 * a new one); 'setpass': the key has no key password yet (mandatory); 'change': from Settings.
 */
function KeyScreen(mode) {
  const kb = S.keyBackup;
  const pwField = (ph, ac) => h('input', { type: 'password', placeholder: ph, autocomplete: ac || 'new-password', class: 'ltr' });
  // the account is confirmed by its login password or, for accounts that sign in by SMS, by an SMS code
  const acct = () => {
    if (!E.needsAccountPassword() && mode !== 'change') return null;
    const f = pwField('رمز ورود حساب یا کد پیامکی', 'current-password');
    const b = h('button', { class: 'btn sm flat', type: 'button', onclick: async () => {
      b.disabled = true;
      const e = await E.reauthSms();
      toast(e || 'کد تأیید به موبایل شما پیامک شد');
      setTimeout(() => { b.disabled = false; }, 60000);
    } }, 'ارسال کد پیامکی');
    const wrap = h('div', { class: 'field' }, f, h('div', { class: 'd', style: { fontSize: '13px', color: 'var(--fg2)' } }, 'اگر با پیامک وارد می‌شوید و رمز ندارید: ', b));
    Object.defineProperty(wrap, 'value', { get: () => f.value }); // read like an input
    return wrap;
  };
  const busy = async (btn, err, fn) => {
    btn.disabled = true; err.className = 'err'; err.textContent = '';
    try { const e = await fn(); if (e) err.textContent = e; } catch (ex) { err.textContent = E.errText(ex); }
    btn.disabled = false;
  };
  const checkNew = (a, b) => (a.value.length < 6 ? 'رمز کلید باید دست‌کم ۶ نویسه باشد' : a.value !== b.value ? 'رمز کلید و تکرار آن یکی نیستند' : null);

  // set (or change) the key password of the key on this device
  const setForm = (title, intro, submitLabel, makeNew) => {
    const p1 = pwField('رمز کلید تازه'), p2 = pwField('تکرار رمز کلید'), ap = acct();
    const err = h('div', { class: 'err' });
    const btn = h('button', { class: 'btn' + (makeNew ? ' danger' : ''), type: 'submit' }, submitLabel);
    return h('form', { class: 'form', onsubmit: (e) => {
      e.preventDefault();
      busy(btn, err, async () => {
        const bad = checkNew(p1, p2) || (ap && !ap.value ? 'رمز ورود حساب یا کد پیامکی را وارد کنید' : null);
        if (bad) return bad;
        if (makeNew && !(await confirmBox('ساخت کلید تازه', 'با کلید تازه، پیام‌های قبلی روی دستگاه‌هایی که آن‌ها را ندارند باز نمی‌شوند و دستگاه‌های دیگر شما باید دوباره کلید را بازگردانند. ادامه می‌دهید؟', 'ساخت کلید تازه', true))) return null;
        const e2 = makeNew ? await E.newKey(p1.value, ap && ap.value) : await E.setKeyPassword(p1.value, ap && ap.value);
        if (!e2 && mode === 'change') { toast('رمز کلید عوض شد'); go('#/settings'); }
        return e2;
      });
    } }, h('h3', null, title), h('p', { class: 'hint' }, intro), p1, p2, ap, err, btn);
  };

  let body;
  if (mode === 'choose') {
    const restore = kb ? (() => {
      const kp = pwField(kb.v === 2 ? 'رمز کلید' : 'رمز ورود قبلی حساب', 'current-password');
      const err = h('div', { class: 'err' });
      const btn = h('button', { class: 'btn', type: 'submit' }, 'بازگرداندن کلید قبلی');
      return h('form', { class: 'form', onsubmit: (e) => { e.preventDefault(); busy(btn, err, () => (kp.value ? E.restoreKey(kp.value) : 'رمز را وارد کنید')); } },
        h('h3', null, 'بازگرداندن کلید قبلی (پیشنهادی)'),
        h('p', { class: 'hint' }, kb.v === 2
          ? 'رمز کلیدی را که برای حسابتان گذاشته‌اید وارد کنید. پیام‌های قبلی خوانا می‌مانند و مخاطبان تغییری نمی‌بینند.'
          : 'این حساب هنوز رمز کلید ندارد و کلیدش با رمز ورود قبلی قفل است. همان رمز قبلی را وارد کنید.'),
        kp, err, btn);
    })() : h('p', { class: 'hint' }, 'برای کلید این حساب پشتیبانی روی سرور نیست، پس فقط ساخت کلید تازه ممکن است.');
    body = [
      h('p', null, 'کلید رمزنگاری این دستگاه با کلید حساب شما یکی نیست. تا یکی از دو راه زیر را انتخاب نکنید، پیامی فرستاده یا باز نمی‌شود.'),
      restore,
      h('div', { class: 'section' }, 'یا'),
      setForm('ساخت کلید تازه', 'پیام‌های قبلی با کلید تازه باز نمی‌شوند و کنار نام شما برای مخاطبان «کلید عوض شد» می‌آید. اگر رمز کلید را فراموش کرده‌اید، همین راه را بزنید.', 'ساخت کلید تازه', true),
    ];
  } else if (mode === 'setpass') {
    body = [setForm('رمز کلید بگذارید', 'کلید رمزنگاری شما با این رمز قفل می‌شود و روی سرور می‌ماند تا روی هر دستگاه بازگردد. این رمز جدا از رمز ورود است، فقط شما آن را می‌دانید و مدیر هم نمی‌تواند عوضش کند. اگر فراموشش کنید، پیام‌های قدیمی روی دستگاه تازه باز نمی‌شوند.', 'ذخیرهٔ رمز کلید', false)];
  } else {
    body = [setForm('تغییر رمز کلید', 'کلید همان می‌ماند؛ فقط رمزی که پشتیبانش با آن قفل است عوض می‌شود.', 'ذخیرهٔ رمز کلید تازه', false)];
  }
  const el = h('div', { class: 'scroll', style: { display: 'flex', flexDirection: 'column', overflow: 'hidden' } },
    h('div', { class: 'bar' },
      mode === 'change' ? h('button', { class: 'icon', title: 'بازگشت', onclick: () => go('#/settings') }, '→') : null,
      h('h1', null, 'کلید رمزنگاری'),
      mode !== 'change' ? h('button', { class: 'btn sm flat', onclick: () => E.logout() }, 'خروج') : null),
    h('div', { class: 'scroll' }, h('div', { class: 'keybox' }, body)));
  return { el };
}

// ---------------- chat list ----------------
function ListScreen() {
  const conn = h('span', { class: 'conn' });
  const reqBadge = h('span', { class: 'badge hidden' });
  const list = h('div', { class: 'scroll' });
  const el = h('div', { class: 'scroll', style: { display: 'flex', flexDirection: 'column', overflow: 'hidden' } },
    h('div', { class: 'bar' },
      h('h1', null, 'سپن ', conn),
      h('button', { class: 'icon', title: 'درخواست‌های ارتباط', onclick: () => go('#/requests') }, '👥', reqBadge),
      h('button', { class: 'icon', title: 'گفتگوی تازه', onclick: () => go('#/new') }, '✏️'),
      h('button', { class: 'icon', title: 'تنظیمات', onclick: () => go('#/settings') }, '⚙️')),
    list);
  const render = batched(() => {
    conn.textContent = connText();
    const n = S.requests.incoming.length;
    reqBadge.textContent = faNum(n);
    reqBadge.classList.toggle('hidden', !n);
    const pins = pinnedChats();
    const all = E.summaries();
    const sorted = [...pins.map((c) => all.find((s) => s.convo === c)).filter(Boolean), ...all.filter((s) => !pins.includes(s.convo))];
    const rows = sorted.map((s) => {
      const group = E.isGroup(s.convo);
      const gt = group ? E.typingIn(s.convo) : [];
      const typing = group ? gt.length > 0 : Date.now() - (S.typing[s.convo] || 0) < 4500;
      const last = s.last;
      const draft = draftOf(s.convo);
      let prev = last ? (group && !last.mine && last.type !== 'call' ? E.nameOf(last.sender) + ': ' : last.mine && last.type !== 'call' ? 'شما: ' : '') + E.preview(last) : 'هنوز پیامی نیست';
      if (draft) prev = [h('span', { class: 'draft' }, 'پیش‌نویس: '), draft];
      if (typing) prev = group ? E.nameOf(gt[0]) + (gt.length > 1 ? ' و ' + faNum(gt.length - 1) + ' نفر دیگر' : '') + ' در حال نوشتن…' : 'در حال نوشتن…';
      const tick = last && !typing && !draft ? E.tickOf(last) : null;
      const row = h('button', { class: 'row' },
        avatarWithDot(s.convo),
        h('div', { class: 'mid' },
          h('div', { class: 'top' }, h('div', { class: 'name' }, E.titleOf(s.convo)), tick ? tickEl(tick) : null, h('div', { class: 'time' }, last ? fmtListTime(last.ts) : '')),
          h('div', { class: 'sub' }, h('div', { class: 'prev' + (typing ? ' typing' : '') }, prev), s.unread ? h('span', { class: 'count' }, faNum(s.unread)) : pins.includes(s.convo) ? h('span', { class: 'pinmark' }, '📌') : null)));
      const wasLong = onLongPress(row, () => {
        const pinned = pinnedChats().includes(s.convo);
        sheet(E.titleOf(s.convo), [{ label: pinned ? 'برداشتن سنجاق از بالای فهرست' : '📌 سنجاق به بالای فهرست', run: () => { togglePinChat(s.convo); render(); } }]);
      });
      row.addEventListener('click', () => { if (!wasLong()) go('#/c/' + encodeURIComponent(s.convo)); });
      return row;
    });
    fill(list, 
      isIOS && !standalone() ? h('div', { class: 'hint' }, 'برای اینکه سپن مثل یک برنامه باز شود: دکمهٔ اشتراک‌گذاری ', h('b', null, '⬆️'), ' و بعد ', h('b', null, '«افزودن به صفحهٔ اصلی»'), '.') : null,
      rows.length ? rows : h('div', { class: 'empty' }, 'هنوز گفتگویی ندارید. با دکمهٔ ✏️ یک گفتگو شروع کنید.'));
  });
  render();
  return { el, update: render };
}

// ---------------- contacts (new chat) ----------------
function ContactsScreen() {
  const q = h('input', { type: 'text', placeholder: 'جستجو', oninput: () => render() });
  const list = h('div');
  const el = h('div', { class: 'scroll', style: { display: 'flex', flexDirection: 'column', overflow: 'hidden' } },
    h('div', { class: 'bar' }, h('button', { class: 'icon', title: 'بازگشت', onclick: () => go('#/') }, '→'), h('h1', null, 'مخاطبان'),
      h('button', { class: 'icon', title: 'افزودن مخاطب', onclick: () => go('#/requests') }, '➕')),
    h('div', { class: 'scroll' }, h('div', { class: 'form', style: { paddingBottom: '4px' } }, q), list));
  const render = batched(() => {
    const term = q.value.trim().toLowerCase();
    const groups = S.groups.filter((g) => !term || g.name.toLowerCase().includes(term));
    const users = S.users.filter((u) => u.username !== S.me && (!term || u.username.includes(term) || (u.display_name || '').toLowerCase().includes(term)))
      .sort((a, b) => (b.online - a.online) || E.nameOf(a.username).localeCompare(E.nameOf(b.username), 'fa'));
    const row = (c, sub, onclick) => h('button', { class: 'row', onclick }, avatarWithDot(c, 'sm'), h('div', { class: 'mid' }, h('div', { class: 'name' }, E.titleOf(c)), h('div', { class: 'prev' }, sub)));
    fill(list, 
      groups.length ? h('div', { class: 'section' }, 'گروه‌ها') : null,
      groups.map((g) => row(g.key, faNum(g.members.length) + ' عضو', () => go('#/c/' + encodeURIComponent(g.key)))),
      h('div', { class: 'section' }, 'افراد'),
      users.length ? users.map((u) => row(u.username, (u.online ? 'آنلاین · ' : '') + '@' + u.username + (u.dm ? '' : ' · فقط پاسخ'), () => {
        if (!u.dm && !(S.convos.get(u.username) || []).length) { toast('شروع گفتگو با این کاربر مجاز نیست؛ اگر او پیام بدهد می‌توانید پاسخ دهید'); return; }
        go('#/c/' + encodeURIComponent(u.username));
      })) : h('div', { class: 'empty' }, 'مخاطبی پیدا نشد. از دکمهٔ ➕ برای فرستادن درخواست ارتباط استفاده کنید.'));
  });
  render();
  return { el, update: (k) => { if (k === 'users' || k === 'groups') render(); } };
}

// ---------------- connection requests ----------------
function RequestsScreen() {
  const name = h('input', { type: 'text', placeholder: 'نام کاربری یا شمارهٔ موبایل', class: 'ltr', autocapitalize: 'off', autocorrect: 'off', spellcheck: 'false' });
  const msg = h('div', { class: 'err' });
  const btn = h('button', { class: 'btn', type: 'submit' }, 'فرستادن درخواست');
  const lists = h('div');
  E.refreshRequests().catch(() => { });
  async function add(e) {
    e.preventDefault();
    if (!name.value.trim()) return;
    btn.disabled = true;
    let who = name.value.trim();
    // a mobile number: find the member it belongs to (only members who allow being found by number)
    if (/^[+\d\s\-()۰-۹٠-٩]{7,}$/.test(who)) {
      const f = await E.lookup([who]);
      if (f.error || !f.matches.length) {
        btn.disabled = false;
        msg.className = 'err';
        msg.textContent = f.error || 'کسی با این شماره در سپن پیدا نشد (یا پیدا شدن با شماره را خاموش کرده)';
        return;
      }
      const m = f.matches[0];
      if (m.connected) { btn.disabled = false; msg.className = 'ok'; msg.textContent = (m.display_name || m.username) + ' از قبل در مخاطبان شماست'; return; }
      if (!(await confirmBox('درخواست ارتباط', 'این شماره متعلق به ' + (m.display_name ? m.display_name + ' ' : '') + '(@' + m.username + ') است. درخواست ارتباط فرستاده شود؟', 'فرستادن'))) { btn.disabled = false; return; }
      who = m.username;
    }
    const r = await E.contactAction('request', who);
    btn.disabled = false;
    msg.className = r.error ? 'err' : 'ok';
    msg.textContent = r.error || (r.result === 'connected' ? 'ارتباط برقرار شد' : 'درخواست فرستاده شد؛ بعد از پذیرفتن او به مخاطبان اضافه می‌شود');
    if (!r.error) name.value = '';
  }
  const act = async (what, u, accept) => { const r = await E.contactAction(what, u, accept); if (r.error) toast(r.error); };
  const el = h('div', { class: 'scroll', style: { display: 'flex', flexDirection: 'column', overflow: 'hidden' } },
    h('div', { class: 'bar' }, h('button', { class: 'icon', title: 'بازگشت', onclick: () => history.length > 1 ? history.back() : go('#/') }, '→'), h('h1', null, 'درخواست‌های ارتباط')),
    h('div', { class: 'scroll' },
      h('form', { class: 'form', onsubmit: add }, h('div', { class: 'field' }, h('label', null, 'افزودن مخاطب با نام کاربری یا شمارهٔ موبایل'), name), msg, btn),
      lists));
  const render = batched(() => {
    const { incoming, outgoing } = S.requests;
    const who = (r) => (r.display_name ? r.display_name + ' · ' : '') + '@' + r.username;
    fill(lists, 
      h('div', { class: 'section' }, 'درخواست‌های دریافتی'),
      incoming.length ? incoming.map((r) => h('div', { class: 'setting' }, h('div', { class: 'l' }, who(r)),
        h('button', { class: 'btn sm', onclick: () => act('respond', r.username, true) }, 'پذیرفتن'),
        h('button', { class: 'btn sm flat', onclick: () => act('respond', r.username, false) }, 'رد'))) : h('div', { class: 'hint' }, 'درخواستی ندارید'),
      h('div', { class: 'section' }, 'درخواست‌های فرستاده‌شده'),
      outgoing.length ? outgoing.map((r) => h('div', { class: 'setting' }, h('div', { class: 'l' }, who(r), h('div', { class: 'd' }, r.status === 'declined' ? 'رد شد' : 'در انتظار پاسخ')),
        h('button', { class: 'btn sm flat', onclick: () => act('cancel', r.username) }, 'لغو'))) : h('div', { class: 'hint' }, 'درخواستی نفرستاده‌اید'));
  });
  render();
  return { el, update: (k) => { if (k === 'requests') render(); } };
}

// ---------------- chat ----------------
function ChatScreen(convo) {
  const group = E.isGroup(convo);
  if (!group && !E.user(convo) && !(S.convos.get(convo) || []).length) { setTimeout(() => go('#/'), 0); return { el: h('div') }; }
  S.openConvo = convo;
  E.markRead(convo);
  let reply = null, editing = null, selected = null, limit = 120, search = '', forceBottom = true;

  const title = h('div', { class: 't' }), sub = h('div', { class: 's' }), av = h('div');
  const callBtns = group ? [] : [
    h('button', { class: 'icon', title: 'تماس صوتی', onclick: () => Call.startCall(convo, false) }, '📞'),
    h('button', { class: 'icon', title: 'تماس تصویری', onclick: () => Call.startCall(convo, true) }, '🎥')];
  const searchInput = h('input', { type: 'text', placeholder: 'جستجو در گفتگو', oninput: () => { search = searchInput.value.trim(); renderList(); } });
  const searchBar = h('div', { class: 'searchbar hidden' }, searchInput, h('button', { class: 'icon', onclick: () => { searchBar.classList.add('hidden'); search = ''; searchInput.value = ''; renderList(); } }, '✕'));
  const pinBar = h('div', { class: 'pinbar hidden' });
  const msgs = h('div', { class: 'msgs' });
  const jumpCount = h('span', { class: 'badge hidden' });
  const jump = h('button', { class: 'jump hidden', title: 'آخرین پیام', onclick: () => { forceBottom = true; msgs.scrollTop = msgs.scrollHeight; } }, '⌄', jumpCount);

  const ta = h('textarea', { rows: 1, placeholder: 'پیام', dir: 'auto' });
  const fileIn = h('input', { type: 'file', multiple: true, class: 'hidden' });
  const replyBar = h('div', { class: 'replybar hidden' });
  const selCount = h('div', { class: 'grow' });
  const selBar = h('div', { class: 'selbar hidden' }, h('button', { class: 'icon', title: 'لغو', onclick: () => setSelecting(null) }, '✕'), selCount,
    h('button', { class: 'btn sm', onclick: () => {
      const all = S.convos.get(convo) || [];
      const msgsSel = all.filter((x) => selected.has(x.id));
      if (msgsSel.length) forwardSheet(msgsSel, () => setSelecting(null));
    } }, 'فوروارد'));
  const emojiPanel = h('div', { class: 'emojis hidden' });
  const sendBtn = h('button', { class: 'icon send', title: 'ارسال' }, '➤');
  const micBtn = h('button', { class: 'icon mic', title: 'پیام صوتی (نگه دارید)' }, '🎤');
  const recBar = h('div', { class: 'recbar hidden' });
  const attachBtn = h('button', { class: 'icon', title: 'پیوست', onclick: () => sheet(null, [
    { label: '🖼 عکس یا فایل', run: () => fileIn.click() },
    { label: '📍 موقعیت مکانی', run: shareLocation },
  ]) }, '📎');
  async function shareLocation() {
    toast('در حال پیدا کردن موقعیت…');
    let loc;
    try { loc = await E.currentLocation(); } catch (e) { toast(E.errText(e)); return; }
    document.querySelectorAll('.toast').forEach((t) => t.remove());
    const ok = await confirmBox('ارسال موقعیت مکانی', E.fmtCoord(loc) + (loc.acc ? ' (دقت حدود ' + faNum(loc.acc) + ' متر)' : '') + ' برای ' + E.titleOf(convo) + ' فرستاده شود؟', 'ارسال');
    if (!ok) return;
    forceBottom = true;
    await E.sendLocation(convo, loc, reply);
    setReply(null);
  }
  const emojiBtn = h('button', { class: 'icon', title: 'شکلک' }, '🙂');

  const el = h('div', { class: 'chat', style: { display: 'flex', flexDirection: 'column', height: '100%', position: 'relative' } },
    h('div', { class: 'bar' },
      h('button', { class: 'icon', title: 'بازگشت', onclick: () => go('#/') }, '→'),
      h('div', { class: 'grow', style: { display: 'flex', gap: '10px', alignItems: 'center' }, onclick: () => go('#/p/' + encodeURIComponent(convo)) }, av, h('div', { style: { minWidth: '0' } }, title, sub)),
      callBtns,
      h('button', { class: 'icon', title: 'جستجو', onclick: () => { searchBar.classList.remove('hidden'); searchInput.focus(); } }, '🔍')),
    searchBar, pinBar, msgs, jump,
    h('div', { class: 'composer' }, selBar, replyBar, recBar, h('div', { class: 'line' }, emojiBtn, ta, attachBtn, sendBtn, micBtn), emojiPanel, fileIn));

  function renderHeader() {
    title.textContent = E.titleOf(convo);
    fill(av, avatarWithDot(convo, 'sm'));
    const c = connText();
    let s = '', on = false;
    if (c) s = c;
    else if (group && E.typingIn(convo).length) { const t = E.typingIn(convo); s = E.nameOf(t[0]) + (t.length > 1 ? ' و ' + faNum(t.length - 1) + ' نفر دیگر' : '') + ' در حال نوشتن…'; on = true; }
    else if (group) {
      const g = S.groups.find((x) => x.key === convo);
      const n = g ? g.members.filter((u) => u !== S.me && E.user(u) && E.user(u).online).length : 0;
      s = g ? faNum(g.members.length) + ' عضو' + (n ? '، ' + faNum(n) + ' آنلاین' : '') : '';
    }
    else if (Date.now() - (S.typing[convo] || 0) < 4500) { s = 'در حال نوشتن…'; on = true; }
    else { const u = E.user(convo); s = lastSeenText(u) || '@' + convo; on = !!(u && u.online); }
    sub.textContent = s;
    sub.classList.toggle('on', on);
  }

  function renderPin() {
    const id = S.pins[convo];
    const m = id && (S.convos.get(convo) || []).find((x) => x.id === id);
    pinBar.classList.toggle('hidden', !id);
    if (!id) return;
    fill(pinBar, h('span', null, '📌'), h('div', { class: 'pt' }, h('b', null, 'پیام سنجاق‌شده'), h('span', null, m ? E.preview(m) : 'پیام')));
    pinBar.onclick = () => scrollToMsg(id);
  }

  function setSelecting(set) {
    selected = set;
    selBar.classList.toggle('hidden', !set);
    if (set) selCount.textContent = faNum(set.size) + ' پیام انتخاب شد';
    renderList(true);
  }

  function setEditing(m) {
    editing = m;
    if (m) reply = null;
    queueMicrotask(() => showMic());
    replyBar.classList.toggle('hidden', !m);
    if (m) {
      fill(replyBar, h('div', { class: 'reply' }, h('div', { class: 'ru' }, '✎ ویرایش پیام'), h('div', { class: 'rx' }, E.preview(m))),
        h('button', { class: 'icon', onclick: () => { setEditing(null); ta.value = ''; autosize(); } }, '✕'));
      ta.value = m.text; autosize(); ta.focus();
    }
  }

  function setReply(m) {
    if (editing && m) { editing = null; ta.value = ''; }
    reply = m;
    replyBar.classList.toggle('hidden', !m);
    if (m) {
      fill(replyBar, h('div', { class: 'reply' }, h('div', { class: 'ru' }, 'پاسخ به ' + (m.mine ? 'خودتان' : E.nameOf(m.sender))), h('div', { class: 'rx' }, E.preview(m))),
        h('button', { class: 'icon', onclick: () => setReply(null) }, '✕'));
      ta.focus();
    }
  }

  function highlight(text) {
    if (!search) return text;
    const out = [];
    const low = text.toLowerCase(), q = search.toLowerCase();
    let i = 0, j;
    while ((j = low.indexOf(q, i)) >= 0) { out.push(text.slice(i, j), h('mark', null, text.slice(j, j + q.length))); i = j + q.length; }
    out.push(text.slice(i));
    return out;
  }

  function mediaPart(m) {
    const url = E.mediaUrl(m);
    const prog = S.progress.get(m.id);
    const fail = S.failures.get(m.id);
    if (m.type === 'image') {
      const w = Math.min(260, m.w || 260), hgt = m.w && m.h ? Math.round(w * m.h / m.w) : 180;
      const box = { width: w + 'px', height: Math.min(hgt, 360) + 'px' };
      if (url) return h('img', { class: 'img', src: url, alt: '', style: box, onclick: (e) => { e.stopPropagation(); viewer(url, m); } });
      if (m.fileId && !fail && prog == null && m.size <= 25 * 1024 * 1024 && pref('autoImages', true)) E.download(m).catch(() => { });
      return h('div', { class: 'img-ph', style: box, onclick: (e) => { e.stopPropagation(); S.failures.delete(m.id); E.download(m).catch(() => { }); renderList(); } },
        prog != null ? '⏳ ' + faNum(Math.round(prog * 100)) + '٪' : fail ? '⚠️ ' + fail + ' (دوباره)' : '🖼 ' + fmtSize(m.size));
    }
    return h('div', { class: 'file', onclick: async (e) => {
      e.stopPropagation();
      if (E.mediaUrl(m)) return saveMedia(m);
      if (!m.fileId) return;
      S.failures.delete(m.id);
      try { await E.download(m); toast('دانلود شد؛ برای ذخیره دوباره بزنید'); } catch { }
    } },
    h('div', { class: 'fi' }, url ? '📄' : prog != null ? '⏳' : '⤓'),
    h('div', { style: { minWidth: '0' } }, h('div', { class: 'fn' }, m.name || 'file'),
      h('div', { class: 'fs' }, prog != null ? faNum(Math.round(prog * 100)) + '٪ از ' + fmtSize(m.size) : fail && m.status !== 2 ? '⚠️ ' + fail : fmtSize(m.size))));
  }

  // voice messages on screen: their play button, bars and time are updated in place while playing
  const voiceEls = new Map();
  function paintVoice(m) {
    const v = voiceEls.get(m.id);
    if (!v) return;
    const st = Voice.state(m.id);
    const frac = m.dur ? Math.min(1, st.pos / m.dur) : 0;
    v.btn.textContent = S.progress.get(m.id) != null ? '⏳' : st.playing ? '❚❚' : '▶';
    v.bars.forEach((b, i) => b.classList.toggle('on', (i + 0.5) / v.bars.length <= frac));
    v.time.textContent = fmtDur(st.playing || st.pos ? st.pos : m.dur);
  }
  const offPlayer = Voice.onPlayer(() => { for (const id of voiceEls.keys()) { const m = (S.convos.get(convo) || []).find((x) => x.id === id); if (m) paintVoice(m); } });
  function voicePart(m) {
    const fail = S.failures.get(m.id);
    if (!E.mediaUrl(m) && m.fileId && !fail && S.progress.get(m.id) == null && pref('autoImages', true) && m.size <= 25 * 1024 * 1024) E.download(m).catch(() => { });
    const wave = (m.wave && m.wave.length ? m.wave : new Array(40).fill(3));
    const bars = wave.map((x) => h('i', { style: { height: (3 + x * 0.7) + 'px' } }));
    const btn = h('button', { class: 'vplay', onclick: async (e) => {
      e.stopPropagation();
      Voice.prime();
      let url = E.mediaUrl(m);
      if (!url) {
        if (!m.fileId) return;
        S.failures.delete(m.id);
        try { url = await E.download(m); } catch { renderListB(); return; }
      }
      Voice.toggle(m.id, url);
    } });
    const waveEl = h('div', { class: 'wave', onclick: (e) => { e.stopPropagation(); const r = waveEl.getBoundingClientRect(); Voice.seek(m.id, (e.clientX - r.left) / r.width); } }, bars);
    const time = h('span');
    voiceEls.set(m.id, { btn, bars, time });
    const el = h('div', { class: 'voice' }, btn, h('div', { class: 'vw' }, waveEl, h('div', { class: 'fs' }, time, fail && m.status !== 2 ? ' · ⚠️ ' + fail : '')));
    paintVoice(m);
    return el;
  }

  function locationPart(l) {
    return h('div', { class: 'loc', onclick: (e) => { e.stopPropagation(); openMap(l); } },
      h('div', { class: 'fi' }, '📍'),
      h('div', { style: { minWidth: '0' } }, h('div', { class: 'fn' }, 'موقعیت مکانی'),
        h('div', { class: 'fs ltr' }, E.fmtCoord(l)), l.acc ? h('div', { class: 'fs' }, 'دقت حدود ' + faNum(l.acc) + ' متر') : null));
  }

  function reactionRow(m) {
    const rx = E.reactionsOf(m);
    if (!rx.length) return null;
    return h('div', { class: 'rxn' }, rx.map(([e, us]) => h('button', { class: 'rchip' + (us.includes(S.me) ? ' mine' : ''), onclick: (ev) => { ev.stopPropagation(); reactorsSheet(m); } },
      e, us.length > 1 ? h('span', null, faNum(us.length)) : null)));
  }

  function bubble(m) {
    if (m.type === 'call') return h('div', { class: 'call-line' }, '📞 ' + m.text + ' · ' + fmtTime(m.ts));
    const big = m.type === 'text' && !m.replyId && !m.replyText && Emoji.onlyEmojiCount(m.text) > 0;
    const prog = S.progress.get(m.id);
    const b = h('div', { class: 'bubble' + (big ? ' emoji' : '') },
      group && !m.mine ? h('div', { class: 'who', style: { color: colorFor(m.sender) } }, E.nameOf(m.sender)) : null,
      m.fwFrom ? h('div', { class: 'fw' }, 'فوروارد از ' + (m.fwFrom === S.me ? 'شما' : m.fwName || E.nameOf(m.fwFrom))) : null,
      m.replyText || m.replyId ? h('div', { class: 'reply', onclick: (e) => { e.stopPropagation(); if (m.replyId) scrollToMsg(m.replyId); } },
        h('div', { class: 'ru' }, m.replyUser === S.me ? 'شما' : E.nameOf(m.replyUser || '')), h('div', { class: 'rx' }, m.replyText || '')) : null,
      m.type === 'image' || m.type === 'file' ? mediaPart(m) : null,
      m.type === 'voice' ? voicePart(m) : null,
      m.type === 'location' && m.loc ? locationPart(m.loc) : null,
      m.type === 'text' ? h('div', { class: 'txt', dir: 'auto' }, highlight(m.text)) : null,
      m.mine && prog != null && m.status === 1 ? h('div', { class: 'bar-prog' }, h('i', { style: { width: Math.round(prog * 100) + '%' } })) : null,
      m.status === 2 ? h('div', { class: 'fail' }, '⚠️ ' + (S.failures.get(m.id) || 'ارسال نشد'), h('button', { onclick: (e) => { e.stopPropagation(); E.retry(m); } }, 'تلاش دوباره')) : null,
      reactionRow(m),
      h('div', { class: 'meta' }, m.mine ? (m.status === 1 ? h('span', null, '🕓') : m.status === 2 ? h('span', null, '⚠️') : tickEl(E.tickOf(m))) : null, m.edited ? h('span', { title: fmtFull(m.edited) }, 'ویرایش‌شده ' + (startOfDay(m.edited) === startOfDay(m.ts) ? '' : fmtDay(m.edited) + ' ') + fmtTime(m.edited) + ' ·') : null, h('span', null, fmtTime(m.ts)), S.pins[convo] === m.id ? h('span', null, '📌') : null));
    b.dataset.id = m.id;
    const pickable = m.id > 0 && m.status === 0 && !m.locked;
    return h('div', { class: 'm ' + (m.mine ? 'me' : 'them') + (selected && selected.has(m.id) ? ' sel' : ''), onclick: () => {
      if (!selected) return menu(m);
      if (!pickable) return;
      if (selected.has(m.id)) selected.delete(m.id); else selected.add(m.id);
      if (!selected.size) setSelecting(null); else setSelecting(selected);
    } }, b);
  }

  function menu(m) {
    if (m.locked) return sheet(null, [{ label: 'حذف از این دستگاه', danger: true, run: () => E.deleteLocal(m) }]);
    const pinned = S.pins[convo] === m.id;
    const mineR = (m.reactions || {})[S.me];
    const reactTop = m.id > 0 && m.status === 0 ? (close) => h('div', { class: 'rpick' },
      E.QUICK_REACTIONS.map((e) => h('button', { class: e === mineR ? 'on' : '', onclick: async () => { close(); const err = await E.react(m, e === mineR ? null : e); if (err) toast(err); } }, e)),
      h('button', { class: 'more', title: 'ایموجی‌های بیشتر', onclick: () => { close(); reactionPicker(m); } }, '➕')) : null;
    sheet(null, [
      m.id > 0 && { label: 'پاسخ', run: () => setReply(m) },
      E.canEdit(m) && { label: 'ویرایش', run: () => setEditing(m) },
      m.id > 0 && m.status === 0 && { label: 'فوروارد', run: () => forwardSheet([m]) },
      m.id > 0 && m.status === 0 && { label: 'انتخاب', run: () => setSelecting(new Set([m.id])) },
      m.id > 0 && { label: 'اطلاعات پیام', run: () => infoSheet(m) },
      m.mine && group && m.id > 0 && m.status === 0 && { label: 'دیده شده توسط…', run: () => readersSheet(m) },
      m.type === 'text' && { label: 'کپی', run: () => navigator.clipboard.writeText(m.text).then(() => toast('کپی شد'), () => toast('کپی نشد')) },
      (m.type === 'image' || m.type === 'file') && E.mediaUrl(m) && { label: m.type === 'image' ? 'ذخیرهٔ عکس / اشتراک' : 'ذخیره در Files / اشتراک', run: () => saveMedia(m) },
      m.id > 0 && { label: pinned ? 'برداشتن سنجاق' : 'سنجاق کردن', run: async () => { const e = await E.pinMessage(convo, pinned ? null : m.id); if (e) toast(e); } },
      m.status === 2 && { label: 'تلاش دوباره', run: () => E.retry(m) },
      m.mine && m.id > 0 && m.status === 0 && { label: 'حذف برای همه', danger: true, run: async () => {
        if (!(await confirmBox('حذف برای همه', 'این پیام برای همهٔ اعضای گفتگو پاک می‌شود.', 'حذف', true))) return;
        const e = await E.deleteForAll(m); if (e) toast(e);
      } },
      { label: 'حذف از این دستگاه', danger: true, run: () => E.deleteLocal(m) },
    ], reactTop);
  }

  function scrollToMsg(id) {
    const all = S.convos.get(convo) || [];
    const idx = all.findIndex((x) => x.id === id);
    if (idx < 0) { toast('این پیام روی این دستگاه نیست'); return; }
    if (all.length - idx > limit) { limit = all.length - idx + 20; renderList(true); }
    const b = msgs.querySelector(`.bubble[data-id="${id}"]`);
    if (!b) return;
    b.scrollIntoView({ block: 'center', behavior: 'smooth' });
    b.classList.remove('flash'); void b.offsetWidth; b.classList.add('flash');
  }

  let seen = 0;
  function renderList(keep) {
    let all = S.convos.get(convo) || [];
    if (search) all = all.filter((m) => (m.type === 'text' ? m.text : E.preview(m)).toLowerCase().includes(search.toLowerCase()));
    const shown = all.slice(-limit);
    const atBottom = msgs.scrollHeight - msgs.scrollTop - msgs.clientHeight < 90;
    const fromBottom = msgs.scrollHeight - msgs.scrollTop;
    const kids = [];
    voiceEls.clear();
    if (all.length > shown.length) kids.push(h('button', { class: 'btn sm flat', style: { alignSelf: 'center' }, onclick: () => { limit += 150; renderList(true); } }, 'پیام‌های قبلی'));
    let lastDay = 0;
    for (const m of shown) {
      const d = startOfDay(m.ts);
      if (d !== lastDay) { kids.push(h('div', { class: 'day' }, fmtDay(m.ts))); lastDay = d; }
      kids.push(bubble(m));
    }
    if (!all.length) kids.push(h('div', { class: 'empty' }, search ? 'پیامی پیدا نشد' : 'هنوز پیامی نیست. پیام‌ها سرتاسری رمزنگاری می‌شوند 🔒'));
    fill(msgs, ...kids);
    if (forceBottom || (atBottom && !keep)) { msgs.scrollTop = msgs.scrollHeight; forceBottom = false; }
    else msgs.scrollTop = msgs.scrollHeight - fromBottom;
    const total = (S.convos.get(convo) || []).length;
    if (msgs.scrollHeight - msgs.scrollTop - msgs.clientHeight < 90) seen = total;
    updateJump(total);
  }
  function updateJump(total) {
    const away = msgs.scrollHeight - msgs.scrollTop - msgs.clientHeight > 300;
    jump.classList.toggle('hidden', !away);
    const n = total - seen;
    jumpCount.textContent = faNum(n);
    jumpCount.classList.toggle('hidden', !(away && n > 0));
  }
  msgs.addEventListener('scroll', () => {
    const total = (S.convos.get(convo) || []).length;
    if (msgs.scrollHeight - msgs.scrollTop - msgs.clientHeight < 90) seen = total;
    updateJump(total);
  }, { passive: true });

  // composer
  const autosize = () => { ta.style.height = 'auto'; ta.style.height = Math.min(140, ta.scrollHeight) + 'px'; };
  const canMic = Voice.canRecord();
  const showMic = () => { const mic = canMic && !ta.value.trim() && !editing; micBtn.classList.toggle('hidden', !mic); sendBtn.classList.toggle('hidden', mic); };
  let draftTimer = null;
  ta.addEventListener('input', () => {
    autosize(); showMic();
    if (ta.value.trim()) E.sendTyping(convo);
    clearTimeout(draftTimer); draftTimer = setTimeout(() => { if (!editing) setDraft(convo, ta.value); }, 400);
  });
  ta.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey && !isIOS && matchMedia('(pointer: fine)').matches) { e.preventDefault(); send(); } });
  async function send() {
    const text = ta.value.trim();
    if (!text) return;
    if (editing) {
      const m = editing;
      setEditing(null); ta.value = ''; autosize();
      if (text !== m.text) { const e = await E.editMessage(m, text); if (e) toast(e); }
      return;
    }
    E.sendText(convo, text, reply);
    ta.value = ''; autosize(); setReply(null); setDraft(convo, ''); showMic();
    forceBottom = true;
    ta.focus();
  }

  // ---- voice message: hold the mic, release to send; slide sideways to cancel, up to lock ----
  let rec = null, recState = null, recTick = null;
  function renderRec() {
    if (!recState) { recBar.classList.add('hidden'); return; }
    recBar.classList.remove('hidden');
    const t = h('span', { class: 'rt' }, fmtDur(rec ? rec.elapsed() : 0));
    const lvl = rec ? Math.min(1, rec.level() * 4) : 0;
    fill(recBar, h('span', { class: 'rdot', style: { transform: 'scale(' + (0.8 + lvl * 0.6) + ')' } }), t,
      recState.locked
        ? [h('span', { class: 'grow' }), h('button', { class: 'btn sm flat', onclick: () => endRec(false) }, '🗑 لغو'), h('button', { class: 'btn sm', onclick: () => endRec(true) }, '➤ ارسال')]
        : h('span', { class: 'grow hintx' }, '⇠ برای لغو بکشید · ⇡ قفل'));
  }
  async function beginRec(e) {
    if (rec || recState) return;
    e.preventDefault();
    try { micBtn.setPointerCapture(e.pointerId); } catch { }
    recState = { x: e.clientX, y: e.clientY, locked: false, up: false, t0: Date.now() };
    Voice.stopAll();
    renderRec();
    try { rec = await Voice.startRecording(); } catch {
      recState = null; renderRec();
      toast('دسترسی به میکروفون داده نشد'); return;
    }
    // the permission prompt took the finger away: start over
    if (!recState || (recState.up && !recState.locked)) { rec.cancel(); rec = null; if (recState && Date.now() - recState.t0 > 1500) toast('دوباره دکمه را نگه دارید و صحبت کنید'); recState = null; renderRec(); return; }
    clearInterval(recTick); recTick = setInterval(renderRec, 200);
    renderRec();
  }
  async function endRec(send) {
    const r = rec, st = recState;
    rec = null; recState = null; clearInterval(recTick); renderRec();
    if (!r) return;
    if (!send) { r.cancel(); return; }
    const out = await r.stop();
    if (!out || out.dur < 700 || !out.blob.size) { if (st && !st.locked) toast('برای ضبط پیام صوتی، دکمه را نگه دارید'); return; }
    forceBottom = true;
    await E.sendVoice(convo, out.blob, out.dur, out.wave, reply);
    setReply(null);
  }
  micBtn.addEventListener('pointerdown', beginRec);
  micBtn.addEventListener('pointermove', (e) => {
    if (!recState || recState.locked) return;
    if (Math.abs(e.clientX - recState.x) > 90) endRec(false);
    else if (recState.y - e.clientY > 70) { recState.locked = true; renderRec(); }
  });
  micBtn.addEventListener('pointerup', () => { if (!recState) return; recState.up = true; if (!recState.locked && rec) endRec(true); });
  micBtn.addEventListener('pointercancel', () => { if (recState && !recState.locked) { recState.up = true; if (rec) endRec(false); } });
  micBtn.addEventListener('contextmenu', (e) => e.preventDefault());
  sendBtn.addEventListener('click', (e) => { e.preventDefault(); send(); });
  sendBtn.addEventListener('mousedown', (e) => e.preventDefault()); // keep the keyboard open
  fileIn.addEventListener('change', async () => {
    const files = [...fileIn.files];
    fileIn.value = '';
    forceBottom = true;
    for (const f of files) { const err = await E.sendFile(convo, f, reply); if (err) toast(err); }
    setReply(null);
  });
  function renderEmojis() {
    const rec = Emoji.recent();
    const btn = (e) => h('button', { onclick: () => {
      const s = ta.selectionStart ?? ta.value.length, en = ta.selectionEnd ?? ta.value.length;
      ta.value = ta.value.slice(0, s) + e + ta.value.slice(en);
      Emoji.addRecent(e); autosize();
    } }, e);
    fill(emojiPanel, rec.length ? [h('div', { class: 'cap' }, 'اخیر'), rec.map(btn)] : [],
      Emoji.GROUPS.map(([name, list]) => [h('div', { class: 'cap' }, name), list.split(' ').map(btn)]));
  }
  emojiBtn.addEventListener('click', () => {
    const open = emojiPanel.classList.toggle('hidden');
    if (!open) { renderEmojis(); ta.blur(); }
  });
  ta.addEventListener('focus', () => emojiPanel.classList.add('hidden'));

  const renderAll = batched(() => { renderHeader(); renderPin(); renderList(); });
  const renderListB = batched(() => renderList());
  const tick = setInterval(renderHeader, 2000);
  ta.value = draftOf(convo);
  showMic();
  renderHeader(); renderPin();
  return {
    el,
    mounted: () => { renderList(); autosize(); },
    destroy: () => {
      clearInterval(tick); clearInterval(recTick); offPlayer(); S.openConvo = null;
      if (rec) { rec.cancel(); rec = null; }
      if (!editing) setDraft(convo, ta.value);
    },
    update(kind, data) {
      if (kind === 'msg') {
        if (data && data.convo !== convo) return;
        if (document.visibilityState === 'visible') E.markRead(convo);
        renderListB(); renderPin();
      } else if (kind === 'progress' || kind === 'media' || kind === 'receipts' || kind === 'privacy' || (kind === 'react' && data && data.convo === convo)) renderListB();
      else if (kind === 'pins') { renderPin(); renderListB(); }
      else if (kind === 'users' || kind === 'typing' || kind === 'conn' || kind === 'groups' || kind === 'avatar') renderAll();
    },
  };
}

// ---------------- profile of a contact or group ----------------
function ProfileScreen(convo) {
  const group = E.isGroup(convo);
  const body = h('div');
  const el = h('div', { class: 'scroll', style: { display: 'flex', flexDirection: 'column', overflow: 'hidden' } },
    h('div', { class: 'bar' }, h('button', { class: 'icon', title: 'بازگشت', onclick: () => history.length > 1 ? history.back() : go('#/') }, '→'), h('h1', null, group ? 'گروه' : 'پروفایل')),
    h('div', { class: 'scroll' }, body));
  const fp = h('div', { class: 'mono' });
  const render = batched(() => {
    if (group) {
      const g = S.groups.find((x) => x.key === convo);
      fill(body, h('div', { class: 'profile-head' }, avatar(convo, 'lg'), h('h2', null, E.groupName(convo)), h('div', { class: 'u' }, g ? faNum(g.members.length) + ' عضو' : '')),
        h('div', { class: 'actions' }, h('button', { class: 'btn', onclick: () => go('#/c/' + encodeURIComponent(convo)) }, 'گفتگو')),
        h('div', { class: 'section' }, 'اعضا'),
        (g ? g.members : []).map((u) => h('button', { class: 'row', onclick: () => { if (u !== S.me) go('#/p/' + encodeURIComponent(u)); } },
          avatarWithDot(u, 'sm'), h('div', { class: 'mid' }, h('div', { class: 'name' }, u === S.me ? 'شما' : E.nameOf(u)), h('div', { class: 'prev' }, '@' + u)))));
      return;
    }
    const u = E.user(convo) || { username: convo };
    const url = E.avatarUrl(convo);
    const av = avatar(convo, 'lg');
    if (url) av.addEventListener('click', () => viewer(url));
    fill(body, 
      h('div', { class: 'profile-head' }, av, h('h2', null, E.nameOf(convo)), h('div', { class: 'u' }, '@' + convo), h('div', { class: 'u' }, lastSeenText(u))),
      u.bio ? h('div', { class: 'hint', dir: 'auto' }, u.bio) : null,
      h('div', { class: 'actions' },
        h('button', { class: 'btn', onclick: () => go('#/c/' + encodeURIComponent(convo)) }, '💬 پیام'),
        h('button', { class: 'btn flat', onclick: () => Call.startCall(convo, false) }, '📞 صوتی'),
        h('button', { class: 'btn flat', onclick: () => Call.startCall(convo, true) }, '🎥 تصویری')),
      h('div', { class: 'section' }, 'کد امنیتی'),
      h('div', { class: 'hint' }, 'اگر این کد با کدی که در گوشی او نمایش داده می‌شود یکی باشد، گفتگو فقط بین شما دو نفر است.', h('br'), fp),
      h('div', { class: 'actions' }, h('button', { class: 'btn danger', onclick: async () => {
        if (!(await confirmBox('حذف ارتباط', 'ارتباط با ' + E.nameOf(convo) + ' حذف شود؟', 'حذف', true))) return;
        const r = await E.contactAction('remove', convo);
        if (r.error) toast(r.error); else go('#/');
      } }, 'حذف ارتباط')));
    if (u.pubkey) fingerprint(u.pubkey).then((t) => { fp.textContent = t; }); else fp.textContent = 'هنوز وارد برنامه نشده';
  });
  render();
  return { el, update: (k) => { if (k === 'users' || k === 'groups' || k === 'avatar') render(); } };
}

// ---------------- settings ----------------
function SettingsScreen() {
  const me = () => E.user(S.me) || { username: S.me };
  const name = h('input', { type: 'text', value: me().display_name || '', maxLength: 40, placeholder: 'نام نمایشی' });
  const bio = h('textarea', { rows: 3, value: me().bio || '', maxLength: 140, placeholder: 'دربارهٔ من', dir: 'auto' });
  const msg = h('div', { class: 'err' });
  const avBox = h('div', { style: { cursor: 'pointer' } });
  const photoIn = h('input', { type: 'file', accept: 'image/*', class: 'hidden' });
  const myFp = h('div', { class: 'mono' });
  const caFp = h('div', { class: 'mono' }, '…');
  fingerprint(S.identity.pubB64).then((t) => { myFp.textContent = t; });
  api.caInfo().then((r) => { caFp.textContent = r.fingerprint; }).catch(() => { caFp.textContent = '—'; });

  const renderAv = () => fill(avBox, avatar(S.me, 'lg'), h('div', { class: 'center', style: { color: 'var(--accent)', marginTop: '6px', fontSize: '14px' } }, 'تغییر عکس'));
  avBox.addEventListener('click', () => sheet('عکس پروفایل', [
    { label: 'انتخاب عکس', run: () => photoIn.click() },
    me().avatar_ver > 0 && { label: 'حذف عکس', danger: true, run: async () => { const e = await E.removeAvatar(); if (e) toast(e); } },
  ]));
  photoIn.addEventListener('change', async () => {
    const f = photoIn.files[0];
    photoIn.value = '';
    if (!f) return;
    try {
      const webp = await toAvatar(f);
      const e = await E.saveAvatar(webp);
      toast(e || 'عکس پروفایل ذخیره شد');
    } catch { toast('این عکس باز نشد'); }
  });

  const select = (key, def, options, after) => {
    const s = h('select', { onchange: () => { setPref(key, isNaN(+s.value) ? s.value : +s.value); if (after) after(); } },
      options.map(([v, l]) => h('option', { value: String(v), selected: String(pref(key, def)) === String(v) }, l)));
    return s;
  };
  const toggle = (key, def) => {
    const c = h('input', { type: 'checkbox', checked: pref(key, def), onchange: () => setPref(key, c.checked) });
    return c;
  };
  const setting = (label, desc, control) => h('div', { class: 'setting' }, h('div', { class: 'l' }, label, desc ? h('div', { class: 'd' }, desc) : null), control);
  // privacy lives on the server (it decides what others get); both switches work both ways
  const privacy = (key, label, desc) => {
    const c = h('input', { type: 'checkbox', checked: !S.privacy[key], onchange: async () => {
      c.disabled = true;
      const e = await E.setPrivacy({ [key]: !c.checked });
      c.disabled = false;
      if (e) { toast(e); c.checked = !S.privacy[key]; }
    } });
    return setting(label, desc, c);
  };
  // notifications while the web app is closed (Web Push)
  const pushBox = h('div');
  async function renderPush() {
    const st = await E.pushState();
    const status = { unsupported: 'این مرورگر پشتیبانی نمی‌کند', denied: 'اجازهٔ اعلان رد شده (از تنظیمات گوشی › سپن › اعلان‌ها روشن کنید)', on: 'روشن', off: 'خاموش' }[st];
    const busy = (fn) => async (e) => { e.target.disabled = true; const r = await fn(); if (r) toast(r); e.target.disabled = false; renderPush(); };
    fill(pushBox,
      setting('اعلان وقتی سپن بسته است', status,
        st === 'on' ? h('button', { class: 'btn sm flat', onclick: busy(async () => { await E.disablePush(); return null; }) }, 'خاموش')
          : st === 'off' ? h('button', { class: 'btn sm', onclick: busy(E.enablePush) }, 'روشن کردن') : null),
      st === 'on' ? setting('آزمایش اعلان', 'یک اعلان آزمایشی از سرور فرستاده می‌شود', h('button', { class: 'btn sm flat', onclick: busy(E.testPush) }, 'ارسال')) : null,
      isIOS && !standalone() ? h('div', { class: 'hint' }, 'در آیفون اعلان فقط وقتی کار می‌کند که سپن را با «افزودن به صفحهٔ اصلی» نصب کرده باشید و از همان آیکون باز کنید (iOS ۱۶٫۴ به بالا).') : null,
      h('div', { class: 'hint' }, 'متن پیام در اعلان نمی‌آید (پیام‌ها سرتاسری رمزنگاری‌اند)؛ فقط نام فرستنده.'));
  }
  renderPush();

  const el = h('div', { class: 'scroll', style: { display: 'flex', flexDirection: 'column', overflow: 'hidden' } },
    h('div', { class: 'bar' }, h('button', { class: 'icon', title: 'بازگشت', onclick: () => go('#/') }, '→'), h('h1', null, 'تنظیمات')),
    h('div', { class: 'scroll' },
      h('div', { class: 'profile-head' }, avBox, photoIn, h('div', { class: 'u' }, '@' + S.me)),
      h('form', { class: 'form', onsubmit: async (e) => {
        e.preventDefault();
        const err = await E.saveProfile(name.value.trim(), bio.value.trim());
        msg.className = err ? 'err' : 'ok'; msg.textContent = err || 'ذخیره شد';
      } }, h('div', { class: 'field' }, h('label', null, 'نام نمایشی'), name), h('div', { class: 'field' }, h('label', null, 'دربارهٔ من'), bio), msg, h('button', { class: 'btn', type: 'submit' }, 'ذخیرهٔ پروفایل')),
      h('div', { class: 'section' }, 'ظاهر'),
      setting('پوسته', null, select('theme', 'system', [['system', 'مثل گوشی'], ['light', 'روشن'], ['dark', 'تیره']], applyLook)),
      setting('اندازهٔ متن', null, select('fontSize', 16, [[14, 'کوچک'], [16, 'معمولی'], [18, 'بزرگ'], [20, 'خیلی بزرگ']], applyLook)),
      h('div', { class: 'section' }, 'اعلان‌ها'),
      setting('صدای پیام تازه', 'وقتی سپن باز است', toggle('sound', true)),
      pushBox,
      h('div', { class: 'section' }, 'حریم خصوصی'),
      privacy('hide_seen', 'نمایش «دیده شد» (دو تیک آبی)', 'اگر خاموش کنید، دیگران نمی‌بینند پیامشان را خوانده‌اید و شما هم «دیده شد» آن‌ها را نمی‌بینید. فقط گفتگوهای خصوصی؛ در گروه همیشه نمایش داده می‌شود.'),
      setting('پیدا شدن با شمارهٔ موبایل', 'کسانی که شمارهٔ شما را دارند، می‌توانند شما را در سپن پیدا کنند و درخواست ارتباط بفرستند. شماره‌تان به کسی نشان داده نمی‌شود.', (() => {
        const c = h('input', { type: 'checkbox', checked: S.privacy.findable !== false, onchange: async () => {
          c.disabled = true;
          const e = await E.setPrivacy({ findable: c.checked });
          c.disabled = false;
          if (e) { toast(e); c.checked = S.privacy.findable !== false; }
        } });
        return c;
      })()),
      privacy('hide_last_seen', 'نمایش آنلاین و آخرین بازدید', 'اگر خاموش کنید، دیگران فقط «اخیراً آنلاین بوده» می‌بینند و شما هم آخرین بازدید دیگران را نمی‌بینید.'),
      h('div', { class: 'section' }, 'داده و فضا'),
      setting('دانلود خودکار عکس‌ها و پیام‌های صوتی', 'تا ۲۵ مگابایت', toggle('autoImages', true)),
      setting('پاک کردن عکس‌ها و فایل‌های ذخیره‌شده', 'پیام‌ها می‌مانند', h('button', { class: 'btn sm flat', onclick: async () => { await E.clearMediaCache(); toast('پاک شد'); } }, 'پاک کردن')),
      h('div', { class: 'section' }, 'امنیت'),
      setting('رمز کلید', 'کلید رمزنگاری روی سرور با این رمز قفل است', h('button', { class: 'btn sm flat', onclick: () => go('#/keypass') }, 'تغییر')),
      setting('ورود دستگاه تازه', 'کد یک‌بارمصرف برای ورود روی گوشی یا مرورگر دیگر، بدون پیامک و حتی بدون اینترنت', h('button', { class: 'btn sm flat', onclick: deviceCodeBox }, 'گرفتن کد')),
      h('div', { class: 'hint' }, 'کد امنیتی شما:', h('br'), myFp),
      h('div', { class: 'hint' }, 'اثر انگشت گواهی ریشهٔ سپن (SHA-256):', h('br'), caFp, h('br'), h('a', { href: '/setup' }, 'راهنمای نصب گواهی روی آیفون')),
      h('div', { class: 'section' }, 'دربارهٔ سپن'),
      setting('نسخهٔ وب', null, h('span', { class: 'd' }, faNum(VERSION.split('.')[0]) + '.' + faNum(VERSION.split('.')[1]) + '.' + faNum(VERSION.split('.')[2]))),
      h('div', { class: 'actions' }, h('button', { class: 'btn danger', onclick: async () => {
        if (await confirmBox('خروج از حساب', 'پیام‌های ذخیره‌شده روی این دستگاه پاک می‌شوند. خارج می‌شوید؟', 'خروج', true)) E.logout();
      } }, 'خروج از حساب'))));
  renderAv();
  return { el, update: (k) => { if (k === 'users' || k === 'avatar') renderAv(); } };
}
// (privacy switches read S.privacy when the screen opens; it is refreshed from the server on start)

/** Shows a one-time code (5 minutes) that signs this account in on another device. */
async function deviceCodeBox() {
  const r = await E.deviceCode();
  if (r.error) { toast(r.error); return; }
  const left = h('div', { class: 'center d' });
  const v = h('div', { class: 'veil', onclick: (e) => { if (e.target === v) close(); } },
    h('div', { class: 'dialog' }, h('h3', null, 'ورود دستگاه تازه'),
      h('div', { class: 'devcode' }, r.code.replace(/(\d{3})(\d{3})/, '$1 $2')),
      left,
      h('p', null, 'روی دستگاه تازه، در صفحهٔ ورود ' + (r.phone ? 'شمارهٔ موبایلتان' : 'نام کاربری‌تان (@' + S.me + ')') + ' را بزنید، بعد «کد را دارم» و این کد را. فقط یک بار کار می‌کند. این کد را به هیچ‌کس دیگری ندهید.'),
      h('div', { class: 'btns' }, h('button', { class: 'btn', onclick: () => close() }, 'بستن'))));
  let t = r.ttl;
  const tick = () => { left.textContent = t > 0 ? 'اعتبار: ' + faNum(Math.floor(t / 60)) + ':' + String(t % 60).padStart(2, '0').replace(/\d/g, (d) => faNum(d)) : 'منقضی شد'; t--; };
  tick();
  const timer = setInterval(tick, 1000);
  function close() { clearInterval(timer); v.remove(); }
  document.body.append(v);
}

/** Center-crops a picked photo to 320x320 and encodes it as WebP (what the server accepts). */
async function toAvatar(file) {
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise((resolve, reject) => { const i = new Image(); i.onload = () => resolve(i); i.onerror = reject; i.src = url; });
    const size = 320, s = Math.min(img.naturalWidth, img.naturalHeight);
    const c = document.createElement('canvas');
    c.width = c.height = size;
    const g = c.getContext('2d');
    g.fillStyle = '#ffffff'; g.fillRect(0, 0, size, size);
    g.drawImage(img, (img.naturalWidth - s) / 2, (img.naturalHeight - s) / 2, s, s, 0, 0, size, size);
    return encodeWebp(g.getImageData(0, 0, size, size).data, size, size);
  } finally { URL.revokeObjectURL(url); }
}

// ---------------- call screen (overlay above everything) ----------------
let callEl = null, callTick = null;
function renderCall(c) {
  if (c.phase === 'idle') {
    if (callEl) { callEl.remove(); callEl = null; clearInterval(callTick); }
    if (c.note) toast(c.note);
    return;
  }
  if (!callEl) {
    callEl = h('div', { class: 'call' });
    document.body.append(callEl);
    clearInterval(callTick);
    callTick = setInterval(() => renderCall(Call.C), 1000);
  }
  const remoteVideo = c.remote && c.remote.getVideoTracks().length > 0;
  let rv = callEl.querySelector('video.remote');
  if (!rv) { rv = h('video', { class: 'remote', autoplay: true, playsInline: true }); callEl.append(rv); }
  if (rv.srcObject !== c.remote) { rv.srcObject = c.remote; if (c.remote) rv.play().catch(() => { }); }
  rv.style.visibility = remoteVideo ? 'visible' : 'hidden';
  let lv = callEl.querySelector('video.local');
  const localVideo = c.local && c.local.getVideoTracks().length > 0;
  if (localVideo && !lv) { lv = h('video', { class: 'local', autoplay: true, playsInline: true, muted: true }); callEl.append(lv); }
  if (lv) {
    if (!localVideo) { lv.remove(); } else {
      if (lv.srcObject !== c.local) { lv.srcObject = c.local; lv.play().catch(() => { }); }
      lv.classList.toggle('back', !c.front);
      lv.style.visibility = c.camOff ? 'hidden' : 'visible';
    }
  }
  let status = c.note;
  if (c.phase === 'active') { const s = Math.floor((Date.now() - c.startedAt) / 1000); status = Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0'); }
  else if (c.phase === 'incoming') status = c.video ? 'تماس تصویری ورودی' : 'تماس صوتی ورودی';
  const info = h('div', { class: 'info' }, remoteVideo ? null : avatar(c.peer, 'lg'), h('h2', null, E.nameOf(c.peer)), h('div', null, status));
  const btn = (label, cls, fn, title) => h('button', { class: 'cb ' + cls, title, onclick: fn }, label);
  const ctrls = c.phase === 'incoming'
    ? h('div', { class: 'ctrls' }, btn('✕', 'red', Call.decline, 'رد'), btn(c.video ? '🎥' : '📞', 'green', Call.accept, 'پاسخ'))
    : h('div', { class: 'ctrls' },
      btn(c.muted ? '🔇' : '🎙', c.muted ? 'on' : '', Call.toggleMute, 'قطع صدا'),
      localVideo ? btn(c.camOff ? '🚫' : '📷', c.camOff ? 'on' : '', Call.toggleCamera, 'دوربین') : null,
      localVideo ? btn('🔄', '', Call.switchCamera, 'چرخش دوربین') : null,
      btn('✕', 'red', Call.hangup, 'پایان تماس'));
  callEl.querySelectorAll('.info, .ctrls').forEach((x) => x.remove());
  callEl.append(info, ctrls);
}
Call.onCall(renderCall);

// ---------------- start ----------------
(async () => {
  if (!window.isSecureContext || !globalThis.crypto || !crypto.subtle || !window.indexedDB) {
    fill(app, h('div', { class: 'login' }, h('h2', null, 'اتصال امن برقرار نیست'),
      h('p', null, 'برای استفاده از سپن ابتدا گواهی امنیتی را نصب کنید.'), h('a', { class: 'btn', href: '/setup' }, 'راهنمای نصب')));
    return;
  }
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => { });
  try { await E.init(); } catch (e) { console.error(e); }
  route();
})();
