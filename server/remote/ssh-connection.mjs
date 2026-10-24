// One connection to one host’s daemon (ssh.mjs): ssh started with ssh-args.mjs’s arguments, hello on its stdin, the
// daemon’s messages read from its stdout and ssh’s stderr kept to classify how it ended (ssh-failures.mjs). The
// connection’s state is one object, `c` below, that each of its steps takes, so each stays small.

import { spawn as nodeSpawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { createMessageReader, encode, PROTOCOL_VERSION, validateMessage } from '../../shared/remote-protocol.mjs';
import { helloSettings, sshArgs } from './ssh-args.mjs';
import { classifyExit, classifyRefusal, failure } from './ssh-failures.mjs';

/** How much of ssh’s stderr is kept to classify a failure: its last 16 KiB. */
const STDERR_KEEP = 16 * 1024;
/** How long ssh and the daemon have to answer hello before Postbox gives up on this attempt. */
export const WELCOME_TIMEOUT = 2 * 60 * 1000;
/** How long ssh has to exit after close() before it gets SIGKILL. */
const KILL_GRACE = 5000;

/**
 * @typedef {{ stdin: import('node:stream').Writable, stdout: import('node:stream').Readable,
 *             stderr: import('node:stream').Readable, kill(signal?: NodeJS.Signals): boolean,
 *             on(event: string, fn: (...args: any[]) => void): any, exitCode?: number|null }} SshChild
 * @typedef {(command: string, args: string[], options: object) => SshChild} SpawnLike
 * @typedef {import('./ssh-failures.mjs').SshFailure} SshFailure
 */

/**
 * A connection’s state, which each step below takes.
 * @typedef {{ destination: string, program: string, spawn: SpawnLike, setTimer: (fn: () => void, ms: number) => any,
 *   clearTimer: (t: any) => void, welcomeTimeout: number, args: string[], hello: object, events: EventEmitter,
 *   state: 'new' | 'connecting' | 'open' | 'closed', child: SshChild | null, stderr: string, reason: SshFailure | null,
 *   closedByUs: boolean, opening: Promise<any> | null,
 *   waiting: { resolve: (w: any) => void, reject: (e: SshFailure) => void } | null, welcomeTimer: any, killTimer: any,
 *   reader: { push(chunk: Uint8Array | string): void, end(): void } }} Conn
 *   reason: why it ended, once known before ssh exits (a refused hello, a timeout).
 */

/**
 * One host’s connection. connect() starts ssh, sends hello and resolves with the daemon’s welcome, or rejects with an
 * SshFailure. Then:
 * - 'message' (msg): each daemon-to-postbox message after the welcome, validated.
 * - 'bad-line' (e): a line from the daemon that wasn’t a valid message, which is skipped.
 * - 'close' (failure|null): the connection is gone; null when close() ended it, else an SshFailure saying why.
 * A connection is used once; reconnecting makes a new one (createReconnector).
 *
 * @param {{ destination: string, settings: import('../../shared/remote-settings.mjs').HostSettings, version: string,
 *           token: string, takeover?: boolean, spawn?: SpawnLike, program?: string,
 *           setTimer?: (fn: () => void, ms: number) => any, clearTimer?: (t: any) => void, welcomeTimeout?: number }} o
 *   version: Postbox’s package version, which names the code folder on the host. token: the daemon’s (see the top of
 *   ssh.mjs). takeover: replace another Postbox that drives the daemon. spawn, program and the timers are for tests.
 */
export function createSshConnection({
  destination,
  settings,
  version,
  token,
  takeover = false,
  spawn = nodeSpawn,
  program = 'ssh',
  setTimer = (fn, ms) => setTimeout(fn, ms).unref(),
  clearTimer = (t) => clearTimeout(t),
  welcomeTimeout = WELCOME_TIMEOUT,
}) {
  const args = sshArgs({ destination, settings, version });
  const hello = { type: 'hello', version: PROTOCOL_VERSION, token, ...(takeover ? { takeover: true } : {}), settings: helloSettings(settings) };
  const checked = validateMessage('postbox-to-daemon', hello);
  if (!checked.ok) throw new TypeError(checked.error);
  /** @type {Conn} */
  const c = {
    destination,
    program,
    spawn: /** @type {SpawnLike} */ (spawn),
    setTimer,
    clearTimer,
    welcomeTimeout,
    args,
    hello: checked.msg,
    events: new EventEmitter(),
    state: 'new',
    child: null,
    stderr: '',
    reason: null,
    closedByUs: false,
    opening: null,
    waiting: null,
    welcomeTimer: null,
    killTimer: null,
    reader: /** @type {any} */ (null),
  };
  c.reader = createMessageReader('daemon-to-postbox', {
    onMessage: (m) => onMessage(c, m),
    onError: (e) => c.events.emit('bad-line', e),
  });
  return withGetters(
    c.events,
    { state: () => c.state },
    {
      /** ssh’s arguments, for the person to see what runs. */
      args,
      /** @returns {Promise<any>} the welcome */
      connect: () => connect(c),
      /**
       * Sends one message to the daemon, checked first: a message the daemon would refuse is Postbox’s bug, so it
       * throws instead of crossing. hello is the connection’s own.
       * @param {{ type: string, [field: string]: any }} msg
       */
      send: (msg) => send(c, msg),
      /** Ends the connection: ssh’s stdin closes, then SIGTERM, then SIGKILL after a grace period. Turns go on. */
      close: () => close(c),
    },
  );
}

/** @param {Conn} c */
const closedFailure = (c) => failure('failed', c.destination, { why: 'The connection was closed.' });

/** Answers connect()’s promise, once. @param {Conn} c @param {SshFailure | null} f @param {any} [welcome] */
function settle(c, f, welcome) {
  if (c.welcomeTimer) c.clearTimer(c.welcomeTimer);
  c.welcomeTimer = null;
  const w = c.waiting;
  c.waiting = null;
  if (!w) return;
  if (f) w.reject(f);
  else w.resolve(welcome);
}

/** @param {Conn} c @param {SshFailure | null} f */
function stop(c, f) {
  if (f && !c.reason) c.reason = f;
  if (!c.child) return;
  try {
    c.child.stdin.end();
  } catch {}
  c.child.kill('SIGTERM');
  c.killTimer ??= c.setTimer(() => c.child?.kill('SIGKILL'), KILL_GRACE);
}

/** @param {Conn} c @param {number | null} code @param {string | null} signal */
function ended(c, code, signal) {
  if (c.state === 'closed') return;
  c.state = 'closed';
  if (c.killTimer) c.clearTimer(c.killTimer);
  const f = c.closedByUs && !c.reason ? null : (c.reason ?? classifyExit({ destination: c.destination, code, signal, stderr: c.stderr }));
  settle(c, f ?? closedFailure(c));
  c.events.emit('close', f);
}

/** @param {Conn} c @param {{ type: string, [field: string]: any }} m */
function onMessage(c, m) {
  if (c.state === 'connecting') {
    if (m.type === 'welcome') {
      if (m.version !== PROTOCOL_VERSION) {
        const f = failure('version', c.destination, { why: `It speaks protocol ${m.version}; this Postbox speaks ${PROTOCOL_VERSION}.` });
        settle(c, f);
        return stop(c, f);
      }
      c.state = 'open';
      return settle(c, null, m);
    }
    if (m.type === 'error') {
      const f = classifyRefusal(c.destination, /** @type {any} */ (m));
      settle(c, f);
      return stop(c, f);
    }
    // Anything else before the welcome is the daemon’s bug; it’s reported and skipped.
    return c.events.emit('bad-line', { code: 'bad-message', message: `A ${m.type} came before the welcome.`, offset: -1 });
  }
  if (c.state === 'open') c.events.emit('message', m);
}

/** @param {Conn} c @returns {Promise<any>} the welcome */
function connect(c) {
  if (c.opening) return c.opening;
  c.state = 'connecting';
  c.opening = new Promise((resolve, reject) => {
    c.waiting = { resolve, reject };
  });
  // ssh is the person’s program, found on PATH as a terminal would; no shell starts it.
  try {
    c.child = c.spawn(c.program, c.args, { stdio: ['pipe', 'pipe', 'pipe'] });
  } catch (e) {
    c.state = 'closed';
    settle(c, failure('failed', c.destination, { why: `Postbox couldn’t start ssh: ${e.message}` }));
    return c.opening;
  }
  listen(c, c.child);
  c.welcomeTimer = c.setTimer(() => {
    const f = failure('unreachable', c.destination, { why: `No answer from the host within ${Math.round(c.welcomeTimeout / 1000)} seconds.` });
    settle(c, f);
    stop(c, f);
  }, c.welcomeTimeout);
  c.child.stdin.write(encode(c.hello));
  return c.opening;
}

/** Reads ssh’s output and waits for it to end. @param {Conn} c @param {SshChild} child */
function listen(c, child) {
  child.stdin.on('error', () => {}); // a write after ssh exits; its exit says why
  child.stdout.on('data', (b) => c.reader.push(b));
  child.stderr.setEncoding?.('utf8');
  child.stderr.on('data', (s) => {
    c.stderr = (c.stderr + s).slice(-STDERR_KEEP);
  });
  child.on('error', (e) => {
    // The process couldn’t start (ssh not installed: ENOENT); 'close' may not follow.
    c.reason ??= failure('failed', c.destination, {
      why: e.code === 'ENOENT' ? `ssh isn’t installed or isn’t on PATH (${c.program}).` : `Postbox couldn’t start ssh: ${e.message}`,
    });
    ended(c, null, null);
  });
  // 'close' comes after stdout and stderr have ended, so stderr is complete when it’s classified.
  child.on('close', (code, signal) => {
    c.reader.end();
    ended(c, code, signal);
  });
}

/** @param {Conn} c @param {{ type: string, [field: string]: any }} msg */
function send(c, msg) {
  if (msg?.type === 'hello') throw new TypeError('The connection sends hello itself.');
  const r = validateMessage('postbox-to-daemon', msg);
  if (!r.ok) throw new TypeError(r.error);
  if (c.state !== 'open' || !c.child) throw new Error(`The connection to ${c.destination} isn’t open.`);
  return c.child.stdin.write(encode(r.msg));
}

/** @param {Conn} c */
function close(c) {
  if (c.state === 'closed') return;
  c.closedByUs = true;
  if (!c.child) {
    c.state = 'closed';
    return;
  }
  settle(c, closedFailure(c));
  stop(c, null);
}

/**
 * An emitter with live read-only properties and methods. Object.assign would copy a getter’s value once.
 * @template {object} T @template {Record<string, () => any>} G @template {object} M
 * @param {T} target @param {G} getters @param {M} methods
 * @returns {T & M & { readonly [K in keyof G]: ReturnType<G[K]> }}
 */
export function withGetters(target, getters, methods) {
  for (const [k, get] of Object.entries(getters)) Object.defineProperty(target, k, { get, enumerable: true });
  return /** @type {any} */ (Object.assign(target, methods));
}
