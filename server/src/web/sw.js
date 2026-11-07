// Service worker: keeps the app shell available offline so the home-screen app opens without
// network. Always tries the network first (so updates arrive at once) and never touches /api.
// It also shows Web Push notifications while the app is closed (iPhone, iOS 16.4+) and reports the
// message as delivered, so the sender's tick turns blue.
const CACHE = 'sepan-shell-v7';
const SHELL = ['/', '/app', '/app.css', '/app.mjs', '/engine.mjs', '/api.mjs', '/crypto.mjs', '/store.mjs', '/call.mjs', '/webp.mjs', '/emoji.mjs', '/voice.mjs', '/diag.mjs', '/lan.mjs', '/manifest.webmanifest', '/icon-180.png', '/icon-192.png', '/wallpaper.svg', '/wallpaper-dark.svg'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== self.location.origin || url.pathname.startsWith('/api/')) return;
  e.respondWith(fetch(e.request).then((res) => {
    if (res.ok) { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(e.request, copy)); }
    return res;
  }).catch(() => caches.match(e.request, { ignoreSearch: true }).then((r) => r || caches.match('/app'))));
});

/** The session token the app keeps in IndexedDB (store.mjs, store "kv"); null if logged out. */
function token() {
  return new Promise((resolve) => {
    const r = indexedDB.open('sepan');
    r.onupgradeneeded = () => r.transaction.abort(); // no database yet: nobody is logged in
    r.onerror = () => resolve(null);
    r.onsuccess = () => {
      try {
        const g = r.result.transaction('kv', 'readonly').objectStore('kv').get('token');
        g.onsuccess = () => { resolve(g.result || null); r.result.close(); };
        g.onerror = () => { resolve(null); r.result.close(); };
      } catch { resolve(null); }
    };
  });
}

async function delivered(convo, id) {
  const t = await token();
  if (!t || !convo || !id) return;
  await fetch('/api/receipts', {
    method: 'POST', headers: { authorization: 'Bearer ' + t, 'content-type': 'application/json' },
    body: JSON.stringify({ items: [{ target: convo, delivered: id }] }),
  }).catch(() => { });
}

self.addEventListener('push', (e) => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch { }
  const title = d.title || 'سپن';
  // iOS requires a visible notification for every push
  e.waitUntil(Promise.all([
    self.registration.showNotification(title, {
      body: d.body || 'پیام تازه', tag: d.convo || 'sepan', renotify: true, icon: '/icon-192.png', badge: '/icon-192.png',
      lang: 'fa', dir: 'rtl', data: { convo: d.convo || null },
    }),
    d.t === 'msg' ? delivered(d.convo, d.id) : null,
  ]));
});

self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const convo = e.notification.data && e.notification.data.convo;
  const url = '/' + (convo ? '#/c/' + encodeURIComponent(convo) : '');
  e.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
    for (const c of list) {
      if (new URL(c.url).origin === self.location.origin) { c.navigate(url).catch(() => { }); return c.focus(); }
    }
    return self.clients.openWindow(url);
  }));
});
