// Reconnecting to a host (ssh.mjs): a policy the caller drives. Postbox retries with capped, jittered backoff only
// while it needs the host, at once on the laptop’s wake (D2), and never retries what only the person can fix. The
// reconnector’s state is one object, `r` below, that each of its steps takes.

import { EventEmitter } from 'node:events';
import { withGetters } from './ssh-connection.mjs';
import { failure, SshFailure } from './ssh-failures.mjs';

/** @typedef {ReturnType<typeof import('./ssh-connection.mjs').createSshConnection>} SshConnection */

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
 * A reconnector’s state, which each step below takes.
 * @typedef {{ open: () => SshConnection, needed: () => boolean, setTimer: (fn: () => void, ms: number) => any,
 *   clearTimer: (t: any) => void, delay: (attempt: number) => number, events: EventEmitter,
 *   state: 'idle' | 'connecting' | 'open' | 'waiting' | 'stopped', attempt: number, timer: any,
 *   conn: SshConnection | null, last: SshFailure | null, disposed: boolean }} Reconnector
 */

/**
 * Keeps one host connected while the caller needs it. The caller says when (`needed`: a turn running or a prompt
 * waiting) and calls `wake()` on the laptop’s wake, which tries at once (D2). A failure that only the person can fix
 * (FAILURE_KINDS’ retry: false) stops it until `retry()`, when they ask; the last one is `failure`.
 * - 'open' (conn, welcome): a connection is up; 'state' (state): idle, connecting, open, waiting (for a retry),
 *   stopped (a failure that isn’t retried).
 * @param {{ open: () => SshConnection, needed: () => boolean,
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
  /** @type {Reconnector} */
  const r = {
    open,
    needed,
    setTimer,
    clearTimer,
    delay,
    events: new EventEmitter(),
    state: 'idle',
    attempt: 0,
    timer: null,
    conn: null,
    last: null,
    disposed: false,
  };
  return withGetters(
    r.events,
    // The last failure stays until a connection opens.
    { state: () => r.state, connection: () => (r.state === 'open' ? r.conn : null), failure: () => r.last },
    {
      /** The caller now needs the host (a turn started, a prompt is waiting): connect unless connected or stopped. */
      need() {
        if (r.state === 'idle') tryNow(r);
      },
      /** The laptop woke (D2): try now, from the first backoff step, unless a failure only the person can fix stopped it. */
      wake: () => again(r, false),
      /** The person asked to reconnect, having signed in, checked the key or installed: try now, whatever stopped it. */
      retry: () => again(r, true),
      /** Stops reconnecting and closes any connection. */
      dispose() {
        r.disposed = true;
        if (r.timer) r.clearTimer(r.timer);
        r.timer = null;
        const c = r.conn;
        r.conn = null;
        c?.close();
        set(r, 'idle');
      },
    },
  );
}

/** @param {Reconnector} r @param {Reconnector['state']} s */
function set(r, s) {
  r.state = s;
  r.events.emit('state', s);
}

/** @param {Reconnector} r */
function schedule(r) {
  if (r.disposed) return;
  if (!r.needed()) return set(r, 'idle');
  const ms = r.delay(r.attempt++);
  set(r, 'waiting');
  r.timer = r.setTimer(() => {
    r.timer = null;
    tryNow(r);
  }, ms);
}

/** @param {Reconnector} r @param {SshFailure | null} f */
function lost(r, f) {
  r.conn = null;
  if (f) {
    r.last = f;
    r.events.emit('failure', f);
  }
  if (r.disposed || !f) return set(r, 'idle');
  if (!f.retry) return set(r, 'stopped');
  schedule(r);
}

/** @param {Reconnector} r */
function tryNow(r) {
  if (r.disposed || r.state === 'connecting' || r.state === 'open') return;
  if (r.timer) r.clearTimer(r.timer);
  r.timer = null;
  if (!r.needed()) return set(r, 'idle');
  set(r, 'connecting');
  const c = r.open();
  r.conn = c;
  c.connect().then(
    (welcome) => {
      if (r.disposed || r.conn !== c) return c.close();
      r.attempt = 0;
      r.last = null;
      c.once('close', (f) => lost(r, f));
      set(r, 'open');
      r.events.emit('open', c, welcome);
    },
    (f) => {
      if (r.conn === c) lost(r, f instanceof SshFailure ? f : failure('failed', 'the host', { why: String(f?.message ?? f) }));
    },
  );
}

/** @param {Reconnector} r @param {boolean} person  the person asked, so a failure only they could fix may have been fixed */
function again(r, person) {
  if (r.state === 'stopped' && !person) return;
  if (r.state !== 'waiting' && r.state !== 'stopped' && r.state !== 'idle') return;
  r.attempt = 0;
  if (r.timer) r.clearTimer(r.timer);
  r.timer = null;
  r.state = 'idle';
  tryNow(r);
}
