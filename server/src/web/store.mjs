// Local storage of the web app in IndexedDB: settings / identity key ("kv"), decrypted messages
// ("msgs") and decrypted media for offline viewing ("media"). Nothing here ever leaves the phone.
let dbp = null;

function db() {
  if (!dbp) {
    dbp = new Promise((resolve, reject) => {
      const r = indexedDB.open('sepan', 1);
      r.onupgradeneeded = () => {
        const d = r.result;
        d.createObjectStore('kv');
        d.createObjectStore('msgs', { keyPath: 'id' });
        d.createObjectStore('media');
      };
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(r.error);
    });
  }
  return dbp;
}

function tx(store, mode, fn) {
  return db().then((d) => new Promise((resolve, reject) => {
    const t = d.transaction(store, mode);
    let out;
    Promise.resolve(fn(t.objectStore(store))).then((v) => { out = v; });
    t.oncomplete = () => resolve(out);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error || new Error('aborted'));
  }));
}
const req = (r) => new Promise((resolve, reject) => { r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); });

export const kvGet = (k) => tx('kv', 'readonly', (s) => req(s.get(k)));
export const kvSet = (k, v) => tx('kv', 'readwrite', (s) => { s.put(v, k); });
export const kvDel = (k) => tx('kv', 'readwrite', (s) => { s.delete(k); });

export const allMsgs = () => tx('msgs', 'readonly', (s) => req(s.getAll()));
export const putMsg = (m) => tx('msgs', 'readwrite', (s) => { s.put(m); });
export const putMsgs = (list) => tx('msgs', 'readwrite', (s) => { for (const m of list) s.put(m); });
export const delMsg = (id) => tx('msgs', 'readwrite', (s) => { s.delete(id); });

export const getMedia = (id) => tx('media', 'readonly', (s) => req(s.get(id)));
export const putMedia = (id, blob) => tx('media', 'readwrite', (s) => { s.put(blob, id); });
export const clearMedia = () => tx('media', 'readwrite', (s) => { s.clear(); });

/** Everything except the identity key and settings: used when another account logs in on this phone. */
export async function wipeAccountData() {
  await tx('msgs', 'readwrite', (s) => { s.clear(); });
  await clearMedia();
  for (const k of ['last_id', 'cseq', 'users', 'groups', 'pins', 'read']) await kvDel(k);
}

/** Asks the browser not to evict our data (keys + history) under storage pressure. */
export async function persist() {
  try { if (navigator.storage && navigator.storage.persist) return await navigator.storage.persist(); } catch { }
  return false;
}
