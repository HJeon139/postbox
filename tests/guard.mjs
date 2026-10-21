// Loaded before every test file (npm test): tests must be fast and self-contained, so anything that would
// reach the network or start a real process fails loudly instead. Adapters take fake spawn/fork functions,
// and the runtime takes a stub corpus, so none of them need the real thing.

import childProcess from 'node:child_process';
import http from 'node:http';
import https from 'node:https';
import { syncBuiltinESMExports } from 'node:module';
import net from 'node:net';

const refuse = (what) => () => {
  throw new Error(`A test tried to ${what}. Tests must not touch the network or start processes; pass a fake instead.`);
};

globalThis.fetch = refuse('fetch a URL');
net.connect = net.createConnection = refuse('open a network connection');
net.Socket.prototype.connect = refuse('open a network connection');
http.request = http.get = refuse('make an HTTP request');
https.request = https.get = refuse('make an HTTPS request');
for (const fn of ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork']) childProcess[fn] = refuse(`start a process (${fn})`);
// Named imports (import { spawn } from 'node:child_process') see the replacements too.
syncBuiltinESMExports();
