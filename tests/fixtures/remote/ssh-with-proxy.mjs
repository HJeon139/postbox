// A stand-in for ssh with a ProxyCommand, for tests/integration/remote-ssh-exit.test.mjs: it starts a “proxy” that
// inherits its stderr and outlives it, as a VPN’s ProxyCommand did when the live UAT killed ssh (#120), then
// answers hello with a welcome and stays up. It writes its own PID and the proxy’s to the file PB_SSH_PIDS names.

import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { encode, message, PROTOCOL_VERSION } from '../../../shared/remote-protocol.mjs';

const proxy = spawn('/bin/sh', ['-c', 'exec sleep 60'], { stdio: ['ignore', 'ignore', 'inherit'] });
writeFileSync(String(process.env.PB_SSH_PIDS), JSON.stringify({ ssh: process.pid, proxy: proxy.pid }));
process.stdin.once('data', () => {
  const welcome = {
    version: PROTOCOL_VERSION,
    home: '/home/user',
    node: { path: '/usr/bin/node', version: 'v22.12.0' },
    harnesses: [],
    problems: [],
    turns: [],
  };
  process.stdout.write(encode(message('daemon-to-postbox', 'welcome', welcome)));
});
setInterval(() => {}, 1000);
