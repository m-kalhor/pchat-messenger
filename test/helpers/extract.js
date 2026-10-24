'use strict';
// Copies the server source into a temp app directory so tests run exactly the code that gets installed.
// Source: server/src/ when it exists; otherwise the `cat > $APP/<file> <<'MSG_FILE_EOF'` heredocs
// inside server/upgrade-a.sh (the original layout).
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const SERVER = path.join(__dirname, '..', '..', 'server');
const SRC_DIR = path.join(SERVER, 'src');
const SCRIPT = path.join(SERVER, 'upgrade-a.sh');

function extractApp() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pchat-test-'));
  const appDir = path.join(root, 'app');
  const dataDir = path.join(root, 'data');
  fs.mkdirSync(appDir);
  const files = [];
  if (fs.existsSync(path.join(SRC_DIR, 'server.js'))) {
    for (const f of fs.readdirSync(SRC_DIR)) {
      if (!fs.statSync(path.join(SRC_DIR, f)).isFile()) continue;
      fs.copyFileSync(path.join(SRC_DIR, f), path.join(appDir, f));
      files.push(f);
    }
  } else {
    const src = fs.readFileSync(SCRIPT, 'utf8');
    const re = /^cat > \$APP\/([\w.-]+) <<'MSG_FILE_EOF'\n([\s\S]*?)^MSG_FILE_EOF$/gm;
    for (let m; (m = re.exec(src));) {
      fs.writeFileSync(path.join(appDir, m[1]), m[2]);
      files.push(m[1]);
    }
  }
  if (!files.includes('server.js') || !files.includes('core.js')) throw new Error('could not find server source in server/src or server/upgrade-a.sh');
  return { root, appDir, dataDir, files, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

module.exports = { extractApp };
