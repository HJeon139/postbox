// Shared setup for the integration tests of the host programs (tests/integration/*.test.mjs): a host home in a temp
// folder (a HOME of its own, so nothing touches the real ~/.postbox-remote), turn folders written as the daemon writes
// them, the real runner.mjs started as the daemon starts it, and the in-process daemon with its own runner functions.
// These tests start real processes and bind local Unix sockets, never the network; tests/guard.mjs isn’t loaded.

import { execFileSync, spawn } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { PassThrough } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { createDaemon } from '../../server/remote/host/daemon.mjs';
import { hostVersion, PROGRAMS } from '../../server/remote/host/paths.mjs';
import { encode, hostPaths, message, PROTOCOL_VERSION } from '../../shared/remote-protocol.mjs';
import { readMessages } from '../fake-daemon.mjs';

export const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'remote');
export const HARNESS = join(FIXTURES, 'harness.mjs');
export const TOKEN = 'tok_0123456789abcdefghijklmnopqrstuvwxyz';
export const TURN = 't1';
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/**
 * p, or `value` once ms have passed. The timer is cleared either way: a race against a bare sleep leaves its timer
 * holding the test file’s process open for the rest of the wait after the test has ended.
 * @template T, U @param {Promise<T>} p @param {number} ms @param {U} value @returns {Promise<T | U>}
 */
export function orAfter(p, ms, value) {
  /** @type {NodeJS.Timeout | undefined} */
  let t;
  return Promise.race([p, new Promise((ok) => (t = setTimeout(ok, ms, value)))]).finally(() => clearTimeout(t));
}
export const UNIX = process.platform === 'linux' || process.platform === 'darwin';
export const NO_UNIX = !UNIX && 'needs Unix sockets and process groups, which this platform doesn’t have';

/** /tmp, not os.tmpdir(): macOS’s is deep enough to push a socket path past sun_path. */
export function makeHost({ token = true } = {}) {
  const home = mkdtempSync('/tmp/pbr-');
  const p = hostPaths(home, hostVersion());
  mkdirSync(p.turns, { recursive: true, mode: 0o700 });
  if (token) writeFileSync(p.token, `${TOKEN}\n`, { mode: 0o600 });
  const work = join(home, 'work');
  mkdirSync(work);
  return { home, p, work, env: { ...process.env, HOME: home } };
}

/** Writes the turn folder and start.json. @param {ReturnType<typeof makeHost>} h @param {object} start */
export function writeTurn(h, start, { message, turn = TURN } = /** @type {{ message?: string, turn?: string }} */ ({})) {
  const dir = h.p.turn(turn);
  mkdirSync(dir, { mode: 0o755 }); // the runner makes it 0700
  if (message !== undefined) writeFileSync(join(dir, 'message.jsonl'), message, { mode: 0o600 });
  const full = { turn, harness: 'claude-code', program: process.execPath, argv: [HARNESS], env: {}, stdin: 'none', folder: h.work, ...start };
  writeFileSync(join(dir, 'start.json'), JSON.stringify(full), { mode: 0o600 });
  return dir;
}

/** Runs the runner as the daemon does (detached, no stdio). @returns {{ pid: number, done: Promise<{ code: number | null, signal: string | null }> }} */
export function startRunner(h, turn = TURN) {
  const child = spawn(process.execPath, [PROGRAMS.runner, turn], { env: h.env, cwd: h.p.turn(turn), detached: true, stdio: 'ignore' });
  const done = new Promise((resolve) => child.on('exit', (code, signal) => resolve({ code, signal })));
  return { pid: /** @type {number} */ (child.pid), done };
}

/** check()’s first truthy value, looked at every 20 ms, within ms. */
export async function until(check, what, ms = 10_000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const v = await check();
    if (v) return v;
    await sleep(20);
  }
  throw new Error(`Timed out waiting for ${what}.`);
}

export const read = (path) => (existsSync(path) ? readFileSync(path, 'utf8') : null);
export const mode = (path) => (existsSync(path) ? lstatSync(path).mode & 0o777 : null);

/** Everything a turn folder holds, after the runner. */
export function folder(dir) {
  const files = ['out.jsonl', 'err.log', 'in.jsonl', 'exit.json', 'runner.json'];
  return {
    dirMode: statSync(dir).mode & 0o777,
    files: Object.fromEntries(files.map((f) => [f, { text: read(join(dir, f)), mode: mode(join(dir, f)) }])),
    sock: existsSync(join(dir, 'sock')),
  };
}

/**
 * Whether a process has gone: no such PID, or a zombie nobody has reaped yet (in a container, PID 1 may not reap
 * orphans).
 * @param {number} pid
 */
export function gone(pid) {
  try {
    process.kill(pid, 0);
  } catch (e) {
    return e.code === 'ESRCH';
  }
  try {
    const stat = process.platform === 'linux' ? readFileSync(`/proc/${pid}/stat`, 'utf8') : null;
    // /proc’s third field, just past comm’s closing paren; ps’s first letter.
    const state = stat ? stat.slice(stat.lastIndexOf(')') + 2)[0] : execFileSync('/bin/ps', ['-o', 'stat=', '-p', String(pid)], { encoding: 'utf8' }).trim()[0];
    return state === 'Z' || state === undefined;
  } catch {
    return true;
  }
}

/**
 * The daemon with its own runner functions (createDaemon’s defaults: launchRunner, askRunner, sendStdin, sameProcess
 * and the tool-shell lookups, none injected). Only findPrograms (each harness is node, given harness.mjs as its first
 * argument) and logind (no systemd scope) are given. connect() is a Postbox that has taken over; close() ends it all.
 * @param {ReturnType<typeof makeHost>} h @param {object} [over]  createDaemon options
 */
export function realDaemon(h, over = {}) {
  const before = process.env.HOME;
  // The runner finds its home through paths(), from the environment launchRunner’s spawn passes on.
  process.env.HOME = h.home;
  const daemon = createDaemon({
    home: h.home,
    findPrograms: async () => ({
      node: { path: process.execPath, version: process.version },
      harnesses: ['claude-code', 'codex'].map((name) => ({ name, path: process.execPath, version: null, looked: [] })),
      problems: [],
    }),
    logind: () => ({ killUserProcesses: null, linger: null }),
    log: () => {},
    pollMs: 20,
    ...over,
  });
  // The daemon’s timers are unref’d, as a server’s are, so this keeps the test up while it waits.
  const keep = setInterval(() => {}, 1000);
  const connect = () => {
    const input = new PassThrough();
    const output = new PassThrough();
    daemon.connect({ input, output });
    const msgs = readMessages(output);
    const send = (/** @type {string} */ type, body = {}) => input.write(encode(message('postbox-to-daemon', type, body)));
    send('hello', { version: PROTOCOL_VERSION, token: TOKEN, takeover: true });
    return { msgs, send };
  };
  const close = () => {
    clearInterval(keep);
    daemon.close();
    if (before === undefined) delete process.env.HOME;
    else process.env.HOME = before;
  };
  return { daemon, connect, close };
}
