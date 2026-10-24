'use strict';
const { db, setSetting, hashPassword } = require('./db');
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
    console.log('Note: set who this user can see in the admin panel (visibility matrix).');
  } catch (e) { console.error('Error:', e.message); process.exit(1); }
} else if (cmd === 'reset') {
  need();
  try { const pw = core.resetPassword(name); console.log(`User: ${name}\nNew password: ${pw}\n(All their sessions were logged out.)`); }
  catch (e) { console.error('Error:', e.message); process.exit(1); }
} else if (cmd === 'del') {
  need();
  console.log(core.deleteUser(name) ? 'Deleted.' : 'No such user');
} else if (cmd === 'list') {
  for (const u of db.prepare('SELECT username,display_name,disabled,created FROM users ORDER BY username').all())
    console.log(u.username, u.display_name || '-', u.disabled ? '(disabled)' : '', new Date(u.created).toISOString().slice(0, 10));
} else if (cmd === 'adminpw') {
  const pw = core.genPw();
  setSetting('admin_pass', hashPassword(pw));
  console.log(`Admin panel password: ${pw}\n(Shown once. Run "msgadmin adminpw" again to reset it.)`);
} else {
  console.log('Usage: msgadmin add|reset|del <username> [display name]  |  msgadmin list  |  msgadmin adminpw');
}
