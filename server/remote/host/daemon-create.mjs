// createDaemon (daemon.mjs’s header, #120): the daemon’s options and state, its cleanup and broker, and what the
// `host serve` program and the tests drive it with. Its functions are in the daemon-*.mjs modules, each taking the
// state (`d`) first.

import { spawn as nodeSpawn } from 'node:child_process';
import { HOST_DEFAULTS, hostPaths } from '../../../shared/remote-protocol.mjs';
import { createBroker } from './broker.mjs';
import { createCleanup, SWEEP_MS } from './cleanup.mjs';
import { acceptSocket, connectStreams } from './daemon-conn.mjs';
import { POLL_MS, REMOVE_WAIT_MS, RUNNER_START_MS, STOP_GRACE_MS } from './daemon-constants.mjs';
import { ensureToken, tokenMatches } from './daemon-files.mjs';
import { attached, fail, toPostbox } from './daemon-reply.mjs';
import { armSweep, checkIdle, scan } from './daemon-scan.mjs';
import { stopTurn } from './daemon-stop.mjs';
import { defaultWriteRunner, writeHeld } from './daemon-write.mjs';
import { hostVersion } from './paths.mjs';
import * as defaultProc from './proc.mjs';
import { findPrograms as defaultFindPrograms } from './programs.mjs';
import { askRunner as defaultAskRunner, launchRunner as defaultLaunchRunner, logindFacts } from './runner-client.mjs';

/** @typedef {import('./daemon-constants.mjs').Daemon} Daemon @typedef {import('./daemon-constants.mjs').DaemonOpts} DaemonOpts */

/**
 * The daemon, driven by connections. Everything outside the process is injected, so tests run it in-process with
 * PassThrough streams and a temp home.
 * @param {DaemonOpts} opts
 *   logind: runner.mjs’s logindFacts, asked at each hello for the lingering warning and passed to launchRunner.
 *   uid: this user’s, which the token file must be owned by (-1 where there are no user IDs). onRemoved: `remove` has
 *   deleted ~/.postbox-remote and said `removed`, so the daemon exits. env: the daemon’s environment, which each runner
 *   inherits (read at each start, for KIRO_HOME).
 */
export function createDaemon(opts) {
  const { broker, shim, ...o } = withDefaults(opts);
  /** @type {Daemon} */
  const d = {
    ...o,
    p: hostPaths(o.home, o.version),
    settings: { ...HOST_DEFAULTS },
    programs: null,
    conns: new Set(),
    driver: null,
    ids: 0,
    acked: new Map(),
    dead: new Set(),
    killTimers: new Map(),
    shells: new Map(),
    stoppedFirst: new Set(),
    starting: new Map(),
    problems: new Map(),
    idleTimer: null,
    lastActive: o.now(),
    closed: false,
    removing: false,
    sweepTimer: null,
    checks: Promise.resolve(),
    checking: new Set(),
    cleanup: /** @type {any} */ (null),
    brk: /** @type {any} */ (null),
    shimSeam: undefined,
  };
  d.cleanup = daemonCleanup(d);
  d.brk = broker ?? daemonBroker(d);
  d.shimSeam = shim ?? d.brk.shim;
  return daemonApi(d);
}

/** createDaemon’s options, with their defaults. @param {DaemonOpts} opts */
function withDefaults({
  home,
  version = hostVersion(),
  now = Date.now,
  timers = { setTimeout: (fn, ms) => setTimeout(fn, ms).unref(), clearTimeout: (t) => clearTimeout(t) },
  spawn = nodeSpawn,
  logind = logindFacts,
  launchRunner = defaultLaunchRunner,
  askRunner = defaultAskRunner,
  proc = defaultProc,
  writeRunner = defaultWriteRunner,
  findPrograms = (o) => defaultFindPrograms(o),
  kill = (pid, signal) => process.kill(pid, signal),
  log = (line) => process.stderr.write(`${new Date().toISOString()} ${line}\n`),
  onIdle = () => {},
  onRemoved = onIdle,
  pollMs = POLL_MS,
  stopGraceMs = STOP_GRACE_MS,
  removeWaitMs = REMOVE_WAIT_MS,
  runnerStartMs = RUNNER_START_MS,
  sweepMs = SWEEP_MS,
  broker,
  shim,
  uid = process.getuid ? process.getuid() : -1,
  env = process.env,
}) {
  return {
    home,
    version,
    now,
    timers,
    spawn,
    logind,
    launchRunner,
    askRunner,
    proc,
    writeRunner,
    findPrograms,
    kill,
    log,
    onIdle,
    onRemoved,
    pollMs,
    stopGraceMs,
    removeWaitMs,
    runnerStartMs,
    sweepMs,
    broker,
    shim,
    uid,
    env,
  };
}

/** The daemon’s cleanup.mjs: the cap stops a turn as Stop does, and tells the driving Postbox. @param {Daemon} d */
function daemonCleanup(d) {
  return createCleanup({
    home: d.home,
    version: d.version,
    paths: d.p,
    now: d.now,
    log: d.log,
    settings: () => ({ logRetention: d.settings.logRetention, logMaxBytes: d.settings.logMaxBytes }),
    sameProcess: (r) => d.proc.sameProcess(/** @type {any} */ (r)),
    stopTurn: (turn) => stopTurn(d, turn),
    onCap(turn, text) {
      d.problems.set('log-cap', text);
      if (d.driver && !d.driver.closed) fail(d.driver, 'internal', text, undefined, turn);
    },
  });
}

/** The daemon’s broker.mjs, serving shims and Codex approvals. @param {Daemon} d */
function daemonBroker(d) {
  return createBroker({
    paths: d.p,
    now: d.now,
    timers: d.timers,
    log: d.log,
    tokenMatches: (given) => tokenMatches(d, given),
    settings: () => d.settings,
    toPostbox: (type, body) => toPostbox(d, type, body),
    attached: () => attached(d),
    interrupted: (turn) => d.dead.has(turn),
    writeStdin: (turn, line) => writeHeld(d, turn, line),
    codexPollMs: d.pollMs,
  });
}

/** What the `host serve` program and the tests drive the daemon with. @param {Daemon} d */
function daemonApi(d) {
  return {
    paths: d.p,
    /** Makes the token if it’s missing and arms the idle exit; call once, before any connection. */
    start: () => startDaemon(d),
    scan: () => scan(d),
    /** How far Postbox has applied each turn’s out.jsonl, in this daemon’s life; `.ack` keeps it on disk. */
    acked: d.acked,
    cleanup: d.cleanup,
    /** A Postbox channel over a pair of streams, such as an ssh child’s, or PassThroughs in a test. @param {Parameters<typeof connectStreams>[1]} io */
    connect: (io) => connectStreams(d, io),
    /** A connection to the daemon’s socket: a relayed Postbox, or a turn’s shim, by its first line. @param {import('node:net').Socket} socket */
    accept: (socket) => acceptSocket(d, socket),
    /** Sends a message to the driving Postbox, if one is attached (the broker’s queue). Returns whether it went. */
    toPostbox: (/** @type {string} */ type, /** @type {Record<string, unknown>} */ body) => toPostbox(d, type, body),
    /** The broker serving shims and Codex approvals. */
    broker: d.brk,
    get settings() {
      return d.settings;
    },
    /** Stops followers and timers; the connections stay as they are. */
    close: () => closeDaemon(d),
  };
}

/** @param {Daemon} d */
async function startDaemon(d) {
  ensureToken({ p: d.p, uid: d.uid, log: d.log });
  await d.cleanup.sweep().catch((e) => d.log(`The cleanup at start failed: ${e.message}`));
  armSweep(d);
  const turns = await scan(d);
  d.log(`Daemon ${d.version} for ${d.home}: ${turns.length} turn folders (${turns.filter((t) => t.state === 'running').length} running).`);
  await d.brk.load?.(turns);
  checkIdle(d);
  return turns;
}

/** @param {Daemon} d */
function closeDaemon(d) {
  d.closed = true;
  d.brk.close?.();
  if (d.idleTimer) d.timers.clearTimeout(d.idleTimer);
  if (d.sweepTimer) d.timers.clearTimeout(d.sweepTimer);
  for (const t of d.killTimers.values()) d.timers.clearTimeout(t);
  d.killTimers.clear();
  d.shells.clear();
  for (const child of d.checking) {
    try {
      child.kill('SIGKILL');
    } catch {}
  }
  for (const c of [...d.conns]) c.close();
}
