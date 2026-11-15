'use strict';
// 1.19: call traffic relayed through our TURN server, per user, for the admin panel's «مصرف کاربران» tab.
// coturn writes one "usage" line (client <-> server) and one "peer usage" line (server <-> the other side) for every
// relayed session when it closes, e.g.
//   session 001000000000000001: usage: realm=<messenger>, username=<1763200000:ali>, rp=1500, rb=240000, sp=1480, sb=236000
// The TURN user name is "<expiry>:<sepan user>" (see /api/turn). Both lines count towards the user who owns the
// session, so the sum is about what the relay costs on the server's traffic quota. Calls on a direct path never
// touch the server and are not in the log. The log is read from where it was when the server started (older lines
// are not counted again after a restart); a rotated or truncated file is read from its start.
const fs = require('node:fs');

const RE = /(peer )?usage: realm=<[^>]*>, username=<([^>]*)>, rp=(\d+), rb=(\d+), sp=(\d+), sb=(\d+)/;

/** Parses one log line: { user, bytes } or null. */
function parse(line) {
  const m = RE.exec(line);
  if (!m) return null;
  const name = m[2];
  const user = name.slice(name.lastIndexOf(':') + 1).toLowerCase();
  if (!user) return null;
  return { user, bytes: Number(m[4]) + Number(m[6]), peer: !!m[1] };
}

function start(file, add, everyMs = 60e3) {
  if (!file) return null;
  let pos = -1, ino = 0, rest = '';
  const MAX = 8 << 20; // at most 8 MB per pass
  function pass() {
    let st;
    try { st = fs.statSync(file); } catch { return; }
    if (pos < 0) { pos = st.size; ino = st.ino; return; } // first look: start at the end
    if (st.ino !== ino || st.size < pos) { pos = 0; ino = st.ino; rest = ''; } // rotated / truncated
    if (st.size === pos) return;
    const len = Math.min(st.size - pos, MAX);
    const buf = Buffer.alloc(len);
    let fd;
    try { fd = fs.openSync(file, 'r'); fs.readSync(fd, buf, 0, len, pos); } catch { return; } finally { if (fd !== undefined) try { fs.closeSync(fd); } catch { } }
    pos += len;
    const lines = (rest + buf.toString('utf8')).split('\n');
    rest = lines.pop();
    if (rest.length > 65536) rest = '';
    for (const l of lines) { const u = parse(l); if (u && u.bytes) add(u.user, 'turn', u.bytes); }
  }
  pass();
  const t = setInterval(pass, everyMs);
  t.unref();
  return { pass, stop: () => clearInterval(t) };
}

module.exports = { start, parse };
