// Sepan web app: screens and interaction. State and logic live in engine.mjs, calls in call.mjs.
import * as E from './engine.mjs';
import * as Call from './call.mjs';
import * as api from './api.mjs';
import { fingerprint } from './crypto.mjs';
import { encodeWebp } from './webp.mjs';
import * as Emoji from './emoji.mjs';

const VERSION = '1.2.0';
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

let toastTimer = null;
function toast(text, onclick) {
  document.querySelectorAll('.toast').forEach((t) => t.remove());
  const t = h('div', { class: 'toast', onclick: () => { t.remove(); if (onclick) onclick(); } }, text);
  document.body.append(t);
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.remove(), 3500);
}

function sheet(title, items) {
  const v = h('div', { class: 'veil', onclick: (e) => { if (e.target === v) v.remove(); } },
    h('div', { class: 'sheet' }, title ? h('div', { class: 'st' }, title) : null,
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
  if (kind === 'msg' && data && !data.mine && data.id > 0 && Date.now() - data.ts < 60000 && S.openConvo !== data.convo) {
    const group = E.isGroup(data.convo);
    toast((group ? E.groupName(data.convo) + ' · ' + E.nameOf(data.sender) : E.nameOf(data.sender)) + ': ' + E.preview(data).slice(0, 60), () => go('#/c/' + encodeURIComponent(data.convo)));
    if (pref('sound', true)) Call.notifySound();
  }
  if (kind === 'msg' || kind === 'read') updateTitle();
  if (view && view.update) view.update(kind, data);
});
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') { E.resume(); if (S.openConvo) E.markRead(S.openConvo); }
});
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
function LoginScreen() {
  const user = h('input', { type: 'text', placeholder: 'نام کاربری', autocomplete: 'username', class: 'ltr', autocapitalize: 'off', autocorrect: 'off', spellcheck: 'false' });
  const pass = h('input', { type: 'password', placeholder: 'رمز عبور', autocomplete: 'current-password', class: 'ltr' });
  const err = h('div', { class: 'err' }, logoutReason || '');
  logoutReason = null;
  const btn = h('button', { class: 'btn', type: 'submit' }, 'ورود');
  async function submit(e, force = false) {
    if (e) e.preventDefault();
    if (!user.value.trim() || !pass.value) { err.textContent = 'نام کاربری و رمز عبور را وارد کنید'; return; }
    btn.disabled = true; err.textContent = '';
    try {
      const r = await E.login(user.value, pass.value, force);
      if (r.conflict) {
        const ok = r.conflict === 'reset'
          ? await confirmBox('کلید قبلی باز نشد', 'رمز عبور این حساب عوض شده و پشتیبان کلید با رمز تازه باز نمی‌شود. اگر ادامه دهید یک کلید تازه ساخته می‌شود و پیام‌های قبلی دیگر خوانده نمی‌شوند. ادامه می‌دهید؟', 'ادامه با کلید تازه', true)
          : await confirmBox('این حساب روی دستگاه دیگری فعال است',
            'این حساب روی دستگاه دیگری (احتمالاً نسخهٔ قدیمی اندروید) کلید دیگری دارد. اگر اینجا وارد شوید، آن دستگاه پیام‌های تازه را باز نمی‌کند تا اپ آن به‌روز و دوباره وارد شود. ادامه می‌دهید؟',
            'ورود در اینجا', true);
        if (ok) return submit(null, true);
      }
    } catch (ex) { err.textContent = E.errText(ex); }
    btn.disabled = false;
  }
  const el = h('div', { class: 'scroll' }, h('div', { class: 'login' },
    h('img', { class: 'logo', src: '/icon-192.png', alt: '' }),
    h('h2', null, 'سپن'),
    h('p', null, 'پیام‌رسان خصوصی و رمزنگاری‌شده'),
    h('form', { class: 'form', onsubmit: submit }, user, pass, err, btn),
    isIOS && !standalone() ? h('div', { class: 'hint' }, 'بعد از ورود، از دکمهٔ اشتراک‌گذاری ', h('b', null, '⬆️'), ' گزینهٔ ', h('b', null, '«افزودن به صفحهٔ اصلی»'), ' را بزنید تا سپن مثل یک برنامه باز شود.') : null));
  return { el, mounted: () => user.focus() };
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
    const rows = E.summaries().map((s) => {
      const typing = !E.isGroup(s.convo) && Date.now() - (S.typing[s.convo] || 0) < 4500;
      const last = s.last;
      const prev = typing ? 'در حال نوشتن…' : last ? (E.isGroup(s.convo) && !last.mine && last.type !== 'call' ? E.nameOf(last.sender) + ': ' : last.mine && last.type !== 'call' ? 'شما: ' : '') + E.preview(last) : 'هنوز پیامی نیست';
      return h('button', { class: 'row', onclick: () => go('#/c/' + encodeURIComponent(s.convo)) },
        avatarWithDot(s.convo),
        h('div', { class: 'mid' },
          h('div', { class: 'top' }, h('div', { class: 'name' }, E.titleOf(s.convo)), h('div', { class: 'time' }, last ? fmtListTime(last.ts) : '')),
          h('div', { class: 'sub' }, h('div', { class: 'prev' + (typing ? ' typing' : '') }, prev), s.unread ? h('span', { class: 'count' }, faNum(s.unread)) : null)));
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
  const name = h('input', { type: 'text', placeholder: 'نام کاربری دقیق', class: 'ltr', autocapitalize: 'off', autocorrect: 'off', spellcheck: 'false' });
  const msg = h('div', { class: 'err' });
  const btn = h('button', { class: 'btn', type: 'submit' }, 'فرستادن درخواست');
  const lists = h('div');
  E.refreshRequests().catch(() => { });
  async function add(e) {
    e.preventDefault();
    if (!name.value.trim()) return;
    btn.disabled = true;
    const r = await E.contactAction('request', name.value);
    btn.disabled = false;
    msg.className = r.error ? 'err' : 'ok';
    msg.textContent = r.error || (r.result === 'connected' ? 'ارتباط برقرار شد' : 'درخواست فرستاده شد؛ بعد از پذیرفتن او به مخاطبان اضافه می‌شود');
    if (!r.error) name.value = '';
  }
  const act = async (what, u, accept) => { const r = await E.contactAction(what, u, accept); if (r.error) toast(r.error); };
  const el = h('div', { class: 'scroll', style: { display: 'flex', flexDirection: 'column', overflow: 'hidden' } },
    h('div', { class: 'bar' }, h('button', { class: 'icon', title: 'بازگشت', onclick: () => history.length > 1 ? history.back() : go('#/') }, '→'), h('h1', null, 'درخواست‌های ارتباط')),
    h('div', { class: 'scroll' },
      h('form', { class: 'form', onsubmit: add }, h('div', { class: 'field' }, h('label', null, 'افزودن مخاطب با نام کاربری'), name), msg, btn),
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
  let reply = null, limit = 120, search = '', forceBottom = true;

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
  const emojiPanel = h('div', { class: 'emojis hidden' });
  const sendBtn = h('button', { class: 'icon send', title: 'ارسال' }, '➤');
  const attachBtn = h('button', { class: 'icon', title: 'فایل یا عکس', onclick: () => fileIn.click() }, '📎');
  const emojiBtn = h('button', { class: 'icon', title: 'شکلک' }, '🙂');

  const el = h('div', { class: 'chat', style: { display: 'flex', flexDirection: 'column', height: '100%', position: 'relative' } },
    h('div', { class: 'bar' },
      h('button', { class: 'icon', title: 'بازگشت', onclick: () => go('#/') }, '→'),
      h('div', { class: 'grow', style: { display: 'flex', gap: '10px', alignItems: 'center' }, onclick: () => go('#/p/' + encodeURIComponent(convo)) }, av, h('div', { style: { minWidth: '0' } }, title, sub)),
      callBtns,
      h('button', { class: 'icon', title: 'جستجو', onclick: () => { searchBar.classList.remove('hidden'); searchInput.focus(); } }, '🔍')),
    searchBar, pinBar, msgs, jump,
    h('div', { class: 'composer' }, replyBar, h('div', { class: 'line' }, emojiBtn, ta, attachBtn, sendBtn), emojiPanel, fileIn));

  function renderHeader() {
    title.textContent = E.titleOf(convo);
    fill(av, avatarWithDot(convo, 'sm'));
    const c = connText();
    let s = '', on = false;
    if (c) s = c;
    else if (group) { const g = S.groups.find((x) => x.key === convo); s = g ? faNum(g.members.length) + ' عضو' : ''; }
    else if (Date.now() - (S.typing[convo] || 0) < 4500) { s = 'در حال نوشتن…'; on = true; }
    else { const u = E.user(convo); s = u && u.online ? 'آنلاین' : '@' + convo; on = !!(u && u.online); }
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

  function setReply(m) {
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

  function bubble(m) {
    if (m.type === 'call') return h('div', { class: 'call-line' }, '📞 ' + m.text + ' · ' + fmtTime(m.ts));
    const big = m.type === 'text' && !m.replyId && !m.replyText && Emoji.onlyEmojiCount(m.text) > 0;
    const prog = S.progress.get(m.id);
    const b = h('div', { class: 'bubble' + (big ? ' emoji' : '') },
      group && !m.mine ? h('div', { class: 'who', style: { color: colorFor(m.sender) } }, E.nameOf(m.sender)) : null,
      m.replyText || m.replyId ? h('div', { class: 'reply', onclick: (e) => { e.stopPropagation(); if (m.replyId) scrollToMsg(m.replyId); } },
        h('div', { class: 'ru' }, m.replyUser === S.me ? 'شما' : E.nameOf(m.replyUser || '')), h('div', { class: 'rx' }, m.replyText || '')) : null,
      m.type === 'image' || m.type === 'file' ? mediaPart(m) : null,
      m.type === 'text' ? h('div', { class: 'txt', dir: 'auto' }, highlight(m.text)) : null,
      m.mine && prog != null && m.status === 1 ? h('div', { class: 'bar-prog' }, h('i', { style: { width: Math.round(prog * 100) + '%' } })) : null,
      m.status === 2 ? h('div', { class: 'fail' }, '⚠️ ' + (S.failures.get(m.id) || 'ارسال نشد'), h('button', { onclick: (e) => { e.stopPropagation(); E.retry(m); } }, 'تلاش دوباره')) : null,
      h('div', { class: 'meta' }, m.mine ? h('span', null, m.status === 1 ? '🕓' : m.status === 2 ? '⚠️' : '✓') : null, h('span', null, fmtTime(m.ts)), S.pins[convo] === m.id ? h('span', null, '📌') : null));
    b.dataset.id = m.id;
    return h('div', { class: 'm ' + (m.mine ? 'me' : 'them'), onclick: () => menu(m) }, b);
  }

  function menu(m) {
    if (m.locked) return sheet(null, [{ label: 'حذف از این دستگاه', danger: true, run: () => E.deleteLocal(m) }]);
    const pinned = S.pins[convo] === m.id;
    sheet(null, [
      m.id > 0 && { label: 'پاسخ', run: () => setReply(m) },
      m.type === 'text' && { label: 'کپی', run: () => navigator.clipboard.writeText(m.text).then(() => toast('کپی شد'), () => toast('کپی نشد')) },
      (m.type === 'image' || m.type === 'file') && E.mediaUrl(m) && { label: m.type === 'image' ? 'ذخیرهٔ عکس / اشتراک' : 'ذخیره در Files / اشتراک', run: () => saveMedia(m) },
      m.id > 0 && { label: pinned ? 'برداشتن سنجاق' : 'سنجاق کردن', run: async () => { const e = await E.pinMessage(convo, pinned ? null : m.id); if (e) toast(e); } },
      m.status === 2 && { label: 'تلاش دوباره', run: () => E.retry(m) },
      { label: 'حذف از این دستگاه', danger: true, run: () => E.deleteLocal(m) },
    ]);
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
  ta.addEventListener('input', () => { autosize(); if (ta.value.trim()) E.sendTyping(convo); });
  ta.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey && !isIOS && matchMedia('(pointer: fine)').matches) { e.preventDefault(); send(); } });
  function send() {
    const text = ta.value.trim();
    if (!text) return;
    E.sendText(convo, text, reply);
    ta.value = ''; autosize(); setReply(null);
    forceBottom = true;
    ta.focus();
  }
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
  renderHeader(); renderPin();
  return {
    el,
    mounted: () => renderList(),
    destroy: () => { clearInterval(tick); S.openConvo = null; },
    update(kind, data) {
      if (kind === 'msg') {
        if (data && data.convo !== convo) return;
        if (document.visibilityState === 'visible') E.markRead(convo);
        renderListB(); renderPin();
      } else if (kind === 'progress' || kind === 'media') renderListB();
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
      h('div', { class: 'profile-head' }, av, h('h2', null, E.nameOf(convo)), h('div', { class: 'u' }, '@' + convo), h('div', { class: 'u' }, u.online ? 'آنلاین' : '')),
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
      h('div', { class: 'hint' }, 'در آیفون، نسخهٔ وب فقط وقتی باز است پیام و تماس را دریافت می‌کند. بعد از باز کردن، همهٔ پیام‌های جامانده خودکار می‌رسند.'),
      h('div', { class: 'section' }, 'داده و فضا'),
      setting('دانلود خودکار عکس‌ها', 'عکس‌های تا ۲۵ مگابایت', toggle('autoImages', true)),
      setting('پاک کردن عکس‌ها و فایل‌های ذخیره‌شده', 'پیام‌ها می‌مانند', h('button', { class: 'btn sm flat', onclick: async () => { await E.clearMediaCache(); toast('پاک شد'); } }, 'پاک کردن')),
      h('div', { class: 'section' }, 'امنیت'),
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
