// The two machines of the remote pipeline’s tests (#120, V1; tests/integration/remote-pipeline.test.mjs says what they
// run): a host home and a laptop data folder under one temp folder, the spawn that stands in for ssh, what the
// stand-in and the adapter recorded, and the teardown that checks nothing a test started is left.

import assert from 'node:assert/strict';
import { spawn as nodeSpawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { hostVersion } from '../../server/remote/host/paths.mjs';
import { remoteCommand } from '../../server/remote/ssh.mjs';
import { hostPaths } from '../../shared/remote-protocol.mjs';
import { FIXTURES, gone, NO_UNIX, sleep } from './host.mjs';

export const VERSION = hostVersion();
export const HOST = 'host.example.com';
export const NODE_DIR = dirname(process.execPath);
export const STANDIN = join(FIXTURES, 'claude-standin.mjs');
export const LINUX = process.platform === 'linux';
/** Every process this file starts has it in its environment, for the /proc sweep at the end. */
export const RUN = `v1-${randomUUID()}`;
export const TEST = { skip: NO_UNIX, timeout: 90_000 };
export const BLOCK_ID = 'pick';

export const corpus = { search: () => [], read: () => null, stats: () => ({ books: [], passages: 0 }) };
export const recorded = (name) =>
  readFileSync(join(FIXTURES, '..', 'claude-code', `${name}.jsonl`), 'utf8')
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l));
/**
 * The reply a recorded turn makes once its stream is applied whole: its text deltas, or with none (a recording without
 * partial messages), its assistant messages’ text.
 */
export function replyOf(name) {
  const events = recorded(name);
  const deltas = events.filter((e) => e.event?.delta?.type === 'text_delta').map((e) => e.event.delta.text);
  if (deltas.length) return deltas.join('');
  return events
    .filter((e) => e.type === 'assistant')
    .flatMap((e) => e.message.content.filter((c) => c.type === 'text').map((c) => c.text))
    .join('');
}

// ── The two machines ────────────────────────────────────────────────────────────────

/**
 * A host home and a laptop data folder under one temp folder, and the spawn that stands in for ssh. Each session is
 * kept with what crossed it: `sent`, the messages Postbox wrote, and `got`, the daemon’s.
 * @param {{ timings?: Record<string, number> }} [o]  POSTBOX_SHIM_TIMINGS for the shim (it can only shorten its waits)
 */
export function machine({ timings = {} } = {}) {
  const root = mkdtempSync('/tmp/pbv-'); // not os.tmpdir(): macOS’s pushes the sockets’ paths past sun_path
  const home = join(root, 'h');
  const trace = join(root, 'trace');
  const applied = join(root, 'applied');
  for (const d of [home, trace, applied]) mkdirSync(d);
  // The host’s claude: a wrapper that execs the stand-in with this node, as an installer’s launcher would.
  const claude = join(home, 'bin', 'claude');
  mkdirSync(dirname(claude));
  for (const p of [process.execPath, STANDIN]) assert.ok(!p.includes("'"), `${p} has a quote the wrapper can’t hold`);
  writeFileSync(claude, `#!/bin/sh\nexec '${process.execPath}' '${STANDIN}' "$@"\n`, { mode: 0o755 });
  const mark = `${RUN}-${randomUUID().slice(0, 8)}`;
  const env = {
    HOME: home,
    POSTBOX_REMOTE_HOME: home,
    PATH: `${NODE_DIR}:/usr/bin:/bin:/usr/sbin:/sbin`,
    POSTBOX_STANDIN_TRACE: trace,
    POSTBOX_SHIM_TIMINGS: JSON.stringify({ progress: 300, ...timings }),
    POSTBOX_V1_RUN: mark,
  };
  /** @type {{ child: import('node:child_process').ChildProcess, attach: boolean, sent: any[], got: any[] }[]} */
  const sessions = [];
  const m = {
    root,
    home,
    trace,
    applied,
    claude,
    mark,
    env,
    sessions,
    data: join(root, 'data'),
    paths: hostPaths(home, VERSION),
    /** The reconnect backoff, per attempt; a test lengthens it to hold a drop open. */
    delay: 50,
    /** PIDs seen, which must all be gone at the end. @type {Map<number, string>} */
    pids: new Map(),
    /** @type {(program: string, args: string[], options: object) => import('node:child_process').ChildProcess} */
    spawn: (program, args, options) => sshStandIn(m, env, sessions, program, args, options),
  };
  process.env.POSTBOX_CLAUDE_RECORD = applied;
  return m;
}

/**
 * The spawn that stands in for ssh: it runs ssh’s last argument with /bin/sh -c in the host’s environment, and keeps
 * each session with what crossed it.
 * @param {any} m @param {Record<string, string>} env @param {any[]} sessions @param {string} program
 * @param {string[]} args @param {object} options
 */
function sshStandIn(m, env, sessions, program, args, options) {
  assert.equal(program, 'ssh');
  // Its own group, so a drop can kill the shell and the attach it runs together.
  const child = nodeSpawn('/bin/sh', ['-c', args.at(-1)], { ...options, env, detached: true });
  const s = { child, attach: args.at(-1) === remoteCommand(VERSION), sent: /** @type {any[]} */ ([]), got: /** @type {any[]} */ ([]) };
  sessions.push(s);
  m.pids.set(/** @type {number} */ (child.pid), 'an ssh session');
  if (s.attach) {
    const write = child.stdin?.write.bind(child.stdin);
    if (child.stdin && write)
      child.stdin.write = /** @type {any} */ (
        (chunk, ...rest) => {
          for (const l of String(chunk).split('\n')) if (l) s.sent.push(JSON.parse(l));
          return write(chunk, ...rest);
        }
      );
    let buf = '';
    child.stdout?.on('data', (b) => {
      buf += b;
      const end = buf.lastIndexOf('\n') + 1;
      s.got.push(...wholeLines(buf.slice(0, end)));
      buf = buf.slice(end);
    });
  }
  return child;
}

/** A file’s whole lines, as JSON: one still being written, past its last \n, waits for the next look. @param {string} text */
export const wholeLines = (text) =>
  text
    .split('\n')
    .slice(0, -1)
    .filter(Boolean)
    .map((l) => JSON.parse(l));

/** The stand-in’s runs so far, oldest first: their events and the lines each wrote. @param {ReturnType<typeof machine>} m */
export function standins(m) {
  return readdirSync(m.trace)
    .filter((f) => /^\d+\.jsonl$/.test(f))
    .map((f) => {
      const events = wholeLines(readFileSync(join(m.trace, f), 'utf8'));
      const pid = Number(f.split('.')[0]);
      const out = join(m.trace, `${pid}.out.jsonl`);
      return { pid, events, start: events[0], out: existsSync(out) ? readFileSync(out, 'utf8') : '', has: (ev) => events.find((e) => e.ev === ev) };
    })
    .filter((s) => s.start)
    .sort((a, b) => a.start.at - b.start.at);
}

/** What the adapter applied, one file per run, oldest first (the adapter names them by time). @param {ReturnType<typeof machine>} m */
export const appliedRuns = (m) =>
  readdirSync(m.applied)
    .sort()
    .map((f) => readFileSync(join(m.applied, f), 'utf8'));

/** The daemon’s PID, from daemon.pid, or null. @param {ReturnType<typeof machine>} m */
export function daemonPid(m) {
  try {
    return JSON.parse(readFileSync(join(m.paths.code, 'daemon.pid'), 'utf8')).pid;
  } catch {
    return null;
  }
}

export const alive = (pid) => !gone(pid);
/** Whether a PID is a zombie, from /proc (Linux only). @param {number} pid */
export function zombie(pid) {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    return stat.slice(stat.lastIndexOf(')') + 2)[0] === 'Z';
  } catch {
    return false;
  }
}

/**
 * Every process with the machine’s marker in its environment that isn’t a zombie, from /proc (Linux only).
 * @param {string} mark @returns {number[]}
 */
export function marked(mark) {
  const name = 'POSTBOX_V1_RUN=';
  const found = [];
  for (const pid of readdirSync('/proc')
    .filter((d) => /^\d+$/.test(d))
    .map(Number)) {
    if (pid === process.pid || zombie(pid)) continue;
    try {
      if (
        readFileSync(`/proc/${pid}/environ`, 'utf8')
          .split('\0')
          .some((v) => v.startsWith(name) && v.slice(name.length).startsWith(mark))
      )
        found.push(pid);
    } catch {}
  }
  return found;
}

/**
 * Ends what a test left: its Postboxes (turns on the host aren’t stopped by that) and the daemon, with SIGTERM as a
 * person’s `kill` would. Then every PID it saw, and on Linux every marked process, must be gone; anything left is a
 * stray, and is killed so nothing outlives the test. Returns the strays.
 * @param {ReturnType<typeof machine>} m @param {any[]} postboxes
 */
export async function teardown(m, postboxes) {
  for (const p of postboxes) await p.done().catch(() => {});
  delete process.env.POSTBOX_CLAUDE_RECORD;
  for (const s of standins(m)) {
    m.pids.set(s.pid, 'a stand-in claude');
    const shim = s.has('shim')?.pid;
    if (shim) m.pids.set(shim, 'a shim');
  }
  const daemon = daemonPid(m);
  if (daemon) {
    m.pids.set(daemon, 'the daemon');
    try {
      process.kill(daemon, 'SIGTERM');
    } catch {}
  }
  const end = Date.now() + 10_000;
  const left = () => [...m.pids.keys()].filter(alive);
  while (left().length && Date.now() < end) await sleep(50);
  /** @type {Map<number, string>} */
  const strays = new Map(left().map((pid) => [pid, `${m.pids.get(pid)} (${pid})`]));
  if (LINUX) for (const pid of marked(m.mark)) if (!strays.has(pid)) strays.set(pid, `a process with the test’s marker (${pid})`);
  // Whatever is left goes now, by group where it leads one.
  for (const pid of strays.keys())
    for (const target of [-pid, pid])
      try {
        process.kill(target, 'SIGKILL');
      } catch {}
  rmSync(m.root, { recursive: true, force: true });
  return [...strays.values()];
}

/** Runs a test on a fresh pair of machines and checks that nothing it started is left. */
export async function onMachines(opts, fn) {
  const m = machine(opts);
  /** @type {any[]} */
  const postboxes = [];
  let failed = null;
  try {
    await fn(m, postboxes);
  } catch (e) {
    failed = e;
  }
  const strays = await teardown(m, postboxes);
  if (failed) throw failed;
  assert.deepEqual(strays, [], 'every process the test started is gone once Postbox and the daemon have closed');
}
