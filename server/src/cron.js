'use strict';
// Minimal 5-field cron: minute hour day-of-month month day-of-week. Supports *, lists, ranges, steps.
const RANGES = [[0, 59], [0, 23], [1, 31], [1, 12], [0, 7]];

function parseField(src, [lo, hi]) {
  const set = new Set();
  for (const part of src.split(',')) {
    const m = /^(\*|\d+(?:-\d+)?)(?:\/(\d+))?$/.exec(part);
    if (!m) throw new Error('bad cron field: ' + src);
    const step = m[2] ? Number(m[2]) : 1;
    if (step < 1) throw new Error('bad step');
    let a, b;
    if (m[1] === '*') { a = lo; b = hi; }
    else if (m[1].includes('-')) { [a, b] = m[1].split('-').map(Number); }
    else { a = Number(m[1]); b = m[2] ? hi : a; }
    if (a < lo || b > hi || a > b) throw new Error('cron value out of range: ' + src);
    for (let v = a; v <= b; v += step) set.add(v);
  }
  return set;
}

function parse(expr) {
  const f = String(expr).trim().split(/\s+/);
  if (f.length !== 5) throw new Error('cron must have 5 fields');
  const sets = f.map((x, i) => parseField(x, RANGES[i]));
  if (sets[4].has(7)) sets[4].add(0);
  return { sets, domStar: f[2].startsWith('*'), dowStar: f[4].startsWith('*') };
}

function matches(c, d) {
  const [mi, ho, dom, mo, dow] = c.sets;
  if (!mi.has(d.getMinutes()) || !ho.has(d.getHours()) || !mo.has(d.getMonth() + 1)) return false;
  const domOk = dom.has(d.getDate());
  const dowOk = dow.has(d.getDay());
  if (c.domStar || c.dowStar) return domOk && dowOk;
  return domOk || dowOk; // classic cron: both restricted -> either
}

function nextRun(expr, from = new Date()) {
  const c = parse(expr);
  const d = new Date(from.getTime());
  d.setSeconds(0, 0);
  d.setMinutes(d.getMinutes() + 1);
  for (let i = 0; i < 366 * 24 * 60; i++) {
    if (matches(c, d)) return d;
    d.setMinutes(d.getMinutes() + 1);
  }
  return null;
}

module.exports = { parse, matches, nextRun };
