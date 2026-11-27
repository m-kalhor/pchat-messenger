'use strict';
// 1.28.1: the version of Sepan published on Café Bazaar. Apps installed from Bazaar may only be
// updated through Bazaar, so the Bazaar build of the app does not download APKs: it asks the server
// which version Bazaar has, and when that is newer it opens Bazaar. The server reads the public app
// page (its schema.org "softwareVersion", else the «نسخه ۱.۲.۳» line) at most every few hours, only
// when a Bazaar app asks, so servers without Bazaar users never contact Bazaar.

const PAGE = process.env.BAZAAR_APP_URL || 'https://cafebazaar.ir/app/com.pchat.app';
const OK_MS = 6 * 3600 * 1000;    // re-read after 6 hours
const FAIL_MS = 30 * 60 * 1000;   // after a failed read, try again in 30 minutes
const MAX_BYTES = 3 * 1024 * 1024;

let cache = { name: null, at: 0, ok: false };
let pending = null;

const faDigits = (s) => s.replace(/[۰-۹]/g, (d) => String('۰۱۲۳۴۵۶۷۸۹'.indexOf(d))).replace(/[٠-٩]/g, (d) => String('٠١٢٣٤٥٦٧٨٩'.indexOf(d)));
const isVersion = (v) => typeof v === 'string' && /^\d{1,4}(\.\d{1,4}){1,3}$/.test(v);

/** The version name in a Bazaar app page, or null. */
function parsePage(html) {
  const m = /\\?"softwareVersion\\?"\s*:\s*\\?"([^"\\]{1,30})\\?"/.exec(html);
  if (m && isVersion(faDigits(m[1]))) return faDigits(m[1]);
  const f = /نسخه[\s:]*([۰-۹٠-٩0-9]{1,4}(?:[.٫][۰-۹٠-٩0-9]{1,4}){1,3})/.exec(html);
  if (f) { const v = faDigits(f[1]).replace(/٫/g, '.'); if (isVersion(v)) return v; }
  return null;
}

async function read() {
  const r = await fetch(PAGE, { headers: { 'User-Agent': 'Mozilla/5.0 (Sepan update check)', Accept: 'text/html' }, signal: AbortSignal.timeout(15000), redirect: 'follow' });
  if (!r.ok) throw new Error('http ' + r.status);
  const html = (await r.text()).slice(0, MAX_BYTES);
  const v = parsePage(html);
  if (!v) throw new Error('no version on page');
  return v;
}

/** The published version name (cached), or null when it is not known (yet). Never throws. */
async function version() {
  const age = Date.now() - cache.at;
  if (age < (cache.ok ? OK_MS : FAIL_MS)) return cache.name;
  if (!pending) {
    pending = read()
      .then((v) => { cache = { name: v, at: Date.now(), ok: true }; })
      .catch((e) => { console.warn('[bazaar] version read failed:', e.message); cache = { name: cache.name, at: Date.now(), ok: false }; })
      .finally(() => { pending = null; });
  }
  await pending;
  return cache.name;
}

module.exports = { version, parsePage, PAGE, _reset: () => { cache = { name: null, at: 0, ok: false }; } };
