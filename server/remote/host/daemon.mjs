// The daemon on a remote host (#120, the design’s “The daemon”, “Postbox and the daemon”, “Files and cleanup”). It
// speaks shared/remote-protocol.mjs’s postbox-to-daemon and daemon-to-postbox channels, starts each turn as a runner
// (runner.mjs), hands Postbox each turn’s out.jsonl from any byte offset and follows it, and stops a turn only when its
// runner is still the process runner.json names.
//
// One daemon per version, and the processes `ssh` starts. Every `host attach` is a separate process started by ssh, so
// one daemon needs coordination. The daemon is its own process, `host serve`, listening on paths().socket in the
// version’s 0700 folder; `host attach` is only a relay that pipes its stdio (the SSH channel) to that socket:
// 1. attach connects to the socket. If a daemon answers, it relays, and that’s all.
// 2. Otherwise it takes the version’s start lock (paths().lock, ~/.postbox-remote/locks/<version>.lock), a folder made
//    with mkdir (atomic), connects once more (another attach may have just started one), and if nobody answers, makes
//    the version’s folder if it’s missing (a checkout’s), starts `host serve` detached, waits for its socket to answer,
//    drops the lock and relays. The installer holds the same lock while it checks and replaces the version’s folder
//    (install.mjs), so the lock is outside that folder, and an attach makes nothing in it without the lock. The lock
//    holds its owner’s record (proc.mjs, “The start lock’s owner”), and is broken only once that owner is gone, or
//    once it has had no record for LOCK_STALE_MS; its age alone never breaks it, however long an install holds it.
//    Each holder drops it only while the record in it is still its own.
// 3. serve takes the daemon’s own lock for its whole life: daemon.pid, made with O_EXCL, holding its PID, boot ID and
//    start time. One that names a live process (proc.mjs’s sameProcess) means a daemon is up or starting, and serve
//    exits; one that doesn’t is from a daemon that died, and is removed (under daemon.pid.break, so two serves that
//    both find it stale can’t remove a fresh one). Only while it holds daemon.pid does serve connect once more, remove
//    a stale socket file (nothing answers: ENOENT or ECONNREFUSED; any other error is reported, and the file is left)
//    and bind. So the start lock going stale under a slow start can’t start a second daemon.
// The first attach doesn’t become the daemon itself, though that’s one process fewer: the daemon outlives the attach
// that started it, and sshd ends a session only once the channel’s stdout and stderr close, so a daemon holding them
// would keep that ssh open after Postbox dropped or was taken over. A relay closes them when its socket closes.
// Where logind kills a session’s processes at logout, the daemon goes with the session that started it; that’s
// harmless, since turns don’t need it (runners have their own scope) and the next attach restarts it from disk.
//
// The daemon’s socket also serves each turn’s shim (shim-to-daemon). A connection’s first line says which it is: a
// Postbox hello has `version`, a shim’s has `turn`. Serving the shim (tool calls, permission prompts, the snapshot’s
// reading tools) and declining Codex’s approvals at permissionWaitMax is broker.mjs’s; this file hands it each shim
// connection and the Postbox messages it owns (snapshot, snapshot-items, answer, reply), and tells it when a turn
// starts, when Stop arrives, and before a line goes to a held stdin. Tests can pass their own (`broker`, `shim`).
//
// Its log is its stderr: the attach’s for the relay, daemon.log in the version’s folder for serve. stdout carries
// protocol messages only.

import { spawn as nodeSpawn } from 'node:child_process';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import {
  chmodSync,
  closeSync,
  constants,
  promises as fsp,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmdirSync,
  rmSync,
  statSync,
  unlinkSync,
  watch,
  writeFileSync,
} from 'node:fs';
import net from 'node:net';
import { dirname, join, posix } from 'node:path';
import {
  createLineReader,
  DIR_MODE,
  encode,
  encodedBytes,
  FILE_MODE,
  HOST_DEFAULTS,
  hostPaths,
  message,
  PROTOCOL_VERSION,
  parseLine,
  REMOTE_LIMITS,
  socketPathFits,
  TURN_FILES,
  validateExitRecord,
  validateMessage,
  validateRunnerRecord,
  validateStartRecord,
} from '../../../shared/remote-protocol.mjs';
import { createBroker } from './broker.mjs';
import { createCleanup, SWEEP_MS } from './cleanup.mjs';
import { hostVersion, PROGRAMS, paths } from './paths.mjs';
import * as defaultProc from './proc.mjs';
import { LOCK_OWNER, lockOwnerLive, parseLockOwner } from './proc.mjs';
import { findPrograms as defaultFindPrograms, NODE_MAJOR } from './programs.mjs';
import { askRunner as defaultAskRunner, launchRunner as defaultLaunchRunner, sendStdin } from './runner.mjs';

/** Stop’s grace period between SIGINT to the turn’s group and SIGKILL (C5: SIGINT ends a Claude Code turn). */
export const STOP_GRACE_MS = 10_000;
/** How often a follower looks at its log when no file event came (fs.watch can miss events, or be unavailable). */
export const POLL_MS = 1000;
/** How long a runner has to answer a liveness check. */
export const ASK_TIMEOUT_MS = 1000;
/** How long a launched runner has to answer on its socket before `start` fails, and how often it’s asked. */
export const RUNNER_START_MS = 10_000;
const RUNNER_START_POLL_MS = 50;
/** How long an attach waits for the serve it started to answer. */
export const SERVE_START_MS = 10_000;
/**
 * A start lock with no owner record yet is one an attach or install has just made, and is held for this long; one
 * still without a record after it is from one that died between making it and writing its record, and is broken. A
 * lock with a record is judged by its owner alone. An attach waits for a held lock for up to SERVE_START_MS more than
 * this. The install script’s own grace (find’s -mmin +1) counts whole minutes, so it’s a minute, and cleanup’s is this.
 */
export const LOCK_STALE_MS = 3 * SERVE_START_MS;
/** The start lock’s break lock (`<lock>.break`) is held for one removal; one older than this is from one that died. */
const BREAK_STALE_MS = 5000;
/** daemon.log is set aside as daemon.log.1 when it’s over this at serve’s start. */
const LOG_KEEP_BYTES = 4 * 1024 * 1024;
/** How long `remove` waits for the turns it stopped to end, past Stop’s grace period. */
const REMOVE_WAIT_MS = 5000;
/** The daemon’s entry point, which the `host` launcher (PROGRAMS.host, a shell script) runs with the Node it found. */
export const HOST_ENTRY = join(dirname(PROGRAMS.host), 'host.mjs');
/** Exit codes, from sysexits.h. */
export const EXIT = Object.freeze({ ok: 0, usage: 64, unavailable: 69, software: 70, noperm: 77 });

const READ_CHUNK = 64 * 1024;

/**
 * runner.mjs’s and proc.mjs’s functions, injectable so tests run without processes.
 * @typedef {(o: { node: string, turn: string, paths: ReturnType<typeof hostPaths>, scope: 'auto' | 'setsid', spawn: any, logind?: any })
 *   => { pid: number, scoped: boolean, lingerOff: boolean } | Promise<{ pid: number, scoped: boolean, lingerOff: boolean }>} LaunchRunner
 *   scoped: the runner went into a systemd user scope; lingerOff: logind says lingering is off for this user
 * @typedef {(socketPath: string, turn: string, o: { timeoutMs: number, token: string }) => Promise<boolean>} AskRunner
 * @typedef {{ sameProcess: (r: import('../../../shared/remote-protocol.mjs').RunnerRecord) => boolean | Promise<boolean>,
 *   toolGroups: (pgid: number) => import('./proc.mjs').ToolGroup[] | null,
 *   liveGroups: (groups: import('./proc.mjs').ToolGroup[]) => import('./proc.mjs').ToolGroup[] | Promise<import('./proc.mjs').ToolGroup[]> }} Proc
 * @typedef {(o: { socketPath: string, turn: string, line: string, token: string }) => Promise<number>} WriteRunner
 *   sends one held-stdin line to a runner and resolves with in.jsonl’s size after it
 * @typedef {{ setTimeout: (fn: () => void, ms: number) => any, clearTimeout: (t: any) => void }} Timers
 * @typedef {{ write: (s: string) => boolean, end: () => void, once?: (e: 'drain', fn: () => void) => any }} Output
 * @typedef {{ id: number, output: Output, ready: boolean, closed: boolean, follows: Map<string, Follower>,
 *   queue: Promise<void>, close: () => void }} Conn
 * @typedef {{ stop: () => void, poke: () => void }} Follower
 * @typedef {{ turn: string, harness: string, state: 'running' | 'ended' | 'interrupted', size: number,
 *   exit: import('../../../shared/remote-protocol.mjs').ExitRecord | null }} TurnFound
 * @typedef {{ hello?: (send: (type: string, body: Record<string, unknown>) => void) => void | Promise<void>,
 *   message?: (msg: any, reply: { send: (type: string, body: Record<string, unknown>) => void, fail: (code: string, text: string) => void }) => boolean | Promise<boolean>,
 *   load?: (turns: TurnFound[]) => Promise<void>, starting?: (turn: string) => Promise<void>, started?: (turn: string) => unknown,
 *   stopping?: (turn: string) => Promise<void>, checkWrite?: (turn: string, line: string) => { refused: string } | { done: (ok: boolean) => void },
 *   shim?: ShimSeam, close?: () => void }} Broker
 *   broker.mjs’s seam: hello is called after each welcome (to resend what waits for Postbox); message gets snapshot,
 *   snapshot-items, answer and reply (remove is the daemon’s own: cleanup.mjs), and returns false for one it doesn’t
 *   take; load replays the turn folders at start; starting and started bracket a turn’s runner launch; stopping comes
 *   first in a Stop (and in the cap’s and remove’s); checkWrite before a held-stdin line goes.
 * @typedef {(conn: { first: string, write: (s: string) => boolean, end: () => void }) => { line: (text: string) => void, close: () => void }} ShimSeam
 */

/**
 * The daemon, driven by connections. Everything outside the process is injected, so tests run it in-process with
 * PassThrough streams and a temp home.
 * @param {{ home: string, version?: string, now?: () => number, timers?: Timers, spawn?: any, logind?: any,
 *   launchRunner?: LaunchRunner, askRunner?: AskRunner, proc?: Proc, writeRunner?: WriteRunner,
 *   findPrograms?: (o: { home: string, settings: Record<string, any> }) => Promise<import('./programs.mjs').Programs>,
 *   kill?: (pid: number, signal: NodeJS.Signals) => void, log?: (line: string) => void, onIdle?: () => void,
 *   onRemoved?: () => void, pollMs?: number, stopGraceMs?: number, runnerStartMs?: number, sweepMs?: number,
 *   broker?: Broker, shim?: ShimSeam, uid?: number, env?: Record<string, string | undefined> }} opts
 *   uid: this user’s, which the token file must be owned by (-1 where there are no user IDs). onRemoved: `remove` has
 *   deleted ~/.postbox-remote and said `removed`, so the daemon exits. env: the daemon’s environment, which each runner
 *   inherits (read at each start, for KIRO_HOME).
 */
export function createDaemon({
  home,
  version = hostVersion(),
  now = Date.now,
  timers = { setTimeout: (fn, ms) => setTimeout(fn, ms).unref(), clearTimeout: (t) => clearTimeout(t) },
  spawn = nodeSpawn,
  logind,
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
  runnerStartMs = RUNNER_START_MS,
  sweepMs = SWEEP_MS,
  broker,
  shim,
  uid = process.getuid ? process.getuid() : -1,
  env = process.env,
}) {
  const p = hostPaths(home, version);
  /** @type {Record<string, any>} the settings the driver’s hello sent, over HOST_DEFAULTS */
  let settings = { ...HOST_DEFAULTS };
  /** @type {import('./programs.mjs').Programs | null} what the last hello found */
  let programs = null;
  /** @type {Set<Conn>} Postbox connections, said hello or not */
  const conns = new Set();
  /** @type {Conn | null} the one that drives the daemon */
  let driver = null;
  let ids = 0;
  /** @type {Map<string, number>} per turn, how far Postbox has applied out.jsonl; cleanup.mjs keeps it in `.ack` */
  const acked = new Map();
  /** Turns whose runner was found not to be the one runner.json names: interrupted, whatever a socket says. */
  const dead = new Set();
  /** @type {Map<string, any>} SIGKILL timers, per turn */
  const killTimers = new Map();
  /** @type {Map<string, Map<number, import('./proc.mjs').ToolGroup>>} tool shells’ groups Stop recorded, per turn */
  const shells = new Map();
  /** Problems found since the start, beside programs’ (lingering, say), for each welcome. */
  /** @type {Map<string, string>} */
  const problems = new Map();
  /** @type {any} */
  let idleTimer = null;
  let lastActive = now();
  let closed = false;
  /** Set once `remove` starts: nothing new starts after it. */
  let removing = false;
  /** @type {any} */
  let sweepTimer = null;
  const cleanup = createCleanup({
    home,
    version,
    paths: p,
    now,
    log,
    settings: () => ({ logRetention: settings.logRetention, logMaxBytes: settings.logMaxBytes }),
    sameProcess: (r) => proc.sameProcess(/** @type {any} */ (r)),
    stopTurn: (turn) => stopTurn(turn),
    onCap(turn, text) {
      problems.set('log-cap', text);
      if (driver && !driver.closed) fail(driver, 'internal', text, undefined, turn);
    },
  });

  // ── Files ──

  const exists = (path) =>
    fsp.lstat(path).then(
      () => true,
      () => false,
    );
  /** exit.json, when it’s there and valid. */
  const readExit = async (turn) => {
    try {
      const r = validateExitRecord(JSON.parse(await fsp.readFile(p.turn(turn, TURN_FILES.exit), 'utf8')));
      return r.ok ? r.msg : null;
    } catch {
      return null;
    }
  };
  const readJson = async (path) => {
    try {
      return JSON.parse(await fsp.readFile(path, 'utf8'));
    } catch {
      return undefined;
    }
  };
  const sizeOf = (path) =>
    fsp.stat(path).then(
      (s) => s.size,
      () => 0,
    );
  /** Writes a file atomically, mode 0600: a temporary file beside it, then rename. */
  const writeAtomic = async (path, text) => {
    const tmp = `${path}.${process.pid}.${++ids}.tmp`;
    await fsp.writeFile(tmp, text, { mode: FILE_MODE, flag: 'wx' });
    await fsp.rename(tmp, path);
  };
  /** The host’s token, as this daemon’s home has it, or null if it can’t be read. */
  const readToken = () => {
    try {
      return readFileSync(p.token, 'utf8').trim() || null;
    } catch {
      return null;
    }
  };
  /** Whether the turn’s runner answers `who` with its turn. Given the token, so the runner checks this home’s. */
  const runnerAlive = async (turn) => {
    const token = readToken();
    if (!token) return false;
    return askRunner(p.turn(turn, TURN_FILES.socket), turn, { timeoutMs: ASK_TIMEOUT_MS, token }).catch(() => false);
  };

  /** The host’s token, made if missing (ensureToken). */
  const makeToken = () => ensureToken({ p, uid, log });
  /** Whether a token matches the file’s, in constant time. A missing or unreadable file matches nothing. */
  function tokenMatches(given) {
    let want;
    try {
      want = Buffer.from(readFileSync(p.token, 'utf8').trim());
    } catch (e) {
      log(`Couldn’t read the token at ${p.token}: ${e.message}`);
      return false;
    }
    const got = Buffer.from(String(given));
    // timingSafeEqual needs equal lengths; compare want with itself so a wrong length takes as long.
    const same = timingSafeEqual(got.length === want.length ? got : want, want);
    return got.length === want.length && same && want.length > 0;
  }

  // ── Scanning turn folders ──

  /**
   * Every turn folder: a live runner (its socket answers with its turn) is running, exit.json is ended, neither is
   * interrupted. A folder without a valid start.json isn’t a turn the daemon started, and is skipped.
   * @returns {Promise<TurnFound[]>}
   */
  async function scan() {
    let names = [];
    try {
      names = await fsp.readdir(p.turns);
    } catch (e) {
      if (e.code !== 'ENOENT') log(`Couldn’t list ${p.turns}: ${e.message}`);
      return [];
    }
    const found = await Promise.all(
      names.slice(0, REMOTE_LIMITS.turns).map(async (turn) => {
        let dir;
        try {
          dir = p.turn(turn);
        } catch {
          return null;
        }
        const start = validateStartRecord(await readJson(`${dir}/${TURN_FILES.start}`));
        if (!start.ok) return null;
        const exit = await readExit(turn);
        const state = exit ? 'ended' : !dead.has(turn) && (await runnerAlive(turn)) ? 'running' : 'interrupted';
        // A runner may write exit.json between the two looks.
        const exitNow = exit ?? (state === 'interrupted' ? await readExit(turn) : null);
        return /** @type {TurnFound} */ ({
          turn,
          harness: start.msg.harness,
          state: exitNow ? 'ended' : state,
          size: (await cleanup.deletedSize(turn)) ?? (await sizeOf(`${dir}/${TURN_FILES.out}`)),
          exit: exitNow,
        });
      }),
    );
    return /** @type {TurnFound[]} */ (found.filter(Boolean));
  }

  // ── Idle ──

  /** Arms the idle exit when nobody is attached; it fires once no turn runs, idleTimeout after the last client left. */
  function checkIdle() {
    if (closed) return;
    if (idleTimer) timers.clearTimeout(idleTimer);
    idleTimer = null;
    if (conns.size) return;
    const wait = Math.max(0, lastActive + settings.idleTimeout - now());
    idleTimer = timers.setTimeout(async () => {
      idleTimer = null;
      if (closed || conns.size) return;
      if (now() - lastActive < settings.idleTimeout) return checkIdle();
      const running = (await scan()).filter((t) => t.state === 'running');
      if (closed || conns.size) return;
      if (running.length) {
        // Look again later; the idle time counts from when the last turn was seen running.
        lastActive = now();
        return checkIdle();
      }
      await cleanup.sweep().catch((e) => log(`The cleanup before exiting failed: ${e.message}`));
      if (closed || conns.size) return;
      log(`Idle for ${Math.round(settings.idleTimeout / 1000)} s with no turn running and nobody attached; exiting.`);
      onIdle();
    }, wait);
  }

  // ── Connections ──

  /**
   * A Postbox channel: lines from it go to line(), and send() writes to output. Returns the line handlers.
   * @param {Output} output @param {() => void} [end]  closes the transport (a socket’s end); output.end() by default
   */
  function openConn(output, end = () => output.end()) {
    /** @type {Conn} */
    const c = {
      id: ++ids,
      output,
      ready: false,
      closed: false,
      follows: new Map(),
      queue: Promise.resolve(),
      close() {
        if (c.closed) return;
        c.closed = true;
        for (const f of c.follows.values()) f.stop();
        c.follows.clear();
        if (driver === c) driver = null;
        conns.delete(c);
        lastActive = now();
        try {
          end();
        } catch {}
        checkIdle();
      },
    };
    conns.add(c);
    checkIdle();
    return {
      conn: c,
      /** @param {string} text  one line, without its \n */
      line(text) {
        if (c.closed) return;
        const r = parseLine('postbox-to-daemon', text);
        if (!r.ok) return fail(c, 'bad-message', r.error);
        // Handled in order: Postbox may send read right after start.
        c.queue = c.queue.then(() =>
          c.closed
            ? undefined
            : dispatch(c, r.msg).catch((e) => {
                log(`A ${r.msg.type} failed: ${e.stack ?? e.message}`);
                fail(c, 'internal', `The daemon couldn’t handle ${r.msg.type}: ${e.message}`, r.msg.type, r.msg.turn);
              }),
        );
      },
      /** @param {{ message: string }} e */
      error(e) {
        if (!c.closed) fail(c, 'bad-message', e.message);
      },
      close: () => c.close(),
    };
  }

  /** @param {Conn} c @param {string} type @param {Record<string, unknown>} body @returns {Promise<void> | undefined} */
  function send(c, type, body) {
    if (c.closed) return;
    const ok = c.output.write(encode(message('daemon-to-postbox', type, body)));
    if (!ok && c.output.once) return new Promise((resolve) => c.output.once?.('drain', () => resolve()));
  }
  /** @param {Conn} c @param {string} code @param {string} text @param {string} [re] @param {string} [turn] */
  function fail(c, code, text, re, turn) {
    send(c, 'error', { code, message: text.slice(0, REMOTE_LIMITS.messageChars), ...(re ? { re } : {}), ...(turn ? { turn } : {}) });
  }

  /** Each message after hello, by type. @type {Record<string, (c: Conn, m: any) => Promise<void> | void>} */
  const handlers = {
    start: (c, m) => start(c, m),
    read: (c, m) => read(c, m),
    write: (c, m) => write(c, m),
    stop: (c, m) => stop(c, m),
    ack: (c, m) => ack(c, m),
    remove: (c) => remove(c),
  };

  /** @param {Conn} c @param {any} m */
  async function dispatch(c, m) {
    if (m.type === 'hello') return hello(c, m);
    if (!c.ready) return fail(c, 'not-ready', 'Say hello with the host’s token first.', m.type, m.turn);
    if (removing) return fail(c, 'internal', 'Postbox is being removed from this host.', m.type, m.turn);
    if (Object.hasOwn(handlers, m.type)) return handlers[m.type](c, m);
    const reply = { send: (type, body) => send(c, type, body), fail: (code, text) => fail(c, code, text, m.type, m.turn) };
    if (brk.message && (await brk.message(m, reply))) return;
    const code = { answer: 'no-prompt', reply: 'no-tool' }[m.type] ?? 'internal';
    fail(c, code, `This daemon doesn’t handle ${m.type} yet.`, m.type, m.turn);
  }

  /** @param {Conn} c @param {any} m */
  async function hello(c, m) {
    if (m.version !== PROTOCOL_VERSION)
      return fail(
        c,
        'version',
        `This host’s daemon speaks protocol ${PROTOCOL_VERSION}, and Postbox sent ${m.version}. Install this Postbox’s version on the host.`,
        'hello',
      );
    if (!tokenMatches(m.token))
      return fail(c, 'bad-token', `The token doesn’t match the host’s, in ~/.postbox-remote/token. Reinstall Postbox on the host.`, 'hello');
    if (driver && driver !== c && !driver.closed) {
      if (!m.takeover) return fail(c, 'busy', 'Another Postbox is using this host. Take over to use it from here.', 'hello');
      const old = driver;
      log(`Connection ${c.id} took over from ${old.id}.`);
      fail(old, 'taken-over', 'Another Postbox took over this host.');
      old.close();
    }
    driver = c;
    c.ready = true;
    settings = { ...HOST_DEFAULTS, ...(m.settings ?? {}) };
    programs = await findPrograms({ home, settings });
    if (c.closed) return;
    const turns = await scan();
    const allProblems = [...programs.problems, ...[...problems].map(([code, text]) => ({ code, message: text }))].slice(0, REMOTE_LIMITS.problems);
    await send(c, 'welcome', { version: PROTOCOL_VERSION, home, node: programs.node, harnesses: programs.harnesses, problems: allProblems, turns });
    checkIdle();
    await brk.hello?.((type, body) => send(c, type, body));
  }

  /**
   * Whether a path is under a folder, once symbolic links are followed: its nearest part that exists, real, is the
   * real folder or under it, and the path isn’t the folder itself. A part that doesn’t exist yet is made later, under
   * that one.
   * @param {string} top @param {string} path  an absolute path with no “..” or “.” parts
   */
  async function inside(top, path) {
    const real = (x) => fsp.realpath(x).catch(() => null);
    const realTop = await real(top);
    if (!realTop) return false;
    let at = path;
    let found = await real(at);
    while (!found && at !== '/') {
      at = dirname(at);
      found = await real(at);
    }
    if (!found) return false;
    // Under it, or the folder itself when the path’s own part doesn’t exist yet (so it’s made under it).
    if (found === realTop) return at !== path;
    return found.startsWith(realTop === '/' ? '/' : `${realTop}/`);
  }

  /**
   * The agents folder of the Kiro home a turn’s runner will use, as Kiro finds it: start.env’s KIRO_HOME (an Isolated
   * persona’s, which must be under ~/.postbox-remote), else the daemon’s own (the runner inherits it), else ~/.kiro.
   * @param {Record<string, string>} startEnv @returns {Promise<{ dir: string } | { error: string }>}
   */
  async function kiroAgents(startEnv) {
    const plain = (x) => x.startsWith('/') && x === posix.normalize(x) && (x === '/' || !x.endsWith('/'));
    if (Object.hasOwn(startEnv, 'KIRO_HOME')) {
      const kiro = startEnv.KIRO_HOME;
      if (!plain(kiro) || !(await inside(p.root, kiro)))
        return { error: `The turn’s KIRO_HOME ${kiro} isn’t under ${p.root}, so Postbox won’t write a Kiro agent file there.` };
      return { dir: `${kiro}/agents` };
    }
    const own = env.KIRO_HOME;
    if (own) {
      if (!plain(own)) return { error: `This host’s KIRO_HOME, ${own}, isn’t an absolute path, so Postbox can’t tell where Kiro reads agents from.` };
      return { dir: `${own === '/' ? '' : own}/agents` };
    }
    return { dir: `${home === '/' ? '' : home}/.kiro/agents` };
  }

  /** @param {Conn} c @param {any} m */
  async function start(c, m) {
    const failStart = (code, text) => fail(c, code, text, 'start', m.turn);
    const harness = programs?.harnesses.find((h) => h.name === m.harness);
    if (!harness?.path)
      return failStart('no-harness', `${m.harness} isn’t installed on this host. The daemon looked in ${harness?.looked.join(', ') || 'no folders'}.`);
    const node = programs?.node.path ?? process.execPath;
    const dir = p.turn(m.turn);
    if (!socketPathFits(p.turn(m.turn, TURN_FILES.socket)))
      return failStart('start-failed', `The turn’s socket path, ${p.turn(m.turn, TURN_FILES.socket)}, is too long for a Unix socket on Linux.`);
    if (await exists(dir)) return failStart('turn-exists', `There’s already a turn ${m.turn} on this host.`);
    // A Kiro agent file goes in the agents folder of the Kiro home the runner will use (kiroAgents).
    const agents = m.agentFile ? await kiroAgents(m.env) : null;
    if (agents && 'error' in agents) return failStart('start-failed', agents.error);
    // The working folder: the project’s own must exist; the default one under ~/postbox-work is made.
    try {
      if (!(await fsp.stat(m.folder)).isDirectory()) return failStart('start-failed', `${m.folder} isn’t a folder on this host.`);
    } catch (e) {
      if (e.code !== 'ENOENT') return failStart('start-failed', `Couldn’t open ${m.folder}: ${e.message}`);
      if (!m.folder.startsWith(`${home === '/' ? '' : home}/postbox-work/`))
        return failStart('start-failed', `The folder ${m.folder} doesn’t exist on this host. Create it, or change the project’s folder for this host.`);
      await fsp.mkdir(m.folder, { recursive: true, mode: DIR_MODE });
    }
    const record = { turn: m.turn, harness: m.harness, program: harness.path, argv: m.argv, env: m.env, stdin: m.stdin, folder: m.folder };
    const checked = validateStartRecord(record);
    if (!checked.ok) return failStart('start-failed', checked.error);
    try {
      await fsp.mkdir(p.turns, { recursive: true, mode: DIR_MODE });
      await fsp.mkdir(dir, { mode: DIR_MODE });
    } catch (e) {
      if (e.code === 'EEXIST') return failStart('turn-exists', `There’s already a turn ${m.turn} on this host.`);
      throw e;
    }
    try {
      for (const f of m.files) await fsp.writeFile(`${dir}/${f.name}`, f.text, { mode: FILE_MODE, flag: 'wx' });
      await brk.starting?.(m.turn);
      // Outside the turn folder (a Kiro home’s agents folder), recorded in it, so it goes when the turn ends.
      if (m.agentFile && agents && 'dir' in agents) await cleanup.writeAgentFile(m.turn, { dir: agents.dir, name: m.agentFile.name, text: m.agentFile.text });
      await writeAtomic(`${dir}/${TURN_FILES.start}`, JSON.stringify(record));
      const { pid, scoped, lingerOff } = await launchRunner({ node, turn: m.turn, paths: p, scope: settings.detach, spawn, logind });
      log(`Started turn ${m.turn} (${m.harness}), runner ${pid}${scoped ? ', in a systemd user scope' : ''}.`);
      // Only a scoped runner ends at the last logout: without the scope (KillUserProcesses off), a probe saw turns
      // survive with lingering off.
      if (scoped && lingerOff)
        problems.set(
          'no-linger',
          'Lingering is off for this user, so turns end when the last session on the host ends. Run “loginctl enable-linger” on the host to keep them running.',
        );
    } catch (e) {
      // Nothing ran, so the folder goes, and the same turn can be started again.
      await cleanup.dropAgentFile(m.turn).catch(() => {});
      await fsp.rm(dir, { recursive: true, force: true }).catch(() => {});
      return failStart('start-failed', `Couldn’t start turn ${m.turn}: ${e.message}`);
    }
    // `started` means the runner is up (the protocol): its socket answers, so a `write` right after it reaches the
    // runner, and messages on a channel are handled in order, so one sent before this answer waits for it.
    const up = await runnerUp(m.turn);
    if (up !== true) return failStart('start-failed', `Turn ${m.turn}’s runner didn’t start: ${up}`);
    send(c, 'started', { turn: m.turn });
    brk.started?.(m.turn);
  }

  /**
   * Waits for a launched runner: true once its socket answers or exit.json is there (a harness that ended at once),
   * else why not. A runner that refuses its turn says why in err.log before runner.json, and exits.
   * @param {string} turn @returns {Promise<true | string>}
   */
  async function runnerUp(turn) {
    const tries = Math.max(1, Math.ceil(runnerStartMs / RUNNER_START_POLL_MS));
    for (let i = 0; i < tries; i++) {
      if ((await runnerAlive(turn)) || (await exists(p.turn(turn, TURN_FILES.exit)))) return true;
      if (!(await exists(p.turn(turn, TURN_FILES.runner)))) {
        const said = (await fsp.readFile(p.turn(turn, TURN_FILES.err), 'utf8').catch(() => ''))
          .split('\n')
          .filter((l) => l.startsWith('postbox runner: '))
          .at(-1);
        if (said) return said.slice('postbox runner: '.length);
      }
      if (closed) return 'the daemon is closing.';
      await new Promise((resolve) => setTimeout(resolve, RUNNER_START_POLL_MS).unref());
    }
    return `its socket didn’t answer within ${Math.round(runnerStartMs / 1000)} s; see ${p.turn(turn, TURN_FILES.err)}.`;
  }

  /** The turn’s folder, or an error to the connection. @param {Conn} c @param {string} turn @param {string} re */
  async function needTurn(c, turn, re) {
    if (await exists(p.turn(turn, TURN_FILES.start))) return true;
    fail(c, 'no-turn', `There’s no turn ${turn} on this host.`, re, turn);
    return false;
  }

  /** @param {Conn} c @param {any} m */
  async function read(c, m) {
    if (!(await needTurn(c, m.turn, 'read'))) return;
    const which = m.log ?? 'out';
    const path = p.turn(m.turn, which === 'in' ? TURN_FILES.in : TURN_FILES.out);
    // Logs Postbox acked whole are gone once the turn ended: from 0 or their end, it hears only `ended`.
    const gone = await cleanup.deletedSize(m.turn);
    if (gone !== null && (m.from === 0 || m.from === gone)) {
      follow(c, m.turn, which, m.from, true, true);
      return;
    }
    if (!(await atLineStart(path, m.from)))
      return fail(c, 'bad-offset', `${m.from} isn’t 0, the start of a line or the end of ${m.turn}’s ${which} log.`, 'read', m.turn);
    follow(c, m.turn, which, m.from, false, true);
  }

  /** Whether an offset is 0, just past a \n, or the file’s size. */
  async function atLineStart(path, from) {
    if (from === 0) return true;
    let fh;
    try {
      fh = await fsp.open(path, 'r');
      const { size } = await fh.stat();
      if (from === size) return true;
      if (from > size) return false;
      const b = Buffer.alloc(1);
      await fh.read(b, 0, 1, from - 1);
      return b[0] === 10;
    } catch {
      return false;
    } finally {
      await fh?.close();
    }
  }

  /**
   * Sends a log’s lines from an offset, then follows it while the turn runs, then (for out.jsonl) `ended`. A quiet
   * follower sends only `ended`: the answer to a stop from a connection that isn’t reading the turn. A follower for a
   * `read` (`caughtUp`) says `caught-up` once, when its first pass has sent every line the log had then.
   * @param {Conn} c @param {string} turn @param {'out' | 'in'} which @param {number} from @param {boolean} quiet
   * @param {boolean} [caughtUp]
   */
  function follow(c, turn, which, from, quiet, caughtUp = false) {
    const key = `${turn}:${which}`;
    c.follows.get(key)?.stop();
    const dir = p.turn(turn);
    const path = `${dir}/${which === 'in' ? TURN_FILES.in : TURN_FILES.out}`;
    let stopped = false;
    let wake = () => {};
    let poked = false;
    /** @type {import('node:fs').FSWatcher | null} */
    let watcher = null;
    /** @type {NodeJS.Timeout | null} */
    let timer = null;
    /** @type {Follower} */
    const f = {
      stop() {
        stopped = true;
        f.poke();
      },
      poke() {
        poked = true;
        wake();
      },
    };
    c.follows.set(key, f);
    try {
      watcher = watch(dir, () => f.poke());
      watcher.on('error', () => {
        watcher?.close();
        watcher = null;
      });
      watcher.unref();
    } catch (e) {
      // Polling alone still sees everything, POLL_MS late (inotify’s watch limit, say).
      log(`Couldn’t watch ${dir} (${e.message}); polling it every ${pollMs} ms.`);
    }
    const nap = () =>
      new Promise((resolve) => {
        if (poked || stopped) {
          poked = false;
          return resolve(undefined);
        }
        wake = () => {
          wake = () => {};
          if (timer) clearTimeout(timer);
          poked = false;
          resolve(undefined);
        };
        timer = setTimeout(() => wake(), pollMs);
        timer.unref();
      });

    // The line being read: where it starts, its bytes so far (none kept once it’s too long), and its length.
    let pos = from;
    let lineStart = from;
    /** @type {Buffer[]} */
    let parts = [];
    let held = 0;
    let skipping = false;
    const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

    /** Sends one line, or a cut one: too long, not UTF-8, or too big as a message. */
    const emit = async (offset, next, cut) => {
      const base = { turn, ...(which === 'in' ? { log: which } : {}), offset, next };
      /** @type {string | null} */
      let text = null;
      if (!cut) {
        try {
          text = decoder.decode(parts.length === 1 ? parts[0] : Buffer.concat(parts, held));
        } catch {
          text = null;
        }
      }
      const body = text === null ? null : { ...base, text };
      if (body && encodedBytes({ type: 'line', ...body }) <= REMOTE_LIMITS.lineBytes) await send(c, 'line', body);
      else await send(c, 'line', { ...base, text: '', cut: true });
    };
    const reset = (next) => {
      parts = [];
      held = 0;
      skipping = false;
      lineStart = next;
    };
    const take = async (buf) => {
      let i = 0;
      while (i < buf.length) {
        const nl = buf.indexOf(10, i);
        const end = nl === -1 ? buf.length : nl;
        const n = end - i;
        if (!skipping && held + n > REMOTE_LIMITS.streamLineBytes) {
          skipping = true;
          parts = [];
        }
        if (!skipping && n) parts.push(Buffer.from(buf.subarray(i, end)));
        held += n;
        if (nl === -1) break;
        const next = lineStart + held + 1;
        await emit(lineStart, next, skipping);
        reset(next);
        i = nl + 1;
      }
    };
    /** Reads to the end of the file as it is now. */
    const drain = async () => {
      let fh;
      try {
        fh = await fsp.open(path, 'r');
      } catch (e) {
        if (e.code === 'ENOENT') return;
        throw e;
      }
      try {
        const buf = Buffer.alloc(READ_CHUNK);
        for (;;) {
          if (stopped) return;
          const { bytesRead } = await fh.read(buf, 0, buf.length, pos);
          if (!bytesRead) return;
          pos += bytesRead;
          await take(buf.subarray(0, bytesRead));
        }
      } finally {
        await fh.close();
      }
    };

    const run = async () => {
      let misses = 0;
      while (!stopped && !c.closed) {
        let exit = await readExit(turn);
        let over = Boolean(exit);
        if (!over) {
          // Interrupted: the runner doesn’t answer twice running, or isn’t the one runner.json names.
          if (dead.has(turn) || !(await runnerAlive(turn))) misses++;
          else misses = 0;
          if (dead.has(turn) || misses >= 2) {
            exit = await readExit(turn);
            over = true;
          }
        }
        if (!quiet) await drain();
        if (stopped || c.closed) return;
        // The last line may have no \n; it’s sent now that nothing more will come.
        if (over && !quiet && (held || skipping)) {
          await emit(lineStart, lineStart + held, skipping);
          reset(lineStart + held);
        }
        if (caughtUp) {
          // Every line the log had when this pass got to its end has gone: size is the file’s size then, less a last
          // line still without its \n, which waits for more.
          caughtUp = false;
          await send(c, 'caught-up', { turn, log: which, size: quiet ? from : lineStart });
        }
        if (over) {
          if (which === 'out') await send(c, 'ended', { turn, exit, size: (await cleanup.deletedSize(turn)) ?? (await sizeOf(path)) });
          if (exit) cleanup.turnEnded(turn).catch((e) => log(`Cleaning turn ${turn} failed: ${e.message}`));
          return;
        }
        await nap();
      }
    };
    run()
      .catch((e) => {
        log(`Following turn ${turn}’s ${which} log failed: ${e.stack ?? e.message}`);
        fail(c, 'internal', `Couldn’t read turn ${turn}’s ${which} log: ${e.message}`, 'read', turn);
      })
      .finally(() => {
        watcher?.close();
        if (timer) clearTimeout(timer);
        if (c.follows.get(key) === f) c.follows.delete(key);
      });
    return f;
  }

  /** @param {Conn} c @param {any} m */
  async function write(c, m) {
    if (!(await needTurn(c, m.turn, 'write'))) return;
    const start = validateStartRecord(await readJson(p.turn(m.turn, TURN_FILES.start)));
    if (!start.ok || start.msg.stdin !== 'held') return fail(c, 'not-held', `Turn ${m.turn}’s stdin isn’t held, so it takes no lines.`, 'write', m.turn);
    if (await readExit(m.turn)) return fail(c, 'turn-ended', `Turn ${m.turn} has ended.`, 'write', m.turn);
    // A Codex answer to a request the broker already declined would be a second answer to it.
    const check = brk.checkWrite?.(m.turn, m.line) ?? { done: () => {} };
    if ('refused' in check) return fail(c, 'no-prompt', check.refused, 'write', m.turn);
    let upTo;
    try {
      upTo = await writeHeld(m.turn, m.line);
    } catch (e) {
      check.done(false);
      return fail(c, e.code === 'internal' ? 'internal' : 'turn-ended', e.message, 'write', m.turn);
    }
    check.done(true);
    send(c, 'written', { turn: m.turn, upTo });
  }

  /** One line for a turn’s held stdin, through its runner; resolves with in.jsonl’s size after it. */
  async function writeHeld(turn, line) {
    const token = readToken();
    if (!token) throw Object.assign(new Error(`Couldn’t read the host’s token at ${p.token}.`), { code: 'internal' });
    try {
      return await writeRunner({ socketPath: p.turn(turn, TURN_FILES.socket), turn, line, token });
    } catch (e) {
      throw new Error(`Turn ${turn}’s runner didn’t take the line: ${e.message}`);
    }
  }

  /**
   * SIGINT to the turn’s process group, then SIGKILL after the grace period, and only while runner.json still names a
   * live process (PID, boot ID and start time). If it doesn’t, the turn is interrupted, and nothing is signaled. The
   * connection hears `ended` on its read of the turn, or on its own if it isn’t reading it.
   *
   * Claude Code’s tool shells each lead a session of their own, outside the turn’s group, and outlive a SIGKILL to it
   * (proc.mjs, “A turn’s tool shells”). So their groups are recorded at SIGINT and again at SIGKILL, while the CLI that
   * started them is still their parent, and the SIGKILL goes to each one still there, then to the turn’s group.
   * @param {Conn} c @param {any} m
   */
  async function stop(c, m) {
    if (!(await needTurn(c, m.turn, 'stop'))) return;
    await stopTurn(m.turn);
    if (!c.follows.has(`${m.turn}:out`)) follow(c, m.turn, 'out', 0, true);
  }
  /**
   * Stop without a connection to answer (the cap and `remove` use it too): whether a runner was signaled.
   * @param {string} turn @returns {Promise<boolean>}
   */
  async function stopTurn(turn) {
    // First, so a shim call made from here on is refused, as on the laptop (#126).
    await brk.stopping?.(turn);
    if (await readExit(turn)) return false;
    const rec = validateRunnerRecord(await readJson(p.turn(turn, TURN_FILES.runner)));
    if (!rec.ok || !(await proc.sameProcess(rec.msg))) {
      log(
        `Stop for turn ${turn}: ${rec.ok ? `process ${rec.msg.pid} isn’t its runner any more` : 'no valid runner.json'}, so it’s interrupted; nothing was signaled.`,
      );
      dead.add(turn);
      pokeTurn(turn);
      return false;
    }
    const pid = rec.msg.pid;
    recordShells(turn, pid);
    signal(pid, 'SIGINT', turn);
    if (!killTimers.has(turn))
      killTimers.set(
        turn,
        timers.setTimeout(async () => {
          killTimers.delete(turn);
          // The harness may have ended on SIGINT and left a shell running, so the recorded shell groups still
          // there are killed either way, as the laptop’s stopTurn does. liveGroups matches a group only by a member
          // with the start time it was recorded with, so a reused PID is never hit. Only the turn’s own group waits on
          // runner.json still naming a live runner.
          const ended = (await readExit(turn)) || !(await proc.sameProcess(rec.msg));
          if (!ended) recordShells(turn, pid);
          const found = [...(shells.get(turn)?.values() ?? [])];
          shells.delete(turn);
          for (const g of await proc.liveGroups(found)) signal(g.pgid, 'SIGKILL', turn, 'tool shell group');
          if (ended) return;
          signal(pid, 'SIGKILL', turn);
          // The runner went with its group, so nobody else will say how the harness ended.
          try {
            await fsp.writeFile(p.turn(turn, TURN_FILES.exit), JSON.stringify({ code: null, signal: 'SIGKILL', at: now() }), { mode: FILE_MODE, flag: 'wx' });
          } catch {}
          pokeTurn(turn);
        }, stopGraceMs),
      );
    return true;
  }
  /**
   * Adds the tool shells’ groups under a turn’s group, as they are now, to what Stop has recorded for it (a group seen
   * both times keeps the members it had each time).
   * @param {string} turn @param {number} pgid
   */
  function recordShells(turn, pgid) {
    const seen = proc.toolGroups(pgid);
    if (seen === null) log(`Couldn’t list this host’s processes, so Stop for turn ${turn} reaches only its own group, not its tool shells.`);
    const mine = shells.get(turn) ?? new Map();
    for (const g of seen ?? []) {
      const had = mine.get(g.pgid);
      mine.set(g.pgid, had ? { pgid: g.pgid, members: [...had.members, ...g.members] } : g);
    }
    shells.set(turn, mine);
  }
  const signal = (pgid, sig, turn, what = 'group') => {
    try {
      kill(-pgid, sig);
      log(`Sent ${sig} to turn ${turn}’s ${what} ${pgid}.`);
    } catch (e) {
      if (e.code !== 'ESRCH') log(`Couldn’t send ${sig} to turn ${turn}’s ${what} ${pgid}: ${e.message}`);
    }
  };
  const pokeTurn = (turn) => {
    for (const c of conns) for (const [k, f] of c.follows) if (k.startsWith(`${turn}:`)) f.poke();
  };

  /** @param {Conn} c @param {any} m */
  async function ack(c, m) {
    if (!(await needTurn(c, m.turn, 'ack'))) return;
    const size = (await cleanup.deletedSize(m.turn)) ?? (await sizeOf(p.turn(m.turn, TURN_FILES.out)));
    if (m.upTo > size) return fail(c, 'bad-offset', `${m.upTo} is past the end of ${m.turn}’s log.`, 'ack', m.turn);
    // Kept in the turn folder, so a restarted daemon still knows; an ended turn’s logs may go now (cleanup.mjs).
    acked.set(m.turn, await cleanup.ack(m.turn, m.upTo));
  }

  /**
   * `remove`: stops every running turn, waits for them to end (Stop’s grace period, then REMOVE_WAIT_MS at most),
   * deletes ~/.postbox-remote (cleanup.mjs refuses one that isn’t the home folder’s own), says `removed`, and exits.
   * @param {Conn} c
   */
  async function remove(c) {
    removing = true;
    const bad = await cleanup.rootProblem();
    if (bad) {
      removing = false;
      return fail(c, 'internal', bad, 'remove');
    }
    const records = [];
    for (const t of (await scan()).filter((x) => x.state === 'running')) {
      await stopTurn(t.turn);
      const rec = validateRunnerRecord(await readJson(p.turn(t.turn, TURN_FILES.runner)));
      if (rec.ok) records.push({ turn: t.turn, rec: rec.msg });
    }
    const live = async () => {
      const still = [];
      for (const r of records) if (!(await readExit(r.turn)) && (await proc.sameProcess(r.rec))) still.push(r.turn);
      return still;
    };
    let still = await live();
    for (let i = Math.ceil((stopGraceMs + REMOVE_WAIT_MS) / pollMs); still.length && i > 0; i--) {
      await new Promise((resolve) => setTimeout(resolve, pollMs).unref());
      still = await live();
    }
    if (still.length) log(`Turns ${still.join(', ')} hadn’t ended ${Math.round((stopGraceMs + REMOVE_WAIT_MS) / 1000)} s after Stop; removing anyway.`);
    for (const x of conns) for (const f of x.follows.values()) f.stop();
    try {
      await cleanup.removeAll((pid) => kill(pid, 'SIGTERM'));
    } catch (e) {
      removing = false;
      return fail(c, 'internal', `Couldn’t remove Postbox from this host: ${e.message}`, 'remove');
    }
    await send(c, 'removed', {});
    for (const x of [...conns]) x.close();
    closed = true;
    if (idleTimer) timers.clearTimeout(idleTimer);
    if (sweepTimer) timers.clearTimeout(sweepTimer);
    onRemoved();
  }

  /** Sweeps every sweepMs (cleanup.mjs); the timer is unref’d, like the others. */
  function armSweep() {
    if (closed) return;
    sweepTimer = timers.setTimeout(async () => {
      sweepTimer = null;
      if (closed) return;
      await cleanup.sweep().catch((e) => log(`The cleanup sweep failed: ${e.message}`));
      armSweep();
    }, sweepMs);
  }

  /**
   * Splits a channel’s bytes into lines for a handler.
   * @param {(text: string) => void} onLine @param {(e: { message: string }) => void} onError
   */
  const lineReader = (onLine, onError) => createLineReader({ onLine, onError });

  const attached = () => Boolean(driver && !driver.closed && driver.ready);
  /** Sends a message to the driving Postbox, if one is attached. Returns whether it went. */
  const toPostbox = (type, body) => {
    if (!driver || !attached()) return false;
    send(driver, type, body);
    return true;
  };
  /** @type {Broker} */
  const brk =
    broker ??
    createBroker({
      paths: p,
      now,
      timers,
      log,
      tokenMatches,
      settings: () => settings,
      toPostbox,
      attached,
      interrupted: (turn) => dead.has(turn),
      writeStdin: writeHeld,
      codexPollMs: pollMs,
    });
  const shimSeam = shim ?? brk.shim;

  return {
    paths: p,
    /** Makes the token if it’s missing and arms the idle exit; call once, before any connection. */
    async start() {
      makeToken();
      await cleanup.sweep().catch((e) => log(`The cleanup at start failed: ${e.message}`));
      armSweep();
      const turns = await scan();
      log(`Daemon ${version} for ${home}: ${turns.length} turn folders (${turns.filter((t) => t.state === 'running').length} running).`);
      await brk.load?.(turns);
      checkIdle();
      return turns;
    },
    scan,
    /** How far Postbox has applied each turn’s out.jsonl, in this daemon’s life; `.ack` keeps it on disk. */
    acked,
    cleanup,
    /**
     * A Postbox channel over a pair of streams, such as an ssh child’s, or PassThroughs in a test.
     * @param {{ input: import('node:stream').Readable, output: Output & { end: () => void } }} io
     */
    connect({ input, output }) {
      const h = openConn(output);
      const reader = lineReader(h.line, h.error);
      input.on('data', (b) => reader.push(b));
      input.on('end', () => {
        reader.end();
        h.close();
      });
      input.on('error', () => h.close());
      return h.conn;
    },
    /**
     * A connection to the daemon’s socket: a relayed Postbox, or a turn’s shim, by its first line.
     * @param {import('node:net').Socket} socket
     */
    accept(socket) {
      /** @type {{ line: (text: string) => void, error?: (e: { message: string }) => void, close: () => void } | null} */
      let h = null;
      const first = (text) => {
        let v;
        try {
          v = JSON.parse(text);
        } catch {}
        if (v && typeof v === 'object' && v.type === 'hello' && Object.hasOwn(v, 'turn') && !Object.hasOwn(v, 'version')) {
          if (!shimSeam) {
            const r = validateMessage('daemon-to-shim', { type: 'error', code: 'internal', message: 'This daemon doesn’t serve the shim yet.' });
            if (r.ok) socket.end(encode(r.msg));
            return;
          }
          h = shimSeam({ first: text, write: (s) => socket.write(s), end: () => socket.end() });
          return;
        }
        h = openConn(socket, () => socket.end());
        h.line(text);
      };
      const reader = lineReader(
        (text) => (h ? h.line(text) : first(text)),
        (e) => (h?.error ? h.error(e) : socket.destroy()),
      );
      socket.on('data', (b) => reader.push(b));
      socket.on('end', () => {
        reader.end();
        h?.close();
        socket.end();
      });
      socket.on('error', (e) => {
        log(`A socket connection failed: ${e.message}`);
        h?.close();
      });
      socket.on('close', () => h?.close());
    },
    /** Sends a message to the driving Postbox, if one is attached (the broker’s queue). Returns whether it went. */
    toPostbox,
    /** The broker serving shims and Codex approvals. */
    broker: brk,
    get settings() {
      return settings;
    },
    /** Stops followers and timers; the connections stay as they are. */
    close() {
      closed = true;
      brk.close?.();
      if (idleTimer) timers.clearTimeout(idleTimer);
      if (sweepTimer) timers.clearTimeout(sweepTimer);
      for (const t of killTimers.values()) timers.clearTimeout(t);
      killTimers.clear();
      shells.clear();
      for (const c of [...conns]) c.close();
    },
  };
}

// ── The runner’s socket ──

/**
 * Sends one line for a held stdin to a turn’s runner with runner.mjs’s sendStdin: `who` with the token, which the
 * runner answers with `iam` for its turn, then `stdin`, which it answers with `written`.
 * @type {WriteRunner}
 */
export function defaultWriteRunner({ socketPath, turn, line, token }) {
  return sendStdin(socketPath, line, { token, turn });
}

// ── The `host` program ──

/**
 * The host’s token, made if missing: 32 random bytes as hex, 0600, in a 0700 folder. An existing one that’s group-
 * or other-accessible is set back to 0600, and said in the log, since the daemon can fix that itself; one that isn’t
 * a regular file of this user’s is refused, since anyone who could replace it could choose the token. Used by the
 * daemon at its start and by `host token`, install’s step that prints it for the laptop to keep.
 * @param {{ p: ReturnType<typeof hostPaths>, uid: number, log: (line: string) => void }} o
 *   uid: this user’s, which the token file must be owned by (-1 where there are no user IDs)
 * @returns {string} the token
 */
export function ensureToken({ p, uid, log }) {
  mkdirSync(p.root, { recursive: true, mode: DIR_MODE });
  const st = statSync(p.root);
  if ((st.mode & 0o777) !== DIR_MODE) {
    log(`${p.root} was mode ${(st.mode & 0o777).toString(8)}; setting it to 700.`);
    try {
      chmodSync(p.root, DIR_MODE);
    } catch (e) {
      log(`Couldn’t set ${p.root} to 700: ${e.message}`);
    }
  }
  try {
    const made = randomBytes(32).toString('hex');
    writeFileSync(p.token, made, { mode: FILE_MODE, flag: 'wx' });
    log(`Made the token at ${p.token}.`);
    return made;
  } catch (e) {
    if (e.code !== 'EEXIST') throw e;
  }
  const tok = lstatSync(p.token);
  if (!tok.isFile() || (uid >= 0 && tok.uid !== uid))
    throw new Error(
      `${p.token} isn’t a file of this user’s (${tok.isFile() ? `it’s owned by user ${tok.uid}` : 'it isn’t a regular file'}), so the daemon won’t trust it. Remove it and reinstall Postbox on the host to make a new one.`,
    );
  if (tok.mode & 0o077) {
    log(`${p.token} was mode ${(tok.mode & 0o777).toString(8)}; setting it to 600.`);
    chmodSync(p.token, FILE_MODE);
  }
  return readFileSync(p.token, 'utf8').trim();
}

/**
 * @typedef {{ argv: string[], getuid?: () => number, stdin?: NodeJS.ReadableStream, stdout?: NodeJS.WritableStream,
 *   stderr?: { write: (s: string) => any }, home?: string, connect?: (path: string) => import('node:net').Socket,
 *   spawn?: any, now?: () => number, sleep?: (ms: number) => Promise<void>, nodeVersion?: string,
 *   umask?: (mask: number) => number, proc?: LockProc }} MainOpts
 * @typedef {{ bootId: () => string | null, startTime: (pid: number) => number | null, sameProcess: (r: any) => boolean }} LockProc
 *   proc.mjs’s, for the start lock’s and daemon.pid’s owner records
 */

/**
 * `host attach` (the relay, starting the daemon if none answers), `host serve` (the daemon) and `host token` (makes the
 * token if it’s missing and prints it, for install). Resolves with the exit code; `serve` resolves only when the
 * daemon exits.
 * @param {MainOpts} o
 */
export async function main({
  argv,
  getuid = () => (process.getuid ? process.getuid() : -1),
  stdin = process.stdin,
  stdout = process.stdout,
  stderr = process.stderr,
  home,
  connect = (path) => net.connect(path),
  spawn = nodeSpawn,
  now = Date.now,
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
  nodeVersion = process.version,
  umask = (mask) => process.umask(mask),
  proc = defaultProc,
}) {
  const say = (line) => stderr.write(`postbox host: ${line}\n`);
  const tell = (code, text) => {
    say(text);
    try {
      stdout.write(encode(message('daemon-to-postbox', 'error', { code, message: text })));
    } catch {}
  };
  const cmd = argv[0];
  if (cmd !== 'attach' && cmd !== 'serve' && cmd !== 'token') {
    say('Usage: host attach. Postbox runs it over ssh; it speaks JSON lines on stdin and stdout.');
    return EXIT.usage;
  }
  if (getuid() === 0) {
    tell('root', 'Postbox’s daemon doesn’t run as root. Connect to this host as your own user.');
    return EXIT.noperm;
  }
  if (Number(/^v?(\d+)/.exec(nodeVersion)?.[1] ?? 0) < NODE_MAJOR) {
    tell('no-node', `Postbox’s daemon needs Node ${NODE_MAJOR} or later, and this host’s node is ${nodeVersion}.`);
    return EXIT.unavailable;
  }
  const p = paths(home ? { home } : {});
  if (cmd === 'token') {
    // Install’s last step (server/remote/install.mjs): the token, made if it’s missing, on one line of its own.
    umask(0o077);
    try {
      stdout.write(`${ensureToken({ p, uid: getuid(), log: say })}\n`);
      return EXIT.ok;
    } catch (e) {
      tell('internal', `Couldn’t make or read the host’s token at ${p.token}: ${e.message}`);
      return EXIT.software;
    }
  }
  if (!socketPathFits(p.socket)) {
    tell('internal', `The daemon’s socket path, ${p.socket}, is too long for a Unix socket on Linux.`);
    return EXIT.software;
  }
  // An attach makes the version’s folder only while it holds the start lock (attach), never under an install.
  if (cmd === 'serve') {
    try {
      mkdirSync(p.code, { recursive: true, mode: DIR_MODE });
    } catch (e) {
      tell('internal', `Couldn’t make ${p.code}: ${e.message}`);
      return EXIT.software;
    }
    return serve({ p, home, say, connect, proc });
  }
  return attach({ p, stdin, stdout, say, tell, connect, spawn, now, sleep, proc });
}

/**
 * Connects to a Unix socket: the socket once it answers, or null when nothing listens (no file, or a stale one).
 * @param {(path: string) => import('node:net').Socket} connect @param {string} path
 * @returns {Promise<import('node:net').Socket | null>}
 */
export function tryConnect(connect, path) {
  return new Promise((resolve, reject) => {
    const sock = connect(path);
    const onError = (e) => {
      sock.destroy();
      if (e.code === 'ENOENT' || e.code === 'ECONNREFUSED') resolve(null);
      else reject(e);
    };
    sock.once('error', onError);
    sock.once('connect', () => {
      sock.off('error', onError);
      resolve(sock);
    });
  });
}

/**
 * The relay: finds or starts the daemon (the header), then pipes stdin to its socket and the socket to stdout until
 * either side ends.
 */
async function attach({ p, stdin, stdout, say, tell, connect, spawn, now, sleep, proc }) {
  const lock = p.lock;
  const me = ownerRecord(proc);
  /** @type {import('node:net').Socket | null} */
  let sock = null;
  try {
    const deadline = now() + SERVE_START_MS + LOCK_STALE_MS;
    while (!sock && now() < deadline) {
      sock = await tryConnect(connect, p.socket);
      if (sock) break;
      if (!takeLock(lock, me, now, proc)) {
        await sleep(50);
        continue;
      }
      try {
        sock = await tryConnect(connect, p.socket);
        if (!sock) {
          mkdirSync(p.code, { recursive: true, mode: DIR_MODE });
          sock = await startServe({ p, connect, spawn, now, sleep, say });
        }
      } finally {
        dropLock(lock, me);
      }
    }
  } catch (e) {
    tell('internal', `Couldn’t reach or start the daemon: ${e.message}`);
    return EXIT.unavailable;
  }
  if (!sock) {
    tell('internal', `No daemon answered on ${p.socket}, and none could be started.`);
    return EXIT.unavailable;
  }
  const s = sock;
  return new Promise((resolve) => {
    stdin.pipe(s);
    s.pipe(stdout, { end: false });
    s.on('error', (e) => say(`The daemon’s socket failed: ${e.message}`));
    s.on('close', () => resolve(EXIT.ok));
  });
}

/**
 * This process’s start lock owner record (proc.mjs, “The start lock’s owner”): its PID, boot ID and start time, or its
 * PID alone where those can’t be read, as the install script writes it without /proc.
 * @param {LockProc} proc
 */
function ownerRecord(proc) {
  const [bootId, startTime] = [proc.bootId(), proc.startTime(process.pid)];
  return JSON.stringify(bootId === null || startTime === null ? { pid: process.pid } : { pid: process.pid, bootId, startTime });
}

/**
 * Takes the start lock, a folder in ~/.postbox-remote/locks, with `me` as its owner record: true if it’s taken. One
 * that’s held is broken if it’s stale (lockStale), and taken at once; one that isn’t is waited for (the caller tries
 * again), whether an attach or an install (install.mjs) holds it.
 * @param {string} lock @param {string} me @param {() => number} now @param {LockProc} proc
 */
function takeLock(lock, me, now, proc) {
  mkdirSync(dirname(lock), { recursive: true, mode: DIR_MODE });
  for (let tries = 0; tries < 2; tries++) {
    try {
      mkdirSync(lock, { mode: DIR_MODE });
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      if (lockStale(lock, now, proc) && breakLock(lock, now, proc)) continue;
      return false;
    }
    // Written beside it and renamed in, so a reader never sees half a record.
    const tmp = `${lock}/.${LOCK_OWNER}.${process.pid}`;
    try {
      writeFileSync(tmp, me, { mode: FILE_MODE });
      renameSync(tmp, `${lock}/${LOCK_OWNER}`);
    } catch (e) {
      rmSync(lock, { recursive: true, force: true });
      throw e;
    }
    return true;
  }
  return false;
}

/**
 * Whether a held start lock is stale: its owner is gone, or it has had no owner record for LOCK_STALE_MS. False if
 * it’s gone meanwhile.
 * @param {string} lock @param {() => number} now @param {LockProc} proc
 */
function lockStale(lock, now, proc) {
  let text;
  try {
    text = readFileSync(`${lock}/${LOCK_OWNER}`, 'utf8');
  } catch {
    try {
      return now() - statSync(lock).mtimeMs > LOCK_STALE_MS;
    } catch {
      return false;
    }
  }
  return !(/** @type {boolean} */ (lockOwnerLive(parseLockOwner(text), { sameProcess: proc.sameProcess })));
}

/**
 * Removes a stale start lock under `<lock>.break`, judging it once more there: of two attaches (or an install) that
 * both found it stale, the second then finds the fresh lock the first made, and leaves it. A break lock is held for
 * one removal, so one older than BREAK_STALE_MS is from one that died holding it. True if it removed the lock.
 * @param {string} lock @param {() => number} now @param {LockProc} proc
 */
function breakLock(lock, now, proc) {
  const brk = `${lock}.break`;
  try {
    mkdirSync(brk, { mode: DIR_MODE });
  } catch {
    try {
      if (now() - statSync(brk).mtimeMs > BREAK_STALE_MS) rmdirSync(brk);
    } catch {}
    return false;
  }
  try {
    if (!lockStale(lock, now, proc)) return false;
    const aside = `${lock}.stale.${process.pid}`;
    rmSync(aside, { recursive: true, force: true });
    renameSync(lock, aside);
    rmSync(aside, { recursive: true, force: true });
    return true;
  } catch {
    return false;
  } finally {
    try {
      rmdirSync(brk);
    } catch {}
  }
}

/**
 * Drops the start lock, only while its owner record is still `me`: one broken and taken by another (say, after this
 * process was suspended past a check) is theirs, and stays. Renamed aside first, so it’s never seen without a record.
 * @param {string} lock @param {string} me
 */
function dropLock(lock, me) {
  try {
    if (readFileSync(`${lock}/${LOCK_OWNER}`, 'utf8') !== me) return;
    const aside = `${lock}.free.${process.pid}`;
    rmSync(aside, { recursive: true, force: true });
    renameSync(lock, aside);
    rmSync(aside, { recursive: true, force: true });
  } catch {}
}

/** Starts `host serve` detached, its stderr on daemon.log, and waits for its socket to answer. */
async function startServe({ p, connect, spawn, now, sleep, say }) {
  const logPath = `${p.code}/daemon.log`;
  try {
    if (statSync(logPath).size > LOG_KEEP_BYTES) renameSync(logPath, `${logPath}.1`);
  } catch {}
  const fd = openSync(logPath, constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT, FILE_MODE);
  /** @type {string | null} */
  let exited = null;
  try {
    const child = spawn(process.execPath, [HOST_ENTRY, 'serve'], { detached: true, stdio: ['ignore', 'ignore', fd], env: process.env });
    child.on('error', (e) => {
      exited = `it couldn’t start: ${e.message}`;
    });
    child.on('exit', (code, sig) => {
      // 0: another daemon holds daemon.pid and is starting; its socket answers soon.
      if (code !== 0) exited = `it exited (${sig ?? code}); see ${logPath}`;
    });
    child.unref();
  } finally {
    closeSync(fd);
  }
  say(`Started the daemon; its log is ${logPath}.`);
  const deadline = now() + SERVE_START_MS;
  while (now() < deadline) {
    const sock = await tryConnect(connect, p.socket);
    if (sock) return sock;
    if (exited) throw new Error(`The daemon didn’t start: ${exited}.`);
    await sleep(50);
  }
  throw new Error(`The daemon didn’t answer on ${p.socket} within ${SERVE_START_MS / 1000} s; see ${logPath}.`);
}

/**
 * The daemon: takes daemon.pid, binds the socket and serves until it’s idle or told to stop.
 * @param {{ p: ReturnType<typeof paths>, home?: string, say: (line: string) => void, connect: (path: string) => import('node:net').Socket,
 *   proc: LockProc }} o
 */
async function serve({ p, home, say, connect, proc }) {
  process.umask(0o077);
  // An ssh session that ends can send SIGHUP; turns and the next attach don’t need this one to go.
  process.on('SIGHUP', () => {});
  const lock = takeDaemonLock(p.code, proc);
  if (lock.held === false) {
    say(lock.why);
    return lock.code;
  }
  const release = lock.release;
  let other;
  try {
    other = await tryConnect(connect, p.socket);
  } catch (e) {
    release();
    say(`Couldn’t tell whether a daemon serves ${p.socket} (${e.message}), so it’s left as it is; exiting.`);
    return EXIT.unavailable;
  }
  if (other) {
    other.destroy();
    release();
    say('Another daemon already serves this version; exiting.');
    return EXIT.ok;
  }
  await fsp.rm(p.socket, { force: true });
  const server = net.createServer();
  /** @type {(code: number) => void} */
  let exit = () => {};
  const done = new Promise((resolve) => {
    exit = resolve;
  });
  const daemon = createDaemon({
    home: home ?? process.env.POSTBOX_REMOTE_HOME ?? (await import('node:os')).homedir(),
    log: (line) => say(line),
    onIdle: () => shutdown(EXIT.ok),
    onRemoved: () => shutdown(EXIT.ok),
  });
  const shutdown = async (code) => {
    daemon.close();
    await fsp.rm(p.socket, { force: true }).catch(() => {});
    server.close();
    release();
    exit(code);
  };
  server.on('connection', (sock) => daemon.accept(sock));
  // Before the socket answers, so a SIGTERM from someone who has seen it answer always gets the clean shutdown.
  process.on('SIGTERM', () => shutdown(EXIT.ok));
  process.on('SIGINT', () => shutdown(EXIT.ok));
  try {
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(p.socket, () => resolve(undefined));
    });
    await fsp.chmod(p.socket, FILE_MODE);
    await daemon.start();
  } catch (e) {
    await shutdown(EXIT.software);
    throw e;
  }
  return done;
}

/**
 * Takes daemon.pid for this process’s life (the header, step 3): `held` with a release that removes it only while
 * it’s still ours, or why not and the exit code.
 * @param {string} dir @param {{ bootId: () => string | null, startTime: (pid: number) => number | null, sameProcess: (r: any) => boolean }} proc
 * @returns {{ held: true, release: () => void } | { held: false, why: string, code: number }}
 */
export function takeDaemonLock(dir, proc) {
  const file = `${dir}/daemon.pid`;
  const me = { pid: process.pid, bootId: proc.bootId(), startTime: proc.startTime(process.pid) };
  if (me.bootId === null || me.startTime === null)
    return { held: false, why: 'Couldn’t read this process’s boot ID and start time, so the daemon can’t take its lock; exiting.', code: EXIT.software };
  const text = JSON.stringify(me);
  // Written whole beside it, then linked into place, which fails if daemon.pid is there: another serve never reads
  // a half-written one.
  const tmp = `${file}.${process.pid}.tmp`;
  try {
    writeFileSync(tmp, text, { mode: FILE_MODE });
  } catch (e) {
    return { held: false, why: `Couldn’t write ${tmp}: ${e.message}`, code: EXIT.software };
  }
  const brk = `${file}.break`;
  try {
    for (let tries = 0; tries < 20; tries++) {
      try {
        linkSync(tmp, file);
        let released = false;
        return {
          held: true,
          release() {
            if (released) return;
            released = true;
            try {
              if (readFileSync(file, 'utf8') === text) unlinkSync(file);
            } catch {}
          },
        };
      } catch (e) {
        if (e.code !== 'EEXIST') return { held: false, why: `Couldn’t make ${file}: ${e.message}`, code: EXIT.software };
      }
      const seen = readLockRecord(file);
      if (seen === null) continue;
      if (proc.sameProcess(seen.record)) return { held: false, why: `Daemon ${seen.record.pid} already serves this version; exiting.`, code: EXIT.ok };
      // Stale: removed under daemon.pid.break, and only if it’s still the one just read, so a serve that found it
      // stale a moment before another replaced it can’t remove the new one.
      try {
        mkdirSync(brk, { mode: DIR_MODE });
      } catch (e) {
        if (e.code !== 'EEXIST') return { held: false, why: `Couldn’t make ${brk}: ${e.message}`, code: EXIT.software };
        // It’s held for the moment one removal takes; one older than a second is from a serve that died holding it.
        try {
          if (Date.now() - statSync(brk).mtimeMs > 1000) rmdirSync(brk);
        } catch {}
        pause(10);
        continue;
      }
      try {
        if (readLockRecord(file)?.text === seen.text) unlinkSync(file);
      } catch {
      } finally {
        try {
          rmdirSync(brk);
        } catch {}
      }
    }
    return { held: false, why: `Couldn’t take ${file}: it kept changing; exiting.`, code: EXIT.unavailable };
  } finally {
    try {
      unlinkSync(tmp);
    } catch {}
  }
}
/** Waits without returning to the event loop, as long as one stale lock’s removal takes. @param {number} ms */
const pause = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

/**
 * daemon.pid’s text and record, or null if it’s missing. Text that isn’t a record reads as a dead process’s, so it’s
 * stale (daemon.pid is linked into place whole, so it isn’t one being written).
 * @param {string} file @returns {{ text: string, record: { pid: number, bootId: string, startTime: number } } | null}
 */
function readLockRecord(file) {
  let text;
  try {
    text = readFileSync(file, 'utf8');
  } catch {
    return null;
  }
  try {
    const r = JSON.parse(text);
    if (r && Number.isSafeInteger(r.pid) && typeof r.bootId === 'string' && Number.isSafeInteger(r.startTime)) return { text, record: r };
  } catch {}
  return { text, record: { pid: 0, bootId: '', startTime: -1 } };
}
