'use strict';
/**
 * 1.25: entry point of the packaged server executable (tools/package builds it from this file).
 *   sepan-server                 the messenger server (what server.js does in the source tree)
 *   sepan-server cli ARGS        the admin command line (msgadmin), e.g. "cli add ali", "cli setup"
 *   sepan-server license ...     install approval: request code / activate / status (as root, by the installer)
 *   sepan-server version
 */
// a single executable sees [exe, how it was called, ...args], like node [node, script, ...args]
const argv = process.argv.slice(2);
process.argv = [process.execPath, __filename, ...argv];
const cmd = argv[0];

if (cmd === 'cli') {
  process.argv.splice(2, 1);
  require('./cli');
} else if (cmd === 'license') {
  process.exitCode = require('./license').cli(argv.slice(1));
} else if (cmd === 'version' || cmd === '--version') {
  console.log(require('./license').VERSION);
} else {
  require('./server');
}
