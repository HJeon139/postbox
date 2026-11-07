// The daemon’s constants and shapes (daemon.mjs’s header, #120), which its modules share: the timings, the exit codes,
// the entry point, and the state createDaemon passes each of its functions.

import { dirname, join } from 'node:path';
import { PROGRAMS } from './paths.mjs';

/** Stop’s grace period between SIGINT to the turn’s group and SIGKILL (C5: SIGINT ends a Claude Code turn). */
export const STOP_GRACE_MS = 10_000;
/** How often a follower looks at its log when no file event came (fs.watch can miss events, or be unavailable). */
export const POLL_MS = 1000;
/** How long a runner has to answer a liveness check. */
export const ASK_TIMEOUT_MS = 1000;
/**
 * How long a turn whose runner doesn’t answer, while runner.json still names its live process, is still running: from
 * the first miss, on the daemon’s clock (daemon-running.mjs, #738). Past it the turn ends as interrupted, so every turn
 * ends without the laptop.
 */
export const RUNNER_SILENT_MAX_MS = 60_000;
/**
 * How long a runner killed at that ceiling has to be gone before its turn ends anyway, said to be unkilled, so the
 * laptop doesn’t resume it beside a process that may still run (daemon-running.mjs, #872).
 */
export const KILL_WAIT_MS = 5000;
/** How long a silent runner’s last process check stands before the next look checks again (daemon-running.mjs, #872). */
export const PROCESS_CHECK_MS = 5000;
/** How long a launched runner has to answer on its socket before `start` fails, and how often it’s asked. */
export const RUNNER_START_MS = 10_000;
export const RUNNER_START_POLL_MS = 50;
/** How long an attach waits for the serve it started to answer. */
export const SERVE_START_MS = 10_000;
/**
 * A start lock with no owner record yet is one an attach or install has just made, and is held for this long; one
 * still without a record after it is from one that died between making it and writing its record, and is broken. A
 * lock with a record is judged by its owner alone. An attach waits for a held lock for up to SERVE_START_MS more than
 * this. The install script’s own grace (find’s -mmin +1) counts whole minutes, so it’s a minute, and cleanup’s is this.
 */
export const LOCK_STALE_MS = 3 * SERVE_START_MS;
/**
 * The start lock’s break lock (`<lock>.break`) and daemon.pid.break hold their owner’s record from the moment they’re
 * there (holdBreak), and are judged by it. One with no record isn’t one being made; it’s held this long all the same,
 * then broken. (An empty one, which no breaker leaves, is replaced at once: rename(2) replaces an empty folder.)
 */
export const BREAK_STALE_MS = 5000;
export const PID_BREAK_STALE_MS = 1000;
/** daemon.log is set aside as daemon.log.1 when it’s over this at serve’s start. */
export const LOG_KEEP_BYTES = 4 * 1024 * 1024;
/** How long `remove` waits for the turns it stopped to end, past Stop’s grace period. */
export const REMOVE_WAIT_MS = 5000;
/** The daemon’s entry point, which the `host` launcher (PROGRAMS.host, a shell script) runs with the Node it found. */
export const HOST_ENTRY = join(dirname(PROGRAMS.host), 'host.mjs');
/** Exit codes, from sysexits.h. */
export const EXIT = Object.freeze({ ok: 0, usage: 64, unavailable: 69, software: 70, noperm: 77 });

/** How much of a log a follower reads at a time. */
export const READ_CHUNK = 64 * 1024;

/**
 * runner.mjs’s and proc.mjs’s functions, injectable so tests run without processes.
 * @typedef {(o: { node: string, turn: string, paths: ReturnType<typeof import('../../../shared/remote-protocol.mjs').hostPaths>, scope: 'auto' | 'setsid', spawn: any, logind?: any })
 *   => { pid: number, scoped: boolean, lingerOff: boolean } | Promise<{ pid: number, scoped: boolean, lingerOff: boolean }>} LaunchRunner
 *   scoped: the runner went into a systemd user scope; lingerOff: logind says lingering is off for this user
 * @typedef {(socketPath: string, turn: string, o: { timeoutMs: number, token: string }) => Promise<boolean>} AskRunner
 * @typedef {{ sameProcess: (r: import('../../../shared/remote-protocol.mjs').RunnerRecord) => boolean | Promise<boolean>, bootId: () => string | null,
 *   toolGroups: (pgid: number) => import('./proc.mjs').ToolGroup[] | null,
 *   liveGroups: (groups: import('./proc.mjs').ToolGroup[]) => import('./proc.mjs').ToolGroup[] | Promise<import('./proc.mjs').ToolGroup[]> }} Proc
 * @typedef {(o: { socketPath: string, turn: string, line: string, token: string }) => Promise<number>} WriteRunner
 *   sends one held-stdin line to a runner and resolves with in.jsonl’s size after it
 * @typedef {{ setTimeout: (fn: () => void, ms: number) => any, clearTimeout: (t: any) => void }} Timers
 * @typedef {{ write: (s: string) => boolean, end: () => void, once?: (e: 'drain', fn: () => void) => any }} Output
 * @typedef {{ id: number, output: Output, ready: boolean, closed: boolean, follows: Map<string, Follower>,
 *   queue: Promise<void>, close: (reason?: 'replaced' | 'taken-over') => void, instance?: string | null }} Conn
 *   instance: the Postbox its hello named, once it’s the driver (daemon-hello.mjs)
 * @typedef {{ stop: () => void, poke: () => void }} Follower
 * @typedef {{ since: number, checked: number, look: number, pid: number, over: boolean, killedAt: number | null, unkilled: boolean }} Silence
 *   a runner’s silence: since its first miss, on the daemon’s monotonic clock (mono), on look number `look`; checked: when its process was
 *   last found there, on mono, which stands for PROCESS_CHECK_MS; over once it has lasted
 *   RUNNER_SILENT_MAX_MS, when its process is killed (killedAt, on mono); unkilled once it’s still there KILL_WAIT_MS later
 * @typedef {{ turn: string, harness: string, state: 'running' | 'ended' | 'interrupted', size: number,
 *   exit: import('../../../shared/remote-protocol.mjs').ExitRecord | null }} TurnFound
 * @typedef {{ hello?: (send: (type: string, body: Record<string, unknown>) => void) => void | Promise<void>,
 *   message?: (msg: any, reply: { send: (type: string, body: Record<string, unknown>) => void, fail: (code: string, text: string) => void }) => boolean | Promise<boolean>,
 *   load?: (turns: TurnFound[]) => Promise<void>, starting?: (turn: string) => Promise<void>, started?: (turn: string) => unknown,
 *   stopping?: (turn: string) => Promise<void>, checkWrite?: (turn: string, line: string) => { refused: string } | { done: (ok: boolean) => void },
 *   shim?: ShimSeam, driverLost?: () => void, close?: () => void | Promise<void> }} Broker
 *   broker.mjs’s seam: hello is called after each welcome (to resend what waits for Postbox); message gets snapshot,
 *   snapshot-items, answer and reply (remove is the daemon’s own: cleanup.mjs), and returns false for one it doesn’t
 *   take; load replays the turn folders at start; starting and started bracket a turn’s runner launch; stopping comes
 *   first in a Stop (and in the cap’s and remove’s); checkWrite before a held-stdin line goes.
 * @typedef {(conn: { first: string, write: (s: string) => boolean, end: () => void }) => { line: (text: string) => void, close: () => void }} ShimSeam
 */

/**
 * createDaemon’s options (its JSDoc says what each is for).
 * @typedef {{ home: string, version?: string, now?: () => number, mono?: () => number, timers?: Timers, spawn?: any, logind?: () => import('./runner.mjs').LogindFacts,
 *   launchRunner?: LaunchRunner, askRunner?: AskRunner, proc?: Proc, writeRunner?: WriteRunner,
 *   findPrograms?: (o: { home: string, settings: Record<string, any> }) => Promise<import('./programs.mjs').Programs>,
 *   kill?: (pid: number, signal: NodeJS.Signals) => void, log?: (line: string) => void, onIdle?: () => void,
 *   onRemoved?: () => void, pollMs?: number, stopGraceMs?: number, removeWaitMs?: number, runnerStartMs?: number, sweepMs?: number,
 *   broker?: Broker, shim?: ShimSeam, uid?: number, env?: Record<string, string | undefined> }} DaemonOpts
 */
/**
 * One daemon: its options, defaults filled in, and its state, which createDaemon passes to every function in the
 * daemon-*.mjs modules as `d`.
 * - settings: what the driver’s hello sent, over HOST_DEFAULTS. programs: what the last hello found.
 * - conns: Postbox connections, said hello or not. driver: the one that drives the daemon.
 * - acked: per turn, how far Postbox has applied out.jsonl; cleanup.mjs keeps it in `.ack`.
 * - dead: turns whose runner was found not to be the one runner.json names: interrupted, whatever a socket says.
 * - silentSince: turns whose runner stopped answering while its process still runs, and since when (daemon-running.mjs).
 *   looks: how many looks at a turn have begun, each one’s number; answeredLook: per turn, the newest look its runner
 *   answered, so crossing looks keep the newer verdict.
 * - killTimers: SIGKILL timers, per turn. shells: tool shells’ groups Stop recorded, per turn.
 * - stoppedFirst: turns asked to stop while this daemon didn’t have them: a start for one is refused (stop). In memory
 *   only, since a restart ends every channel a late start could come on.
 * - starting: starts under way, per turn, until they’ve answered.
 * - problems: problems found since the start, beside programs’ (lingering, rechecked at each hello; the log cap), for
 *   each welcome.
 * - removing: set once `remove` starts: nothing new starts after it.
 * - checks: the sign-in checks’ queue. checking: the signInCheck processes running, so close() can end them.
 * - brk: the broker (broker.mjs, or the test’s); shimSeam: what serves a shim’s connection.
 * @typedef {Required<Omit<DaemonOpts, 'broker' | 'shim'>> & { p: ReturnType<typeof import('../../../shared/remote-protocol.mjs').hostPaths>,
 *   settings: Record<string, any>, programs: import('./programs.mjs').Programs | null, conns: Set<Conn>, driver: Conn | null, ids: number,
 *   acked: Map<string, number>, dead: Set<string>, silentSince: Map<string, Silence>, looks: number, answeredLook: Map<string, number>, killTimers: Map<string, any>, shells: Map<string, Map<number, import('./proc.mjs').ToolGroup>>,
 *   stoppedFirst: Set<string>, starting: Map<string, Promise<void>>, problems: Map<string, string>, idleTimer: any, lastActive: number,
 *   closed: boolean, removing: boolean, sweepTimer: any, checks: Promise<void>, checking: Set<any>,
 *   cleanup: ReturnType<typeof import('./cleanup.mjs').createCleanup>, brk: Broker, shimSeam: ShimSeam | undefined }} Daemon
 */
