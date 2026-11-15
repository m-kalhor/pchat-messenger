'use strict';
/**
 * SMS providers (1.16.0). Each provider is one file in this folder that exports
 *   { id, name, help, fields: [{ key, label, secret?, placeholder?, def?, re }], send(cfg, phone, code), credit?(cfg) }
 * and is listed in PROVIDERS below; the admin picks one in the panel. A provider's settings are kept
 * as JSON under 'sms_cfg_<id>', so switching back and forth keeps each provider's values.
 * Numbers reach send() in the international form (+98912…).
 */
const { db, getSetting, setSetting } = require('../db');

const PROVIDERS = [require('./artapayamak')];
const byId = new Map(PROVIDERS.map((p) => [p.id, p]));

// 1.16.0: sms.ir is gone; drop its settings and its old success/failure state
if (getSetting('migrated_v116_sms') !== '1') {
  db.prepare("DELETE FROM settings WHERE key IN ('sms_api_key','sms_template_id','sms_param','sms_last_ok','sms_last_error')").run();
  setSetting('migrated_v116_sms', '1');
}

const provider = () => byId.get(getSetting('sms_provider', '')) || PROVIDERS[0];
const enabled = () => getSetting('sms_enabled', '1') === '1';

/** The stored values of provider p, with defaults filled in. */
function cfgOf(p = provider()) {
  let c = {};
  try { c = JSON.parse(getSetting('sms_cfg_' + p.id, '{}')) || {}; } catch { }
  const out = {};
  for (const f of p.fields) out[f.key] = typeof c[f.key] === 'string' && c[f.key] ? c[f.key] : (f.def || '');
  return out;
}
const configured = (p = provider()) => { const c = cfgOf(p); return p.fields.every((f) => !!c[f.key]); };
const ready = () => enabled() && configured();

/** What the panel may see: secrets only as set / last four characters. */
function publicInfo() {
  const cur = provider();
  return {
    provider: cur.id,
    providers: PROVIDERS.map((p) => {
      const c = cfgOf(p);
      return {
        id: p.id, name: p.name, help: p.help || '', credit: typeof p.credit === 'function', configured: configured(p),
        fields: p.fields.map((f) => ({
          key: f.key, label: f.label, secret: !!f.secret, placeholder: f.placeholder || '',
          ...(f.secret ? { set: !!c[f.key], hint: c[f.key] ? '…' + c[f.key].slice(-4) : '' } : { value: c[f.key] }),
        })),
      };
    }),
  };
}

/**
 * Saves the admin's values for provider id. A secret left empty keeps the stored one, null clears it;
 * other fields are saved as typed (empty = default). Throws 'bad_sms_provider' or 'bad_sms_<field>'.
 */
function update(id, values) {
  const p = byId.get(id);
  if (!p) throw new Error('bad_sms_provider');
  let old = {};
  try { old = JSON.parse(getSetting('sms_cfg_' + p.id, '{}')) || {}; } catch { }
  const next = { ...old };
  let newSecret = false;
  for (const f of p.fields) {
    if (!values || !(f.key in values)) continue;
    const v = values[f.key];
    if (v === null) { delete next[f.key]; continue; }
    const s = String(v).trim();
    if (!s) { if (!f.secret) delete next[f.key]; continue; }
    if (!f.re.test(s)) throw new Error('bad_sms_' + f.key);
    if (f.secret && s !== old[f.key]) newSecret = true;
    next[f.key] = s;
  }
  setSetting('sms_cfg_' + p.id, JSON.stringify(next));
  const switched = getSetting('sms_provider', '') !== p.id;
  setSetting('sms_provider', p.id);
  // another provider or a new key: the old failure no longer says anything
  if (switched || newSecret) setSetting('sms_last_error', 'null');
}

function setState(ok, error) {
  if (ok) setSetting('sms_last_ok', Date.now());
  else setSetting('sms_last_error', JSON.stringify({ t: Date.now(), error: String(error).slice(0, 200) }));
}
/** { last_ok, last_error: {t, error} } and down = the newest attempt failed. */
function status() {
  const ok = Number(getSetting('sms_last_ok', 0)) || null;
  let err = null;
  try { err = JSON.parse(getSetting('sms_last_error', 'null')); } catch { }
  return { last_ok: ok, last_error: err, down: !!err && err.t > (ok || 0) };
}
const why = (e) => (e && e.name === 'TimeoutError' ? 'timeout' : (e && e.message) || String(e));

/** Sends the code with the active provider. Throws when the SMS did not go out. */
async function send(phone, code) {
  if (!ready()) throw new Error('sms_not_configured');
  const p = provider();
  try { await p.send(cfgOf(p), phone, code); setState(true); } catch (e) { setState(false, why(e)); throw new Error(why(e)); }
}
/** Account credit; a good answer also proves the key, so it clears an old 'SMS down' warning. */
async function credit() {
  const p = provider();
  if (typeof p.credit !== 'function') throw new Error('sms_no_credit');
  if (!configured(p)) throw new Error('sms_not_configured');
  try { const c = await p.credit(cfgOf(p)); setState(true); return c; } catch (e) { setState(false, why(e)); throw new Error(why(e)); }
}

module.exports = { PROVIDERS, provider, enabled, ready, configured, publicInfo, update, status, send, credit };
