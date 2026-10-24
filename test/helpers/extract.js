'use strict';
// The server source only lives as heredocs inside server/upgrade-a.sh.
// Pull every `cat > $APP/<file> <<'MSG_FILE_EOF'` block out into a temp app directory,
// so tests run exactly the code that gets installed on the VPS.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const SCRIPT = path.join(__dirname, '..', '..', 'server', 'upgrade-a.sh');

function extractApp() {
  const src = fs.readFileSync(SCRIPT, 'utf8');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pchat-test-'));
  const appDir = path.join(root, 'app');
  const dataDir = path.join(root, 'data');
  fs.mkdirSync(appDir);
  const re = /^cat > \$APP\/([\w.-]+) <<'MSG_FILE_EOF'\n([\s\S]*?)^MSG_FILE_EOF$/gm;
  const files = [];
  for (let m; (m = re.exec(src));) {
    fs.writeFileSync(path.join(appDir, m[1]), m[2]);
    files.push(m[1]);
  }
  if (!files.includes('server.js') || !files.includes('core.js')) throw new Error('could not extract server files from upgrade-a.sh');
  return { root, appDir, dataDir, files, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

module.exports = { extractApp };
