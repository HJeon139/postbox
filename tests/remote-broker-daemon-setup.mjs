// The in-process daemon and a socket-shaped shim that tests/remote-broker-daemon.test.mjs and tests/remote-link-loss.test.mjs
// share: fake runners, Postbox as a pair of streams, a shim as a pair of functions.

import { writeFileSync } from 'node:fs';
import { Duplex, PassThrough } from 'node:stream';
import { createDaemon } from '../server/remote/host/daemon.mjs';
import { encode, message, TURN_FILES } from '../shared/remote-protocol.mjs';
import { BOOT, VERSION } from './remote-broker-fixtures.mjs';

/** The daemon in-process, with fake runners: a held stdin’s writes are kept in `writes`. @param {string} home */
export function inProcessDaemon(home) {
  const alive = new Set();
  const writes = [];
  let pid = 4000;
  const daemon = createDaemon({
    home,
    version: VERSION,
    // logind’s facts, which the daemon asks at each hello (the lingering warning): none, as on a host without systemd.
    logind: () => ({ killUserProcesses: null, linger: null }),
    async launchRunner(o) {
      writeFileSync(o.paths.turn(o.turn, TURN_FILES.runner), JSON.stringify({ turn: o.turn, version: VERSION, pid: ++pid, bootId: BOOT, startTime: 1 }), {
        mode: 0o600,
      });
      alive.add(o.turn);
      return { pid, scoped: false, lingerOff: false };
    },
    askRunner: async (_path, turn) => alive.has(turn),
    proc: { sameProcess: async () => true, toolGroups: () => [], liveGroups: () => [] },
    async writeRunner(o) {
      writes.push(o.line);
      return 10;
    },
    findPrograms: async () => ({
      node: { path: '/usr/bin/node', version: 'v22.12.0' },
      harnesses: [
        { name: 'claude-code', path: '/usr/bin/claude', version: '2.1.300', looked: [] },
        { name: 'codex', path: '/usr/bin/codex', version: '0.50.0', looked: [] },
      ],
      problems: [],
    }),
    kill: () => {},
    log: () => {},
    pollMs: 10,
    stopGraceMs: 60_000,
  });
  return { daemon, writes };
}

/** A shim, over a socket-shaped pair, as accept() sees one: what it got, and a function that sends. @param {any} daemon */
export function socketShim(daemon) {
  const toDaemon = new PassThrough();
  const fromDaemon = new PassThrough();
  daemon.accept(/** @type {any} */ (Duplex.from({ readable: toDaemon, writable: fromDaemon })));
  const got = [];
  let buf = '';
  fromDaemon.on('data', (d) => {
    buf += d;
    for (let nl = buf.indexOf('\n'); nl !== -1; nl = buf.indexOf('\n')) {
      got.push(JSON.parse(buf.slice(0, nl)));
      buf = buf.slice(nl + 1);
    }
  });
  const shimSend = (type, body) => toDaemon.write(encode(message('shim-to-daemon', type, body)));
  return { got, shimSend, toDaemon };
}
