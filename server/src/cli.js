'use strict';
const { db, setSetting, getSetting, hashPassword } = require('./db');
const core = require('./core');

const [, , cmd, name, ...rest] = process.argv;

function need() {
  if (!name || !core.NAME_RE.test(name) || name === 'all') {
    console.error('Username: 2-20 chars of a-z, 0-9, _ (and not "all")');
    process.exit(1);
  }
}

if (cmd === 'add') {
  need();
  try {
    const hasDefault = !!db.prepare('SELECT 1 FROM categories WHERE id=1').get();
    const pw = core.createUser(name, rest.join(' '), hasDefault ? [1] : []);
    console.log(`User: ${name}\nPassword: ${pw}\n(Shown once. Give it to the user privately.)`);
    console.log('Note: set who this user can see in the admin panel ("ارتباط کاربران" tab).');
  } catch (e) { console.error('Error:', e.message); process.exit(1); }
} else if (cmd === 'reset') {
  need();
  try { const pw = core.resetPassword(name); console.log(`User: ${name}\nNew password: ${pw}\n(All their sessions were logged out.)`); }
  catch (e) { console.error('Error:', e.message); process.exit(1); }
} else if (cmd === 'del') {
  need();
  require('./ugroups').userDeleted(name);
  console.log(core.deleteUser(name) ? 'Deleted.' : 'No such user');
} else if (cmd === 'list') {
  for (const u of db.prepare('SELECT username,display_name,disabled,created FROM users ORDER BY username').all())
    console.log(u.username, u.display_name || '-', u.disabled ? '(disabled)' : '', new Date(u.created).toISOString().slice(0, 10));
} else if (cmd === 'adminpw') {
  const pw = core.genPw();
  setSetting('admin_pass', hashPassword(pw));
  const user = getSetting('admin_user', 'admin');
  console.log(`Admin panel password: ${pw}\nAdmin panel username: ${user}\n(Shown once. Run "msgadmin adminpw" again to reset it.)`);
} else if (cmd === 'totp-off') {
  // 1.18: the authenticator phone is lost: sign in to the panel with the password alone, then turn it on again
  require('./totp').disable();
  console.log('Admin panel second factor (authenticator code) is OFF. Turn it on again in the panel: «حساب مدیر».');
} else if (cmd === 'devices-off') {
  // 1.24: a phone with the «سپن مدیر» app was lost: remove every paired phone (their open sessions end too)
  const n = require('./admindevices').removeAll();
  console.log(`Removed ${n} paired admin phone(s). Pair again from the app after signing in with the password.`);
} else if (cmd === 'adminuser') {
  if (!name || !/^[a-z0-9_.\-]{3,32}$/.test(name)) { console.error('Admin username: 3-32 chars of a-z, 0-9, _ . -'); process.exit(1); }
  setSetting('admin_user', name);
  console.log(`Admin panel username: ${name}`);
} else if (cmd === 'setup') {
  // 1.25: the installer (sepan-setup.sh) writes its answers as JSON on stdin (secrets never on the command line)
  let a;
  try { a = JSON.parse(require('node:fs').readFileSync(0, 'utf8')); } catch { console.error('setup: JSON on stdin expected'); process.exit(1); }
  const out = [];
  if (a.app_name !== undefined) { setSetting('app_name', String(a.app_name).trim().slice(0, 30)); out.push('app name'); }
  if (a.admin_user) {
    if (!/^[a-z0-9_.\-]{3,32}$/.test(a.admin_user)) { console.error('Admin username: 3-32 chars of a-z, 0-9, _ . -'); process.exit(1); }
    setSetting('admin_user', a.admin_user); out.push('admin user');
  }
  if (a.admin_pass) {
    if (String(a.admin_pass).length < 8) { console.error('Admin password: at least 8 characters'); process.exit(1); }
    setSetting('admin_pass', hashPassword(String(a.admin_pass))); out.push('admin password');
  }
  if (typeof a.open_signup === 'boolean') { setSetting('open_signup', a.open_signup ? '1' : '0'); out.push('signup'); }
  if (typeof a.group_calls === 'boolean') { setSetting('gcall_on', a.group_calls ? '1' : '0'); out.push('group calls'); }
  if (a.sms && a.sms.provider) {
    try { require('./sms').update(a.sms.provider, a.sms.values || {}); setSetting('sms_enabled', '1'); out.push('sms'); }
    catch (e) { console.error('SMS settings: ' + e.message); process.exit(1); }
  }
  console.log('Saved: ' + (out.join(', ') || 'nothing'));
} else if (cmd === 'sms-test') {
  // 1.25: one test code to the given number with the configured provider (used by the installer)
  require('./sms').send(String(name || ''), String(100000 + require('node:crypto').randomInt(900000)))
    .then(() => console.log('SMS SENT'), (e) => { console.error('SMS FAILED: ' + e.message); process.exit(1); });
} else if (cmd === 'license') {
  process.exitCode = require('./license').cli(process.argv.slice(3));
} else {
  console.log('Usage: msgadmin add|reset|del <username> [display name]  |  msgadmin list  |  msgadmin adminpw  |  msgadmin adminuser <name>  |  msgadmin totp-off  |  msgadmin devices-off');
}
