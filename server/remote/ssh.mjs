// The laptop’s connection to one remote host (#120): the system `ssh`, started by Postbox with fixed options and a
// fixed remote command, carrying shared/remote-protocol.mjs’s JSON lines over its stdio to the host’s daemon. The design
// is architecture.md, “Remote hosts”, sections “The SSH connection” and “Security”.
//
// - ssh is started from an argument array, never a shell on the laptop. On the host, sshd hands the one command string
//   to the login shell, so that string is fixed: the code folder for a validated version, then `attach`. Everything
//   else (the token, settings, turns) goes as JSON on stdin, so no shell ever parses a prompt, a path or a setting.
// - Command-line options come first, so they win over ~/.ssh/config: “for each configuration directive, the first
//   specified value will be used”, and command-line options are read before the user’s file (ssh_config(5)). The
//   person’s config still supplies everything these don’t set (ProxyJump, certificates, known hosts, a user).
// - A failure is classified from ssh’s exit status and stderr, or from the daemon’s `error` to hello, so the UI can say
//   what happened and what the person can do next (FAILURE_KINDS). ssh “exits with the exit status of the remote
//   command or with 255 if an error occurred” (ssh(1), EXIT STATUS).
// - Reconnecting is a policy the caller drives (createReconnector): Postbox retries with capped, jittered backoff only
//   while it needs the host (a turn running, a prompt waiting) and at once on the laptop’s wake (D2), and never retries
//   what only the person can fix.
//
// The daemon’s token: the daemon creates it on the host (~/.postbox-remote/token, 0600); install (L2) reads it back
// over ssh and keeps it on the laptop in its own file under Postbox’s data folder, `data/remote-tokens/<host id>`,
// mode 0600, never in the state the page reads. This module only takes it as `token` and sends it in hello, on stdin,
// never as an argument, which other local users could read from the process list.

import { spawn as nodeSpawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { createMessageReader, encode, HOST_ENFORCED, hostPaths, PROTOCOL_VERSION, validateMessage } from '../../shared/remote-protocol.mjs';
import { checkDestination, checkHostSettings } from '../../shared/remote-settings.mjs';

/** How much of ssh’s stderr is kept to classify a failure: its last 16 KiB. */
const STDERR_KEEP = 16 * 1024;
/** How long ssh and the daemon have to answer hello before Postbox gives up on this attempt. */
export const WELCOME_TIMEOUT = 2 * 60 * 1000;
/** How long ssh has to exit after close() before it gets SIGKILL. */
const KILL_GRACE = 5000;

/**
 * The command sshd runs on the host, through the login shell, which expands the ~. The version is checked as
 * hostPaths checks it, and the path is hostPaths’ `host`, so install, the daemon and this agree on one layout.
 * @param {string} version  Postbox’s package version, such as 0.10.0
 */
export function remoteCommand(version) {
  const host = hostPaths('/', version).host; // /.postbox-remote/<version>/server/remote/host/host
  // hostPaths allows only letters, digits, . + and - in a version; checked again here, since the shell reads this.
  if (!/^[A-Za-z0-9/.+-]+$/.test(host)) throw new TypeError(`“${version}” isn’t a version Postbox installs.`);
  return `~${host} attach`;
}

/**
 * ssh’s arguments for one host, without the program. The destination is checked here as well as where it entered, so
 * one starting with “-” never reaches ssh, which would read it as an option.
 * @param {{ destination: string, settings: import('../../shared/remote-settings.mjs').HostSettings, version: string }} o
 * @returns {string[]}
 */
export function sshArgs({ destination, settings, version }) {
  const d = checkDestination(destination);
  if (!d.ok) throw new TypeError(d.error);
  const s = checkHostSettings(settings, settings);
  if (!s.ok) throw new TypeError(s.error);
  const { keepAlive, dedicatedConnection, forwardAgent } = s.value;
  return [
    // “If set to yes, user interaction such as password prompts and host key confirmation requests will be disabled”
    // (ssh_config(5), BatchMode), so ssh fails at once instead of waiting on a prompt nobody sees.
    '-o',
    'BatchMode=yes',
    // A session on a multiplexed connection gets the leader’s options, so these wouldn’t apply; “the string none”
    // disables connection sharing (ssh_config(5), ControlPath). dedicatedConnection off keeps the person’s own.
    ...(dedicatedConnection ? ['-o', 'ControlPath=none'] : []),
    // “Specifies whether the connection to the authentication agent (if any) will be forwarded to the remote
    // machine” (ssh_config(5), ForwardAgent). Off unless the host’s settings turn it on.
    '-o',
    `ForwardAgent=${forwardAgent ? 'yes' : 'no'}`,
    // A keepalive after this many seconds “if no data has been received from the server”, and ssh disconnects after
    // ServerAliveCountMax unanswered: 15 s × 3 is “approximately 45 seconds” (ssh_config(5), ServerAliveInterval and
    // ServerAliveCountMax). The setting is in milliseconds, in whole seconds (remote-settings.mjs).
    '-o',
    `ServerAliveInterval=${Math.round(keepAlive.interval / 1000)}`,
    '-o',
    `ServerAliveCountMax=${keepAlive.count}`,
    // “Disable pseudo-terminal allocation” (ssh(1), -T): the channel carries JSON lines, which a tty would mangle.
    '-T',
    // ssh(1) doesn’t document “--”, but ssh parses its options with getopt(3), which ends them at “--”, and
    // openssh-portable’s ssh.c then sets opt_terminated, so the words after the destination aren’t parsed as options
    // either (without it, ssh re-reads them for options: the `goto again` after the host). So even a destination that
    // got past checkDestination with a leading “-” would be a destination, and the command stays a command.
    '--',
    d.value,
    // ssh(1): “If a command is specified, it will be executed on the remote host instead of a login shell.” One
    // argument, since ssh joins the words of a command with spaces anyway.
    remoteCommand(version),
  ];
}

/** The settings hello carries: HOST_ENFORCED, from the host’s settings. @param {import('../../shared/remote-settings.mjs').HostSettings} settings */
export function helloSettings(settings) {
  return Object.fromEntries(HOST_ENFORCED.map((k) => [k, structuredClone(settings[k])]));
}

// ── Failures ────────────────────────────────────────────────────────────────────────

/**
 * Each way a connection fails, and whether Postbox tries again on its own. The rest need the person: a sign-in, a
 * host key to check, an install, a newer version, or taking over from another Postbox.
 */
export const FAILURE_KINDS = Object.freeze({
  'sign-in': { retry: false },
  'host-key': { retry: false },
  unreachable: { retry: true },
  'not-installed': { retry: false },
  version: { retry: false },
  'bad-token': { retry: false },
  busy: { retry: false },
  // The daemon closed the channel itself, such as after `remove`.
  ended: { retry: true },
  failed: { retry: true },
});
/** @typedef {keyof typeof FAILURE_KINDS} FailureKind */

/** Whether Postbox reconnects after this kind of failure without being asked. @param {string} kind */
export const retries = (kind) => FAILURE_KINDS[kind]?.retry ?? false;

/** A failed or dropped connection: what happened (`message`) and what the person can do next (`next`). */
export class SshFailure extends Error {
  /**
   * @param {FailureKind} kind @param {string} message @param {string} next
   * @param {{ code?: number|null, signal?: string|null, stderr?: string, changed?: boolean }} [detail]
   */
  constructor(kind, message, next, detail = {}) {
    super(message);
    this.name = 'SshFailure';
    this.kind = kind;
    this.next = next;
    this.retry = retries(kind);
    this.detail = detail;
  }
}

// The strings are OpenSSH’s, from tests/fixtures/ssh/failures.json, which says which were recorded and which come from
// openssh-portable’s source. Each is matched on its own line, since ssh adds warnings around them.
const HOST_KEY_CHANGED = /REMOTE HOST IDENTIFICATION HAS CHANGED|POSSIBLE DNS SPOOFING DETECTED|Host key for .* has changed/;
const HOST_KEY = /^Host key verification failed\.$|^No \S+ host key is known for /m;
const SIGN_IN = /: Permission denied \([^)]*\)\.$|^Received disconnect from .*: Too many authentication failures|^Permission denied, please try again\.$/m;
const UNREACHABLE = new RegExp(
  [
    'Could not resolve hostname',
    '^ssh: connect to host .* port \\S+: ',
    '^Timeout, server .* not responding\\.$',
    '^Connection (?:closed|reset) by ',
    '^kex_exchange_identification: ',
    '^Connection timed out during banner exchange',
    'Broken pipe$',
    'Network is unreachable$',
    'No route to host$',
  ].join('|'),
  'm',
);
const OFFENDING = /^Offending \S+ key in (.+):(\d+)$/m;

/** The destination’s host, without a user, for commands like ssh-keygen -R. @param {string} d */
const hostOnly = (d) => d.replace(/^.*@/, '');
/** The last line of ssh’s output that says something, to quote. @param {string} text */
const lastLine = (text) =>
  text
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('**') && !/^@+$/.test(l))
    .at(-1) ?? '';

/**
 * A failure in words for the person, by kind.
 * @param {FailureKind} kind @param {string} d  the host’s destination
 * @param {{ code?: number|null, signal?: string|null, stderr?: string, changed?: boolean, why?: string, said?: string }} [detail]
 *   why: Postbox’s own reason, a sentence; said: the line of ssh’s stderr to quote, else its last line that says something.
 * @returns {SshFailure}
 */
export function failure(kind, d, detail = {}) {
  // Postbox’s own reason, else the line of ssh’s stderr that says the most.
  const said = detail.said || lastLine(detail.stderr ?? '');
  const quote = detail.why ? ` ${detail.why}` : said ? ` ssh said: “${said}”` : '';
  const tryAgain = 'Postbox tries again on its own while a turn runs or a prompt waits.';
  const text = {
    'sign-in': [
      `Postbox couldn’t sign in to ${d}: ssh had no key or certificate it could use without asking.`,
      `Sign in to ${d} in a terminal (run \`ssh ${d}\`), then reconnect.`,
    ],
    'host-key': detail.changed
      ? [
          `${d}’s host key has changed since you last connected, so ssh refused it. The host may have been rebuilt, or someone may be intercepting the connection.`,
          `Check the new key with whoever runs ${d} before you trust it. If it’s right, remove the old one with \`ssh-keygen -R ${hostOnly(d)}\`${
            OFFENDING.test(detail.stderr ?? '') ? ` (ssh found it at ${(detail.stderr ?? '').match(OFFENDING)?.slice(1).join(', line ')})` : ''
          }, connect once with \`ssh ${d}\` in a terminal, then reconnect.`,
        ]
      : [
          `ssh doesn’t know ${d}’s host key yet, and it won’t accept a new one without asking.`,
          `Connect once in a terminal with \`ssh ${d}\`, check that the fingerprint it shows is the host’s, accept it, then reconnect.`,
        ],
    unreachable: [
      `Postbox couldn’t reach ${d}.${quote}`,
      `Check that ${d} is running and that this computer can reach its network, such as over a VPN. ${tryAgain}`,
    ],
    'not-installed': [
      `Postbox’s host program isn’t installed on ${d}, or it couldn’t start.${quote}`,
      `Install Postbox on ${d} from the host’s settings, then reconnect.`,
    ],
    version: [
      `The Postbox daemon on ${d} speaks another version of the protocol.${quote}`,
      `Install this Postbox’s version on ${d} from the host’s settings, then reconnect.`,
    ],
    'bad-token': [`The daemon on ${d} didn’t accept Postbox’s token.${quote}`, `Reinstall Postbox on ${d} from the host’s settings, then reconnect.`],
    busy: [`Another Postbox is using ${d}.${quote}`, `Take over ${d} to use it from here; the other Postbox is disconnected.`],
    ended: [`The Postbox daemon on ${d} closed the connection.`, tryAgain],
    failed: [
      `The connection to ${d} failed${detail.code != null ? ` (ssh exited with ${detail.code})` : detail.signal ? ` (ssh ended on ${detail.signal})` : ''}.${quote}`,
      `Run \`ssh ${d}\` in a terminal to see what ssh says. ${tryAgain}`,
    ],
  }[kind];
  const { why: _why, said: _said, ...rest } = detail;
  return new SshFailure(kind, text[0], text[1], rest);
}

/**
 * Classifies how ssh ended before or after the daemon answered.
 * @param {{ destination: string, code: number|null, signal: string|null, stderr: string }} o
 * @returns {SshFailure}
 */
export function classifyExit({ destination, code, signal, stderr }) {
  const text = stderr.replace(/\r\n?/g, '\n');
  const detail = { code, signal, stderr: text };
  if (code === 255) {
    if (HOST_KEY_CHANGED.test(text)) return failure('host-key', destination, { ...detail, changed: true });
    if (HOST_KEY.test(text)) return failure('host-key', destination, detail);
    if (SIGN_IN.test(text)) return failure('sign-in', destination, detail);
    if (UNREACHABLE.test(text)) return failure('unreachable', destination, { ...detail, said: lastMatch(text) });
    return failure('failed', destination, detail);
  }
  // The login shell couldn’t find (127) or run (126) the host program: the fixed command names nothing else.
  if (code === 127 || code === 126) return failure('not-installed', destination, detail);
  if (code === 0) return failure('ended', destination, detail);
  return failure('failed', destination, detail);
}

/** The line UNREACHABLE matched, to quote. @param {string} text */
function lastMatch(text) {
  return (
    text
      .split('\n')
      .filter((l) => UNREACHABLE.test(l))
      .at(-1)
      ?.trim() ?? ''
  );
}

/** The daemon’s `error` to hello, as a failure. @param {string} destination @param {{ code: string, message: string }} m */
function classifyRefusal(destination, m) {
  const kind = m.code === 'version' || m.code === 'bad-token' || m.code === 'busy' ? m.code : 'failed';
  return failure(kind, destination, { why: `The host’s daemon said: “${m.message}”` });
}

// ── The connection ──────────────────────────────────────────────────────────────────

/**
 * @typedef {{ stdin: import('node:stream').Writable, stdout: import('node:stream').Readable,
 *             stderr: import('node:stream').Readable, kill(signal?: NodeJS.Signals): boolean,
 *             on(event: string, fn: (...args: any[]) => void): any, exitCode?: number|null }} SshChild
 * @typedef {(command: string, args: string[], options: object) => SshChild} SpawnLike
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
 *   this file). takeover: replace another Postbox that drives the daemon. spawn, program and the timers are for tests.
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

  const events = new EventEmitter();
  /** @type {'new' | 'connecting' | 'open' | 'closed'} */
  let state = 'new';
  /** @type {SshChild | null} */
  let child = null;
  let stderr = '';
  /** @type {SshFailure | null} why it ended, once known before ssh exits (a refused hello, a timeout) */
  let reason = null;
  let closedByUs = false;
  /** @type {Promise<any> | null} */
  let opening = null;
  /** @type {{ resolve: (w: any) => void, reject: (e: SshFailure) => void } | null} */
  let waiting = null;
  let welcomeTimer = null;
  let killTimer = null;

  const closedFailure = () => failure('failed', destination, { why: 'The connection was closed.' });
  /** @param {SshFailure | null} f @param {any} [welcome] */
  const settle = (f, welcome) => {
    if (welcomeTimer) clearTimer(welcomeTimer);
    welcomeTimer = null;
    const w = waiting;
    waiting = null;
    if (!w) return;
    if (f) w.reject(f);
    else w.resolve(welcome);
  };
  const stop = (/** @type {SshFailure | null} */ f) => {
    if (f && !reason) reason = f;
    if (!child) return;
    try {
      child.stdin.end();
    } catch {}
    child.kill('SIGTERM');
    killTimer ??= setTimer(() => child?.kill('SIGKILL'), KILL_GRACE);
  };
  const ended = (code, signal) => {
    if (state === 'closed') return;
    state = 'closed';
    if (killTimer) clearTimer(killTimer);
    const f = closedByUs && !reason ? null : (reason ?? classifyExit({ destination, code, signal, stderr }));
    settle(f ?? closedFailure());
    events.emit('close', f);
  };

  const reader = createMessageReader('daemon-to-postbox', {
    onMessage(m) {
      if (state === 'connecting') {
        if (m.type === 'welcome') {
          if (m.version !== PROTOCOL_VERSION) {
            const f = failure('version', destination, { why: `It speaks protocol ${m.version}; this Postbox speaks ${PROTOCOL_VERSION}.` });
            settle(f);
            return stop(f);
          }
          state = 'open';
          return settle(null, m);
        }
        if (m.type === 'error') {
          const f = classifyRefusal(destination, /** @type {any} */ (m));
          settle(f);
          return stop(f);
        }
        // Anything else before the welcome is the daemon’s bug; it’s reported and skipped.
        return events.emit('bad-line', { code: 'bad-message', message: `A ${m.type} came before the welcome.`, offset: -1 });
      }
      if (state === 'open') events.emit('message', m);
    },
    onError: (e) => events.emit('bad-line', e),
  });

  return withGetters(
    events,
    { state: () => state },
    {
      /** ssh’s arguments, for the person to see what runs. */
      args,
      /** @returns {Promise<any>} the welcome */
      connect() {
        if (opening) return opening;
        state = 'connecting';
        opening = new Promise((resolve, reject) => {
          waiting = { resolve, reject };
        });
        // ssh is the person’s program, found on PATH as a terminal would; no shell starts it.
        try {
          child = spawn(program, args, { stdio: ['pipe', 'pipe', 'pipe'] });
        } catch (e) {
          state = 'closed';
          settle(failure('failed', destination, { why: `Postbox couldn’t start ssh: ${e.message}` }));
          return opening;
        }
        const c = child;
        c.stdin.on('error', () => {}); // a write after ssh exits; its exit says why
        c.stdout.on('data', (b) => reader.push(b));
        c.stderr.setEncoding?.('utf8');
        c.stderr.on('data', (s) => {
          stderr = (stderr + s).slice(-STDERR_KEEP);
        });
        c.on('error', (e) => {
          // The process couldn’t start (ssh not installed: ENOENT); 'close' may not follow.
          reason ??= failure('failed', destination, {
            why: e.code === 'ENOENT' ? `ssh isn’t installed or isn’t on PATH (${program}).` : `Postbox couldn’t start ssh: ${e.message}`,
          });
          ended(null, null);
        });
        // 'close' comes after stdout and stderr have ended, so stderr is complete when it’s classified.
        c.on('close', (code, signal) => {
          reader.end();
          ended(code, signal);
        });
        welcomeTimer = setTimer(() => {
          const f = failure('unreachable', destination, { why: `No answer from the host within ${Math.round(welcomeTimeout / 1000)} seconds.` });
          settle(f);
          stop(f);
        }, welcomeTimeout);
        c.stdin.write(encode(checked.msg));
        return opening;
      },
      /**
       * Sends one message to the daemon, checked first: a message the daemon would refuse is Postbox’s bug, so it
       * throws instead of crossing. hello is the connection’s own.
       * @param {{ type: string, [field: string]: any }} msg
       */
      send(msg) {
        if (msg?.type === 'hello') throw new TypeError('The connection sends hello itself.');
        const r = validateMessage('postbox-to-daemon', msg);
        if (!r.ok) throw new TypeError(r.error);
        if (state !== 'open' || !child) throw new Error(`The connection to ${destination} isn’t open.`);
        return child.stdin.write(encode(r.msg));
      },
      /** Ends the connection: ssh’s stdin closes, then SIGTERM, then SIGKILL after a grace period. Turns go on. */
      close() {
        if (state === 'closed') return;
        closedByUs = true;
        if (!child) {
          state = 'closed';
          return;
        }
        settle(closedFailure());
        stop(null);
      },
    },
  );
}

// ── Reconnecting ────────────────────────────────────────────────────────────────────

/** The backoff: from `base`, times `factor` each attempt, capped at `max`, then jittered down by up to `jitter`. */
export const BACKOFF = Object.freeze({ base: 1000, factor: 2, max: 60_000, jitter: 0.5 });

/**
 * The wait before reconnect attempt `attempt` (0 for the first after a drop). Jitter spreads hosts that dropped
 * together, and never makes a wait longer than the cap.
 * @param {number} attempt @param {{ random?: () => number } & Partial<typeof BACKOFF>} [o]
 */
export function backoffDelay(attempt, { random = Math.random, ...o } = {}) {
  const { base, factor, max, jitter } = { ...BACKOFF, ...o };
  const capped = Math.min(max, base * factor ** Math.min(attempt, 30));
  return Math.round(capped * (1 - jitter * random()));
}

/**
 * Keeps one host connected while the caller needs it. The caller says when (`needed`: a turn running or a prompt
 * waiting) and calls `wake()` on the laptop’s wake, which tries at once (D2). A failure that only the person can fix
 * (FAILURE_KINDS’ retry: false) stops it until `retry()`, when they ask; the last one is `failure`.
 * - 'open' (conn, welcome): a connection is up; 'state' (state): idle, connecting, open, waiting (for a retry),
 *   stopped (a failure that isn’t retried).
 * @param {{ open: () => ReturnType<typeof createSshConnection>, needed: () => boolean,
 *           setTimer?: (fn: () => void, ms: number) => any, clearTimer?: (t: any) => void,
 *           delay?: (attempt: number) => number }} o
 */
export function createReconnector({
  open,
  needed,
  setTimer = (fn, ms) => setTimeout(fn, ms).unref(),
  clearTimer = (t) => clearTimeout(t),
  delay = backoffDelay,
}) {
  const events = new EventEmitter();
  /** @type {'idle' | 'connecting' | 'open' | 'waiting' | 'stopped'} */
  let state = 'idle';
  let attempt = 0;
  let timer = null;
  /** @type {ReturnType<typeof createSshConnection> | null} */
  let conn = null;
  /** @type {SshFailure | null} */
  let last = null;
  let disposed = false;

  const set = (s) => {
    state = s;
    events.emit('state', s);
  };
  const schedule = () => {
    if (disposed) return;
    if (!needed()) return set('idle');
    const ms = delay(attempt++);
    set('waiting');
    timer = setTimer(() => {
      timer = null;
      tryNow();
    }, ms);
  };
  const lost = (/** @type {SshFailure | null} */ f) => {
    conn = null;
    if (f) {
      last = f;
      events.emit('failure', f);
    }
    if (disposed || !f) return set('idle');
    if (!f.retry) return set('stopped');
    schedule();
  };
  const tryNow = () => {
    if (disposed || state === 'connecting' || state === 'open') return;
    if (timer) clearTimer(timer);
    timer = null;
    if (!needed()) return set('idle');
    set('connecting');
    const c = open();
    conn = c;
    c.connect().then(
      (welcome) => {
        if (disposed || conn !== c) return c.close();
        attempt = 0;
        last = null;
        c.once('close', lost);
        set('open');
        events.emit('open', c, welcome);
      },
      (f) => {
        if (conn === c) lost(f instanceof SshFailure ? f : failure('failed', 'the host', { why: String(f?.message ?? f) }));
      },
    );
  };

  /** @param {boolean} person  the person asked, so a failure only they could fix may have been fixed */
  const again = (person) => {
    if (state === 'stopped' && !person) return;
    if (state !== 'waiting' && state !== 'stopped' && state !== 'idle') return;
    attempt = 0;
    if (timer) clearTimer(timer);
    timer = null;
    state = 'idle';
    tryNow();
  };

  return withGetters(
    events,
    // The last failure stays until a connection opens.
    { state: () => state, connection: () => (state === 'open' ? conn : null), failure: () => last },
    {
      /** The caller now needs the host (a turn started, a prompt is waiting): connect unless connected or stopped. */
      need() {
        if (state === 'idle') tryNow();
      },
      /** The laptop woke (D2): try now, from the first backoff step, unless a failure only the person can fix stopped it. */
      wake: () => again(false),
      /** The person asked to reconnect, having signed in, checked the key or installed: try now, whatever stopped it. */
      retry: () => again(true),
      /** Stops reconnecting and closes any connection. */
      dispose() {
        disposed = true;
        if (timer) clearTimer(timer);
        timer = null;
        const c = conn;
        conn = null;
        c?.close();
        set('idle');
      },
    },
  );
}

/**
 * An emitter with live read-only properties and methods. Object.assign would copy a getter’s value once.
 * @template {object} T @template {Record<string, () => any>} G @template {object} M
 * @param {T} target @param {G} getters @param {M} methods
 * @returns {T & M & { readonly [K in keyof G]: ReturnType<G[K]> }}
 */
function withGetters(target, getters, methods) {
  for (const [k, get] of Object.entries(getters)) Object.defineProperty(target, k, { get, enumerable: true });
  return /** @type {any} */ (Object.assign(target, methods));
}
