// What the cleanup tests share (tests/remote-cleanup*.test.mjs, #120): a temp home with cleanup over it and a fake
// process check, turn folders as the daemon and a runner leave them, and an in-process daemon with fake runners over
// PassThrough streams, as tests/remote-daemon.test.mjs drives it.

import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { createCleanup } from '../server/remote/host/cleanup.mjs';
import { createDaemon } from '../server/remote/host/daemon.mjs';
import { encode, hostPaths, MESSAGE_FILE, message, PROTOCOL_VERSION, TURN_FILES } from '../shared/remote-protocol.mjs';
import { readMessages } from './fake-daemon.mjs';

export const VERSION = '0.10.0';
export const BOOT = '0f1e2d3c-4b5a-4968-8776-655443322110';
export const TOKEN = 'a'.repeat(64);
export const DAY = 24 * 3600 * 1000;
export const RETENTION = 7 * DAY;

/** A temp home, and cleanup over it whose process check says yes for the PIDs in `alive`. */
export function setup({ version = VERSION, logMaxBytes = 1 << 20, clock = 0 } = {}) {
  const home = mkdtempSync(join(tmpdir(), 'pbc-'));
  const p = hostPaths(home, version);
  mkdirSync(p.turns, { recursive: true, mode: 0o700 });
  writeFileSync(p.token, TOKEN, { mode: 0o600 });
  const alive = new Set();
  const stops = [];
  const caps = [];
  const logs = [];
  const time = { skew: clock };
  const cleanup = createCleanup({
    home,
    version,
    paths: p,
    now: () => Date.now() + time.skew,
    log: (l) => logs.push(l),
    settings: () => ({ logRetention: RETENTION, logMaxBytes }),
    sameProcess: (r) => alive.has(r.pid),
    stopTurn: async (turn) => stops.push(turn),
    onCap: (turn, text) => caps.push({ turn, text }),
  });
  return { home, p, alive, stops, caps, logs, time, cleanup, done: () => rmSync(home, { recursive: true, force: true }) };
}

/**
 * A turn folder as the daemon and a runner leave it.
 * @param {{ out?: string, exit?: boolean, pid?: number, version?: string, runner?: boolean, files?: Record<string, string> }} [o]
 */
export function makeTurn(p, turn, { out = '{"n":1}\n{"n":2}\n', exit = true, pid = 777, version = VERSION, runner = true, files = {} } = {}) {
  const dir = p.turn(turn);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeFileSync(
    join(dir, TURN_FILES.start),
    JSON.stringify({ turn, harness: 'claude-code', program: '/home/user/.local/bin/claude', argv: [], env: {}, stdin: 'file', folder: '/home/user/work' }),
  );
  if (runner) writeFileSync(join(dir, TURN_FILES.runner), JSON.stringify({ turn, version, pid, bootId: BOOT, startTime: 99 }));
  writeFileSync(join(dir, TURN_FILES.out), out);
  writeFileSync(join(dir, TURN_FILES.err), 'warning\n');
  writeFileSync(join(dir, MESSAGE_FILE), '{"type":"user"}\n');
  writeFileSync(join(dir, TURN_FILES.snapshot), '{}');
  writeFileSync(join(dir, TURN_FILES.tools), '');
  for (const [name, text] of Object.entries(files)) writeFileSync(join(dir, name), text);
  if (exit) writeFileSync(join(dir, TURN_FILES.exit), JSON.stringify({ code: 0, signal: null, at: 5 }));
  return dir;
}
export const ls = (dir) => readdirSync(dir).sort();
/** Waits for check() to hold, looking every 10 ms. */
export async function until(check, what, ms = 2000) {
  for (const end = Date.now() + ms; Date.now() < end; await new Promise((r) => setTimeout(r, 10))) if (check()) return;
  throw new Error(`Timed out waiting for ${what}.`);
}

// ── Through the daemon ──

/** What the daemon’s findPrograms finds: Node, Claude Code and Kiro. */
const FOUND = {
  node: { path: '/usr/bin/node', version: 'v22.12.0' },
  harnesses: [
    { name: 'claude-code', path: '/home/user/.local/bin/claude', version: '2.1.296', looked: [] },
    { name: 'kiro-cli', path: '/home/user/.local/bin/kiro-cli', version: '1.0.0', looked: [] },
  ],
  problems: [],
};

/** A Postbox channel to the daemon, said hello with the token, taking over. */
async function connectTo(daemon) {
  const input = new PassThrough();
  const output = new PassThrough();
  daemon.connect({ input, output });
  const msgs = readMessages(output);
  const send = (type, body = {}) => input.write(encode(message('postbox-to-daemon', type, body)));
  send('hello', { version: PROTOCOL_VERSION, token: TOKEN, takeover: true });
  const welcome = await msgs.next('welcome');
  return { msgs, send, welcome, output };
}

export function daemonSetup({ home = mkdtempSync(join(tmpdir(), 'pbd-')), onRemoved = () => {}, env = {}, stuck = new Set(), launching = null } = {}) {
  const p = hostPaths(home, VERSION);
  mkdirSync(p.root, { recursive: true, mode: 0o700 });
  writeFileSync(p.token, TOKEN, { mode: 0o600 });
  const alive = new Set();
  const kills = [];
  let pid = 4000;
  const daemon = createDaemon({
    home,
    version: VERSION,
    // The daemon’s own environment, which the runner inherits: KIRO_HOME, for the Kiro home an agent file goes in.
    env,
    // logind’s facts, which the daemon asks at each hello (the lingering warning): none, as on a host without systemd.
    logind: () => ({ killUserProcesses: null, linger: null }),
    async launchRunner(o) {
      if (launching) await launching;
      writeFileSync(o.paths.turn(o.turn, TURN_FILES.runner), JSON.stringify({ turn: o.turn, version: VERSION, pid: ++pid, bootId: BOOT, startTime: 1 }));
      alive.add(o.turn);
      return { pid, scoped: false, lingerOff: false };
    },
    askRunner: async (_path, turn) => alive.has(turn),
    proc: {
      sameProcess: async (r) => alive.has(r.turn ?? ''),
      toolGroups: () => [],
      liveGroups: (g) => g,
    },
    findPrograms: async () => structuredClone(FOUND),
    // A harness that ends on SIGINT: the runner records it.
    kill(target, signal) {
      kills.push([target, signal]);
      for (const turn of [...alive]) {
        const r = JSON.parse(readFileSync(p.turn(turn, TURN_FILES.runner), 'utf8'));
        if (-target === r.pid && !stuck.has(turn)) {
          writeFileSync(p.turn(turn, TURN_FILES.exit), JSON.stringify({ code: null, signal, at: 9 }));
          alive.delete(turn);
        }
      }
    },
    log: () => {},
    onRemoved,
    pollMs: 10,
    stopGraceMs: 50,
    removeWaitMs: 100,
  });
  const connect = () => connectTo(daemon);
  const done = () => {
    daemon.close();
    rmSync(home, { recursive: true, force: true });
  };
  return { home, p, alive, kills, daemon, connect, done, env };
}

export const startMsg = (turn, over = {}) => ({
  turn,
  harness: 'claude-code',
  folder: '/tmp',
  argv: ['-p'],
  env: {},
  stdin: 'file',
  files: [{ name: MESSAGE_FILE, text: '{"type":"user"}\n' }],
  ...over,
});
