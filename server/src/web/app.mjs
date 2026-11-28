// Sepan web app: screens and interaction. State and logic live in engine.mjs, calls in call.mjs.
import * as E from './engine.mjs';
import * as Call from './call.mjs';
import * as GC from './groupcall.mjs';
import * as api from './api.mjs';
import { fingerprint } from './crypto.mjs';
import { encodeWebp } from './webp.mjs';
import * as Emoji from './emoji.mjs';
import * as Voice from './voice.mjs';
import * as Diag from './diag.mjs';
import './lan.mjs';
import { COUNTRIES, flag, joinPhone } from './countries.mjs';
import { ic } from './icons.mjs';

const VERSION = '1.29.0';
const S = E.S;
const app = document.getElementById('app');

// ---------------- small helpers ----------------
const PROPS = new Set(['controls', 'value', 'checked', 'disabled', 'srcObject', 'muted', 'autoplay', 'playsInline', 'multiple', 'accept', 'selected', 'type', 'placeholder', 'rows', 'maxLength', 'autocomplete', 'src', 'alt', 'href', 'download', 'title', 'dir']);
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
// 1.28: a short tap felt in the hand (phones that allow it), and «less motion» from the system
const buzz = (ms = 8) => { try { if (navigator.vibrate) navigator.vibrate(ms); } catch { } };
const lessMotion = () => matchMedia('(prefers-reduced-motion: reduce)').matches;
/** 1.28: a friendly empty screen: round picture, what is missing, what to do, and a button for it */
function emptyState(icon, title, text, action, onAction) {
  return h('div', { class: 'estate' }, h('div', { class: 'eo' }, h('div', { class: 'ei' }, ic(icon, 34))),
    h('div', { class: 'et' }, title), text ? h('div', { class: 'ex' }, text) : null,
    action ? h('button', { class: 'btn', onclick: onAction }, action) : null);
}
/** grey shimmering rows that stand in for the chat list until it arrives */
const skeleton = (n = 7) => h('div', { class: 'skel' }, Array.from({ length: n }, (_, i) => h('div', { class: 'srow' }, h('i', { class: 'sav' }),
  h('div', { class: 'sl' }, h('i', { style: { width: [55, 40, 62, 35, 50, 45, 58][i % 7] + '%' } }), h('i', { style: { width: [80, 70, 50, 75, 60, 82, 66][i % 7] + '%' } })))));
const typingDots = () => h('span', { class: 'tdots' }, h('i'), h('i'), h('i'));

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
  // 1.29: «پیام‌های ذخیره‌شده»
  if (E.isSaved(convo)) { el.style.background = 'var(--accent)'; el.append(ic('bookmark', cls === 'xs' ? 14 : cls === 'sm' ? 20 : cls === 'lg' ? 48 : 24)); return el; }
  el.style.background = colorFor(convo);
  const url = group ? E.groupAvatarUrl(convo) : E.avatarUrl(convo);
  if (url) el.append(h('img', { src: url, alt: '' }));
  else if (group) el.append(ic(E.isChan(convo) ? 'campaign' : 'group', cls === 'xs' ? 14 : cls === 'sm' ? 22 : cls === 'lg' ? 52 : 26));
  else el.textContent = initials(E.nameOf(convo));
  return el;
}
function avatarWithDot(convo, cls) {
  const u = !E.isGroup(convo) && E.user(convo);
  return h('div', { class: 'av-wrap' }, avatar(convo, cls), u && u.online && convo !== S.me ? h('span', { class: 'dot' }) : null);
}

/** grey ✓ = on the server, blue ✓ = on their phone, blue ✓✓ = seen. */
const tickEl = (t) => (t ? h('span', { class: 'tick ' + t, title: TICK_TEXT[t] }, ic(t === 'seen' ? 'doneAll' : 'check', 16)) : null);

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

/**
 * 1.27 «حذف گفتگو»: empties the whole chat on this device; in a private chat «برای X هم پاک شود» also deletes it
 * on the other person's devices and on the server. Resolves true when the chat was deleted.
 */
function clearChatDialog(convo) {
  return new Promise((resolve) => {
    const group = E.isGroup(convo);
    const both = !group && convo !== S.me;
    const cb = h('input', { type: 'checkbox' });
    const err = h('p', { class: 'err hidden' });
    const close = (r) => { v.remove(); resolve(r); };
    const ok = h('button', { class: 'btn danger', onclick: async () => {
      if (both && cb.checked) {
        ok.disabled = true; ok.textContent = 'در حال حذف…';
        const e = await E.clearChatForBoth(convo);
        if (e) { ok.disabled = false; ok.textContent = 'حذف'; err.textContent = e; err.classList.remove('hidden'); return; }
      } else await E.clearChatLocal(convo);
      close(true);
    } }, 'حذف');
    const v = h('div', { class: 'veil', onclick: (e) => { if (e.target === v && !ok.disabled) close(false); } },
      h('div', { class: 'dialog' }, h('h3', null, 'حذف گفتگو'),
        h('p', null, group ? `همهٔ پیام‌ها، فایل‌ها و تماس‌های «${E.titleOf(convo)}» از این دستگاه پاک می‌شود. عضویت شما سر جایش می‌ماند.`
          : `همهٔ پیام‌ها، فایل‌ها و تماس‌های گفتگو با «${E.titleOf(convo)}» از این دستگاه پاک می‌شود و برنمی‌گردد.`),
        both ? h('label', { class: 'pick' }, cb, h('span', null, 'برای ' + E.nameOf(convo) + ' هم پاک شود')) : null,
        err,
        h('div', { class: 'btns' }, h('button', { class: 'btn flat', onclick: () => { if (!ok.disabled) close(false); } }, 'انصراف'), ok)));
    document.body.append(v);
  });
}

/** 1.22.1: «تازه‌های این نسخه» once per web version, for someone who used an older one (not on a first visit). */
async function whatsNew() {
  const seen = pref('notesSeen', null);
  if (seen === VERSION) return;
  if (seen === null && !api.getToken()) { setPref('notesSeen', VERSION); return; }
  let r;
  try { r = await api.appNotes(VERSION); } catch { return; } // tried again on the next start
  setPref('notesSeen', VERSION);
  const notes = (r && Array.isArray(r.notes) ? r.notes : []).filter((x) => typeof x === 'string');
  if (!notes.length) return;
  const v = h('div', { class: 'veil', onclick: (e) => { if (e.target === v) v.remove(); } },
    h('div', { class: 'dialog' }, h('h3', null, 'تازه‌های نسخهٔ ' + faNum(VERSION.split('.')[0]) + '.' + faNum(VERSION.split('.')[1]) + '.' + faNum(VERSION.split('.')[2])),
      h('ul', { class: 'notes' }, notes.map((n) => h('li', null, n))),
      h('div', { class: 'btns' }, h('button', { class: 'btn', onclick: () => v.remove() }, 'باشه'))));
  document.body.append(v);
}

/** Longest side and JPEG quality of a «compressed» photo (about 200-400 KB, fine for chat). */
const PHOTO_MAX_SIDE = 1600, PHOTO_QUALITY = 0.8;
/** Shrinks a photo to PHOTO_MAX_SIDE as JPEG (drops EXIF/GPS). GIFs, unreadable or already-small files stay as they are. */
async function compressPhoto(file) {
  if (file.type === 'image/gif') return file;
  try {
    let src;
    try { src = await createImageBitmap(file, { imageOrientation: 'from-image' }); } catch {
      src = await new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = URL.createObjectURL(file); });
    }
    const w0 = src.width || src.naturalWidth, h0 = src.height || src.naturalHeight;
    const k = Math.min(1, PHOTO_MAX_SIDE / Math.max(w0, h0));
    const c = document.createElement('canvas');
    c.width = Math.max(1, Math.round(w0 * k)); c.height = Math.max(1, Math.round(h0 * k));
    const g = c.getContext('2d');
    g.fillStyle = '#fff'; g.fillRect(0, 0, c.width, c.height); // transparent PNGs get a white background, not black
    g.drawImage(src, 0, 0, c.width, c.height);
    if (src.close) src.close(); else URL.revokeObjectURL(src.src);
    const blob = await new Promise((res) => c.toBlob(res, 'image/jpeg', PHOTO_QUALITY));
    if (!blob || blob.size >= file.size) return file;
    return new File([blob], (file.name || 'photo').replace(/\.[^.]*$/, '') + '.jpg', { type: 'image/jpeg' });
  } catch { return file; }
}
/** Preview of the picked photo(s) with a «compress» switch whose last value is remembered; resolves true/false, or null if cancelled. */
function photoSendBox(files) {
  return new Promise((resolve) => {
    const urls = files.slice(0, 6).map((f) => URL.createObjectURL(f));
    const total = files.reduce((a, f) => a + f.size, 0);
    const box = h('input', { type: 'checkbox', checked: pref('photoCompress', true) });
    const note = h('div', { style: { fontSize: '12px', color: 'var(--fg2)' } });
    const upd = () => { note.textContent = box.checked ? 'حجم کمتر، کیفیت مناسب چت' : 'عکس اصلی (' + fmtSize(total) + ')'; };
    box.addEventListener('change', upd); upd();
    const close = (r) => { v.remove(); urls.forEach((u) => URL.revokeObjectURL(u)); if (r != null) setPref('photoCompress', box.checked); resolve(r); };
    const v = h('div', { class: 'veil', onclick: (e) => { if (e.target === v) close(null); } },
      h('div', { class: 'dialog' }, h('h3', null, files.length > 1 ? 'ارسال ' + faNum(files.length) + ' عکس' : 'ارسال عکس'),
        h('div', { style: { display: 'flex', flexWrap: 'wrap', gap: '6px', justifyContent: 'center', margin: '0 0 12px' } },
          urls.map((u) => h('img', { src: u, alt: '', style: { maxWidth: urls.length > 1 ? '120px' : '100%', maxHeight: urls.length > 1 ? '120px' : '50vh', objectFit: 'cover', borderRadius: '8px' } }))),
        h('label', { style: { display: 'flex', alignItems: 'center', gap: '10px', margin: '0 0 14px', cursor: 'pointer' } }, box,
          h('div', null, h('div', { style: { fontWeight: '600' } }, 'فشرده‌سازی'), note)),
        h('div', { class: 'btns' }, h('button', { class: 'btn flat', onclick: () => close(null) }, 'انصراف'),
          h('button', { class: 'btn', onclick: () => close(box.checked) }, 'ارسال'))));
    document.body.append(v);
  });
}

const fmtFull = (ts) => new Date(ts).toLocaleString('fa-IR-u-ca-persian', { dateStyle: 'long', timeStyle: 'short' });

/** Pick one or more chats to forward to, like Telegram; «پنهان کردن فرستنده» sends a plain copy. */
function forwardSheet(msgs, done) {
  const keys = E.summaries().map((x) => x.convo);
  for (const u of S.users) if (u.dm && u.username !== S.me && !keys.includes(u.username)) keys.push(u.username);
  const targets = keys.filter((c) => E.isGroup(c) || E.isSaved(c) || (E.user(c) && (E.user(c).dm || (S.convos.get(c) || []).length))).sort((a, b) => E.isSaved(b) - E.isSaved(a));
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
      h('div', { class: 'picklist' }, E.reactionsOf(m).map(([e, us]) => us.map((u) => u.startsWith('~')
        // 1.21: in a channel other members' reactions come without names
        ? h('div', { class: 'pick' }, h('div', { class: 'av sm' }, '👤'), h('span', { class: 'grow' }, 'یکی از اعضا'), h('span', { class: 'rbig' }, e))
        : h('div', { class: 'pick' }, avatar(u, 'sm'), h('span', { class: 'grow' }, u === S.me ? 'شما' : E.nameOf(u)), h('span', { class: 'rbig' }, e))))),
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
      E.isChan(m.convo) && m.id > 0 ? h('p', null, '👁 دیده شده: ' + faNum(E.viewsOf(m))) : null,
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
    h('div', { class: 'vbar' }, h('button', { class: 'icon', title: 'بستن', onclick: () => v.remove() }, ic('close')),
      // 1.12: ⋮ = save to…, save to gallery / share
      m ? h('button', { class: 'icon', title: 'گزینه‌ها', onclick: () => sheet(null, mediaItems(m)) }, '⋮') : null),
    h('img', { src: url, alt: '' }));
  document.body.append(v);
}

/** Name with an extension for a message's media. */
function mediaName(m, blob) {
  if (m.name) return m.name;
  const mime = (blob && blob.type) || m.mime || (m.type === 'image' ? 'image/jpeg' : '');
  const ext = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/gif': 'gif', 'image/webp': 'webp', 'video/mp4': 'mp4', 'audio/ogg': 'ogg', 'audio/webm': 'webm', 'audio/mp4': 'm4a' }[mime] || 'bin';
  const pre = mime.startsWith('image/') ? 'IMG' : mime.startsWith('video/') ? 'VID' : m.type === 'voice' ? 'VOICE' : 'FILE';
  const d = new Date(m.ts || Date.now()), z = (n) => String(n).padStart(2, '0');
  return `${pre}_Sepan_${d.getFullYear()}${z(d.getMonth() + 1)}${z(d.getDate())}_${z(d.getHours())}${z(d.getMinutes())}${z(d.getSeconds())}.${ext}`;
}

/** The decrypted file of a message, downloading it first when needed. */
async function mediaFile(m) {
  if (!E.mediaBlob(m)) {
    if (!m.fileId) return null;
    toast('در حال دریافت…');
    try { await E.download(m); } catch { toast('دریافت فایل ناموفق بود'); return null; }
  }
  const blob = E.mediaBlob(m);
  if (!blob) return null;
  return new File([blob], mediaName(m, blob), { type: blob.type || m.mime || 'application/octet-stream' });
}

const canShareFiles = () => !!(navigator.canShare && navigator.share);

/** 1.12 save / share items for photos, videos, files and voice messages (message menu and viewer ⋮). */
function mediaItems(m) {
  const visual = m.type === 'image' || /^(image|video)\//.test(m.mime || '');
  return [
    canShareFiles() && { label: visual ? 'ذخیره در گالری / اشتراک‌گذاری' : 'اشتراک‌گذاری', run: () => shareMedia(m) },
    { label: 'ذخیره در…', run: () => saveMediaAs(m) },
  ];
}

/** Share sheet; on iPhone it offers «Save Image» / «Save Video» (gallery) and «Save to Files». */
async function shareMedia(m) {
  const f = await mediaFile(m);
  if (!f) return;
  if (navigator.canShare && navigator.canShare({ files: [f] })) {
    try { await navigator.share({ files: [f] }); return; } catch (e) { if (e.name === 'AbortError') return; }
  }
  saveMediaAs(m);
}

/** «ذخیره در…»: the folder picker where the browser has one (Chrome / Edge on a computer), otherwise a normal download. */
async function saveMediaAs(m) {
  const f = await mediaFile(m);
  if (!f) return;
  if (window.showSaveFilePicker) {
    try {
      const ext = f.name.includes('.') ? '.' + f.name.split('.').pop() : '';
      const hnd = await window.showSaveFilePicker({ suggestedName: f.name, types: ext && f.type ? [{ accept: { [f.type]: [ext] } }] : undefined });
      const w = await hnd.createWritable(); await w.write(f); await w.close();
      toast('ذخیره شد'); return;
    } catch (e) { if (e.name === 'AbortError') return; }
  }
  const url = URL.createObjectURL(f);
  const a = h('a', { href: url, download: f.name });
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
}

/** Tap on a downloaded file: share sheet on phones, otherwise save. */
async function saveMedia(m) {
  if (canShareFiles()) return shareMedia(m);
  return saveMediaAs(m);
}

// ---------------- theme / text size / viewport ----------------
/** 1.28: the five accent colours, the same as in the Android app */
const ACCENTS = [['آبی سپن', '#2A73C9'], ['سبزآبی', '#138A72'], ['بنفش', '#7352C7'], ['نارنجی', '#D9691A'], ['صورتی', '#C93A70']];
function applyLook() {
  const t = pref('theme', 'system');
  if (t === 'system') document.documentElement.removeAttribute('data-theme'); else document.documentElement.dataset.theme = t;
  document.documentElement.style.setProperty('--fs', pref('fontSize', 16) + 'px');
  document.documentElement.classList.toggle('plainbg', !pref('wallpaper', true));
  // 1.28: accent colour (0 = Sepan blue)
  const a = pref('accent', 0);
  if (a) document.documentElement.dataset.accent = a; else document.documentElement.removeAttribute('data-accent');
  const meta = document.querySelector('meta[name=theme-color]');
  if (meta) meta.content = ACCENTS[a] ? ACCENTS[a][1] : ACCENTS[0][1];
}
applyLook();
if (window.visualViewport) {
  // iOS: keep the composer above the keyboard
  const fit = () => { app.style.height = visualViewport.height + 'px'; if (document.activeElement && document.activeElement.tagName === 'TEXTAREA') window.scrollTo(0, 0); };
  visualViewport.addEventListener('resize', fit);
  fit();
}

// ---------------- @username (1.7) ----------------
/** Opens the chat with @name: a contact directly, anybody else after finding them (a message request). */
async function openUser(name) {
  name = String(name || '').replace(/^@/, '').toLowerCase();
  if (!name) return;
  if (name === S.me) { go('#/settings'); return; }
  const u = E.user(name);
  if (u && (u.dm || (S.convos.get(name) || []).length)) { go('#/c/' + encodeURIComponent(name)); return; }
  const r = await E.findUser(name);
  if (r.error) { toast(r.error); return; }
  if (r.me) { go('#/settings'); return; }
  if (!r.connected && !r.can_message) {
    const ok = await confirmBox((r.display_name || r.username) + ' · @' + r.username, 'این کاربر از کسانی که در مخاطبانش نیستند پیام نمی‌گیرد. درخواست ارتباط فرستاده شود؟', 'فرستادن درخواست');
    if (ok) { const x = await E.contactAction('request', r.username); toast(x.error || (x.result === 'connected' ? 'ارتباط برقرار شد' : 'درخواست فرستاده شد')); }
    return;
  }
  go('#/c/' + encodeURIComponent(r.username));
}
const NAME_AT = /@([A-Za-z0-9_]{2,20})(?![A-Za-z0-9_])/g;

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
  else if (/^join=[A-Za-z0-9_-]{12,32}$/.test(hash)) { try { sessionStorage.setItem('sepan_join', hash.slice(5)); } catch { } view = ListScreen(); setTimeout(() => { history.replaceState(null, '', '#/'); pendingJoin(); }, 0); }
  else if (hash.startsWith('/c/')) view = ChatScreen(hash.slice(3));
  else if (hash.startsWith('/p/')) view = ProfileScreen(hash.slice(3));
  else if (hash === '/new') view = ContactsScreen();
  else if (hash === '/archive') view = ListScreen(true); // 1.29
  else if (hash === '/requests') view = RequestsScreen();
  else if (hash === '/calls') view = CallsScreen();
  else if (/^@[A-Za-z0-9_]{2,20}$/.test(hash)) { const n = hash.slice(1); view = ListScreen(); setTimeout(() => { history.replaceState(null, '', '#/'); openUser(n); }, 0); }
  else if (hash === '/settings') view = SettingsScreen();
  else if (hash === '/stickers') view = StickersScreen();
  else if (/^\/stickers\/[a-f0-9]{16}$/.test(hash)) view = StickerPackScreen(hash.slice(10));
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
// 1.20: an invite link opened before signing in is kept and offered right after
try { const j = /join=([A-Za-z0-9_-]{12,32})/.exec(location.hash); if (j) sessionStorage.setItem('sepan_join', j[1]); } catch { }
function pendingJoin() {
  let t = null;
  try { t = sessionStorage.getItem('sepan_join'); sessionStorage.removeItem('sepan_join'); } catch { }
  if (t) setTimeout(() => joinByLink(t), 300);
}
E.on((kind, data) => {
  if (kind === 'login') { go('#/'); route(); pendingJoin(); return; }
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
  if (visible) { E.resume(); if (S.openConvo) E.markRead(S.openConvo); if (view && view.update) view.update('visible'); }
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
  // 1.17: country picker + the national number without its leading 0; the server gets "+98912…"
  const country = h('select', { 'aria-label': 'کشور' }, COUNTRIES.map(([iso, name, dial]) => h('option', { value: iso }, flag(iso) + ' ' + name + '  \u200E+' + dial)));
  try { const last = localStorage.getItem('sepan_country'); if (last && COUNTRIES.some((c) => c[0] === last)) country.value = last; } catch { }
  const dialOf = () => (COUNTRIES.find((c) => c[0] === country.value) || COUNTRIES[0])[2];
  const phone = input('912 345 6789', { inputmode: 'tel', autocomplete: 'tel-national' });
  const dialEl = h('span', { class: 'dial' });
  const phRow = h('div', { class: 'phrow' }, dialEl, phone);
  const showDial = () => { dialEl.textContent = '+' + dialOf(); dialEl.style.display = phone.value.trim().startsWith('+') ? 'none' : ''; phone.placeholder = dialOf() === '98' ? '912 345 6789' : 'شماره بدون ۰ اول'; };
  phone.addEventListener('input', () => {
    const v = phone.value.replace(/[۰-۹]/g, (c) => c.charCodeAt(0) - 0x6f0).replace(/[٠-٩]/g, (c) => c.charCodeAt(0) - 0x660);
    phone.value = v.trim().startsWith('+') ? '+' + v.replace(/\D/g, '').slice(0, 15) : v.replace(/\D/g, '').replace(/^0+/, '').slice(0, 14);
    showDial();
  });
  country.addEventListener('change', () => { try { localStorage.setItem('sepan_country', country.value); } catch { } showDial(); });
  showDial();
  const fullPhone = () => joinPhone(dialOf(), phone.value);
  const shownPhone = () => '\u200E' + fullPhone();
  const phoneHint = h('div', { class: 'hint', style: { margin: '-6px 0 0' } }, 'شماره را بدون ۰ اول بنویسید');
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
    const full = fullPhone();
    if (full.startsWith('+98') ? !/^\+989\d{9}$/.test(full) : !/^\+[1-9]\d{6,14}$/.test(full)) { err.textContent = 'شمارهٔ موبایل درست نیست؛ شماره را بدون ۰ اول بنویسید'; return; }
    if (!full.startsWith('+98')) {
      // the SMS line is Iranian: a foreign number signs in with a code from another device or the admin
      step = 'code'; render();
      info.textContent = 'پیامک ورود فعلاً فقط برای شماره‌های ایران فرستاده می‌شود. کد ورود را از دستگاه دیگرتان (تنظیمات › ورود دستگاه تازه) یا از مدیر بگیرید و این‌جا وارد کنید.';
      code.focus();
      return;
    }
    await busy(btn, async () => {
      try { await api.smsCode(full); }
      catch (ex) {
        if (ex instanceof api.HttpError && ex.body.error === 'wait') { step = 'code'; render(); countdown(ex.body.wait || 60); return; }
        if (ex instanceof api.HttpError && ex.body.error === 'sms_unavailable') { step = 'code'; render(); }
        throw ex;
      }
      step = 'code'; render();
      info.textContent = 'کد ورود به ' + shownPhone() + ' پیامک شد.';
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
      const r = await E.codeLogin(fullPhone(), code.value);
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
        h('div', { class: 'hint', style: { margin: 0 } }, 'شمارهٔ ' + shownPhone() + ' تأیید شد و هنوز حسابی ندارد. یک نام کاربری انتخاب کنید؛ دیگران با همین نام شما را پیدا می‌کنند.'),
        uname, dname, err, loginBtn,
        link('انصراف', () => { step = 'phone'; ticket = null; loginBtn.textContent = 'ورود'; render(); }));
      return;
    }
    country.disabled = phone.disabled = step === 'code';
    fill(box,
      country, phRow, step === 'phone' ? phoneHint : null,
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
      mode === 'change' ? h('button', { class: 'icon', title: 'بازگشت', onclick: () => go('#/settings') }, ic('back')) : null,
      h('h1', null, 'کلید رمزنگاری'),
      mode !== 'change' ? h('button', { class: 'btn sm flat', onclick: () => E.logout() }, 'خروج') : null),
    h('div', { class: 'scroll' }, h('div', { class: 'keybox' }, body)));
  return { el };
}

// ---------------- chat list ----------------
let listTab = 'all'; // 1.29: the chat list's tab (kept while the page is open)
function ListScreen(archive = false) {
  const conn = h('span', { class: 'conn' });
  const reqBadge = h('span', { class: 'badge hidden' });
  const list = h('div', { class: 'scroll' });
  const tabsEl = h('div', { class: 'ctabs' });
  const connLine = h('div', { class: 'connline hidden' });
  const nav = bottomNav('chats');
  const menu = () => sheet(null, [
    S.feats.saved ? { label: '🔖 ' + E.SAVED_TITLE, run: () => go('#/c/' + encodeURIComponent(S.me)) } : null,
    { label: '🗂 پوشه‌های گفتگو', run: () => foldersBox() },
    { label: '🗄 بایگانی' + (S.chat.archived.length ? ' (' + faNum(S.chat.archived.length) + ')' : ''), run: () => go('#/archive') },
  ]);
  const el = h('div', { class: 'scroll', style: { display: 'flex', flexDirection: 'column', overflow: 'hidden', position: 'relative' } },
    archive
      ? h('div', { class: 'bar' }, h('button', { class: 'icon', title: 'بازگشت', onclick: () => go('#/') }, ic('back')), h('h1', null, 'بایگانی ', conn))
      : h('div', { class: 'bar' },
        h('h1', null, 'سپن ', conn),
        h('button', { class: 'icon', title: 'درخواست‌های ارتباط', onclick: () => go('#/requests') }, ic('personAdd'), reqBadge),
        h('button', { class: 'icon', title: 'بیشتر', onclick: menu }, ic('more'))),
    connLine, archive ? null : tabsEl, list,
    // 1.28: round «گفتگوی تازه» button above the bottom bar
    archive ? null : h('button', { class: 'fab', title: 'گفتگوی تازه', onclick: () => { buzz(); newMenu(); } }, ic('edit')),
    nav.el);
  const render = batched(() => {
    conn.textContent = connText();
    connLine.classList.toggle('hidden', !connText());
    nav.update();
    const n = S.requests.incoming.length;
    reqBadge.textContent = faNum(n);
    reqBadge.classList.toggle('hidden', !n);
    const pins = pinnedChats();
    // message requests (people I am not connected to who wrote to me) live under «درخواست‌ها», not in the list
    const isReq = (c) => { const r = E.reqOf(c); return r === 'in' || r === 'declined'; };
    const all = E.summaries().filter((x) => !isReq(x.convo));
    const sorted = [...pins.map((c) => all.find((s) => s.convo === c)).filter(Boolean), ...all.filter((s) => !pins.includes(s.convo))];
    // 1.29: tabs (built-in kinds + my folders) and the archive
    const active = sorted.filter((s) => !E.isArchived(s.convo));
    const arch = sorted.filter((s) => E.isArchived(s.convo));
    const tabs = E.chatTabs();
    let tab = tabs.find((t) => t.key === listTab) || tabs[0];
    if (S.chat.hideTabs) tab = tabs[0];
    tabsEl.classList.toggle('hidden', !!S.chat.hideTabs);
    if (!archive && !S.chat.hideTabs) {
      fill(tabsEl, tabs.map((t) => {
        const cnt = t.key === 'unread' ? 0 : active.filter((s) => E.inTab(t, s) && s.unread > 0).length;
        const b = h('button', { class: 'ctab' + (t.key === tab.key ? ' on' : ''), onclick: () => { if (wasLong()) return; listTab = t.key; render(); list.scrollTop = 0; } },
          t.name, cnt ? h('span', { class: 'cn' }, faNum(cnt)) : null);
        const wasLong = onLongPress(b, () => { buzz(12); foldersBox(); });
        return b;
      }), h('button', { class: 'ctab edit', title: 'ویرایش پوشه‌ها', onclick: () => foldersBox() }, ic('edit', 16)));
    }
    const shown = archive ? arch : active.filter((s) => E.inTab(tab, s));
    const rows = shown.map((s) => {
      const group = E.isGroup(s.convo);
      const gt = group ? E.typingIn(s.convo) : [];
      const typing = group ? gt.length > 0 : Date.now() - (S.typing[s.convo] || 0) < 4500;
      const last = s.last;
      const draft = draftOf(s.convo);
      const chan = group && E.isChan(s.convo);
      let prev = last ? (chan ? '' : group && !last.mine && last.type !== 'call' ? E.nameOf(last.sender) + ': ' : last.mine && last.type !== 'call' && !E.isSaved(s.convo) ? 'شما: ' : '') + E.preview(last) : (chan ? 'کانال' : E.isSaved(s.convo) ? 'یادداشت‌ها و پیام‌های نگه‌داشته' : 'هنوز پیامی نیست');
      if (draft) prev = [h('span', { class: 'draft' }, 'پیش‌نویس: '), draft];
      if (typing) prev = group ? E.nameOf(gt[0]) + (gt.length > 1 ? ' و ' + faNum(gt.length - 1) + ' نفر دیگر' : '') + ' در حال نوشتن…' : 'در حال نوشتن…';
      const tick = last && !typing && !draft && !E.isSaved(s.convo) ? E.tickOf(last) : null;
      const row = h('button', { class: 'row' },
        avatarWithDot(s.convo),
        h('div', { class: 'mid' },
          h('div', { class: 'top' }, h('div', { class: 'name' }, chan ? ic('campaign', 16, 'nic') : null, E.titleOf(s.convo)), group && GC.roomOf(s.convo) ? h('span', { class: 'gcmark', title: 'تماس گروهی در جریان' }, ic('call', 16)) : null, tick ? tickEl(tick) : null, h('div', { class: 'time' }, last ? fmtListTime(last.ts) : '')),
          h('div', { class: 'sub' }, h('div', { class: 'prev' + (typing ? ' typing' : '') }, typing ? typingDots() : null, prev),
            s.mentions ? h('span', { class: 'count at', title: 'منشن' }, ic('at', 14)) : null,
            s.unread ? h('span', { class: 'count' }, faNum(s.unread)) : pins.includes(s.convo) ? h('span', { class: 'pinmark' }, ic('pin', 16)) : null)));
      const wasLong = onLongPress(row, () => {
        buzz(12);
        const pinned = pinnedChats().includes(s.convo);
        const inArch = E.isArchived(s.convo);
        sheet(E.titleOf(s.convo), [{ label: pinned ? 'برداشتن سنجاق از بالای فهرست' : '📌 سنجاق به بالای فهرست', run: () => { togglePinChat(s.convo); render(); } },
          { label: inArch ? '📤 خارج کردن از بایگانی' : '🗄 بایگانی', run: () => E.setArchived(s.convo, !inArch) },
          { label: '🗂 افزودن به پوشه', run: () => folderPick(s.convo) },
          { label: '🗑 حذف گفتگو', danger: true, run: () => clearChatDialog(s.convo) }]);
      });
      row.addEventListener('click', () => { if (!wasLong()) go('#/c/' + encodeURIComponent(s.convo)); });
      return row;
    });
    const reqRow = n && !archive ? h('button', { class: 'row', onclick: () => go('#/requests') },
      h('div', { class: 'av', style: { background: 'var(--accent)' } }, ic('inbox', 26)),
      h('div', { class: 'mid' }, h('div', { class: 'top' }, h('div', { class: 'name' }, 'درخواست‌های پیام')),
        h('div', { class: 'sub' }, h('div', { class: 'prev' }, S.requests.incoming.slice(0, 3).map((r) => r.display_name || '@' + r.username).join('، ')), h('span', { class: 'count' }, faNum(n))))) : null;
    const unreadArch = arch.filter((s) => s.unread > 0).length;
    const archRow = !archive && arch.length && tab.key === 'all' ? h('button', { class: 'row', onclick: () => go('#/archive') },
      h('div', { class: 'av', style: { background: 'var(--muted, #8a97a6)' } }, ic('archive', 26)),
      h('div', { class: 'mid' }, h('div', { class: 'top' }, h('div', { class: 'name' }, 'بایگانی')),
        h('div', { class: 'sub' }, h('div', { class: 'prev' }, arch.slice(0, 4).map((x) => E.titleOf(x.convo)).join('، ')), unreadArch ? h('span', { class: 'count muted' }, faNum(unreadArch)) : null))) : null;
    fill(list,
      isIOS && !standalone() && !archive ? h('div', { class: 'hint' }, 'برای اینکه سپن مثل یک برنامه باز شود: دکمهٔ اشتراک‌گذاری ', h('b', null, '⬆️'), ' و بعد ', h('b', null, '«افزودن به صفحهٔ اصلی»'), '.') : null,
      archRow, reqRow,
      rows.length ? rows : archive ? emptyState('archive', 'بایگانی خالی است', 'با نگه داشتن انگشت روی یک گفتگو آن را بایگانی کنید.')
        : sorted.length ? h('div', { class: 'hint' }, tab.folder ? 'این پوشه هنوز گفتگویی ندارد. با نگه داشتن انگشت روی هر گفتگو آن را به پوشه بیفزایید.' : 'گفتگویی در این بخش نیست')
        : !S.lastId && S.conn !== 'online' ? skeleton()
        : emptyState('chat', 'هنوز گفتگویی ندارید', 'با یکی از مخاطبانتان گفتگو را شروع کنید؛ پیام‌ها سرتاسری رمزنگاری می‌شوند.', 'گفتگوی تازه', newMenu),
      h('div', { style: { height: '84px' } }));
  });
  render();
  E.refreshRequests().catch(() => { });
  return { el, update: render };
}

// ---------------- 1.29: chat folders ----------------
function foldersBox() {
  const body = h('div');
  const v = h('div', { class: 'veil', onclick: (e) => { if (e.target === v) v.remove(); } },
    h('div', { class: 'dialog' }, h('h3', null, 'پوشه‌های گفتگو'),
      h('p', null, 'گفتگوها را در پوشه‌های خودتان بچینید. پوشه‌ها روی همهٔ دستگاه‌هایتان یکی است و فقط خودتان می‌بینید.'),
      body, h('div', { class: 'btns' }, h('button', { class: 'btn', onclick: () => v.remove() }, 'بستن'))));
  const render = () => {
    const fs = S.chat.folders;
    const tabsCb = h('input', { type: 'checkbox', checked: !S.chat.hideTabs, onchange: () => E.setHideTabs(!tabsCb.checked) });
    fill(body,
      fs.map((f, i) => h('div', { class: 'pick' },
        ic('folder', 20), h('span', { class: 'grow', style: { cursor: 'pointer' }, onclick: () => { v.remove(); folderEdit(f); } }, f.name, h('small', null, ' · ' + faNum(f.convos.length) + ' گفتگو')),
        i > 0 ? h('button', { class: 'icon', title: 'بالاتر', onclick: () => { E.moveFolder(f.id, -1); render(); } }, ic('arrowUp', 20)) : null,
        i < fs.length - 1 ? h('button', { class: 'icon', title: 'پایین‌تر', onclick: () => { E.moveFolder(f.id, 1); render(); } }, ic('arrowDown', 20)) : null,
        h('button', { class: 'icon', title: 'حذف', onclick: () => { E.deleteFolder(f.id); render(); } }, ic('close', 20)))),
      fs.length < E.MAX_FOLDERS ? h('button', { class: 'btn flat', onclick: () => { v.remove(); folderEdit(null); } }, '+ پوشهٔ تازه') : null,
      h('label', { class: 'pick sw' }, h('span', { class: 'grow' }, 'نمایش زبانه‌ها بالای فهرست'), tabsCb));
  };
  render();
  document.body.append(v);
}
function folderEdit(f, pre = []) {
  const chosen = new Set(f ? f.convos : pre);
  const name = h('input', { type: 'text', placeholder: 'نام پوشه', maxLength: E.MAX_FOLDER_NAME, value: f ? f.name : '' });
  const count = h('small');
  const list = h('div', { class: 'picklist' });
  const chats = E.summaries().map((x) => x.convo);
  const upd = () => { count.textContent = 'گفتگوها (' + faNum(chosen.size) + ')'; };
  fill(list, chats.map((c) => {
    const cb = h('input', { type: 'checkbox', checked: chosen.has(c), onchange: () => { if (cb.checked) chosen.add(c); else chosen.delete(c); upd(); } });
    return h('label', { class: 'pick' }, cb, avatar(c, 'sm'), h('span', null, E.titleOf(c)));
  }));
  upd();
  const v = h('div', { class: 'veil', onclick: (e) => { if (e.target === v) v.remove(); } },
    h('div', { class: 'dialog' }, h('h3', null, f ? 'ویرایش پوشه' : 'پوشهٔ تازه'), name, count, list,
      h('div', { class: 'btns' }, h('button', { class: 'btn flat', onclick: () => v.remove() }, 'انصراف'),
        h('button', { class: 'btn', onclick: () => { const err = E.saveFolder(f ? f.id : null, name.value, [...chosen]); if (err) toast(err); else v.remove(); } }, 'ذخیره'))));
  document.body.append(v);
  name.focus();
}
function folderPick(convo) {
  const body = h('div');
  const v = h('div', { class: 'veil', onclick: (e) => { if (e.target === v) v.remove(); } },
    h('div', { class: 'dialog' }, h('h3', null, 'افزودن به پوشه'), body, h('div', { class: 'btns' }, h('button', { class: 'btn', onclick: () => v.remove() }, 'بستن'))));
  const render = () => fill(body,
    S.chat.folders.length ? null : h('p', null, 'هنوز پوشه‌ای نساخته‌اید.'),
    S.chat.folders.map((f) => {
      const cb = h('input', { type: 'checkbox', checked: f.convos.includes(convo), onchange: () => E.toggleInFolder(f.id, convo) });
      return h('label', { class: 'pick' }, cb, h('span', null, f.name));
    }),
    S.chat.folders.length < E.MAX_FOLDERS ? h('button', { class: 'btn flat', onclick: () => { v.remove(); folderEdit(null, [convo]); } }, '+ پوشهٔ تازه') : null);
  render();
  document.body.append(v);
}

// ---------------- 1.29: scheduled send ----------------
/** Resolves to the chosen time (ms) or null. Quick choices first, then a day and a time. */
function schedulePicker(title, initial) {
  return new Promise((resolve) => {
    const close = (r) => { v.remove(); resolve(r); };
    const now = Date.now();
    const days = S.feats.sched_days || 30;
    const at = (d, hh, mm) => { const x = new Date(startOfDay(now)); x.setDate(x.getDate() + d); x.setHours(hh, mm, 0, 0); return x.getTime(); };
    const quick = [['یک ساعت دیگر', now + 3600e3], ['امشب ساعت ۲۱', at(0, 21, 0)], ['فردا ساعت ۹ صبح', at(1, 9, 0)]].filter((q) => q[1] > now + 60e3);
    const start = new Date(initial && initial > now ? initial : now + 3600e3);
    const daySel = h('select', null, Array.from({ length: days + 1 }, (_, i) => h('option', { value: String(i) },
      i === 0 ? 'امروز' : i === 1 ? 'فردا' : new Date(at(i, 12, 0)).toLocaleDateString('fa-IR-u-ca-persian', { weekday: 'long', day: 'numeric', month: 'long' }))));
    daySel.value = String(Math.max(0, Math.min(days, Math.round((startOfDay(start.getTime()) - startOfDay(now)) / 864e5))));
    const time = h('input', { type: 'time', value: String(start.getHours()).padStart(2, '0') + ':' + String(Math.floor(start.getMinutes() / 5) * 5).padStart(2, '0') });
    const pick = (t) => { if (t < Date.now() + 30e3) { toast('این زمان گذشته است'); return; } close(t); };
    const v = h('div', { class: 'veil', onclick: (e) => { if (e.target === v) close(null); } },
      h('div', { class: 'dialog' }, h('h3', null, title),
        quick.map(([label, t]) => h('button', { class: 'it qk', onclick: () => pick(t) }, ic('clock', 18), ' ', label)),
        h('p', null, 'یا زمان دلخواه:'), daySel, time,
        h('div', { class: 'btns' }, h('button', { class: 'btn flat', onclick: () => close(null) }, 'انصراف'),
          h('button', { class: 'btn', onclick: () => { const [hh, mm] = (time.value || '12:00').split(':').map(Number); pick(at(Number(daySel.value), hh, mm)); } }, 'تنظیم'))));
    document.body.append(v);
  });
}
function scheduledSheet(convo) {
  const body = h('div', { class: 'picklist' });
  const v = h('div', { class: 'veil', onclick: (e) => { if (e.target === v) { off(); v.remove(); } } },
    h('div', { class: 'dialog' }, h('h3', null, 'پیام‌های زمان‌دار'),
      h('p', null, 'روی سرور می‌مانند و سر وقت فرستاده می‌شوند، حتی اگر مرورگر بسته باشد.'), body,
      h('div', { class: 'btns' }, h('button', { class: 'btn', onclick: () => { off(); v.remove(); } }, 'بستن'))));
  const run = async (x, what, at) => { const err = await E.scheduledAction(x, what, at); if (err) toast(err); };
  const render = () => {
    const l = E.scheduledIn(convo);
    fill(body, l.length ? l.map((x) => h('div', { class: 'sch' + (x.failed ? ' failed' : '') },
      h('div', { class: 'grow' }, h('div', { class: 'st' }, x.text), h('small', null, fmtFull(x.at) + (x.silent ? ' · بی‌صدا' : '')),
        x.failed ? h('small', { class: 'err' }, E.schedFailText(x.failed)) : null),
      h('button', { class: 'icon', title: 'همین حالا بفرست', onclick: () => run(x, 'now') }, ic('send', 20)),
      h('button', { class: 'icon', title: 'تغییر زمان', onclick: async () => { const t = await schedulePicker('تغییر زمان ارسال', x.at); if (t) run(x, 'move', t); } }, ic('schedule', 20)),
      h('button', { class: 'icon', title: 'حذف', onclick: () => run(x, 'delete') }, ic('close', 20)))) : h('p', null, 'پیامی در صف نیست'));
  };
  const off = E.on((k) => { if (k === 'scheduled') render(); });
  render();
  document.body.append(v);
}

// ---------------- contacts (new chat) ----------------
function ContactsScreen() {
  const q = h('input', { type: 'text', placeholder: 'جستجو یا ‎@نام‌کاربری', oninput: () => render(), onkeydown: (e) => { if (e.key === 'Enter' && /^@?[A-Za-z0-9_]{2,20}$/.test(q.value.trim())) openUser(q.value.trim()); } });
  const list = h('div');
  const el = h('div', { class: 'scroll', style: { display: 'flex', flexDirection: 'column', overflow: 'hidden' } },
    h('div', { class: 'bar' }, h('button', { class: 'icon', title: 'بازگشت', onclick: () => go('#/') }, ic('back')), h('h1', null, 'مخاطبان'),
      h('button', { class: 'icon', title: 'افزودن مخاطب', onclick: () => go('#/requests') }, ic('personAdd'))),
    h('div', { class: 'scroll' }, h('div', { class: 'form', style: { paddingBottom: '4px' } }, q), list));
  const render = batched(() => {
    const term = q.value.trim().toLowerCase().replace(/^@/, '');
    const groups = S.groups.filter((g) => !term || g.name.toLowerCase().includes(term));
    const users = S.users.filter((u) => u.username !== S.me && u.req !== 'in' && u.req !== 'declined' && (!term || u.username.includes(term) || (u.display_name || '').toLowerCase().includes(term)))
      .sort((a, b) => (b.online - a.online) || E.nameOf(a.username).localeCompare(E.nameOf(b.username), 'fa'));
    const row = (c, sub, onclick) => h('button', { class: 'row', onclick }, avatarWithDot(c, 'sm'), h('div', { class: 'mid' }, h('div', { class: 'name' }, E.titleOf(c)), h('div', { class: 'prev' }, sub)));
    // anybody by exact @username (not only contacts): opens a chat, or a message request to a stranger
    const exact = /^[a-z0-9_]{2,20}$/.test(term) && term !== S.me && !users.some((u) => u.username === term);
    fill(list, 
      exact ? h('button', { class: 'row', onclick: () => openUser(term) }, h('div', { class: 'av sm', style: { background: '#3390ec' } }, '@'),
        h('div', { class: 'mid' }, h('div', { class: 'name' }, 'پیدا کردن ‎@' + term), h('div', { class: 'prev' }, 'جستجو با نام کاربری دقیق'))) : null,
      groups.length ? h('div', { class: 'section' }, 'گروه‌ها') : null,
      groups.map((g) => row(g.key, faNum(g.members.length) + ' عضو', () => go('#/c/' + encodeURIComponent(g.key)))),
      h('div', { class: 'section' }, 'افراد'),
      users.length ? users.map((u) => row(u.username, (u.online ? 'آنلاین · ' : '') + '@' + u.username + (u.req === 'out' ? ' · در انتظار پذیرفتن' : u.dm ? '' : ' · فقط پاسخ'), () => {
        if (!u.dm && !(S.convos.get(u.username) || []).length) { toast('شروع گفتگو با این کاربر مجاز نیست؛ اگر او پیام بدهد می‌توانید پاسخ دهید'); return; }
        go('#/c/' + encodeURIComponent(u.username));
      })) : emptyState('search', 'مخاطبی پیدا نشد', 'نام کاربری دقیق را با ‎@ بنویسید، یا با شمارهٔ موبایل پیدا کنید.', 'پیدا کردن با شماره', () => go('#/requests')));
  });
  render();
  return { el, update: (k) => { if (k === 'users' || k === 'groups') render(); } };
}

// ---------------- message and connection requests ----------------
function RequestsScreen() {
  const name = h('input', { type: 'text', placeholder: '@نام‌کاربری یا شمارهٔ موبایل', class: 'ltr', autocapitalize: 'off', autocorrect: 'off', spellcheck: 'false' });
  const msg = h('div', { class: 'err' });
  const btn = h('button', { class: 'btn', type: 'submit' }, 'پیدا کردن');
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
      who = f.matches[0].username;
    }
    btn.disabled = false;
    name.value = '';
    openUser(who);
  }
  const act = async (what, u, accept) => { const r = await E.contactAction(what, u, accept); if (r.error) toast(r.error); };
  const el = h('div', { class: 'scroll', style: { display: 'flex', flexDirection: 'column', overflow: 'hidden' } },
    h('div', { class: 'bar' }, h('button', { class: 'icon', title: 'بازگشت', onclick: () => history.length > 1 ? history.back() : go('#/') }, ic('back')), h('h1', null, 'درخواست‌ها')),
    h('div', { class: 'scroll' },
      h('form', { class: 'form', onsubmit: add }, h('div', { class: 'field' }, h('label', null, 'پیام به هر کسی با نام کاربری یا شمارهٔ موبایل'), name), msg, btn),
      lists));
  const render = batched(() => {
    const { incoming = [], declined = [], blocked = [], outgoing = [] } = S.requests;
    const who = (r) => (r.display_name ? r.display_name + ' · ' : '') + '@' + r.username;
    const detail = (r) => [r.msgs ? faNum(r.msgs) + ' پیام' : null, r.calls ? '📞 ' + faNum(r.calls) + ' تماس بی‌پاسخ' : null, r.ts ? fmtListTime(r.ts) : null].filter(Boolean).join(' · ');
    const open = (r) => (r.msgs ? () => go('#/c/' + encodeURIComponent(r.username)) : null);
    const item = (r, ...btns) => h('div', { class: 'setting' },
      h('div', { class: 'l', style: r.msgs ? { cursor: 'pointer' } : null, onclick: open(r) }, who(r), h('div', { class: 'd' }, detail(r) || 'درخواست ارتباط', r.msgs ? ' · برای دیدن پیام‌ها بزنید' : '')), btns);
    fill(lists,
      h('div', { class: 'section' }, 'درخواست‌های تازه'),
      incoming.length ? incoming.map((r) => item(r,
        h('button', { class: 'btn sm', onclick: () => act('respond', r.username, true) }, 'پذیرفتن'),
        h('button', { class: 'btn sm flat', onclick: () => act('respond', r.username, false) }, 'رد'),
        h('button', { class: 'btn sm flat danger', onclick: async () => { if (await confirmBox('مسدود کردن', who(r) + ' دیگر نمی‌تواند به شما پیام بدهد یا زنگ بزند. بعداً از همین صفحه می‌شود رفع مسدودی کرد.', 'مسدود', true)) act('block', r.username); } }, 'مسدود'))) : h('div', { class: 'hint' }, 'درخواست تازه‌ای ندارید'),
      declined.length ? [h('div', { class: 'section' }, 'رد شده‌ها (هنوز می‌شود پذیرفت)'), declined.map((r) => item(r,
        h('button', { class: 'btn sm', onclick: () => act('respond', r.username, true) }, 'پذیرفتن'),
        h('button', { class: 'btn sm flat danger', onclick: () => act('block', r.username) }, 'مسدود')))] : null,
      blocked.length ? [h('div', { class: 'section' }, 'مسدود شده‌ها'), blocked.map((r) => item(r,
        h('button', { class: 'btn sm flat', onclick: () => act('unblock', r.username) }, 'رفع مسدودی')))] : null,
      h('div', { class: 'section' }, 'فرستاده‌شده'),
      outgoing.length ? outgoing.map((r) => h('div', { class: 'setting' }, h('div', { class: 'l' }, who(r), h('div', { class: 'd' }, 'در انتظار پذیرفتن' + (r.msgs ? ' · ' + faNum(r.msgs) + ' پیام' : ''))),
        h('button', { class: 'btn sm flat', onclick: () => act('cancel', r.username) }, 'لغو'))) : h('div', { class: 'hint' }, 'درخواستی نفرستاده‌اید'));
  });
  render();
  return { el, update: (k) => { if (k === 'requests') render(); } };
}

// ---------------- chat ----------------
function ChatScreen(convo) {
  const group = E.isGroup(convo);
  const saved = E.isSaved(convo); // 1.29: «پیام‌های ذخیره‌شده»
  if (!group && !saved && !E.user(convo) && !(S.convos.get(convo) || []).length) { setTimeout(() => go('#/'), 0); return { el: h('div') }; }
  S.openConvo = convo;
  const pendingMentions = E.takeMentions(convo); // 1.29: «@» jumps to them, oldest first
  E.markRead(convo);
  let reply = null, editing = null, selected = null, limit = 120, search = '', forceBottom = true;
  // 1.21: a channel: older posts for a new member, and the 👁 counts while it is on screen
  const chan = group && E.isChan(convo);
  if (chan) E.loadChannel(convo).then(() => E.markRead(convo));
  const viewsTimer = chan ? setInterval(() => E.refreshViews(convo), 30000) : null;

  const title = h('div', { class: 't' }), sub = h('div', { class: 's' }), av = h('div');
  const callBtns = saved ? [] : group ? [h('button', { class: 'icon gcbtn', title: 'تماس صوتی گروهی', onclick: () => groupCall(convo) }, ic('call')),
    h('button', { class: 'icon gcbtn gcvid', title: 'تماس تصویری گروهی', onclick: () => groupCall(convo, true) }, ic('video'))] : [
    h('button', { class: 'icon', title: 'تماس صوتی', onclick: () => call(false) }, ic('call')),
    h('button', { class: 'icon', title: 'تماس تصویری', onclick: () => call(true) }, ic('video'))];
  // 1.19: the green «پیوستن» bar of a group call that is running in this group (like Telegram)
  const gcBar = h('div', { class: 'gcbar hidden' });
  function renderGcBar() {
    const r = group ? GC.roomOf(convo) : null;
    const g = group && S.groups.find((x) => x.key === convo);
    for (const b of el.querySelectorAll('.gcbtn')) b.classList.toggle('hidden', !(GC.cfg().on && g && g.call !== false && (!b.classList.contains('gcvid') || GC.videoOn())));
    const mine = r && GC.G.room && GC.G.room.id === r.id && GC.G.phase === 'active';
    gcBar.classList.toggle('hidden', !r || mine);
    if (!r || mine) return;
    fill(gcBar, h('div', { class: 'avs' }, r.parts.slice(0, 4).map((p) => avatar(p.u, 'xs'))),
      h('div', { class: 'grow' }, h('b', null, 'تماس گروهی'), ' · ', faNum(r.parts.length) + ' نفر'),
      h('button', { class: 'btn sm', onclick: () => GC.join(r.id) }, 'پیوستن'));
  }
  // a message request (no connection yet): calls are only noted on the request, they do not ring
  function call(video) {
    const r = E.reqOf(convo);
    if (r === 'in' || r === 'declined') { toast('اول درخواست را بپذیرید'); return; }
    Call.startCall(convo, video);
  }
  const reqBar = h('div', { class: 'reqbar hidden' });
  const searchInput = h('input', { type: 'text', placeholder: 'جستجو در گفتگو', oninput: () => { search = searchInput.value.trim(); renderList(); } });
  const searchBar = h('div', { class: 'searchbar hidden' }, searchInput, h('button', { class: 'icon', onclick: () => { searchBar.classList.add('hidden'); search = ''; searchInput.value = ''; renderList(); } }, ic('close')));
  const pinBar = h('div', { class: 'pinbar hidden' });
  const msgs = h('div', { class: 'msgs' });
  const jumpCount = h('span', { class: 'badge hidden' });
  const jump = h('button', { class: 'jump hidden', title: 'آخرین پیام', onclick: () => { forceBottom = true; msgs.scrollTo({ top: msgs.scrollHeight, behavior: lessMotion() ? 'auto' : 'smooth' }); } }, ic('arrowDown', 26), jumpCount);
  // 1.29: mentions of me, scheduled messages, «@» suggestions
  const atCount = h('span', { class: 'badge' });
  const atBtn = h('button', { class: 'jump at hidden', title: 'منشن‌ها', onclick: () => { const id = pendingMentions.shift(); if (id) scrollToMsg(id); renderAt(); } }, ic('at', 24), atCount);
  const renderAt = () => { atBtn.classList.toggle('hidden', !pendingMentions.length); atCount.textContent = faNum(pendingMentions.length); };
  const schedBar = h('div', { class: 'pinbar schbar hidden' });
  function renderSched() {
    const l = E.scheduledIn(convo);
    schedBar.classList.toggle('hidden', !l.length);
    if (!l.length) return;
    const failed = l.filter((x) => x.failed).length;
    fill(schedBar, h('span', { class: 'pinic' }, ic(failed ? 'error' : 'schedule', 20)),
      h('div', { class: 'pt' }, h('b', null, faNum(l.length) + ' پیام زمان‌دار'), h('span', null, failed ? faNum(failed) + ' ارسال نشد' : 'نزدیک‌ترین: ' + fmtFull(l[0].at))));
    schedBar.onclick = () => scheduledSheet(convo);
  }
  const mentionBox = h('div', { class: 'mentions hidden' });

  const ta = h('textarea', { rows: 1, placeholder: 'پیام', dir: 'auto' });
  const fileIn = h('input', { type: 'file', multiple: true, class: 'hidden' });
  const photoIn = h('input', { type: 'file', multiple: true, accept: 'image/*', class: 'hidden' });
  const camIn = h('input', { type: 'file', accept: 'image/*', capture: 'environment', class: 'hidden' });
  const replyBar = h('div', { class: 'replybar hidden' });
  const selCount = h('div', { class: 'grow' });
  const selBar = h('div', { class: 'selbar hidden' }, h('button', { class: 'icon', title: 'لغو', onclick: () => setSelecting(null) }, ic('close')), selCount,
    h('button', { class: 'btn sm', onclick: () => {
      const all = S.convos.get(convo) || [];
      const msgsSel = all.filter((x) => selected.has(x.id) && x.id > 0 && x.type !== 'call');
      if (msgsSel.length) forwardSheet(msgsSel, () => setSelecting(null)); else toast('تماس‌ها فوروارد نمی‌شوند');
    } }, 'فوروارد'),
    // 1.27: delete the selected messages / call lines from this device
    h('button', { class: 'btn sm danger', onclick: async () => {
      const all = S.convos.get(convo) || [];
      const sel = all.filter((x) => selected.has(x.id));
      if (!sel.length || !(await confirmBox('حذف ' + faNum(sel.length) + ' مورد', 'موارد انتخاب‌شده فقط از این دستگاه پاک می‌شوند.', 'حذف', true))) return;
      for (const x of sel) E.deleteLocal(x);
      setSelecting(null);
    } }, 'حذف'));
  const emojiPanel = h('div', { class: 'emojis hidden' });
  const sendBtn = h('button', { class: 'icon send', title: 'ارسال' }, ic('send', 22));
  const micBtn = h('button', { class: 'icon mic', title: 'پیام صوتی (نگه دارید)' }, ic('mic', 24));
  const recBar = h('div', { class: 'recbar hidden' });
  const attachBtn = h('button', { class: 'icon', title: 'پیوست', onclick: () => sheet(null, [
    { label: '🖼 عکس از گالری', run: () => photoIn.click() },
    { label: '📷 عکس با دوربین', run: () => camIn.click() },
    { label: '📎 فایل', run: () => fileIn.click() },
    { label: '📍 موقعیت مکانی', run: shareLocation },
  ]) }, ic('attach'));
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
  const emojiBtn = h('button', { class: 'icon', title: 'شکلک' }, ic('smile'));
  const lockBar = h('div', { class: 'lockbar hidden' });

  const connLine = h('div', { class: 'connline hidden' });
  const el = h('div', { class: 'chat', style: { display: 'flex', flexDirection: 'column', height: '100%', position: 'relative' } },
    h('div', { class: 'bar' },
      h('button', { class: 'icon', title: 'بازگشت', onclick: () => go('#/') }, ic('back')),
      h('div', { class: 'grow', style: { display: 'flex', gap: '10px', alignItems: 'center' }, onclick: () => { if (!saved) go('#/p/' + encodeURIComponent(convo)); } }, av, h('div', { style: { minWidth: '0' } }, title, sub)),
      callBtns,
      h('button', { class: 'icon', title: 'جستجو', onclick: () => { searchBar.classList.remove('hidden'); searchInput.focus(); } }, ic('search')),
      // 1.27: ⋮ › «حذف گفتگو»
      h('button', { class: 'icon', title: 'گزینه‌ها', onclick: () => sheet(E.titleOf(convo), [
        E.scheduledIn(convo).length ? { label: '🕒 پیام‌های زمان‌دار (' + faNum(E.scheduledIn(convo).length) + ')', run: () => scheduledSheet(convo) } : null,
        { label: '🗑 حذف گفتگو', danger: true, run: async () => { if (await clearChatDialog(convo)) go('#/'); } }]) }, ic('more'))),
    connLine, searchBar, gcBar, pinBar, schedBar, reqBar, msgs, jump, atBtn,
    // 1.13: send/mic on the right; 1.28: the text box, emoji and attach sit in one floating pill
    h('div', { class: 'composer' }, selBar, mentionBox, replyBar, recBar, lockBar, h('div', { class: 'line' }, sendBtn, micBtn, h('div', { class: 'pill' }, ta, emojiBtn, attachBtn)), emojiPanel, fileIn, photoIn, camIn));
  // 1.20: a user group where only admins write, or one the server admin froze
  function renderLock() {
    const why = group ? E.writeBlock(convo) : '';
    lockBar.textContent = why;
    lockBar.classList.toggle('hidden', !why);
    const line = el.querySelector('.composer .line');
    if (line) line.classList.toggle('hidden', !!why);
  }

  function renderHeader() {
    title.textContent = E.titleOf(convo);
    fill(av, avatarWithDot(convo, 'sm'));
    const c = connText();
    connLine.classList.toggle('hidden', !c);
    let s = '', on = false, typing = false;
    if (c) s = c;
    else if (saved) s = 'یادداشت‌ها و پیام‌های نگه‌داشته، فقط برای شما';
    else if (group && E.typingIn(convo).length) { const t = E.typingIn(convo); s = E.nameOf(t[0]) + (t.length > 1 ? ' و ' + faNum(t.length - 1) + ' نفر دیگر' : '') + ' در حال نوشتن'; on = true; typing = true; }
    else if (chan) { const g = E.groupOf(convo); s = '📢 کانال' + (g ? ' · ' + faNum(g.count || g.members.length) + ' عضو' : ''); }
    else if (group) {
      const g = S.groups.find((x) => x.key === convo);
      const n = g ? g.members.filter((u) => u !== S.me && E.user(u) && E.user(u).online).length : 0;
      s = g ? faNum(g.members.length) + ' عضو' + (n ? '، ' + faNum(n) + ' آنلاین' : '') : '';
    }
    else if (Date.now() - (S.typing[convo] || 0) < 4500) { s = 'در حال نوشتن'; on = true; typing = true; }
    else { const u = E.user(convo); s = lastSeenText(u) || '@' + convo; on = !!(u && u.online); }
    if (typing) fill(sub, typingDots(), s); else sub.textContent = s;
    sub.classList.toggle('on', on);
  }

  function renderReq() {
    const r = E.reqOf(convo);
    reqBar.classList.toggle('hidden', !r);
    const stranger = r === 'out';
    attachBtn.classList.toggle('hidden', stranger);
    showMic();
    if (!r) return;
    const nm = E.nameOf(convo);
    if (stranger) {
      fill(reqBar, h('div', { class: 'rt' }, 'درخواست پیام: ' + nm + ' هنوز در مخاطبان شما نیست. تا وقتی بپذیرد، تا ' + faNum(3) + ' پیام متنی (بدون فایل) می‌شود فرستاد. تماس بعد از پذیرفتن ممکن است.'));
      return;
    }
    const q = (S.requests.incoming || []).concat(S.requests.declined || []).find((x) => x.username === convo);
    const act = async (what, accept) => { const x = await E.contactAction(what, convo, accept); if (x.error) toast(x.error); else if (what === 'block') go('#/requests'); };
    fill(reqBar,
      h('div', { class: 'rt' }, nm + ' (@' + convo + ') در مخاطبان شما نیست' + (r === 'declined' ? ' و این درخواست را رد کرده‌اید' : '') + '.' + (q && q.calls ? ' 📞 ' + faNum(q.calls) + ' تماس بی‌پاسخ.' : '') + ' با پاسخ دادن یا «پذیرفتن» به هم وصل می‌شوید.'),
      h('div', { class: 'ra' },
        h('button', { class: 'btn sm', onclick: () => act('respond', true) }, 'پذیرفتن'),
        r === 'in' ? h('button', { class: 'btn sm flat', onclick: async () => { await act('respond', false); go('#/requests'); } }, 'رد') : null,
        h('button', { class: 'btn sm flat danger', onclick: async () => { if (await confirmBox('مسدود کردن', nm + ' دیگر نمی‌تواند به شما پیام بدهد یا زنگ بزند.', 'مسدود', true)) act('block'); } }, 'مسدود')));
  }

  function renderPin() {
    const id = S.pins[convo];
    const m = id && (S.convos.get(convo) || []).find((x) => x.id === id);
    pinBar.classList.toggle('hidden', !id);
    if (!id) return;
    fill(pinBar, h('span', { class: 'pinic' }, ic('pin', 20)), h('div', { class: 'pt' }, h('b', null, 'پیام سنجاق‌شده'), h('span', null, m ? E.preview(m) : 'پیام')));
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
        h('button', { class: 'icon', onclick: () => { setEditing(null); ta.value = ''; autosize(); } }, ic('close')));
      ta.value = m.text; autosize(); ta.focus();
    }
  }

  function setReply(m) {
    if (editing && m) { editing = null; ta.value = ''; }
    reply = m;
    replyBar.classList.toggle('hidden', !m);
    if (m) {
      fill(replyBar, h('div', { class: 'reply' }, h('div', { class: 'ru' }, 'پاسخ به ' + (m.mine ? 'خودتان' : E.nameOf(m.sender))), h('div', { class: 'rx' }, E.preview(m))),
        h('button', { class: 'icon', onclick: () => setReply(null) }, ic('close')));
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

  /** Text with clickable @usernames (search hits still highlighted). */
  function richText(text) {
    const out = [];
    let i = 0;
    for (const mm of text.matchAll(NAME_AT)) {
      if (mm.index > 0 && /[A-Za-z0-9_.]/.test(text[mm.index - 1])) continue; // e-mail addresses
      const n = mm[1].toLowerCase();
      out.push(highlight(text.slice(i, mm.index)), h('a', { class: 'mention', href: '#', dir: 'ltr', onclick: (e) => { e.preventDefault(); e.stopPropagation(); openUser(n); } }, '@' + mm[1]));
      i = mm.index + mm[0].length;
    }
    out.push(highlight(text.slice(i)));
    return out;
  }

  function mediaPart(m) {
    const url = E.mediaUrl(m);
    const prog = S.progress.get(m.id);
    const fail = S.failures.get(m.id);
    if (m.type === 'image') {
      const w = Math.min(260, m.w || 260), hgt = m.w && m.h ? Math.round(w * m.h / m.w) : 180;
      const box = { width: w + 'px', height: Math.min(hgt, 360) + 'px' };
      if (url) {
        // 1.12: a long press (or right click) opens the message menu, a tap opens the viewer
        const img = h('img', { class: 'img', src: url, alt: '', style: box, onclick: (e) => { e.stopPropagation(); if (!wasLong()) viewer(url, m); } });
        const wasLong = onLongPress(img, () => { if (!selected) menu(m); });
        return img;
      }
      if (m.fileId && !fail && prog == null && m.size <= 25 * 1024 * 1024 && pref('autoImages', true)) E.download(m).catch(() => { });
      return h('div', { class: 'img-ph' + (prog != null ? ' shim' : ''), style: box, onclick: (e) => { e.stopPropagation(); S.failures.delete(m.id); E.download(m).catch(() => { }); renderList(); } },
        prog != null ? h('span', { class: 'ring' }, faNum(Math.round(prog * 100)) + '٪') : fail ? [ic('error', 18), ' ' + fail + ' (دوباره)'] : [ic('download', 20), ' ' + fmtSize(m.size)]);
    }
    if ((m.mime || '').startsWith('video/')) {
      // videos play right here in the chat (1.7), with the browser's own controls (full screen, speed)
      if (url) {
        const vid = h('video', { class: 'vid', src: url, controls: true, playsInline: true, preload: 'metadata', onclick: (e) => e.stopPropagation() });
        onLongPress(vid, () => { if (!selected) menu(m); });
        return vid;
      }
      return h('div', { class: 'img-ph vid-ph', onclick: (e) => { e.stopPropagation(); if (!m.fileId) return; S.failures.delete(m.id); E.download(m).catch(() => { }); renderList(); } },
        prog != null ? faNum(Math.round(prog * 100)) + '٪' : fail ? [ic('error', 18), ' ' + fail + ' (دوباره)'] : [ic('play', 26), ' ویدیو · ' + fmtSize(m.size)]);
    }
    return h('div', { class: 'file', onclick: async (e) => {
      e.stopPropagation();
      if (E.mediaUrl(m)) return saveMedia(m);
      if (!m.fileId) return;
      S.failures.delete(m.id);
      try { await E.download(m); toast('دانلود شد؛ برای ذخیره دوباره بزنید'); } catch { }
    } },
    h('div', { class: 'fi' }, ic(url ? 'file' : prog != null ? 'hourglass' : 'download', 22)),
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
    const want = S.progress.get(m.id) != null ? 'hourglass' : st.playing ? 'pause' : 'play';
    if (v.btn.dataset.ic !== want) { v.btn.dataset.ic = want; fill(v.btn, ic(want, 24)); }
    v.bars.forEach((b, i) => b.classList.toggle('on', (i + 0.5) / v.bars.length <= frac));
    v.time.textContent = fmtDur(st.playing || st.pos ? st.pos : m.dur);
    v.speed.textContent = Voice.getRate() === 1 ? '1×' : Voice.getRate() === 1.5 ? '1.5×' : '2×';
    v.speed.classList.toggle('on', Voice.getRate() !== 1);
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
    // playback speed: 1x -> 1.5x -> 2x, remembered for the next voice messages
    const speed = h('button', { class: 'vspeed', title: 'سرعت پخش', onclick: (e) => { e.stopPropagation(); Voice.cycleRate(); } });
    voiceEls.set(m.id, { btn, bars, time, speed });
    const el = h('div', { class: 'voice' }, btn, h('div', { class: 'vw' }, waveEl, h('div', { class: 'fs' }, time, speed, fail && m.status !== 2 ? ' · ⚠️ ' + fail : '')));
    paintVoice(m);
    return el;
  }

  function locationPart(l) {
    return h('div', { class: 'loc', onclick: (e) => { e.stopPropagation(); openMap(l); } },
      h('div', { class: 'fi' }, ic('location', 22)),
      h('div', { style: { minWidth: '0' } }, h('div', { class: 'fn' }, 'موقعیت مکانی'),
        h('div', { class: 'fs ltr' }, E.fmtCoord(l)), l.acc ? h('div', { class: 'fs' }, 'دقت حدود ' + faNum(l.acc) + ' متر') : null));
  }

  function reactionRow(m) {
    const rx = E.reactionsOf(m);
    if (!rx.length) return null;
    return h('div', { class: 'rxn' }, rx.map(([e, us]) => h('button', { class: 'rchip' + (us.includes(S.me) ? ' mine' : ''), onclick: (ev) => { ev.stopPropagation(); reactorsSheet(m); } },
      e, us.length > 1 ? h('span', null, faNum(us.length)) : null)));
  }

  // 1.28: swipe a message to the left to answer it (like the Android app)
  function swipeReply(wrap, b, m) {
    if (!(m.id > 0)) return () => false;
    let x0 = 0, y0 = 0, dx = 0, on = false, done = false, swiped = 0;
    wrap.addEventListener('pointerdown', (e) => { if (selected || e.button) return; x0 = e.clientX; y0 = e.clientY; dx = 0; on = true; done = false; });
    wrap.addEventListener('pointermove', (e) => {
      if (!on) return;
      const mx = e.clientX - x0, my = e.clientY - y0;
      if (!done && Math.abs(my) > 14 && Math.abs(my) > Math.abs(mx)) { on = false; return; }
      if (mx < -8 && Math.abs(mx) > Math.abs(my)) {
        done = true;
        dx = Math.max(-90, mx);
        b.style.transition = 'none';
        b.style.transform = 'translateX(' + dx + 'px)';
        wrap.classList.toggle('swipe', dx < -60);
      }
    });
    const end = () => {
      if (!on) return;
      on = false;
      if (!done) return;
      b.style.transition = ''; b.style.transform = '';
      wrap.classList.remove('swipe');
      if (dx < -60) { buzz(); swiped = Date.now(); setReply(m); }
    };
    wrap.addEventListener('pointerup', end);
    wrap.addEventListener('pointercancel', end);
    wrap.addEventListener('pointerleave', end);
    return () => Date.now() - swiped < 400 || (done && Math.abs(dx) > 8);
  }

  function bubble(m, first) {
    // 1.27: a call line can be selected and deleted (it lives only on this device)
    if (m.type === 'call') return h('div', { class: 'call-line' + (selected && selected.has(m.id) ? ' sel' : ''), onclick: () => {
      if (!selected) return sheet(null, [{ label: 'انتخاب', run: () => setSelecting(new Set([m.id])) }, { label: 'حذف از این دستگاه', danger: true, run: () => E.deleteLocal(m) }]);
      if (selected.has(m.id)) selected.delete(m.id); else selected.add(m.id);
      if (!selected.size) setSelecting(null); else setSelecting(selected);
    } }, ic('call', 14), ' ' + m.text + ' · ' + fmtTime(m.ts));
    const big = (m.type === 'text' && !m.replyId && !m.replyText && Emoji.onlyEmojiCount(m.text) > 0) || m.type === 'sticker';
    const prog = S.progress.get(m.id);
    const b = h('div', { class: 'bubble' + (big ? ' emoji' : '') + (m.type === 'sticker' ? ' sticker' : '') },
      group && !m.mine && !chan ? h('div', { class: 'who', style: { color: colorFor(m.sender) } }, E.nameOf(m.sender)) : null,
      m.fwFrom ? h('div', { class: 'fw' }, 'فوروارد از ' + (m.fwFrom === S.me ? 'شما' : m.fwName || E.nameOf(m.fwFrom))) : null,
      m.replyText || m.replyId ? h('div', { class: 'reply', onclick: (e) => { e.stopPropagation(); if (m.replyId) scrollToMsg(m.replyId); } },
        h('div', { class: 'ru' }, m.replyUser === S.me ? 'شما' : E.nameOf(m.replyUser || '')), h('div', { class: 'rx' }, m.replyText || '')) : null,
      m.type === 'image' || m.type === 'file' ? mediaPart(m) : null,
      m.type === 'voice' ? voicePart(m) : null,
      m.type === 'location' && m.loc ? locationPart(m.loc) : null,
      m.type === 'sticker' && m.stk ? stickerImg(m.stk.id, 'stk big') : null,
      m.type === 'text' ? h('div', { class: 'txt', dir: 'auto' }, richText(m.text)) : null,
      m.mine && prog != null && m.status === 1 ? h('div', { class: 'bar-prog' }, h('i', { style: { width: Math.round(prog * 100) + '%' } })) : null,
      m.status === 2 ? h('div', { class: 'fail' }, '⚠️ ' + (S.failures.get(m.id) || 'ارسال نشد'), h('button', { onclick: (e) => { e.stopPropagation(); E.retry(m); } }, 'تلاش دوباره')) : null,
      reactionRow(m),
      h('div', { class: 'meta' }, chan && m.id > 0 ? h('span', { title: 'دیده شده' }, '👁 ' + faNum(E.viewsOf(m))) : null,
        chan && m.id > 0 && (E.groupOf(convo) || {}).sign ? h('span', null, '✍️ ' + (m.mine ? 'شما' : E.nameOf(m.sender)) + ' ·') : null,
        m.mine ? (m.status === 1 ? h('span', { class: 'tick sent' }, ic('clock', 14)) : m.status === 2 ? h('span', { class: 'tick err' }, ic('error', 14)) : tickEl(E.tickOf(m))) : null, m.edited ? h('span', { title: fmtFull(m.edited) }, 'ویرایش‌شده ' + (startOfDay(m.edited) === startOfDay(m.ts) ? '' : fmtDay(m.edited) + ' ') + fmtTime(m.edited) + ' ·') : null, h('span', null, fmtTime(m.ts)), S.pins[convo] === m.id ? h('span', null, '📌') : null));
    b.dataset.id = m.id;
    const pickable = m.id > 0 && m.status === 0 && !m.locked;
    const wrap = h('div', { class: 'm ' + (m.mine ? 'me' : 'them') + (first ? ' first' : '') + (selected && selected.has(m.id) ? ' sel' : '') + (shownIds && !shownIds.has(m.id) && !(m.mine && m.id > 0) ? ' in' : ''), onclick: () => {
      if (swipedNow()) return;
      if (!selected) return menu(m);
      if (!pickable) return;
      if (selected.has(m.id)) selected.delete(m.id); else selected.add(m.id);
      if (!selected.size) setSelecting(null); else setSelecting(selected);
    } }, h('span', { class: 'swr' }, ic('reply', 20)), b);
    const swipedNow = swipeReply(wrap, b, m);
    return wrap;
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
      S.feats.saved && !saved && m.id > 0 && m.status === 0 && m.type !== 'call' && { label: '🔖 ذخیره در پیام‌های ذخیره‌شده', run: () => { E.forward([m], [S.me], false); toast('در پیام‌های ذخیره‌شده نگه داشته شد'); } },
      m.id > 0 && m.status === 0 && { label: 'انتخاب', run: () => setSelecting(new Set([m.id])) },
      m.id > 0 && { label: 'اطلاعات پیام', run: () => infoSheet(m) },
      m.mine && group && m.id > 0 && m.status === 0 && { label: 'دیده شده توسط…', run: () => readersSheet(m) },
      m.type === 'sticker' && m.stk && { label: isFav(m.stk.id) ? 'برداشتن از علاقه‌مندی‌ها' : '⭐ افزودن به علاقه‌مندی‌ها', run: () => toggleFav(m.stk) },
      m.type === 'sticker' && m.stk && E.stickerCached(m.stk.id) !== null && { label: '🎭 نمایش پک', run: () => packSheet(m.stk.p) },
      m.type === 'text' && { label: 'کپی', run: () => navigator.clipboard.writeText(m.text).then(() => toast('کپی شد'), () => toast('کپی نشد')) },
      ...(m.status === 0 && m.fileId && ['image', 'file', 'voice'].includes(m.type) ? mediaItems(m) : []),
      m.id > 0 && (!E.isUserGroup(convo) || E.canManageGroup(convo)) && { label: pinned ? 'برداشتن سنجاق' : 'سنجاق کردن', run: async () => { const e = await E.pinMessage(convo, pinned ? null : m.id); if (e) toast(e); } },
      m.status === 2 && { label: 'تلاش دوباره', run: () => E.retry(m) },
      (m.mine || (E.isUserGroup(convo) && E.canManageGroup(convo) && m.type !== 'call')) && m.id > 0 && m.status === 0 && { label: m.mine ? 'حذف برای همه' : 'حذف برای همه (مدیر گروه)', danger: true, run: async () => {
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
  let shownIds = null; // 1.28: ids already on screen; only messages that arrive later slide in
  function renderList(keep) {
    let all = S.convos.get(convo) || [];
    if (search) all = all.filter((m) => (m.type === 'text' ? m.text : E.preview(m)).toLowerCase().includes(search.toLowerCase()));
    const shown = all.slice(-limit);
    const atBottom = msgs.scrollHeight - msgs.scrollTop - msgs.clientHeight < 90;
    const fromBottom = msgs.scrollHeight - msgs.scrollTop;
    const kids = [];
    voiceEls.clear();
    if (all.length > shown.length) kids.push(h('button', { class: 'btn sm flat', style: { alignSelf: 'center' }, onclick: () => { limit += 150; renderList(true); } }, 'پیام‌های قبلی'));
    let lastDay = 0, prev = null;
    for (const m of shown) {
      const d = startOfDay(m.ts);
      let newDay = false;
      if (d !== lastDay) { kids.push(h('div', { class: 'day' }, fmtDay(m.ts))); lastDay = d; newDay = true; }
      const first = newDay || !prev || prev.type === 'call' || prev.mine !== m.mine || (!m.mine && prev.sender !== m.sender);
      kids.push(bubble(m, first));
      prev = m;
    }
    if (!all.length) kids.push(search ? emptyState('search', 'پیامی پیدا نشد', 'کلمهٔ دیگری را امتحان کنید.')
      : saved ? h('div', { class: 'hello' }, emptyState('bookmark', E.SAVED_TITLE, 'یادداشت، فایل و عکس برای خودتان بفرستید یا پیام‌ها را با «فوروارد» و «ذخیره» اینجا نگه دارید. روی همهٔ دستگاه‌هایتان هست و بعد از ۹۰ روز پاک نمی‌شود.'))
      : h('div', { class: 'hello' }, emptyState('lock', 'هنوز پیامی نیست', 'پیام‌ها سرتاسری رمزنگاری می‌شوند؛ فقط شما و ' + (group ? 'اعضا' : E.nameOf(convo)) + ' می‌خوانید.',
        !chan && !(group && E.writeBlock(convo)) && E.reqOf(convo) !== 'in' ? 'سلام 👋' : null, () => { forceBottom = true; E.sendText(convo, 'سلام 👋', null); })));
    shownIds = new Set(shown.map((m) => m.id));
    fill(msgs, ...kids);
    if (fxFlying) { const t = fxTarget(msgs, fxFlying); if (t) t.style.visibility = 'hidden'; }
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
  const showMic = () => { const mic = canMic && E.reqOf(convo) !== 'out' && !ta.value.trim() && !editing; micBtn.classList.toggle('hidden', !mic); sendBtn.classList.toggle('hidden', mic); };
  let draftTimer = null;
  // 1.29: «@» in a group offers its members
  function renderMentions() {
    const before = ta.value.slice(0, ta.selectionStart ?? ta.value.length);
    const mm = group && !chan && !editing ? /(^|\s)@([^\s@]{0,32})$/.exec(before) : null;
    let list = mm ? E.mentionCandidates(convo, mm[2]) : [];
    if (mm && E.canMentionAll(convo) && ('همه'.startsWith(mm[2]) || 'all'.startsWith(mm[2].toLowerCase()))) list = ['همه', ...list];
    mentionBox.classList.toggle('hidden', !list.length);
    if (!list.length) return;
    fill(mentionBox, list.map((u) => h('button', { class: 'mrow', onmousedown: (e) => e.preventDefault(), onclick: () => {
      const start = before.length - mm[2].length - 1;
      ta.value = ta.value.slice(0, start) + '@' + u + ' ' + ta.value.slice(before.length);
      const pos = start + u.length + 2;
      ta.focus(); ta.setSelectionRange(pos, pos); autosize(); renderMentions();
    } }, u === 'همه' ? h('div', { class: 'av sm', style: { background: 'var(--accent)' } }, ic('group', 20)) : avatar(u, 'sm'),
      h('div', null, h('b', null, u === 'همه' ? 'همه' : E.nameOf(u)), h('small', null, u === 'همه' ? 'خبر به همهٔ اعضا، حتی اگر گروه را بی‌صدا کرده باشند' : '@' + u)))));
  }
  ta.addEventListener('input', () => {
    autosize(); showMic(); renderMentions();
    if (ta.value.trim()) E.sendTyping(convo);
    clearTimeout(draftTimer); draftTimer = setTimeout(() => { if (!editing) setDraft(convo, ta.value); }, 400);
  });
  ta.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey && !isIOS && matchMedia('(pointer: fine)').matches) { e.preventDefault(); send(); } });
  async function send(silent) {
    const text = ta.value.trim();
    if (!text) return;
    mentionBox.classList.add('hidden');
    if (editing) {
      const m = editing;
      setEditing(null); ta.value = ''; autosize();
      if (text !== m.text) { const e = await E.editMessage(m, text); if (e) toast(e); }
      return;
    }
    E.sendText(convo, text, reply, silent);
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
  // 1.29: hold (or right-click) the send key: «ارسال بی‌صدا» / «ارسال زمان‌دار»
  async function sendLater(silent) {
    const text = ta.value.trim();
    if (!text) return;
    const at = await schedulePicker(saved ? 'یادآوری' : 'ارسال زمان‌دار');
    if (!at) return;
    const err = await E.scheduleText(convo, text, reply, at, silent);
    if (err) { toast(err); return; }
    ta.value = ''; autosize(); setReply(null); setDraft(convo, ''); showMic();
    toast('برای ' + fmtFull(at) + ' تنظیم شد');
  }
  const sendLong = onLongPress(sendBtn, () => {
    if (editing || !ta.value.trim() || E.reqOf(convo) === 'out') return;
    buzz(12);
    sheet(null, [
      !saved && { label: '🔕 ارسال بی‌صدا', run: () => send(true) },
      S.feats.sched && { label: saved ? '🕒 یادآوری در زمان دلخواه' : '🕒 ارسال زمان‌دار', run: () => sendLater(false) },
      S.feats.sched && !saved && { label: '🕒 زمان‌دار و بی‌صدا', run: () => sendLater(true) },
    ]);
  });
  sendBtn.addEventListener('click', (e) => { e.preventDefault(); if (sendLong()) return; send(); });
  sendBtn.addEventListener('mousedown', (e) => e.preventDefault()); // keep the keyboard open
  fileIn.addEventListener('change', async () => {
    const files = [...fileIn.files];
    fileIn.value = '';
    forceBottom = true;
    for (const f of files) { const err = await E.sendFile(convo, f, reply); if (err) toast(err); }
    setReply(null);
  });
  for (const inp of [photoIn, camIn]) inp.addEventListener('change', async () => {
    const files = [...inp.files].filter((f) => /^image\//.test(f.type));
    inp.value = '';
    if (!files.length) return;
    const compress = await photoSendBox(files);
    if (compress == null) return;
    forceBottom = true;
    for (const f of files) {
      const out = compress ? await compressPhoto(f) : f;
      const err = await E.sendFile(convo, out, reply);
      if (err) toast(err);
    }
    setReply(null);
  });
  let panelMode = pref('panelMode', 'emoji');
  let renderStk = null;
  function renderEmojis() {
    const modeBar = h('div', { class: 'panel-tabs' },
      h('button', { class: panelMode === 'emoji' ? 'on' : '', onclick: () => { panelMode = 'emoji'; setPref('panelMode', panelMode); renderEmojis(); } }, 'شکلک'),
      h('button', { class: panelMode === 'sticker' ? 'on' : '', onclick: () => { panelMode = 'sticker'; setPref('panelMode', panelMode); renderEmojis(); } }, 'استیکر'));
    if (panelMode === 'sticker') {
      const box = h('div', { class: 'stk-panel' });
      renderStk = stickerPanel(box, async (k, fx) => {
        forceBottom = true;
        if (fx) { fxLast = Date.now(); emojiPanel.classList.add('hidden'); }
        await E.sendSticker(convo, k, reply, fx); setReply(null);
        if (fx && pref('stkFx', true)) playFx(k.id, msgs);
      });
      fill(emojiPanel, modeBar, box);
      emojiPanel.classList.add('stickers');
      return;
    }
    renderStk = null;
    emojiPanel.classList.remove('stickers');
    const rec = Emoji.recent();
    const btn = (e) => h('button', { onclick: () => {
      const s = ta.selectionStart ?? ta.value.length, en = ta.selectionEnd ?? ta.value.length;
      ta.value = ta.value.slice(0, s) + e + ta.value.slice(en);
      Emoji.addRecent(e); autosize();
    } }, e);
    fill(emojiPanel, modeBar, rec.length ? [h('div', { class: 'cap' }, 'اخیر'), rec.map(btn)] : [],
      Emoji.GROUPS.map(([name, list]) => [h('div', { class: 'cap' }, name), list.split(' ').map(btn)]));
  }
  emojiBtn.addEventListener('click', () => {
    const open = emojiPanel.classList.toggle('hidden');
    if (!open) { renderEmojis(); ta.blur(); }
  });
  ta.addEventListener('focus', () => emojiPanel.classList.add('hidden'));

  /** 1.22: the newest effect sticker that came while this chat was not on screen, played once. */
  function playPending() {
    if (document.visibilityState !== 'visible' || S.openConvo !== convo) return;
    const m = E.takeFx(convo);
    if (m && m.stk && pref('stkFx', true)) playFx(m.stk.id, msgs);
  }

  const renderAll = batched(() => { renderHeader(); renderPin(); renderReq(); renderLock(); renderList(); });
  const renderListB = batched(() => renderList());
  const tick = setInterval(renderHeader, 2000);
  ta.value = draftOf(convo);
  showMic();
  renderHeader(); renderPin(); renderReq(); renderGcBar(); renderLock(); renderSched(); renderAt();
  return {
    el,
    mounted: () => { renderList(); autosize(); playPending(); },
    destroy: () => {
      clearInterval(tick); clearInterval(recTick); if (viewsTimer) clearInterval(viewsTimer); offPlayer(); S.openConvo = null;
      if (rec) { rec.cancel(); rec = null; }
      if (!editing) setDraft(convo, ta.value);
    },
    update(kind, data) {
      if (kind === 'msg') {
        if (data && data.convo !== convo) return;
        if (document.visibilityState === 'visible') E.markRead(convo);
        renderListB(); renderPin();
        if (data && data.fxPending) requestAnimationFrame(() => requestAnimationFrame(playPending));
      } else if (kind === 'progress' || kind === 'media' || kind === 'receipts' || kind === 'privacy' || (kind === 'react' && data && data.convo === convo)) renderListB();
      else if (kind === 'pins') { renderPin(); renderListB(); }
      else if (kind === 'requests') renderReq();
      else if (kind === 'scheduled') renderSched();
      else if (kind === 'visible') playPending();
      else if (kind === 'gcall' || kind === 'groups') { renderGcBar(); if (kind === 'groups') renderAll(); }
      else if (kind === 'stickers') { if (renderStk) renderStk(); renderListB(); }
      else if (kind === 'users' || kind === 'typing' || kind === 'conn' || kind === 'groups' || kind === 'avatar') renderAll();
    },
  };
}

// ---------------- profile of a contact or group ----------------
function ProfileScreen(convo) {
  const group = E.isGroup(convo);
  const body = h('div');
  const el = h('div', { class: 'scroll', style: { display: 'flex', flexDirection: 'column', overflow: 'hidden' } },
    h('div', { class: 'bar' }, h('button', { class: 'icon', title: 'بازگشت', onclick: () => history.length > 1 ? history.back() : go('#/') }, ic('back')), h('h1', null, group ? (E.isChan(convo) ? 'کانال' : 'گروه') : 'پروفایل')),
    h('div', { class: 'scroll' }, body));
  const fp = h('div', { class: 'mono' });
  const render = batched(() => {
    if (group && E.isUserGroup(convo)) { renderUserGroup(); return; }
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
  // 1.20: a group a user made: description, members with roles, invite link, owner/admin actions
  let details = null, loading = false;
  async function loadDetails() {
    const g = E.groupOf(convo);
    if (!g || loading) return;
    loading = true;
    const d = await E.groupDetails(g.id);
    loading = false;
    if (!d.error) { details = d; render(); }
  }
  function renderUserGroup() {
    const g = E.groupOf(convo);
    if (!g) { fill(body, h('div', { class: 'empty' }, 'عضو این گروه نیستید')); return; }
    if (!details || details.id !== g.id) loadDetails();
    const manage = g.role === 'owner' || g.role === 'admin', own = g.role === 'owner';
    const chan = g.kind === 'chan', W = chan ? 'کانال' : 'گروه', count = chan ? g.count || g.members.length : g.members.length;
    const roles = new Map(((details && details.roles) || []).map((r) => [r.username, r.role]));
    for (const a of g.admins || []) if (!roles.has(a)) roles.set(a, a === g.owner ? 'owner' : 'admin');
    const RL = { owner: 'مالک', admin: 'مدیر' };
    const order = (u) => (roles.get(u) === 'owner' ? 0 : roles.get(u) === 'admin' ? 1 : 2);
    const members = [...g.members].sort((a, b) => order(a) - order(b) || E.nameOf(a).localeCompare(E.nameOf(b), 'fa'));
    const act = async (fn, okText) => { const r = await E.groupAction(fn); if (r.error) toast(r.error); else { if (okText) toast(okText); details = null; render(); } return r; };
    const av = avatar(convo, 'lg');
    const url = E.groupAvatarUrl(convo);
    if (url) av.addEventListener('click', () => viewer(url));
    const photoIn = h('input', { type: 'file', accept: 'image/*', class: 'hidden', onchange: async () => {
      const f = photoIn.files[0]; photoIn.value = '';
      if (!f) return;
      try { const webp = await toAvatar(f); await act((a) => a.uploadGroupAvatar(g.id, webp)); } catch { toast('این عکس خوانده نشد'); }
    } });
    const memberRow = (u) => h('button', { class: 'row', onclick: () => memberSheet(u) },
      avatarWithDot(u, 'sm'), h('div', { class: 'mid' }, h('div', { class: 'top' }, h('div', { class: 'name' }, u === S.me ? 'شما' : E.nameOf(u)), roles.get(u) ? h('span', { class: 'role' }, RL[roles.get(u)]) : null), h('div', { class: 'prev' }, '@' + u)));
    function memberSheet(u) {
      const r = roles.get(u) || 'member';
      const items = [
        u !== S.me && { label: '💬 پیام / پروفایل', run: () => go('#/p/' + encodeURIComponent(u)) },
        own && u !== S.me && r === 'member' && { label: '⭐ مدیر ' + W + ' شود', run: () => act((a) => a.ugroupOp('/' + g.id + '/role', { user: u, role: 'admin' })) },
        own && u !== S.me && r === 'admin' && { label: 'برداشتن مدیری', run: () => act((a) => a.ugroupOp('/' + g.id + '/role', { user: u, role: 'member' })) },
        own && u !== S.me && { label: '👑 مالکیت ' + W + ' به او برسد', run: async () => {
          if (await confirmBox('انتقال مالکیت', 'مالکیت «' + g.name + '» به ' + E.nameOf(u) + ' برسد؟ شما مدیر ' + W + ' می‌مانید.', 'انتقال')) act((a) => a.ugroupOp('/' + g.id + '/transfer', { user: u }), 'مالکیت منتقل شد');
        } },
        manage && u !== S.me && r !== 'owner' && (own || r === 'member') && { label: 'بیرون کردن از ' + W, danger: true, run: async () => {
          if (await confirmBox('بیرون کردن', E.nameOf(u) + ' از ' + W + ' بیرون شود؟ با لینک دعوت برنمی‌گردد؛ فقط مدیران می‌توانند دوباره اضافه‌اش کنند.' + (chan ? ' پست‌های بعدی با کلید تازه‌ای رمز می‌شوند که او ندارد.' : ''), 'بیرون کردن', true)) act((a) => a.ugroupOp('/' + g.id + '/remove', { user: u }));
        } },
      ];
      if (items.some(Boolean)) sheet(E.nameOf(u) + ' · @' + u, items);
    }
    const link = details && details.invite_link;
    fill(body,
      h('div', { class: 'profile-head' }, av, h('h2', null, g.name), h('div', { class: 'u' }, (chan ? '📢 کانال · ' : '') + faNum(count) + ' عضو' + (g.frozen ? ' · معلق' : ''))),
      g.about ? h('div', { class: 'hint', dir: 'auto', style: { whiteSpace: 'pre-wrap' } }, g.about) : null,
      h('div', { class: 'actions' },
        h('button', { class: 'btn', onclick: () => go('#/c/' + encodeURIComponent(convo)) }, chan ? '📢 پست‌ها' : '💬 گفتگو'),
        g.call ? h('button', { class: 'btn flat', onclick: () => groupCall(convo) }, '📞 تماس گروهی') : null),
      manage && !g.frozen ? [
        h('div', { class: 'section' }, 'مدیریت ' + W),
        h('button', { class: 'row', onclick: () => groupEditBox(g) }, h('div', { class: 'mid' }, h('div', { class: 'name' }, '✏️ نام و توضیح ' + W))),
        h('button', { class: 'row', onclick: () => sheet('عکس ' + W, [{ label: '🖼 انتخاب عکس', run: () => photoIn.click() }, g.avatar_ver > 0 && { label: 'حذف عکس', danger: true, run: () => act((a) => a.deleteGroupAvatar(g.id)) }]) }, h('div', { class: 'mid' }, h('div', { class: 'name' }, '🖼 عکس ' + W))),
        h('button', { class: 'row', onclick: async () => {
          const can = S.users.filter((u) => u.dm && !u.req && u.username !== S.me && !g.members.includes(u.username)).map((u) => u.username);
          if (!can.length) { toast('مخاطب دیگری برای افزودن ندارید؛ لینک دعوت بفرستید'); return; }
          const pick = await pickPeople('افزودن عضو', can, 'افزودن', 0);
          if (pick && pick.length) act((a) => a.ugroupOp('/' + g.id + '/add', { users: pick }), 'اضافه شد');
        } }, h('div', { class: 'mid' }, h('div', { class: 'name' }, '➕ افزودن عضو از مخاطبان'))),
        h('div', { class: 'section' }, 'لینک دعوت'),
        link ? h('div', { class: 'hint' }, h('div', { class: 'mono', style: { direction: 'ltr', wordBreak: 'break-all', userSelect: 'all' } }, link),
          h('div', { class: 'actions', style: { justifyContent: 'flex-start' } },
            h('button', { class: 'btn sm', onclick: async () => { try { await navigator.clipboard.writeText(link); toast('لینک کپی شد'); } catch { toast('لینک را انتخاب و کپی کنید'); } } }, 'کپی'),
            navigator.share ? h('button', { class: 'btn sm flat', onclick: () => navigator.share({ title: g.name, text: 'دعوت به ' + W + ' «' + g.name + '» در سپن', url: link }).catch(() => { }) }, 'اشتراک') : null,
            h('button', { class: 'btn sm flat', onclick: () => showQr(g) }, 'QR'),
            h('button', { class: 'btn sm flat', onclick: () => act((a) => a.ugroupOp('/' + g.id + '/invite', {}), 'لینک تازه ساخته شد؛ لینک قبلی دیگر کار نمی‌کند') }, 'لینک تازه'),
            h('button', { class: 'btn sm flat danger', onclick: () => act((a) => a.ugroupOp('/' + g.id + '/invite', { revoke: true }), 'لینک باطل شد') }, 'باطل کردن')))
          : h('button', { class: 'row', onclick: () => act((a) => a.ugroupOp('/' + g.id + '/invite', {})) }, h('div', { class: 'mid' }, h('div', { class: 'name' }, '🔗 ساختن لینک دعوت'), h('div', { class: 'prev' }, 'هر کس لینک را داشته باشد می‌تواند عضو شود'))),
      ] : null,
      own && !g.frozen && chan ? [
        h('div', { class: 'section' }, 'تنظیمات مالک'),
        h('label', { class: 'row toggle' }, h('div', { class: 'mid' }, h('div', { class: 'name' }, 'امضای نویسنده زیر پست‌ها'), h('div', { class: 'prev' }, 'نام مدیری که پست را گذاشته زیر آن دیده شود')),
          h('input', { type: 'checkbox', checked: !!g.sign, onchange: (e) => act((a) => a.ugroupOp('/' + g.id + '/edit', { sign: e.target.checked })) })),
      ] : null,
      own && !g.frozen && !chan ? [
        h('div', { class: 'section' }, 'تنظیمات مالک'),
        h('label', { class: 'row toggle' }, h('div', { class: 'mid' }, h('div', { class: 'name' }, 'فقط مدیران پیام بفرستند')),
          h('input', { type: 'checkbox', checked: !!g.admins_only, onchange: (e) => act((a) => a.ugroupOp('/' + g.id + '/edit', { admins_only: e.target.checked })) })),
        h('label', { class: 'row toggle' }, h('div', { class: 'mid' }, h('div', { class: 'name' }, 'تماس گروهی در این گروه')),
          h('input', { type: 'checkbox', checked: !!g.call_on, onchange: (e) => act((a) => a.ugroupOp('/' + g.id + '/edit', { call_on: e.target.checked })) })),
      ] : null,
      h('div', { class: 'section' }, chan && !manage ? 'مدیران کانال' : 'اعضا (' + faNum(count) + ')'),
      chan && !manage ? h('div', { class: 'hint' }, 'اعضای کانال یکدیگر را نمی‌بینند.') : null,
      members.map(memberRow),
      h('div', { class: 'actions' },
        h('button', { class: 'btn danger', onclick: async () => {
          const t = own ? 'شما مالک ' + W + ' هستید. اگر بروید، مالکیت به قدیمی‌ترین مدیر می‌رسد (اگر مدیری نباشد ' + W + ' معلق می‌شود).' : 'از «' + g.name + '» بیرون می‌روید.';
          if (!(await confirmBox('ترک ' + W, t, 'ترک ' + W, true))) return;
          const r = await act((a) => a.ugroupOp('/' + g.id + '/leave'));
          if (!r.error) go('#/');
        } }, 'ترک ' + W),
        own ? h('button', { class: 'btn danger', onclick: async () => {
          if (!(await confirmBox('حذف ' + W, '«' + g.name + '» و همهٔ پیام‌هایش برای همهٔ اعضا پاک می‌شود. این کار برگشت ندارد.', 'حذف برای همیشه', true))) return;
          const r = await act((a) => a.ugroupOp('/' + g.id + '/delete'));
          if (!r.error) go('#/');
        } }, 'حذف ' + W) : null),
      photoIn);
  }
  render();
  return { el, update: (k) => { if (k === 'users' || k === 'groups' || k === 'avatar') render(); } };
}

// ---------------- 1.20: making and joining groups ----------------
function newMenu() {
  const u = (S.meInfo && S.meInfo.ugroups) || null;
  sheet(null, [
    { label: '💬 گفتگوی تازه', run: () => go('#/new') },
    u && u.on && { label: '👥 گروه تازه' + (u.limit ? ' (' + faNum(u.owned) + ' از ' + faNum(u.limit) + ')' : ''), run: () => newGroupBox(false) },
    u && u.chan_on && { label: '📢 کانال تازه' + (u.limit ? ' (' + faNum(u.owned) + ' از ' + faNum(u.limit) + ')' : ''), run: () => newGroupBox(true) },
    u && (u.on || u.chan_on) && { label: '🔗 پیوستن با لینک دعوت', run: joinBox },
  ]);
}
function groupEditBox(g, newChan) {
  const W = (g ? g.kind === 'chan' : newChan) ? 'کانال' : 'گروه';
  const name = h('input', { type: 'text', value: g ? g.name : '', placeholder: 'نام ' + W, maxlength: 40 });
  const about = h('textarea', { rows: 3, placeholder: 'توضیح (اختیاری)', maxlength: 255, dir: 'auto' });
  about.value = g ? g.about || '' : '';
  return new Promise((resolve) => {
    const close = (r) => { v.remove(); resolve(r); };
    const ok = h('button', { class: 'btn', onclick: async () => {
      if (!name.value.trim()) { toast('نام ' + W + ' را بنویسید'); return; }
      if (!g) { close({ name: name.value.trim(), about: about.value.trim() }); return; }
      const r = await E.groupAction((a) => a.ugroupOp('/' + g.id + '/edit', { name: name.value.trim(), about: about.value.trim() }));
      if (r.error) toast(r.error); else close(true);
    } }, g ? 'ذخیره' : 'بعدی');
    const v = h('div', { class: 'veil', onclick: (e) => { if (e.target === v) close(null); } },
      h('div', { class: 'dialog' }, h('h3', null, g ? 'ویرایش ' + W : W + ' تازه'), h('div', { class: 'form', style: { padding: 0 } }, name, about),
        h('div', { class: 'btns' }, h('button', { class: 'btn flat', onclick: () => close(null) }, 'انصراف'), ok)));
    document.body.append(v);
    name.focus();
  });
}
async function newGroupBox(chan) {
  const u = S.meInfo && S.meInfo.ugroups;
  if (u && u.owned >= u.limit) { toast(u.limit ? 'به حداکثر ' + faNum(u.limit) + ' گروه و کانالی که می‌توانید بسازید رسیده‌اید' : 'مدیر سرور ساختن گروه و کانال را برای شما بسته است'); return; }
  const info = await groupEditBox(null, chan);
  if (!info) return;
  const can = S.users.filter((x) => x.dm && !x.req && x.username !== S.me).map((x) => x.username);
  let members = [];
  if (can.length) {
    const max = chan ? (u && u.chan_max) : (u && u.max_members);
    members = await pickPeople('اعضای «' + info.name + '»', can, chan ? 'ساختن کانال' : 'ساختن گروه', (max ? max - 1 : 0), [], true);
    if (members === null) return;
  }
  const r = await E.groupAction((a) => a.ugroupOp('/create', { ...info, members, ...(chan ? { kind: 'chan' } : {}) }));
  if (r.error) { toast(r.error); return; }
  await E.refreshGroups().catch(() => { });
  go('#/c/' + encodeURIComponent(r.group.key));
}
function tokenOf(text) {
  const t = String(text || '').trim();
  const m = /join=([A-Za-z0-9_-]{12,32})/.exec(t) || /^([A-Za-z0-9_-]{12,32})$/.exec(t);
  return m ? m[1] : null;
}
async function joinBox() {
  const inp = h('input', { type: 'text', placeholder: 'لینک دعوت را اینجا بگذارید', style: { direction: 'ltr' } });
  const t = await new Promise((resolve) => {
    const close = (r) => { v.remove(); resolve(r); };
    const v = h('div', { class: 'veil', onclick: (e) => { if (e.target === v) close(null); } },
      h('div', { class: 'dialog' }, h('h3', null, 'پیوستن با لینک دعوت'), h('div', { class: 'form', style: { padding: 0 } }, inp),
        h('div', { class: 'btns' }, h('button', { class: 'btn flat', onclick: () => close(null) }, 'انصراف'),
          h('button', { class: 'btn', onclick: () => { const k = tokenOf(inp.value); if (!k) { toast('این لینک دعوت درست نیست'); return; } close(k); } }, 'ادامه'))));
    document.body.append(v);
    inp.focus();
  });
  if (t) joinByLink(t);
}
async function joinByLink(t) {
  let p;
  try { p = await E.groupAction((a) => a.joinPreview(t)); } catch (e) { p = { error: E.errText(e) }; }
  if (p.error) { toast(p.error); return; }
  if (p.member) { go('#/c/' + encodeURIComponent(p.key)); return; }
  const W = p.kind === 'chan' ? 'کانال' : 'گروه';
  if (!(await confirmBox('پیوستن به ' + W, (p.kind === 'chan' ? '📢 ' : '') + '«' + p.name + '» · ' + faNum(p.count) + ' عضو' + (p.about ? ' — ' + p.about : ''), 'پیوستن'))) return;
  const r = await E.groupAction((a) => a.joinGroup(t));
  if (r.error) { toast(r.error); return; }
  await E.refreshGroups().catch(() => { });
  go('#/c/' + encodeURIComponent(r.group.key));
}
async function showQr(g) {
  let url;
  try { url = URL.createObjectURL(await api.groupQr(g.id)); } catch { toast('QR ساخته نشد'); return; }
  const v = h('div', { class: 'veil', onclick: () => { v.remove(); URL.revokeObjectURL(url); } },
    h('div', { class: 'dialog', style: { textAlign: 'center' } }, h('h3', null, g.name), h('img', { src: url, style: { width: '260px', maxWidth: '100%', background: '#fff', padding: '10px', borderRadius: '12px' } }),
      h('p', null, 'با دوربین گوشی این را بخوانید تا لینک دعوت باز شود')));
  document.body.append(v);
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
  // 1.28: settings in rounded cards, each with a coloured icon
  const card = (title, icon, color, ...kids) => h('div', { class: 'scard' }, h('div', { class: 'sh' }, h('span', { class: 'sico', style: { background: color } }, ic(icon, 18)), title), kids);
  const accentRow = h('div', { class: 'accents' });
  const renderAccents = () => fill(accentRow, ACCENTS.map(([n, c], i) => h('button', { class: 'acc' + (pref('accent', 0) === i ? ' on' : ''), title: n, 'aria-label': n,
    onclick: () => { buzz(); setPref('accent', i); applyLook(); renderAccents(); } }, h('span', { style: { background: c } }, pref('accent', 0) === i ? ic('check', 20) : null))));
  renderAccents();
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
    h('div', { class: 'bar' }, h('button', { class: 'icon', title: 'بازگشت', onclick: () => go('#/') }, ic('back')), h('h1', null, 'تنظیمات')),
    h('div', { class: 'scroll settings' },
      h('div', { class: 'profile-head' }, avBox, photoIn, h('div', { class: 'u', title: 'کپی لینک', style: { cursor: 'pointer' }, onclick: () => {
        const link = location.origin + '/@' + S.me;
        navigator.clipboard.writeText(link).then(() => toast('لینک شما کپی شد: ' + link), () => toast(link));
      } }, '@' + S.me + ' ', ic('link', 16))),
      h('form', { class: 'form', onsubmit: async (e) => {
        e.preventDefault();
        const err = await E.saveProfile(name.value.trim(), bio.value.trim());
        msg.className = err ? 'err' : 'ok'; msg.textContent = err || 'ذخیره شد';
      } }, h('div', { class: 'scard', style: { margin: '0' } }, h('div', { class: 'sh' }, h('span', { class: 'sico', style: { background: '#2A73C9' } }, ic('person', 18)), 'حساب'),
        h('div', { class: 'form' }, h('div', { class: 'field' }, h('label', null, 'نام نمایشی'), name), h('div', { class: 'field' }, h('label', null, 'دربارهٔ من'), bio), msg, h('button', { class: 'btn', type: 'submit' }, 'ذخیرهٔ پروفایل')))),
      card('ظاهر', 'palette', '#8E6CD8',
        setting('رنگ اصلی', null, null), accentRow,
        setting('پوسته', null, select('theme', 'system', [['system', 'مثل گوشی'], ['light', 'روشن'], ['dark', 'تیره']], applyLook)),
        setting('پس‌زمینهٔ طرح‌دار گفتگو', 'اگر خاموش کنید، پس‌زمینه ساده می‌شود', (() => { const c = toggle('wallpaper', true); c.addEventListener('change', applyLook); return c; })()),
        setting('اندازهٔ متن', null, select('fontSize', 16, [[14, 'کوچک'], [16, 'معمولی'], [18, 'بزرگ'], [20, 'خیلی بزرگ']], applyLook))),
      card('استیکر', 'smile', '#F5A623',
        setting('استیکرهای من', 'ساختن پک، افزودن عکس یا فایل zip، مرتب‌کردن', h('button', { class: 'btn sm flat', onclick: () => go('#/stickers') }, 'باز کردن'))),
      card('اعلان‌ها', 'bell', '#E5534B',
        setting('صدای پیام تازه', 'وقتی سپن باز است', toggle('sound', true)),
        setting('نمایش افکت استیکر', 'استیکری که با نگه‌داشتن فرستاده شود، تمام‌صفحه می‌آید', toggle('stkFx', true)),
        pushBox),
      // 1.15: only for users the admin allowed to choose the call path
      S.meInfo.call_route ? card('تماس', 'call', '#43A047',
        setting('مسیر پیش‌فرض تماس', 'تماس با این مسیر برقرار می‌شود (اگر طرف مقابل هم نسخهٔ تازه داشته باشد). در خود تماس هم با دکمهٔ 🔀 عوض می‌شود.', (() => {
        const sel = h('select', { onchange: () => Call.setDefaultRoute(sel.value) },
          Object.entries(Call.ROUTE_NAMES).map(([k, v]) => h('option', { value: k, selected: Call.defaultRoute() === k }, v)));
        return sel;
      })())) : null,
      card('حریم خصوصی', 'lock', '#2A73C9',
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
        setting('پیام از کسانی که در مخاطبانم نیستند', 'هر کس نام کاربری شما را بداند می‌تواند تا ۳ پیام متنی بفرستد؛ پیام‌ها در «درخواست‌ها» می‌آیند و شما می‌پذیرید، رد می‌کنید یا مسدود می‌کنید. تماس از غریبه زنگ نمی‌خورد.', (() => {
          const c = h('input', { type: 'checkbox', checked: S.privacy.allow_requests !== false, disabled: !S.meInfo.requests_on, onchange: async () => {
            c.disabled = true;
            const e = await E.setPrivacy({ allow_requests: c.checked });
            c.disabled = false;
            if (e) { toast(e); c.checked = S.privacy.allow_requests !== false; }
          } });
          return c;
        })()),
        privacy('hide_last_seen', 'نمایش آنلاین و آخرین بازدید', 'اگر خاموش کنید، دیگران فقط «اخیراً آنلاین بوده» می‌بینند و شما هم آخرین بازدید دیگران را نمی‌بینید.')),
      card('داده و فضا', 'data', '#16A085',
        setting('دانلود خودکار عکس‌ها و پیام‌های صوتی', 'تا ۲۵ مگابایت', toggle('autoImages', true)),
        setting('پاک کردن عکس‌ها و فایل‌های ذخیره‌شده', 'پیام‌ها می‌مانند', h('button', { class: 'btn sm flat', onclick: async () => { await E.clearMediaCache(); toast('پاک شد'); } }, 'پاک کردن'))),
      card('امنیت', 'shield', '#607D8B',
        setting('رمز ورود', 'رمزی که با نام کاربری وارد می‌شوید؛ بعد از تغییر، دستگاه‌های دیگرتان از حساب خارج می‌شوند', h('button', { class: 'btn sm flat', onclick: passwordBox }, 'تغییر')),
        setting('رمز کلید', 'کلید رمزنگاری روی سرور با این رمز قفل است', h('button', { class: 'btn sm flat', onclick: () => go('#/keypass') }, 'تغییر')),
        setting('ورود دستگاه تازه', 'کد یک‌بارمصرف برای ورود روی گوشی یا مرورگر دیگر، بدون پیامک و حتی بدون اینترنت', h('button', { class: 'btn sm flat', onclick: deviceCodeBox }, 'گرفتن کد')),
        h('div', { class: 'hint' }, 'کد امنیتی شما:', h('br'), myFp),
        h('div', { class: 'hint' }, 'اثر انگشت گواهی ریشهٔ سپن (SHA-256):', h('br'), caFp, h('br'), h('a', { href: '/setup' }, 'راهنمای نصب گواهی روی آیفون'))),
      card('دربارهٔ سپن', 'info', '#607D8B',
        setting('نسخهٔ وب', null, h('span', { class: 'd' }, faNum(VERSION.split('.')[0]) + '.' + faNum(VERSION.split('.')[1]) + '.' + faNum(VERSION.split('.')[2])))),
      h('div', { class: 'actions' }, h('button', { class: 'btn danger', onclick: async () => {
        if (await confirmBox('خروج از حساب', 'پیام‌های ذخیره‌شده روی این دستگاه پاک می‌شوند. خارج می‌شوید؟', 'خروج', true)) E.logout();
      } }, 'خروج از حساب'))));
  renderAv();
  return { el, update: (k) => { if (k === 'users' || k === 'avatar') renderAv(); } };
}
// (privacy switches read S.privacy when the screen opens; it is refreshed from the server on start)

/** 1.9: change the login password: the current password (or an SMS code), then the new one twice. */
function passwordBox() {
  const f = (ph, ac) => h('input', { type: 'password', placeholder: ph, autocomplete: ac, class: 'ltr' });
  const cur = f('رمز فعلی یا کد پیامکی', 'current-password'), p1 = f('رمز تازه (دست‌کم ۸ نویسه)', 'new-password'), p2 = f('تکرار رمز تازه', 'new-password');
  const err = h('div', { class: 'err' });
  const sms = h('button', { class: 'btn sm flat', type: 'button', onclick: async () => {
    sms.disabled = true;
    const e = await E.reauthSms();
    toast(e || 'کد تأیید به موبایل شما پیامک شد');
    setTimeout(() => { sms.disabled = false; }, 60000);
  } }, 'ارسال کد پیامکی');
  const ok = h('button', { class: 'btn', type: 'submit' }, 'تغییر رمز');
  const v = h('div', { class: 'veil', onclick: (e) => { if (e.target === v) v.remove(); } },
    h('form', { class: 'dialog', onsubmit: async (e) => {
      e.preventDefault();
      err.textContent = '';
      if (!cur.value) { err.textContent = 'رمز فعلی را وارد کنید'; return; }
      if (p1.value.length < 8) { err.textContent = 'رمز تازه باید دست‌کم ۸ نویسه باشد'; return; }
      if (p1.value !== p2.value) { err.textContent = 'رمز تازه و تکرار آن یکی نیستند'; return; }
      ok.disabled = true;
      const r = await E.changePassword(cur.value, p1.value);
      ok.disabled = false;
      if (r) { err.textContent = r; return; }
      v.remove();
      toast('رمز ورود عوض شد؛ دستگاه‌های دیگرتان از حساب خارج شدند');
    } }, h('h3', null, 'تغییر رمز ورود'),
      h('div', { class: 'field' }, cur), h('div', { class: 'd', style: { fontSize: '13px', color: 'var(--fg2)' } }, 'رمز فعلی را نمی‌دانید (با پیامک وارد می‌شوید)؟ ', sms),
      h('div', { class: 'field' }, p1), h('div', { class: 'field' }, p2), err,
      h('div', { class: 'btns' }, h('button', { class: 'btn flat', type: 'button', onclick: () => v.remove() }, 'انصراف'), ok)));
  document.body.append(v);
  cur.focus();
}

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

// ---------------- stickers (1.10) ----------------
const STK_MAX = 512;
const stkFavs = () => pref('stkFavs', []);
const stkRecent = () => pref('stkRecent', []);
const isFav = (id) => stkFavs().some((x) => x.id === id);
function toggleFav(k) {
  const list = stkFavs();
  setPref('stkFavs', isFav(k.id) ? list.filter((x) => x.id !== k.id) : [{ id: k.id, p: k.p, e: k.e || '' }, ...list].slice(0, 60));
  toast(isFav(k.id) ? 'به علاقه‌مندی‌ها اضافه شد ⭐' : 'از علاقه‌مندی‌ها برداشته شد');
}
function addStkRecent(k) { setPref('stkRecent', [{ id: k.id, p: k.p, e: k.e || '' }, ...stkRecent().filter((x) => x.id !== k.id)].slice(0, 30)); }

/** An <img> of a sticker that fills in when the image is loaded (from this browser or the server). */
// ---------------- 1.22: full-screen sticker effect ----------------
const FX_GAP = 5000;
let fxLast = 0, fxFlying = null;
/** true (and a toast) while the 5 seconds since the last effect have not passed. */
function fxWait() {
  const left = FX_GAP - (Date.now() - fxLast);
  if (left <= 0) return false;
  toast('⏳ ' + faNum(Math.ceil(left / 1000)) + ' ثانیه دیگر می‌توانید استیکر با افکت بفرستید');
  return true;
}
/** The newest copy of sticker id in the chat (where the effect lands). */
function fxTarget(msgs, id) {
  const all = msgs.querySelectorAll('.bubble.sticker img[data-stk="' + id + '"]');
  return all.length ? all[all.length - 1] : null;
}
/** The sticker comes up big in the middle of the screen, then shrinks into its place in the chat. */
function playFx(id, msgs) {
  if (fxFlying) return;
  fxFlying = id;
  const veil = h('div', { class: 'fx-veil' });
  const big = stickerImg(id, 'fx-stk');
  const layer = h('div', { class: 'fx-layer' }, veil, big);
  document.body.append(layer);
  const hide = () => { const t = fxTarget(msgs, id); if (t) t.style.visibility = 'hidden'; return t; };
  hide();
  let over = false;
  const done = () => { if (over) return; over = true; fxFlying = null; layer.remove(); const t = fxTarget(msgs, id); if (t) t.style.visibility = ''; };
  if (!big.animate) { setTimeout(done, 1500); return; }
  veil.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 250, fill: 'forwards' });
  big.animate([{ transform: 'scale(.2)', opacity: 0 }, { transform: 'scale(1.08)', opacity: 1, offset: 0.7 }, { transform: 'scale(1)', opacity: 1 }],
    { duration: 420, easing: 'ease-out', fill: 'forwards' });
  setTimeout(() => {
    const t = hide();
    const from = big.getBoundingClientRect();
    const to = t ? t.getBoundingClientRect() : null;
    const visible = to && to.width > 0 && to.bottom > 0 && to.top < innerHeight;
    veil.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 480, fill: 'forwards' });
    const end = visible
      ? { transform: `translate(${to.left + to.width / 2 - (from.left + from.width / 2)}px, ${to.top + to.height / 2 - (from.top + from.height / 2)}px) scale(${to.width / from.width})`, opacity: 1 }
      : { transform: 'scale(.4)', opacity: 0 };
    const a = big.animate([{ transform: 'scale(1)', opacity: 1 }, end], { duration: 480, easing: 'cubic-bezier(.4,0,.2,1)', fill: 'forwards' });
    a.onfinish = done;
    setTimeout(done, 900); // in case the animation never finishes (hidden tab)
  }, 1150);
}

function stickerImg(id, cls = 'stk') {
  const cached = E.stickerCached(id);
  if (cached === null) return h('div', { class: cls + ' gone' }, 'استیکر حذف شده');
  const img = h('img', { class: cls, alt: '', draggable: 'false', 'data-stk': id });
  if (cached) { img.src = cached; return img; }
  img.classList.add('loading');
  E.stickerUrl(id).then((u) => {
    if (u) { img.src = u; img.classList.remove('loading'); }
    else img.replaceWith(h('div', { class: cls + ' gone' }, 'استیکر حذف شده'));
  }).catch(() => { });
  return img;
}

/** The sticker half of the emoji panel: favourites, recent, then one tab per pack. */
function stickerPanel(box, onPick) {
  let tab = pref('stkTab', '');
  function render() {
    const packs = S.stickers.packs || [];
    const tabs = [];
    if (stkFavs().length) tabs.push({ key: 'fav', icon: h('span', null, '⭐'), list: stkFavs(), title: 'علاقه‌مندی‌ها' });
    if (stkRecent().length) tabs.push({ key: 'rec', icon: h('span', null, '🕓'), list: stkRecent(), title: 'اخیر' });
    for (const p of packs) if (p.stickers.length) tabs.push({ key: p.id, icon: stickerImg(p.stickers[0].id, 'stk-tab'), list: p.stickers.map((s) => ({ id: s.id, p: p.id, e: s.emoji || '' })), title: p.title });
    let cur = tabs.find((t) => t.key === tab) || tabs[0];
    fill(box,
      h('div', { class: 'stk-tabs' },
        tabs.map((t) => h('button', { class: t === cur ? 'on' : '', title: t.title, onclick: () => { tab = t.key; setPref('stkTab', tab); render(); } }, t.icon)),
        h('button', { title: 'استیکرهای من', onclick: () => go('#/stickers') }, '⚙')),
      cur ? h('div', { class: 'stk-grid' }, cur.list.map((k) => {
        const b = h('button', { onclick: () => { if (wasLong()) return; addStkRecent(k); onPick(k); } }, stickerImg(k.id));
        // 1.22: hold = send with the full-screen effect (a favourite goes at once; others get a small menu)
        const withFx = () => { if (fxWait()) return; addStkRecent(k); onPick(k, true); };
        const wasLong = onLongPress(b, () => {
          try { navigator.vibrate && navigator.vibrate(25); } catch { }
          if (isFav(k.id)) withFx();
          else sheet(null, [{ label: '✨ ارسال با افکت', run: withFx }, { label: '⭐ افزودن به علاقه‌مندی‌ها', run: () => toggleFav(k) }]);
        });
        return b;
      }))
        : h('div', { class: 'stk-empty' }, 'هنوز استیکری ندارید.', h('br'), h('button', { class: 'btn sm', onclick: () => go('#/stickers') }, 'ساختن یا افزودن استیکر')));
  }
  render();
  return render;
}

/** A pack seen from a sticker in a chat: its stickers and «add to my stickers». */
async function packSheet(packId) {
  const r = await E.stickerPack(packId);
  if (r.error) { toast(r.error); return; }
  const v = h('div', { class: 'veil', onclick: (e) => { if (e.target === v) v.remove(); } });
  const action = r.mine ? h('div', { class: 'hint' }, 'این پک شماست')
    : r.official ? h('div', { class: 'hint' }, 'پک عمومی؛ برای همه هست')
      : h('button', { class: 'btn' + (r.added ? ' flat danger' : ''), onclick: async () => {
        const x = r.added ? await E.removeStickerPack(packId) : await E.addStickerPack(packId);
        v.remove(); toast(x.error || (r.added ? 'پک برداشته شد' : 'به استیکرهای شما اضافه شد ✓'));
      } }, r.added ? 'برداشتن از استیکرهای من' : 'افزودن به استیکرهای من (' + faNum(r.stickers.length) + ')');
  v.append(h('div', { class: 'sheet' }, h('div', { class: 'st' }, r.title),
    h('div', { class: 'stk-grid' }, r.stickers.map((s) => h('div', null, stickerImg(s.id)))),
    h('div', { class: 'center', style: { padding: '10px' } }, action),
    h('button', { class: 'it', onclick: () => v.remove() }, 'بستن')));
  document.body.append(v);
}

/** Draws img into a canvas so it fits inside STK_MAX x STK_MAX (keeps the shape and the transparency). */
function fitCanvas(img) {
  const k = Math.min(1, STK_MAX / Math.max(img.naturalWidth || img.width, img.naturalHeight || img.height));
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round((img.naturalWidth || img.width) * k));
  c.height = Math.max(1, Math.round((img.naturalHeight || img.height) * k));
  c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
  return c;
}
const toBlob = (c, type, q) => new Promise((resolve) => c.toBlob(resolve, type, q));
/** WebP where the browser can make it (not Safari: there PNG, made smaller until it fits the limit). */
async function stickerBlob(canvas) {
  const max = ((S.stickers.limits && S.stickers.limits.kb) || 300) * 1024;
  for (const q of [0.9, 0.75, 0.6]) {
    const b = await toBlob(canvas, 'image/webp', q);
    if (!b || b.type !== 'image/webp') break;
    if (b.size <= max) return b;
  }
  let c = canvas;
  for (let i = 0; i < 6; i++) {
    const b = await toBlob(c, 'image/png');
    if (b && b.size <= max) return b;
    const s = document.createElement('canvas');
    s.width = Math.max(1, Math.round(c.width * 0.8)); s.height = Math.max(1, Math.round(c.height * 0.8));
    s.getContext('2d').drawImage(c, 0, 0, s.width, s.height);
    c = s;
  }
  throw new Error('too big');
}
const loadImage = (blob) => new Promise((resolve, reject) => {
  const url = URL.createObjectURL(blob);
  const i = new Image();
  i.onload = () => { URL.revokeObjectURL(url); resolve(i); };
  i.onerror = () => { URL.revokeObjectURL(url); reject(new Error('bad image')); };
  i.src = url;
});

/** The image files inside a .zip (stored or deflated entries), read in the browser. */
async function unzipImages(file) {
  const buf = new Uint8Array(await file.arrayBuffer());
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) throw new Error('not a zip');
  const count = dv.getUint16(eocd + 10, true);
  let p = dv.getUint32(eocd + 16, true);
  const out = [];
  const dec = new TextDecoder();
  for (let n = 0; n < count && p + 46 <= buf.length; n++) {
    if (dv.getUint32(p, true) !== 0x02014b50) break;
    const method = dv.getUint16(p + 10, true), csize = dv.getUint32(p + 20, true);
    const nlen = dv.getUint16(p + 28, true), xlen = dv.getUint16(p + 30, true), clen = dv.getUint16(p + 32, true);
    const local = dv.getUint32(p + 42, true);
    const name = dec.decode(buf.subarray(p + 46, p + 46 + nlen));
    p += 46 + nlen + xlen + clen;
    if (!/\.(png|webp|jpe?g|gif)$/i.test(name) || /(^|\/)(__MACOSX|\.)/.test(name)) continue;
    const start = local + 30 + dv.getUint16(local + 26, true) + dv.getUint16(local + 28, true);
    const data = buf.subarray(start, start + csize);
    let bytes;
    if (method === 0) bytes = data;
    else if (method === 8 && typeof DecompressionStream === 'function') bytes = new Uint8Array(await new Response(new Blob([data]).stream().pipeThrough(new DecompressionStream('deflate-raw'))).arrayBuffer());
    else continue;
    out.push({ name, blob: new Blob([bytes]) });
  }
  out.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
  return out;
}

/** Adds image files (and the images inside .zip files) to a pack, each fitted to 512x512. */
async function importStickers(packId, files, done) {
  let list = [];
  for (const f of files) {
    if (/\.zip$/i.test(f.name) || f.type === 'application/zip') {
      try { list = list.concat(await unzipImages(f)); } catch { toast('فایل zip خوانده نشد'); }
    } else list.push({ name: f.name, blob: f });
  }
  if (!list.length) { toast('عکسی پیدا نشد'); return; }
  let ok = 0, err = null;
  for (let i = 0; i < list.length; i++) {
    toast('در حال افزودن ' + faNum(i + 1) + ' از ' + faNum(list.length) + '…');
    try {
      const blob = await stickerBlob(fitCanvas(await loadImage(list[i].blob)));
      const r = await E.addSticker(packId, blob, '');
      if (r.error) { err = r.error; if (/پر است|خاموش/.test(r.error)) break; } else ok++;
    } catch { err = 'عکس «' + list[i].name + '» باز نشد'; }
  }
  toast(faNum(ok) + ' استیکر اضافه شد' + (err ? ' · ' + err : ''));
  if (done) done();
}

/** Makes one sticker from a photo: square or round crop, zoom and move, an optional caption. */
function stickerMaker(packId, file, done) {
  loadImage(file).then((img) => {
    const V = 280; // preview size
    let round = false, zoom = 1, ox = 0, oy = 0, text = '';
    const cv = h('canvas', { class: 'stk-maker' });
    cv.width = cv.height = V;
    const draw = (g, size) => {
      const base = Math.max(size / img.naturalWidth, size / img.naturalHeight) * zoom;
      const w = img.naturalWidth * base, hh = img.naturalHeight * base;
      g.clearRect(0, 0, size, size);
      g.save();
      if (round) { g.beginPath(); g.arc(size / 2, size / 2, size / 2, 0, Math.PI * 2); g.clip(); }
      g.drawImage(img, (size - w) / 2 + ox * size / V, (size - hh) / 2 + oy * size / V, w, hh);
      g.restore();
      if (text) {
        const fs = Math.round(size * 0.11);
        g.font = 'bold ' + fs + 'px Vazirmatn, Tahoma, sans-serif';
        g.textAlign = 'center'; g.textBaseline = 'bottom'; g.direction = 'rtl';
        g.lineJoin = 'round'; g.lineWidth = fs * 0.18; g.strokeStyle = '#000'; g.fillStyle = '#fff';
        g.strokeText(text, size / 2, size - size * 0.04, size * 0.94);
        g.fillText(text, size / 2, size - size * 0.04, size * 0.94);
      }
    };
    const redraw = () => draw(cv.getContext('2d'), V);
    let drag = null;
    cv.addEventListener('pointerdown', (e) => { drag = { x: e.clientX - ox, y: e.clientY - oy }; cv.setPointerCapture(e.pointerId); });
    cv.addEventListener('pointermove', (e) => { if (!drag) return; ox = e.clientX - drag.x; oy = e.clientY - drag.y; redraw(); });
    cv.addEventListener('pointerup', () => { drag = null; });
    const zoomIn = h('input', { type: 'range', min: '1', max: '4', step: '0.05', value: '1', oninput: () => { zoom = +zoomIn.value; redraw(); } });
    const shape = h('select', { onchange: () => { round = shape.value === 'r'; redraw(); } }, h('option', { value: 's' }, 'مربع'), h('option', { value: 'r' }, 'دایره'));
    const cap = h('input', { type: 'text', placeholder: 'متن روی استیکر (اختیاری)', maxLength: 30, dir: 'auto', oninput: () => { text = cap.value.trim(); redraw(); } });
    const emo = h('input', { type: 'text', placeholder: 'ایموجی (اختیاری) مثلاً 😂', maxLength: 8, style: { width: '100%' } });
    const v = h('div', { class: 'veil' });
    const save = h('button', { class: 'btn', onclick: async () => {
      save.disabled = true;
      try {
        const out = document.createElement('canvas');
        out.width = out.height = STK_MAX;
        draw(out.getContext('2d'), STK_MAX);
        const r = await E.addSticker(packId, await stickerBlob(out), emo.value.trim());
        if (r.error) { toast(r.error); save.disabled = false; return; }
        v.remove(); toast('استیکر ساخته شد ✓'); if (done) done();
      } catch { toast('ساختن استیکر نشد'); save.disabled = false; }
    } }, 'ذخیره');
    v.append(h('div', { class: 'dialog' }, h('h3', null, 'ساخت استیکر'),
      h('div', { class: 'center' }, cv), h('div', { class: 'hint' }, 'عکس را بکشید تا جابه‌جا شود.'),
      h('div', { class: 'field' }, h('label', null, 'بزرگ‌نمایی'), zoomIn),
      h('div', { class: 'field' }, h('label', null, 'شکل'), shape),
      h('div', { class: 'field' }, cap), h('div', { class: 'field' }, emo),
      h('div', { class: 'btns' }, h('button', { class: 'btn flat', onclick: () => v.remove() }, 'انصراف'), save)));
    document.body.append(v);
    redraw();
  }).catch(() => toast('این عکس باز نشد'));
}

/** Settings › استیکرهای من: the packs in my panel; own packs open in StickerPackScreen. */
function StickersScreen() {
  const body = h('div', { class: 'scroll' });
  async function newPack() {
    const title = prompt('نام پک تازه:');
    if (!title || !title.trim()) return;
    const r = await E.createStickerPack(title.trim());
    if (r.error) toast(r.error); else go('#/stickers/' + r.r.id);
  }
  async function move(id, d) {
    const ids = S.stickers.packs.filter((p) => !p.official).map((p) => p.id);
    const i = ids.indexOf(id), j = i + d;
    if (i < 0 || j < 0 || j >= ids.length) return;
    [ids[i], ids[j]] = [ids[j], ids[i]];
    const r = await E.orderStickerPacks(ids); if (r.error) toast(r.error);
  }
  function render() {
    const st = S.stickers;
    const own = st.packs.filter((p) => !p.official);
    const row = (p) => h('div', { class: 'row', onclick: () => (p.mine ? go('#/stickers/' + p.id) : packSheet(p.id)) },
      p.stickers.length ? stickerImg(p.stickers[0].id, 'stk-tab') : h('div', { class: 'stk-tab' }, '🎭'),
      h('div', { class: 'mid' }, h('div', { class: 'top' }, h('span', { class: 'name' }, p.title)),
        h('div', { class: 'sub' }, h('span', { class: 'prev' }, faNum(p.stickers.length) + ' استیکر · ' + (p.official ? 'عمومی' : p.mine ? 'ساختهٔ شما' : 'افزوده‌شده')))),
      p.official ? null : [
        h('button', { class: 'icon', title: 'بالا', onclick: (e) => { e.stopPropagation(); move(p.id, -1); } }, '▲'),
        h('button', { class: 'icon', title: 'پایین', onclick: (e) => { e.stopPropagation(); move(p.id, 1); } }, '▼')]);
    fill(body,
      st.create ? h('div', { class: 'actions' }, h('button', { class: 'btn', onclick: newPack }, '➕ ساختن پک تازه')) : h('div', { class: 'hint' }, 'مدیر سرور ساختن استیکر را خاموش کرده است؛ پک‌های عمومی و پک‌هایی که دیگران فرستاده‌اند در دسترس‌اند.'),
      own.length ? [h('div', { class: 'section' }, 'پک‌های من'), own.map(row)] : null,
      st.packs.some((p) => p.official) ? [h('div', { class: 'section' }, 'پک‌های عمومی'), st.packs.filter((p) => p.official).map(row)] : null,
      h('div', { class: 'hint' }, 'برای افزودن پک کسی دیگر، روی استیکری که فرستاده بزنید و «نمایش پک» را انتخاب کنید. با نگه داشتن یک استیکر در پنل، به علاقه‌مندی‌ها اضافه یا از آن برداشته می‌شود.'));
  }
  const el = h('div', { style: { display: 'flex', flexDirection: 'column', height: '100%' } },
    h('div', { class: 'bar' }, h('button', { class: 'icon', title: 'بازگشت', onclick: () => history.back() }, ic('back')), h('h1', null, 'استیکرهای من')), body);
  render();
  E.refreshStickers().catch(() => { });
  return { el, update: (k) => { if (k === 'stickers') render(); } };
}

/** One of my packs: add (make from a photo / import files or a zip), delete stickers, rename, delete. */
function StickerPackScreen(id) {
  const body = h('div', { class: 'scroll' });
  const title = h('h1');
  const photoIn = h('input', { type: 'file', accept: 'image/*', class: 'hidden', onchange: () => { const f = photoIn.files[0]; photoIn.value = ''; if (f) stickerMaker(id, f); } });
  const filesIn = h('input', { type: 'file', multiple: true, accept: 'image/png,image/webp,image/jpeg,.zip,application/zip', class: 'hidden', onchange: () => { const f = [...filesIn.files]; filesIn.value = ''; if (f.length) importStickers(id, f); } });
  const pack = () => S.stickers.packs.find((p) => p.id === id);
  function render() {
    const p = pack();
    if (!p) { fill(body, h('div', { class: 'empty' }, 'این پک پیدا نشد')); return; }
    title.textContent = p.title;
    const lim = S.stickers.limits || {};
    fill(body,
      h('div', { class: 'actions' },
        h('button', { class: 'btn', onclick: () => photoIn.click() }, '✂ ساخت از عکس'),
        h('button', { class: 'btn flat', onclick: () => filesIn.click() }, '⤒ افزودن فایل‌ها یا zip')),
      h('div', { class: 'hint' }, faNum(p.stickers.length) + ' از ' + faNum(lim.per_pack || 120) + ' استیکر · هر استیکر حداکثر ' + faNum(lim.kb || 300) + ' کیلوبایت. عکس‌های PNG و WebP شفاف، شفاف می‌مانند. برای حذف، روی استیکر بزنید.'),
      h('div', { class: 'stk-grid' }, p.stickers.map((s) => h('button', { onclick: () => sheet(s.emoji || null, [
        { label: 'حذف این استیکر', danger: true, run: async () => { const r = await E.deleteSticker(s.id); if (r.error) toast(r.error); } },
      ]) }, stickerImg(s.id)))),
      h('div', { class: 'actions' },
        h('button', { class: 'btn flat', onclick: async () => { const t = prompt('نام تازهٔ پک:', p.title); if (t && t.trim()) { const r = await E.renameStickerPack(id, t.trim()); if (r.error) toast(r.error); } } }, 'تغییر نام'),
        h('button', { class: 'btn flat danger', onclick: async () => {
          if (!(await confirmBox('حذف پک', 'پک «' + p.title + '» برای همه حذف می‌شود و استیکرهایی که قبلاً فرستاده شده‌اند «استیکر حذف شده» نشان داده می‌شوند.', 'حذف', true))) return;
          const r = await E.deleteStickerPack(id); if (r.error) toast(r.error); else go('#/stickers');
        } }, 'حذف پک')),
      photoIn, filesIn);
  }
  const el = h('div', { style: { display: 'flex', flexDirection: 'column', height: '100%' } },
    h('div', { class: 'bar' }, h('button', { class: 'icon', title: 'بازگشت', onclick: () => go('#/stickers') }, ic('back')), title), body);
  render();
  return { el, update: (k) => { if (k === 'stickers') render(); } };
}

// ---------------- call screen (overlay above everything) ----------------
// ---------------- 1.19: group calls ----------------
/** 1.28: round call buttons with a picture and a caption under them; the green «answer» one pulses */
const CALL_IC = { '✕': 'callEnd', '📞': 'call', '🎥': 'video', '🎙': 'mic', '🔇': 'micOff', '📷': 'video', '🚫': 'videoOff', '🚫📷': 'videoOff', '🔄': 'flipCamera', '👤+': 'personAdd', '✋': 'hand', '😀': 'smile' };
function callBtn(label, cls, fn, t) {
  const b = h('button', { class: 'cb ' + cls + (cls === 'green' ? ' pulse' : ''), title: t, 'aria-label': t, onclick: () => { buzz(); fn(); } }, CALL_IC[label] ? ic(CALL_IC[label], 28) : label);
  return h('div', { class: 'cbw' }, b, h('span', null, t));
}
/** 1.28: bottom bar: chats (with the unread count), calls, settings */
function bottomNav(cur) {
  const badge = h('span', { class: 'badge hidden' });
  const item = (key, icon, label, hash, extra) => h('button', { class: 'bi' + (cur === key ? ' on' : ''), onclick: () => { if (cur !== key) { buzz(); go(hash); } } },
    h('span', { class: 'bic' }, ic(icon, 24), extra), h('span', { class: 'bl' }, label));
  const el = h('nav', { class: 'bnav' }, item('chats', 'chat', 'گفتگوها', '#/', badge), item('calls', 'call', 'تماس‌ها', '#/calls'), item('settings', 'gear', 'تنظیمات', '#/settings'));
  const update = () => {
    const n = E.summaries().reduce((a, x) => a + (x.unread || 0), 0);
    badge.textContent = n > 99 ? '+' + faNum(99) : faNum(n);
    badge.classList.toggle('hidden', !n);
  };
  update();
  return { el, update };
}

/** Picks people from a list (checkboxes); resolves to the chosen usernames, or null. */
function pickPeople(title, names, okLabel, max, pre = [], allowEmpty = false) {
  return new Promise((resolve) => {
    const picked = new Set(pre);
    const list = h('div', { class: 'picklist' });
    const q = h('input', { type: 'text', placeholder: 'جستجو…', oninput: () => render() });
    const ok = h('button', { class: 'btn', onclick: () => close([...picked]) }, okLabel);
    const close = (r) => { v.remove(); resolve(r); };
    function render() {
      const t = q.value.trim().toLowerCase();
      ok.disabled = !picked.size && !allowEmpty;
      fill(list, names.filter((u) => !t || E.nameOf(u).toLowerCase().includes(t) || u.includes(t)).map((u) => {
        const cb = h('input', { type: 'checkbox', checked: picked.has(u), onchange: () => {
          if (cb.checked) { if (max && picked.size >= max) { cb.checked = false; toast('حداکثر ' + faNum(max) + ' نفر'); return; } picked.add(u); } else picked.delete(u);
          ok.disabled = !picked.size && !allowEmpty;
        } });
        return h('label', { class: 'pick' }, cb, avatar(u, 'sm'), h('span', null, E.nameOf(u)));
      }));
    }
    const v = h('div', { class: 'veil', onclick: (e) => { if (e.target === v) close(null); } },
      h('div', { class: 'dialog' }, h('h3', null, title), q, list,
        h('div', { class: 'btns' }, h('button', { class: 'btn flat', onclick: () => close(null) }, 'انصراف'), ok)));
    render();
    document.body.append(v);
  });
}
const callable = () => S.users.filter((u) => u.dm && u.username !== S.me && u.pubkey && !u.req).map((u) => u.username);
const maxVoice = () => (GC.cfg().max_voice || 8);

/** Group chat 📞: join the running call, or start one (a group of over 8 people: pick who rings, like WhatsApp). */
async function groupCall(convo, video = false) {
  const r = GC.roomOf(convo);
  if (r) return GC.join(r.id);
  const g = S.groups.find((x) => x.key === convo);
  if (!g) return;
  const others = g.members.filter((u) => u !== S.me);
  const kind = video ? 'تماس تصویری گروهی' : 'تماس صوتی گروهی';
  if (others.length + 1 <= 8) {
    if (!await confirmBox(kind, 'گوشی ' + faNum(others.length) + ' عضو «' + g.name + '» زنگ می‌خورد.', 'تماس')) return;
    return GC.start({ group: convo, video });
  }
  const ring = await pickPeople('گوشی چه کسانی زنگ بخورد؟', others, 'تماس', maxVoice() - 1);
  if (ring) GC.start({ group: convo, ring, video });
}

/** «تماس جدید» in the Calls tab: one person = a normal call, more = a group call. */
async function newCall() {
  const users = await pickPeople('تماس جدید', callable(), 'تماس صوتی', maxVoice() - 1);
  if (!users) return;
  if (users.length === 1) return Call.startCall(users[0], false);
  if (!GC.cfg().on) return toast('تماس گروهی در این سرور خاموش است');
  GC.start({ users });
}

function CallsScreen() {
  const list = h('div', { class: 'scroll' });
  const nav = bottomNav('calls');
  const el = h('div', { class: 'scroll', style: { display: 'flex', flexDirection: 'column', overflow: 'hidden', position: 'relative' } },
    h('div', { class: 'bar' }, h('h1', null, 'تماس‌ها')),
    list, h('button', { class: 'fab green', title: 'تماس جدید', onclick: () => { buzz(); newCall(); } }, ic('call')), nav.el);
  const render = batched(() => {
    nav.update();
    const logs = [];
    for (const [convo, msgs] of S.convos) for (const m of msgs) if (m.type === 'call') logs.push(m);
    logs.sort((a, b) => b.ts - a.ts);
    const live = [...GC.G.rooms.values()].filter((r) => !(GC.G.room && GC.G.room.id === r.id && GC.G.phase === 'active'));
    fill(list,
      live.length ? h('div', { class: 'section' }, 'تماس‌های در جریان') : null,
      live.map((r) => h('div', { class: 'row' }, avatar(r.group || r.host),
        h('div', { class: 'mid' }, h('div', { class: 'name' }, r.title || E.nameOf(r.host)), h('div', { class: 'prev' }, 'تماس گروهی · ' + faNum(r.parts.length) + ' نفر')),
        h('button', { class: 'btn sm', onclick: () => GC.join(r.id) }, 'پیوستن'))),
      logs.length ? h('div', { class: 'section', style: { display: 'flex' } }, h('span', { class: 'grow' }, 'اخیر'),
        // 1.27
        h('button', { class: 'linkbtn danger', onclick: async () => { if (await confirmBox('پاک کردن تاریخچهٔ تماس', 'همهٔ تماس‌ها از این فهرست و از داخل چت‌ها پاک می‌شوند (فقط روی این دستگاه).', 'پاک کردن همه', true)) E.clearCallLogs(); } }, 'پاک کردن همه')) : null,
      logs.slice(0, 200).map((m) => {
        const missed = /از دست رفته|بی‌پاسخ/.test(m.text || '');
        const group = E.isGroup(m.convo);
        const row = h('div', { class: 'row' }, avatar(m.convo, 'sm'),
          h('div', { class: 'mid', onclick: () => { if (!wasLong()) go('#/c/' + encodeURIComponent(m.convo)); } },
            h('div', { class: 'name' + (missed ? ' missed' : '') }, E.titleOf(m.convo)),
            h('div', { class: 'prev' }, h('span', { class: 'cdir' + (missed ? ' missed' : '') }, ic(m.mine ? 'callMade' : 'callReceived', 15)), ' ' + (m.text || '') + ' · ' + fmtListTime(m.ts))),
          group ? h('button', { class: 'icon', title: 'تماس گروهی', onclick: () => groupCall(m.convo) }, ic('call'))
            : h('button', { class: 'icon', title: 'تماس', onclick: () => Call.startCall(m.convo, false) }, ic('call')));
        // 1.27: long-press / right-click › «حذف از تاریخچه»
        const wasLong = onLongPress(row, () => sheet(E.titleOf(m.convo), [{ label: 'حذف از تاریخچه', danger: true, run: () => E.deleteLocal(m) }]));
        return row;
      }),
      !logs.length && !live.length ? emptyState('call', 'هنوز تماسی ندارید', 'با یک یا چند نفر تماس صوتی یا تصویری بگیرید.', 'تماس تازه', newCall) : null,
      h('div', { style: { height: '84px' } }));
  });
  render();
  return { el, update: (k) => { if (k === 'msg' || k === 'gcall' || k === 'users') render(); } };
}

let gcEl = null, gcTick = null, gcSheet = false;
function renderGcall(g) {
  if (view && view.update) view.update('gcall');
  if (g.phase === 'idle') {
    if (gcEl) { gcEl.remove(); gcEl = null; clearInterval(gcTick); }
    return;
  }
  if (!gcEl) {
    gcEl = h('div', { class: 'call gcall' });
    document.body.append(gcEl);
    clearInterval(gcTick);
    gcTick = setInterval(() => renderGcall(GC.G), 1000);
  }
  const r = g.room;
  if (!r) { fill(gcEl, h('div', { class: 'info' }, h('h2', null, 'تماس گروهی'), h('div', null, g.note || 'در حال پیوستن…'))); return; }
  const title = r.title || (r.host === S.me ? 'تماس گروهی' : E.nameOf(r.host));
  const btn = callBtn;
  if (g.phase === 'incoming') {
    fill(gcEl, h('div', { class: 'info' }, avatar(r.group || r.host, 'lg'), h('h2', null, title), h('div', null, (r.video ? 'تماس تصویری گروهی از ' : 'تماس صوتی گروهی از ') + E.nameOf(g.by)),
      h('div', { class: 'avs' }, r.parts.map((p) => avatar(p.u, 'sm')))),
      h('div', { class: 'ctrls' }, btn('✕', 'red', GC.decline, 'رد'), btn('📞', 'green', GC.accept, 'پیوستن')));
    return;
  }
  const s = Math.floor((Date.now() - g.joinedAt) / 1000);
  const host = r.host === S.me;
  // 1.23: whose picture is shown; my own goes small in the corner when someone else is in the call
  const vidOf = (p) => (p.u === S.me ? g.cam : p.cam) && g.videos[p.u] ? g.videos[p.u] : null;
  const pip = g.cam && g.videos[S.me] && r.parts.length > 1 && g.pin !== S.me;
  const shown = r.parts.filter((p) => !(pip && p.u === S.me));
  const pinned = g.pin && shown.some((p) => p.u === g.pin) ? g.pin : '';
  const tiles = shown.map((p) => {
    const lv = g.levels[p.u] || 0;
    const reacts = g.reacts.filter((x) => x.from === p.u).slice(-1);
    const vs = vidOf(p);
    const tile = h('div', { class: 'tile' + (lv > 0.03 && !p.muted ? ' speak' : '') + (vs ? ' vid' : '') + (pinned === p.u ? ' pin' : '') },
      vs ? videoEl(p.u, vs, p.u === S.me && g.front) : avatar(p.u, 'lg'),
      h('div', { class: 'tn' }, (p.u === S.me ? 'شما' : E.nameOf(p.u)) + (p.u === r.host ? ' ★' : '')),
      h('div', { class: 'ti' }, p.muted ? '🔇' : '', p.hand ? '✋' : '', pinned === p.u ? '📌' : ''),
      reacts.length ? h('div', { class: 'treact' }, reacts[0].emoji) : null);
    tile.onclick = p.u !== S.me ? () => personSheet(p.u, host, !!vs) : (vs ? () => GC.pin(S.me) : null);
    return tile;
  });
  for (const u of [...vidEls.keys()]) if (!r.parts.some((p) => p.u === u && vidOf(p))) vidEls.delete(u);
  const ringing = r.ringing.filter((u) => !r.parts.some((p) => p.u === u));
  fill(gcEl,
    h('div', { class: 'gtop' }, h('div', null, h('b', null, title), h('div', { class: 'mut' }, Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0') + ' · ' + faNum(r.parts.length) + ' نفر' + (ringing.length ? ' · در حال زنگ: ' + ringing.map(E.nameOf).join('، ') : ''))),
      h('button', { class: 'icon', title: 'افزودن نفر', onclick: addPeople }, ic('personAdd', 22))),
    h('div', { class: 'tiles n' + Math.min(shown.length, 9) + (pinned ? ' pinned' : '') + (shown.some(vidOf) ? ' hasvid' : '') }, tiles),
    pip ? h('div', { class: 'gpip', onclick: () => GC.pin(S.me) }, videoEl(S.me, g.videos[S.me], g.front),
      h('button', { class: 'gswitch', title: 'دوربین جلو / عقب', onclick: (e) => { e.stopPropagation(); GC.switchCam(); } }, ic('flipCamera', 18))) : null,
    h('div', { class: 'ctrls' },
      btn(g.muted ? '🔇' : '🎙', g.muted ? 'on' : '', GC.toggleMute, 'میکروفون'),
      GC.videoOn() ? btn(g.cam ? '📷' : '🚫📷', g.cam ? 'on' : '', GC.toggleCam, 'دوربین') : null,
      g.cam && !pip ? btn('🔄', '', GC.switchCam, 'دوربین جلو / عقب') : null,
      btn('✋', g.hand ? 'on' : '', GC.toggleHand, 'بالا بردن دست'),
      btn('😀', '', () => sheet('واکنش', ['👍', '❤️', '😂', '😮', '👏'].map((e) => ({ label: e, run: () => GC.react(e) }))), 'واکنش'),
      btn('✕', 'red', () => GC.leave(), 'خروج')));
}
/** 1.23: one <video> per person, kept across the once-a-second redraw so the picture does not blink. */
const vidEls = new Map();
function videoEl(u, stream, mirror) {
  let v = vidEls.get(u);
  if (!v) { v = h('video', { autoplay: true, playsinline: true }); v.muted = true; vidEls.set(u, v); }
  if (v.srcObject !== stream) v.srcObject = stream;
  v.classList.toggle('mirror', !!mirror);
  if (v.paused) setTimeout(() => v.play().catch(() => { }), 0);
  return v;
}
function personSheet(u, host, vid) {
  const vol = h('input', { type: 'range', min: 0, max: 100, value: Math.round((GC.G.volume[u] != null ? GC.G.volume[u] : 1) * 100), oninput: () => GC.setVolume(u, vol.value / 100) });
  sheet(E.nameOf(u), [
    vid ? { label: GC.G.pin === u ? '📌 برداشتن سنجاق' : '📌 نمایش بزرگ (سنجاق)', run: () => GC.pin(u) } : null,
    E.user(u) && E.user(u).dm ? { label: '💬 پیام خصوصی', run: () => go('#/c/' + encodeURIComponent(u)) } : null,
    host ? { label: '🔇 بستن صدای او برای همه', run: () => GC.host(u, 'mute') } : null,
    host ? { label: '⛔ بیرون کردن از تماس', danger: true, run: async () => { if (await confirmBox('بیرون کردن', E.nameOf(u) + ' از تماس بیرون برود؟', 'بیرون کردن', true)) GC.host(u, 'remove'); } } : null,
  ], () => h('div', { class: 'volrow' }, '🔈 بلندی صدا', vol));
}
async function addPeople() {
  const r = GC.G.room;
  if (!r) return;
  const inCall = new Set([...r.parts.map((p) => p.u), ...r.ringing]);
  const g = r.group && S.groups.find((x) => x.key === r.group);
  const names = [...new Set([...(g ? g.members : []), ...callable()])].filter((u) => u !== S.me && !inCall.has(u));
  const room = maxVoice() - r.parts.length;
  if (room <= 0) return toast('تماس پر است');
  const users = await pickPeople('افزودن به تماس', names, 'زنگ بزن', room);
  if (users) GC.invite(users);
}
GC.onGcall(renderGcall);
GC.setToast((t) => toast(t));

/** 1.19: «افزودن نفر» in a 1:1 call turns it into a group call; the other side moves over by itself. */
async function upgradeCall() {
  const c = Call.C;
  const users = await pickPeople('افزودن به تماس', callable().filter((u) => u !== c.peer), 'زنگ بزن', maxVoice() - 2);
  if (!users || Call.C.phase !== 'active') return;
  Call.upgradeToGroup(users);
}

let callEl = null, callTick = null, callSwap = false, routeLevel = 'top'; // routeLevel (1.15): 'top' | 'server'
// 1.15: the 🔀 path panel is shown; the button toggles it like the ping eye and the choice is remembered
const routePanelOn = () => { try { return localStorage.getItem('sepan_route_panel') !== '0'; } catch { return true; } };
const setRoutePanel = (v) => { try { localStorage.setItem('sepan_route_panel', v ? '1' : '0'); } catch { } };
function renderCall(c) {
  if (c.phase === 'idle') {
    if (callEl) { callEl.remove(); callEl = null; clearInterval(callTick); Diag.detach(); }
    callSwap = false; routeLevel = 'top';
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
  // 1.27: the other person's photo fills the screen (their colour and initial without one), under the video
  let bg = callEl.querySelector('.call-bg');
  if (!bg) { bg = h('div', { class: 'call-bg' }); callEl.prepend(bg); }
  const photo = E.avatarUrl(c.peer);
  const bgKey = c.peer + '|' + (photo || '');
  if (bg.dataset.k !== bgKey) {
    bg.dataset.k = bgKey;
    bg.style.backgroundImage = photo ? `url("${photo}")` : `linear-gradient(${colorFor(c.peer)}, rgba(0, 0, 0, .55)), linear-gradient(${colorFor(c.peer)}, ${colorFor(c.peer)})`;
    bg.textContent = photo ? '' : initials(E.nameOf(c.peer));
  }
  bg.style.visibility = remoteVideo ? 'hidden' : 'visible';
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
  // 1.8: tap the small picture to swap it with the big one (like Telegram); tap again to swap back
  const canSwap = remoteVideo && localVideo;
  callEl.classList.toggle('swap', canSwap && callSwap);
  const tapSmall = (big) => (e) => { e.stopPropagation(); if (canSwap && callSwap === big) { callSwap = !callSwap; renderCall(Call.C); } };
  rv.onclick = tapSmall(true);
  if (lv && localVideo) lv.onclick = tapSmall(false);
  let status = c.note;
  // 1.26: the other side is on another call
  if (c.phase === 'outgoing' && c.busy === 1) status = 'در حال مکالمه است';
  else if (c.phase === 'outgoing' && c.busy === 2) { const s = Math.max(0, Math.floor((Date.now() - c.waitFrom) / 1000)); status = 'در انتظار… ' + Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0'); }
  const busyLine = c.phase === 'outgoing' && c.busy ? h('div', { class: 'route-now' }, c.busy === 1 ? 'اگر منتظر بمانید، وقتی مکالمه‌اش تمام شد تماس خودکار برقرار می‌شود' : 'وقتی مکالمه‌اش تمام شد، تماس خودکار برقرار می‌شود') : null;
  if (c.phase === 'active') { const s = Math.floor((Date.now() - c.startedAt) / 1000); status = Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0'); }
  else if (c.phase === 'incoming') status = c.video ? 'تماس تصویری ورودی' : 'تماس صوتی ورودی';
  // 1.15: a short note when a chosen path could not be reached (the path itself is in the 🔀 panel)
  const routeLine = c.canRoute && c.phase === 'active' && c.note ? h('div', { class: 'route-now' }, c.note) : null;
  const info = h('div', { class: 'info' }, h('h2', null, E.nameOf(c.peer)), h('div', null, status), busyLine, routeLine);
  const btn = callBtn;
  const ctrls = c.phase === 'incoming'
    ? h('div', { class: 'ctrls' }, btn('✕', 'red', Call.decline, 'رد'), btn(c.video ? '🎥' : '📞', 'green', Call.accept, 'پاسخ'))
    : c.phase === 'outgoing' && c.busy === 1
    ? h('div', { class: 'ctrls' }, btn('✕', 'red', Call.hangup, 'قطع'), h('button', { class: 'btn', onclick: Call.waitForPeer }, '⏳ منتظر می‌مانم'))
    : c.phase === 'outgoing' && c.busy === 2
    ? h('div', { class: 'ctrls' }, btn('✕', 'red', Call.hangup, 'لغو انتظار'))
    : h('div', { class: 'ctrls' },
      btn(c.muted ? '🔇' : '🎙', c.muted ? 'on' : '', Call.toggleMute, 'قطع صدا'),
      localVideo ? btn(c.camOff ? '🚫' : '📷', c.camOff ? 'on' : '', Call.toggleCamera, 'دوربین') : null,
      localVideo ? btn('🔄', '', Call.switchCamera, 'چرخش دوربین') : null,
      c.phase === 'active' && !c.video && GC.cfg().on ? btn('👤+', '', upgradeCall, 'افزودن نفر (تماس گروهی)') : null,
      btn('✕', 'red', Call.hangup, 'پایان تماس'));
  // 1.15: 🔀 button + small see-through panel (at most a third of the screen wide):
  // خودکار / مستقیم / سرور › UDP, TCP, TLS. The button shows / hides the panel, remembered.
  let menu = null;
  if (c.canRoute && c.phase === 'active') {
    const shown = routePanelOn() && c.peerRoute;
    const tog = h('button', { class: 'rtog' + (shown ? ' on' : ''), title: c.peerRoute ? 'نمایش / پنهان کردن مسیر اتصال' : 'طرف مقابل نسخهٔ قدیمی سپن را دارد؛ تغییر مسیر ممکن نیست', disabled: !c.peerRoute,
      onclick: () => { setRoutePanel(!routePanelOn()); renderCall(Call.C); } }, ic('route', 20));
    let panel = null;
    if (shown) {
      const pick = (m) => () => { routeLevel = 'top'; Call.setRoute(m); renderCall(Call.C); };
      const item = (m, label) => h('button', { class: 'ri' + (c.route === m ? ' cur' : ''), disabled: c.routing || !c.routes.includes(m), onclick: pick(m) }, (c.route === m ? '✓ ' : '') + label);
      const server = ['udp', 'tcp', 'tls'].includes(c.route);
      const head = h('div', { class: 'rt' }, c.routing ? 'در حال تغییر…' : (c.path || 'مسیر اتصال'));
      panel = routeLevel === 'server'
        ? h('div', { class: 'rp' }, head, h('button', { class: 'ri back', onclick: () => { routeLevel = 'top'; renderCall(Call.C); } }, '→ سرور'),
          item('udp', 'UDP'), item('tcp', 'TCP'), item('tls', 'TLS'))
        : h('div', { class: 'rp' }, head, item('auto', 'خودکار'), item('direct', 'مستقیم'),
          h('button', { class: 'ri' + (server ? ' cur' : ''), disabled: c.routing, onclick: () => { routeLevel = 'server'; renderCall(Call.C); } }, (server ? '✓ ' : '') + 'سرور ‹'));
    }
    menu = h('div', { class: 'route-menu' }, tog, panel);
  }
  callEl.querySelectorAll('.info, .ctrls, .route-menu').forEach((x) => x.remove());
  callEl.append(info, ctrls);
  if (menu) callEl.append(menu);
  // admins' call diagnostics (test feature, switched on per user in the panel)
  if (S.meInfo.diag && c.phase !== 'incoming') Diag.attach(callEl, c.peer, Call.peerConnection);
}
Call.onCall(renderCall);
// 1.26: someone waits until my other Sepan call is over
Call.setWaitHook((peer) => toast(E.nameOf(peer) + ' منتظر تماس با شماست؛ بعد از این تماس خودکار زنگ می‌زند'));

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
  if (api.getToken()) setTimeout(whatsNew, 1500);
})();
