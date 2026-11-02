// HTTP client for the messenger API (same endpoints as android/.../Api.kt). The web app is served
// from the same origin as the API, so there is no CORS and no extra configuration.
export class HttpError extends Error {
  constructor(status, body) {
    super(body && body.error ? body.error : 'http_' + status);
    this.status = status;
    this.body = body || {};
  }
}

let token = null;
export const setToken = (t) => { token = t; };
export const getToken = () => token;

async function call(method, path, body, headers = {}) {
  const h = { ...headers };
  if (token) h.authorization = 'Bearer ' + token;
  let payload = body;
  if (body !== undefined && !(body instanceof Uint8Array) && !(body instanceof Blob)) {
    payload = JSON.stringify(body);
    h['content-type'] = 'application/json';
  }
  const r = await fetch(path, { method, headers: h, body: payload, cache: 'no-store' });
  const ct = r.headers.get('content-type') || '';
  const data = ct.includes('json') ? await r.json().catch(() => ({})) : null;
  if (!r.ok) throw new HttpError(r.status, data);
  return data;
}

export const login = (username, password) => call('POST', '/api/login', { username, password });
export const authConfig = () => call('GET', '/api/auth/config');
export const smsCode = (phone) => call('POST', '/api/auth/sms', { phone });
export const codeLogin = (phone, code, device) => call('POST', '/api/auth/code', { phone, code, device });
export const deviceCode = () => call('POST', '/api/auth/devicecode', {});
export const reauthSms = () => call('POST', '/api/auth/reauth', {});
export const signup = (ticket, username, display_name, device) => call('POST', '/api/auth/signup', { ticket, username, display_name, device });
export const lookup = (phones) => call('POST', '/api/contacts/lookup', { phones });
export const getKeyBackup = () => call('GET', '/api/keybackup');
export const saveKeyBackup = (key_backup, password) => call('POST', '/api/keybackup', { key_backup, password });
export const logout = () => call('POST', '/api/logout', {});
export const me = () => call('GET', '/api/me');
export const users = () => call('GET', '/api/users');
export const groups = () => call('GET', '/api/groups');
export const setPubkey = (pubkey) => call('POST', '/api/pubkey', { pubkey });
export const editMessage = (id, payload, prev) => call('POST', '/api/edit', { id, payload, prev });
export const deleteMessage = (id) => call('POST', '/api/delete', { id });
export const messageHistory = (id) => call('GET', '/api/history?id=' + id);
export const setProfile = (display_name, bio) => call('POST', '/api/profile', { display_name, bio });
export const uploadAvatar = (webp) => call('POST', '/api/avatar', webp, { 'content-type': 'image/webp' });
export const deleteAvatar = () => call('DELETE', '/api/avatar');
export const pin = (target, messageId) => call('POST', '/api/pin', { target, messageId });
export const send = (target, payload, fileId) => call('POST', '/api/send', fileId ? { target, kind: 'msg', payload, fileId } : { target, kind: 'msg', payload });
export const signal = (target, kind, payload) => call('POST', '/api/send', { target, kind, payload }).then((r) => !!r.delivered);
export const turn = () => call('GET', '/api/turn');
export const contactRequests = () => call('GET', '/api/contacts/requests');
export const contactAction = (what, username, accept = false) => call('POST', '/api/contacts/' + what, { username, accept });
export const caInfo = () => call('GET', '/api/web/ca');
export const receipts = (items) => call('POST', '/api/receipts', { items });
export const typing = (target) => call('POST', '/api/typing', { target });
export const react = (id, emoji) => call('POST', '/api/react', { id, emoji });
// keepalive: also delivered when the page is being closed / sent to the background
export const presence = (dev, active) => fetch('/api/presence', {
  method: 'POST', keepalive: true, headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json' }, body: JSON.stringify({ dev, active }),
});
export const privacy = (p) => call('POST', '/api/privacy', p);
export const pushKey = () => call('GET', '/api/push/key');
export const pushSubscribe = (subscription) => call('POST', '/api/push/subscribe', { subscription });
export const pushUnsubscribe = (endpoint) => call('POST', '/api/push/unsubscribe', { endpoint });
export const pushTest = () => call('POST', '/api/push/test');

export const createUpload = (size) => call('POST', '/api/uploads', { size });
export const uploadStatus = (id) => call('GET', '/api/uploads/' + id);
export const patchUpload = (id, offset, bytes) => call('PATCH', '/api/uploads/' + id, bytes, { 'upload-offset': String(offset), 'content-type': 'application/octet-stream' });

export async function avatar(user) {
  const r = await fetch('/api/avatar/' + encodeURIComponent(user), { headers: { authorization: 'Bearer ' + token } });
  if (!r.ok) throw new HttpError(r.status);
  return r.blob();
}

/** Downloads [start, end] of an encrypted file (end inclusive). */
export async function fileRange(id, start, end) {
  const r = await fetch('/api/file/' + id, { headers: { authorization: 'Bearer ' + token, range: `bytes=${start}-${end}` } });
  if (r.status !== 200 && r.status !== 206) throw new HttpError(r.status);
  return new Uint8Array(await r.arrayBuffer());
}

/**
 * Live events (Server-Sent Events read with fetch, because EventSource cannot send the Authorization
 * header). Resolves when the stream ends; rejects on errors. `signal` aborts it.
 */
export async function stream(since, csince, rsince, dev, active, abort, onOpen, onEvent) {
  const q = `since=${since}&csince=${csince}&rsince=${rsince}&dev=${encodeURIComponent(dev)}&active=${active ? 1 : 0}`;
  const r = await fetch('/api/events?' + q, { headers: { authorization: 'Bearer ' + token, accept: 'text/event-stream' }, signal: abort, cache: 'no-store' });
  if (!r.ok) throw new HttpError(r.status);
  onOpen();
  const reader = r.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  let event = 'message';
  let data = [];
  for (;;) {
    const { value, done } = await reader.read();
    if (done) return;
    buf += dec.decode(value, { stream: true });
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).replace(/\r$/, '');
      buf = buf.slice(i + 1);
      if (line === '') {
        if (data.length) onEvent(event, data.join('\n'));
        event = 'message'; data = [];
      } else if (line[0] === ':') onEvent('ping', '');
      else if (line.startsWith('event:')) event = line.slice(6).trim();
      else if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''));
    }
  }
}
