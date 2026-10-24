'use strict';
// Copies server/src into a temp app directory so tests run exactly the code that gets installed.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const SRC_DIR = path.join(__dirname, '..', '..', 'server', 'src');

function extractApp() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pchat-test-'));
  const appDir = path.join(root, 'app');
  const dataDir = path.join(root, 'data');
  fs.cpSync(SRC_DIR, appDir, { recursive: true });
  const files = fs.readdirSync(appDir);
  if (!files.includes('server.js') || !files.includes('core.js')) throw new Error('server source not found in server/src');
  return { root, appDir, dataDir, files, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

module.exports = { extractApp };
