// What the remote lifecycle’s integration tests share (tests/integration/remote-lifecycle*.test.mjs): a laptop and a
// host in temp folders, ssh’s stand-in, a fake harness, waiting, and the processes of Postbox’s left on the host.

import { execFileSync, spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { installCommand, installHost, ROOT, tokenCommand } from '../../server/remote/install.mjs';
import { createSshConnection, remoteCommand } from '../../server/remote/ssh.mjs';
import { hostPaths, REMOTE_DIR } from '../../shared/remote-protocol.mjs';
import { defaultHostSettings, RANGES } from '../../shared/remote-settings.mjs';
import { sleep } from './host.mjs';

export const VERSION = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version;
export const DEST = 'host.example.com';
export const IDLE_MIN = RANGES.idleTimeout.min;
export const SKIP = process.platform !== 'linux' && process.platform !== 'darwin' && 'needs a POSIX sh, tar, Unix sockets and process groups';

/**
 * The stand-in harness: prints `harness:<pid>`; given the shim’s path (not “-”), starts it as `node shim.mjs <turn>`,
 * says initialize, and prints `shim:<pid>` once it answers; then waits `ms`. SIGINT ends it, and the shim, by Node’s
 * default, as it ends a Claude Code turn.
 */
export const HARNESS = `import { spawn } from 'node:child_process';
const [shim, turn, ms] = process.argv.slice(2);
process.stdout.write('harness:' + process.pid + '\\n');
if (shim !== '-') {
  const s = spawn(process.execPath, [shim, turn], { stdio: ['pipe', 'pipe', 'inherit'] });
  s.stdout.once('data', () => process.stdout.write('shim:' + s.pid + '\\n'));
  const init = { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'stand-in', version: '0' } };
  s.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: init }) + '\\n');
}
setTimeout(() => {}, Number(ms));
`;

/**
 * A host home and a laptop data folder under one temp folder in /tmp (short enough for the sockets’ paths), the
 * harness beside them, and the host’s settings: the harness’s node as claudePath, and the shortest idleTimeout. `env`
 * adds to the host’s environment, as POSTBOX_DAEMON_TIMINGS. @param {{ env?: Record<string, string> }} [o]
 */
export function machines({ env = {} } = {}) {
  const root = mkdtempSync('/tmp/pbv-');
  const home = join(root, 'h');
  mkdirSync(home);
  const harness = join(root, 'harness.mjs');
  writeFileSync(harness, HARNESS, { mode: 0o600 });
  const settings = { ...defaultHostSettings(), claudePath: process.execPath, idleTimeout: IDLE_MIN };
  return {
    root,
    // macOS’s /tmp is a link to /private/tmp, and node resolves its main module’s path, so a command line may say either.
    roots: [...new Set([root, realpathSync(root)])],
    home,
    data: join(root, 'data'),
    harness,
    p: hostPaths(home, VERSION),
    host: { id: 'ho_life0001', name: DEST, settings },
    settings,
    env: { HOME: home, PATH: `${dirname(process.execPath)}:/usr/bin:/bin:/usr/sbin:/sbin`, ...env },
  };
}
/** @typedef {ReturnType<typeof machines>} Machines */

/**
 * ssh, replaced: each run checks that it’s one Postbox makes (options, `--`, the destination, then one of its three
 * remote commands), then runs that command with /bin/sh -c in the host’s environment.
 * @param {Machines} m
 */
export function sshHere(m) {
  /** @type {{ args: string[], child: import('node:child_process').ChildProcess }[]} */
  const calls = [];
  const known = [installCommand(VERSION), tokenCommand(VERSION), remoteCommand(VERSION)];
  /** @type {any} */
  const run = (/** @type {string} */ program, /** @type {string[]} */ args, /** @type {object} */ options) => {
    const command = args.at(-1) ?? '';
    if (program !== 'ssh' || args[0] !== '-o' || args.at(-3) !== '--' || args.at(-2) !== DEST || !known.includes(command))
      throw new Error(`That isn’t an ssh run Postbox makes: ${program} ${args.join(' ').slice(0, 200)}`);
    const child = spawn('/bin/sh', ['-c', command], { ...options, env: m.env });
    calls.push({ args, child });
    return child;
  };
  /** The attaches still running, by their PIDs. */
  const attaches = () => calls.filter((c) => c.args.at(-1) === remoteCommand(VERSION) && c.child.exitCode === null && c.child.signalCode === null);
  return { spawn: run, calls, attaches };
}

/** Every message an emitter (a connection or a link) gives, and a wait for one. @param {import('node:events').EventEmitter} source */
export function inbox(source) {
  /** @type {any[]} */
  const all = [];
  source.on('message', (m) => all.push(m));
  return {
    all,
    /** The first message of a type that passes `pick`, within ms. */
    got: (/** @type {string} */ type, pick = (/** @type {any} */ _m) => true, ms = 15_000) =>
      waitFor(() => all.find((m) => m.type === type && pick(m)), `a ${type}`, ms),
    /** The PID a `<name>:<pid>` line of the harness’s gave. */
    pid: async (/** @type {string} */ name, ms = 15_000) => {
      const line = await waitFor(() => all.find((m) => m.type === 'line' && m.text.startsWith(`${name}:`)), `the ${name}’s PID`, ms);
      return Number(line.text.slice(name.length + 1));
    },
  };
}

/** check()’s first truthy value, looked at every `every` ms, within ms. */
export async function waitFor(check, what, ms, every = 50) {
  const end = Date.now() + ms;
  for (;;) {
    const v = await check();
    if (v) return v;
    if (Date.now() > end) throw new Error(`Timed out after ${ms} ms waiting for ${what}.`);
    await sleep(every);
  }
}

/** A turn’s start for the stand-in harness, in a folder the daemon makes under ~/postbox-work. @param {Machines} m */
export const startBody = (m, turn, shim, ms) => ({
  turn,
  harness: 'claude-code',
  folder: `${m.home}/postbox-work/life`,
  argv: [m.harness, shim, turn, String(ms)],
  env: {},
  stdin: 'none',
  files: [],
});

/** The PID in a record file (daemon.pid, runner.json). @param {string} path */
export const pidIn = (path) => JSON.parse(readFileSync(path, 'utf8')).pid;

/**
 * Every process on this machine whose command line contains one of the strings: ps, else (a Linux image without
 * procps) /proc. A zombie no one has reaped has no command line, so it isn’t one.
 * @param {string[]} needles @returns {{ pid: number, command: string }[]}
 */
export function processesWith(needles) {
  let rows;
  try {
    rows = execFileSync('ps', ['-A', '-ww', '-o', 'pid=,args='], { encoding: 'utf8' })
      .split('\n')
      .map((l) => /^\s*(\d+)\s+(.*)$/.exec(l))
      .filter((x) => x !== null)
      .map((x) => ({ pid: Number(x[1]), command: x[2] }));
  } catch (e) {
    if (process.platform !== 'linux' || e.code !== 'ENOENT') throw e;
    rows = [];
    for (const d of readdirSync('/proc')) {
      if (!/^\d+$/.test(d)) continue;
      try {
        rows.push({ pid: Number(d), command: readFileSync(`/proc/${d}/cmdline`, 'utf8').split('\0').join(' ').trim() });
      } catch {}
    }
  }
  return rows.filter((r) => r.pid !== process.pid && needles.some((n) => r.command.includes(n)));
}
/** Postbox’s processes on the host: those running something under the temp home’s ~/.postbox-remote. @param {Machines} m */
export const postboxOnHost = (m) => processesWith(m.roots.map((r) => `${r}/h/${REMOTE_DIR}/`));
/**
 * The relays: each attach’s node, running the installed host.mjs. The ssh stand-in’s own child may be the login shell
 * that started it (dash doesn’t exec a -c command’s last program; bash does), so they’re found by command line.
 * @param {Machines} m
 */
export const relays = (m) => postboxOnHost(m).filter((r) => r.command.endsWith('/server/remote/host/host.mjs attach'));
/** One process’s command line, or null once it’s gone. @param {Machines} m @param {number} pid */
export const commandOf = (m, pid) => processesWith(m.roots).find((r) => r.pid === pid)?.command ?? null;

/**
 * Ends everything the test started (the ssh stand-ins, and any process whose command line names the temp folder:
 * daemons, runners, harnesses and shims) and removes the temp folder.
 * @param {Machines} m @param {ReturnType<typeof sshHere>} [ssh]
 */
export async function reap(m, ssh) {
  for (const c of ssh?.calls ?? []) if (c.child.exitCode === null && c.child.signalCode === null) c.child.kill('SIGKILL');
  for (let i = 0; i < 3; i++) {
    const left = processesWith(m.roots);
    if (!left.length) break;
    for (const r of left) {
      try {
        process.kill(r.pid, 'SIGKILL');
      } catch {}
    }
    await sleep(100);
  }
  rmSync(m.root, { recursive: true, force: true });
}

/** Installs, connects and has the welcome. @param {Machines} m @param {ReturnType<typeof sshHere>} ssh */
export async function installAndAttach(m, ssh) {
  const installed = await installHost({ host: m.host, version: VERSION, dataDir: m.data, spawn: ssh.spawn });
  const conn = createSshConnection({ destination: DEST, settings: m.settings, version: VERSION, token: installed.token, spawn: ssh.spawn });
  const box = inbox(conn);
  const closed = new Promise((resolve) => conn.once('close', resolve));
  const welcome = await conn.connect();
  return { installed, conn, box, welcome, closed };
}
