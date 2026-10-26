// The daemon’s entry point (#120), which the `host` launcher beside it runs with the Node it found:
// `<node> host.mjs attach` (the relay ssh runs, starting the daemon first if none answers), `host.mjs serve` (the
// daemon) and `host.mjs token` (install’s step that makes the token if it’s missing and prints it). daemon.mjs’s header
// says how attach and serve work. The command line is fixed, and everything else arrives as JSON lines on stdin, so
// the login shell never parses a prompt, a path or a setting.

import { main } from './daemon.mjs';

main({ argv: process.argv.slice(2) }).then(
  (code) => process.exit(code),
  (e) => {
    process.stderr.write(`postbox host: ${e.stack ?? e.message}\n`);
    process.exit(70);
  },
);
