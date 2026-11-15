'use strict';
/**
 * Arta Payamak (artapayamak.com), on the IPPanel "Edge" API: https://ippanelcom.github.io/Edge-Document/docs
 *   send:   POST {base}/api/send  { sending_type:'pattern', from_number, code, recipients:[one +98 number], params:{ <var>: code } }
 *   credit: GET  {base}/api/payment/credit/mine -> data.credit
 * Header Authorization: <token>. Every answer is { data, meta: { status, message, message_code } }; status true = done.
 */
const BASE = process.env.SMS_API_URL || 'https://edge.ippanel.com/v1';

/** The sending line in the +98 form the API wants: "3000505", "983000505" and "+983000505" are the same line. */
function lineNumber(s) {
  const p = String(s || '').replace(/[\s-]/g, '');
  if (p.startsWith('+')) return p;
  if (p.startsWith('0098')) return '+' + p.slice(2);
  if (p.startsWith('98')) return '+' + p;
  if (p.startsWith('0')) return '+98' + p.slice(1);
  return '+98' + p;
}

async function call(path, method, body, token) {
  const r = await fetch(BASE + path, {
    method,
    headers: { 'Content-Type': 'application/json', Accept: 'application/json', Authorization: token },
    body: body && JSON.stringify(body),
    signal: AbortSignal.timeout(10000),
  });
  let j = null;
  try { j = await r.json(); } catch { }
  const meta = (j && j.meta) || {};
  if (!r.ok || meta.status !== true) {
    // a validation error names the field: show its first message, else the general one
    const first = meta.errors && Object.values(meta.errors).flat()[0];
    throw new Error(first || meta.message || 'http_' + r.status);
  }
  return j.data;
}

module.exports = {
  id: 'artapayamak',
  name: 'آرتا پیامک (IPPanel)',
  help: 'در پنل آرتا پیامک یک «الگو» (پترن) با یک متغیر برای کد بسازید، مثلاً «کد ورود سپن: %code%»، و صبر کنید تأیید شود. توکن API را از بخش «توسعه‌دهندگان / کلید API» بردارید.',
  fields: [
    { key: 'token', label: 'توکن API', secret: true, re: /^[\x21-\x7e]{8,400}$/ },
    { key: 'from', label: 'شمارهٔ خط ارسال', placeholder: '+983000505', re: /^\+?\d{4,16}$/ },
    { key: 'pattern', label: 'کد الگو', placeholder: 'مثلاً qka6e0fb86auvc4', re: /^[A-Za-z0-9_-]{1,64}$/ },
    { key: 'param', label: 'نام متغیر کد', def: 'code', re: /^[A-Za-z0-9_]{1,40}$/ },
  ],
  async send(c, phone, code) {
    await call('/api/send', 'POST', {
      sending_type: 'pattern', from_number: lineNumber(c.from), code: c.pattern, recipients: [phone], params: { [c.param]: code },
    }, c.token);
  },
  async credit(c) {
    const d = await call('/api/payment/credit/mine', 'GET', undefined, c.token);
    return d && d.credit;
  },
  lineNumber,
};
