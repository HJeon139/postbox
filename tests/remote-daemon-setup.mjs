// What the daemon’s unit tests share (tests/remote-daemon*.test.mjs, #120): a daemon over a temp home with fake
// runners and process checks (launchRunner, askRunner, sameProcess), so nothing is spawned or signaled; a fake clock;
// turn folders as a runner leaves them; and `host attach` over a fake socket.

import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Duplex, PassThrough } from 'node:stream';
import { createDaemon, main } from '../server/remote/host/daemon.mjs';
import { hostVersion } from '../server/remote/host/paths.mjs';
import { encode, hostPaths, MESSAGE_FILE, message, PROTOCOL_VERSION, TURN_FILES } from '../shared/remote-protocol.mjs';
import { readMessages } from './fake-daemon.mjs';

export const TOKEN = 'a'.repeat(64);
export const BOOT = '0f1e2d3c-4b5a-4968-8776-655443322110';
// This checkout’s version, which main() takes from package.json (paths.mjs), so the tests follow each release.
export const VERSION = hostVersion();
export const PROGRAMS_FOUND = {
  node: { path: '/usr/bin/node', version: 'v22.12.0' },
  harnesses: [
    { name: 'claude-code', path: '/home/user/.local/bin/claude', version: '2.1.296', looked: ['/home/user/.local/bin/claude'] },
    { name: 'kiro-cli', path: null, version: null, looked: ['/home/user/.local/bin/kiro-cli', '/usr/local/bin/kiro-cli'] },
    { name: 'codex', path: '/home/user/.local/bin/codex', version: '0.50.0', looked: ['/home/user/.local/bin/codex'] },
  ],
  problems: [],
};

/** A fake clock: now() and timers that run only when tick() passes them. */
export function fakeClock(t0 = 1_760_000_000_000) {
  let t = t0;
  /** @type {{ at: number, fn: () => any }[]} */
  const queue = [];
  return {
    now: () => t,
    timers: {
      setTimeout(fn, ms) {
        const h = { at: t + ms, fn };
        queue.push(h);
        return h;
      },
      clearTimeout(h) {
        const i = queue.indexOf(h);
        if (i !== -1) queue.splice(i, 1);
      },
    },
    queue,
    async tick(ms) {
      t += ms;
      for (;;) {
        const due = queue.filter((h) => h.at <= t).sort((a, b) => a.at - b.at)[0];
        if (!due) return;
        queue.splice(queue.indexOf(due), 1);
        await due.fn();
      }
    },
  };
}

/**
 * A daemon over a temp home, with fake runners.
 * @param {{ token?: string | null, same?: boolean, clock?: ReturnType<typeof fakeClock>, onIdle?: () => void, settings?: object, uid?: number, spawn?: any, broker?: any }} [o]
 *   spawn: the daemon’s own spawn, for the sign-in check (the runners are launchRunner’s, faked here). broker: in place
 *   of the daemon’s own.
 */
export function setup({ token = TOKEN, same = true, clock, onIdle, uid, spawn, broker } = {}) {
  // A short folder name: a turn’s socket path must fit Linux’s 108 bytes, and macOS’s tmpdir is long.
  const home = mkdtempSync(join(tmpdir(), 'pbd-'));
  const p = hostPaths(home, VERSION);
  if (token) {
    mkdirSync(p.root, { recursive: true, mode: 0o700 });
    writeFileSync(p.token, token, { mode: 0o600 });
  }
  const alive = new Set();
  const launches = [];
  const kills = [];
  const writes = [];
  const asks = [];
  /** What the fake launchRunner reports: runner.mjs’s scoped and lingerOff. */
  /**
   * What the fake proc reports: toolGroups’ answers, one per call (null: the processes can’t be listed), and the
   * groups liveGroups finds gone. launching: what launchRunner waits for before its runner is up. logind: what the
   * daemon’s logind check finds (runner.mjs’s logindFacts), and logindAsks how often it was asked.
   * @type {{ same: boolean, scoped: boolean, lingerOff: boolean, refuse: string, groups: any[][] | null, goneGroups: number[], launching: Promise<void> | null,
   *   logind: { killUserProcesses: boolean | null, linger: boolean | null }, logindAsks: number }}
   */
  const state = {
    same,
    scoped: false,
    lingerOff: false,
    refuse: '',
    groups: [],
    goneGroups: [],
    launching: null,
    logind: { killUserProcesses: null, linger: null },
    logindAsks: 0,
  };
  const groupLookups = [];
  const daemon = createDaemon({
    home,
    version: VERSION,
    ...(clock ? { now: clock.now, timers: clock.timers } : {}),
    ...fakeRunners(state, { alive, launches, asks, groupLookups }),
    async writeRunner(o) {
      writes.push(o);
      return 42;
    },
    findPrograms: async () => structuredClone(PROGRAMS_FOUND),
    kill: (pid, signal) => kills.push([pid, signal]),
    log: () => {},
    onIdle,
    pollMs: 10,
    stopGraceMs: 5000,
    ...(uid === undefined ? {} : { uid }),
    ...(spawn ? { spawn } : {}),
    ...(broker ? { broker } : {}),
  });
  const connect = () => connectTo(daemon);
  const done = () => {
    daemon.close();
    rmSync(home, { recursive: true, force: true });
  };
  return { home, p, daemon, alive, launches, kills, writes, asks, connect, done, state, groupLookups };
}

/**
 * setup’s fake runners and process checks (launchRunner, askRunner, proc, and logind’s facts), answering from `state`
 * and recording what they were asked.
 */
function fakeRunners(state, { alive, launches, asks, groupLookups }) {
  let pid = 4000;
  return {
    logind: () => {
      state.logindAsks++;
      return state.logind;
    },
    async launchRunner(o) {
      launches.push(o);
      if (state.launching) await state.launching;
      if (state.refuse) {
        // As runner.mjs refuses a turn: the reason in err.log, no runner.json, and it exits.
        writeFileSync(o.paths.turn(o.turn, TURN_FILES.err), `postbox runner: ${state.refuse}\n`, { mode: 0o600 });
        return { pid: ++pid, scoped: false, lingerOff: false };
      }
      const record = { turn: o.turn, version: VERSION, pid: ++pid, bootId: BOOT, startTime: 1234 };
      writeFileSync(o.paths.turn(o.turn, TURN_FILES.runner), JSON.stringify(record), { mode: 0o600 });
      alive.add(o.turn);
      return { pid, scoped: state.scoped, lingerOff: state.lingerOff };
    },
    askRunner: async (path, turn, o) => {
      asks.push({ path, turn, ...o });
      return alive.has(turn);
    },
    proc: {
      sameProcess: async () => state.same,
      toolGroups: (pgid) => {
        groupLookups.push(pgid);
        return state.groups === null ? null : (state.groups.shift() ?? []);
      },
      liveGroups: (groups) => groups.filter((g) => !state.goneGroups.includes(g.pgid)),
    },
  };
}

/** A Postbox channel to the daemon over PassThroughs, not yet said hello. */
function connectTo(daemon) {
  const input = new PassThrough();
  const output = new PassThrough();
  daemon.connect({ input, output });
  const msgs = readMessages(output);
  const send = (type, body = {}) => input.write(encode(message('postbox-to-daemon', type, body)));
  return { input, output, msgs, send };
}

/** A connection that has said hello. */
export async function hello(s, extra = {}) {
  const c = s.connect();
  c.send('hello', { version: PROTOCOL_VERSION, token: TOKEN, ...extra });
  const welcome = await c.msgs.next('welcome');
  return { ...c, welcome };
}

/** A turn folder as a runner leaves it. @param {{ out?: string, exit?: object | null, start?: boolean, harness?: string }} [o] */
export function makeTurn(p, turn, { out = '', exit = null, start = true, harness = 'claude-code' } = {}) {
  mkdirSync(p.turn(turn), { recursive: true, mode: 0o700 });
  if (start)
    writeFileSync(
      p.turn(turn, TURN_FILES.start),
      JSON.stringify({ turn, harness, program: '/home/user/.local/bin/claude', argv: ['-p'], env: {}, stdin: 'file', folder: '/home/user/work' }),
    );
  writeFileSync(p.turn(turn, TURN_FILES.runner), JSON.stringify({ turn, version: VERSION, pid: 777, bootId: BOOT, startTime: 99 }));
  writeFileSync(p.turn(turn, TURN_FILES.out), out);
  if (exit) writeFileSync(p.turn(turn, TURN_FILES.exit), JSON.stringify(exit));
}

/** Waits for fn() to be true, a few ms at a time. */
export async function until(fn, what, ms = 2000) {
  const end = Date.now() + ms;
  while (!fn()) {
    if (Date.now() > end) assert.fail(`Timed out waiting for ${what}.`);
    await new Promise((r) => setTimeout(r, 2));
  }
}

/** Every `line` a connection gets for a turn until its `ended`. */
export async function linesUntilEnded(msgs, timeoutMs = 2000) {
  const ended = await msgs.next('ended', timeoutMs);
  return { lines: msgs.messages.filter((m) => m.type === 'line'), ended };
}

export const startMsg = (turn, over = {}) => ({
  turn,
  harness: 'claude-code',
  folder: '/tmp',
  argv: ['-p', '--output-format', 'stream-json'],
  env: { CLAUDE_CODE_ENTRYPOINT: 'postbox' },
  stdin: 'file',
  files: [{ name: MESSAGE_FILE, text: '{"type":"user"}\n' }],
  ...over,
});

/**
 * Runs `host attach` with a fake socket that answers once something is spawned, through one hello and welcome.
 * @param {string} home @param {(ms: number) => Promise<void>} sleep @param {object} [opts]  more of main’s options
 */
export async function attachOnce(home, sleep, opts = {}) {
  let served = false;
  const spawned = [];
  const toDaemon = [];
  const fromDaemon = new PassThrough();
  const connect = () => {
    const sock = new Duplex({
      read() {},
      write(chunk, _enc, cb) {
        toDaemon.push(String(chunk));
        cb();
      },
    });
    process.nextTick(() => {
      if (!served) return sock.emit('error', Object.assign(new Error('no socket'), { code: 'ENOENT' }));
      fromDaemon.on('data', (d) => sock.push(d));
      fromDaemon.on('end', () => {
        sock.push(null);
        sock.destroy();
      });
      sock.emit('connect');
    });
    return /** @type {any} */ (sock);
  };
  const spawn = (cmd, args, opts) => {
    spawned.push({ cmd, args, opts });
    served = true;
    return { on() {}, unref() {} };
  };
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const out = [];
  stdout.on('data', (d) => out.push(String(d)));
  const running = main({ argv: ['attach'], getuid: () => 1000, stdin, stdout, stderr: { write: () => {} }, home, connect, spawn, sleep, ...opts });
  stdin.write('{"type":"hello"}\n');
  await waitFor(() => toDaemon.length > 0);
  fromDaemon.write('{"type":"welcome"}\n');
  await waitFor(() => out.length > 0);
  fromDaemon.end();
  return { code: await running, spawned, toDaemon, out };
}

/** Waits for a condition the daemon reaches asynchronously, without sleeping a fixed time. */
export async function waitFor(cond, timeoutMs = 2000) {
  const until = Date.now() + timeoutMs;
  while (!cond()) {
    if (Date.now() > until) throw new Error('Timed out waiting.');
    await new Promise((r) => setTimeout(r, 5));
  }
}
