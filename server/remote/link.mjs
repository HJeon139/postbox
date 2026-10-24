// The laptop’s link to one remote host (#120): one long-lived object over the SSH sessions that come and go. ssh.mjs’s
// createSshConnection is a single session, used once, and its createReconnector opens a new one with backoff while
// Postbox needs the host; this module owns that reconnector and presents the connection that server/remote/process.mjs
// (remoteSpawn) is written against, plus what the runtime and the UI need to know about the host (L5, L6).
//
// What the link promises (process.mjs’s header, “The connection”):
// - send(msg) returns true once msg is written to a session that has had its welcome, and false while there is none
//   (before the first welcome, between a drop and the next, after it gave up or closed). It never throws, even for a
//   message the daemon would refuse (that’s false too). A send that finds no session asks for one, if the host is needed.
// - 'message' (msg): each validated daemon-to-postbox message after a welcome, from whichever session is current.
//   Messages the daemon sends straight after its welcome (the prompts and tool calls it resends after each hello) can
//   arrive before the session’s welcome promise settles, so they’re held from the start of each session and passed on
//   once 'connected' has gone, in the order they came.
// - 'connected' (welcome): at every welcome, the first included.
// - 'error' (failure): only when it gives up: a failure only the person can fix (FAILURE_KINDS’ retry: false, such as
//   sign-in, a host key, busy), or close(). Emitted only to listeners, so a link nobody listens to for errors doesn’t
//   throw. After retry() it can connect again, and emits 'connected' again.
// - setMaxListeners(0): every turn’s child listens.
// And for the runtime and the UI: `welcome` (the latest, kept after a drop, so the host’s home and harnesses stay
// known), `failure` (the current SshFailure, with its kind and next step; null once a session opens), `state` (the
// reconnector’s), 'failure' (f) at each failure and 'state' (s) at each change, and need(), wake(), retry(), idle() and
// close().
//
// When it’s needed: while `needed()` says so, or by default while anything listens for 'message' (a turn’s child, or
// the runtime waiting on a prompt). The reconnector asks it before each attempt, so a host nobody needs isn’t redialed.

import { EventEmitter } from 'node:events';
import { createReconnector, createSshConnection, failure as sshFailure } from './ssh.mjs';

/**
 * @typedef {ReturnType<typeof createSshConnection>} SshConnection
 * @typedef {import('./ssh.mjs').SshFailure} SshFailure
 */

/**
 * One host’s link.
 * @param {{ host: Pick<import('../../shared/remote-settings.mjs').Host, 'name' | 'settings'>, version: string, token: string,
 *           takeover?: boolean, needed?: () => boolean, spawn?: import('./ssh.mjs').SpawnLike, program?: string,
 *           setTimer?: (fn: () => void, ms: number) => any, clearTimer?: (t: any) => void, delay?: (attempt: number) => number,
 *           welcomeTimeout?: number }} o
 *   host: its name is the ssh destination. version and token: as createSshConnection takes them. takeover: the first
 *   session replaces another Postbox (retry({ takeover: true }) asks for it later). spawn, program, the timers, delay
 *   and welcomeTimeout are passed to ssh.mjs, for tests.
 */
export function createHostLink({ host, version, token, takeover = false, needed, spawn, program, setTimer, clearTimer, delay, welcomeTimeout }) {
  const events = new EventEmitter();
  events.setMaxListeners(0);
  const destination = host.name;
  /** @type {any} the latest welcome */
  let welcome = null;
  let closed = false;
  let takeoverNext = takeover;
  /** @type {SshConnection | null} the session that has had its welcome, while it’s open */
  let current = null;
  const isNeeded = needed ?? (() => events.listenerCount('message') > 0);
  /** @type {Map<SshConnection, { flush: () => void }>} each session not yet closed, with its held messages */
  const sessions = new Map();

  /** A new session, whose messages are held until the link has said 'connected' for it. */
  const open = () => {
    const c = createSshConnection({
      destination,
      settings: host.settings,
      version,
      token,
      takeover: takeoverNext,
      ...(spawn ? { spawn } : {}),
      ...(program ? { program } : {}),
      ...(setTimer ? { setTimer } : {}),
      ...(clearTimer ? { clearTimer } : {}),
      ...(welcomeTimeout ? { welcomeTimeout } : {}),
    });
    /** @type {any[] | null} held until 'connected'; null once passed on */
    let held = [];
    sessions.set(c, {
      flush() {
        const msgs = held ?? [];
        held = null;
        for (const m of msgs) if (current === c) events.emit('message', m);
      },
    });
    c.on('message', (m) => {
      if (held) held.push(m);
      else if (current === c) events.emit('message', m);
    });
    c.on('bad-line', (e) => events.emit('bad-line', e));
    c.once('close', () => {
      sessions.delete(c);
      if (current === c) current = null;
    });
    return c;
  };

  const rec = createReconnector({
    open,
    needed: () => !closed && isNeeded(),
    ...(setTimer ? { setTimer } : {}),
    ...(clearTimer ? { clearTimer } : {}),
    ...(delay ? { delay } : {}),
  });
  rec.on('open', (/** @type {SshConnection} */ c, w) => {
    current = c;
    welcome = w;
    takeoverNext = false;
    events.emit('connected', w);
    sessions.get(c)?.flush();
  });
  rec.on('failure', (/** @type {SshFailure} */ f) => events.emit('failure', f));
  rec.on('state', (/** @type {string} */ s) => {
    if (s !== 'open') current = null;
    events.emit('state', s);
    if (s === 'stopped') giveUp(rec.failure);
  });

  /** @param {SshFailure | null} f */
  const giveUp = (f) => {
    if (events.listenerCount('error')) events.emit('error', f ?? sshFailure('failed', destination, { why: 'Postbox stopped connecting.' }));
  };

  return withGetters(
    events,
    {
      /** The latest welcome, or null before the first. */
      welcome: () => welcome,
      /** Why the last attempt failed or the last session dropped (an SshFailure), until a session opens. */
      failure: () => rec.failure,
      /** idle, connecting, open, waiting (for a retry) or stopped (for the person); closed after close(). */
      state: () => (closed ? 'closed' : rec.state),
      /** Whether a session with a welcome is open now. */
      connected: () => current !== null,
    },
    {
      /**
       * Sends one postbox-to-daemon message on the current session. True once written; false with no session (and
       * asks for one), for a message the session refuses, or after close(). Never throws.
       * @param {{ type: string, [field: string]: any }} msg
       */
      send(msg) {
        if (closed) return false;
        const c = current;
        if (!c) {
          rec.need();
          return false;
        }
        try {
          c.send(msg); // false from it is backpressure: the line is still queued on ssh’s stdin
          return true;
        } catch {
          return false;
        }
      },
      /** Postbox needs the host now (a turn starts, a prompt waits): connect unless connected, waiting or stopped. */
      need: () => {
        if (!closed) rec.need();
      },
      /** The laptop woke (D2): try at once, unless a failure only the person can fix stopped it. */
      wake: () => {
        if (!closed) rec.wake();
      },
      /**
       * The person asked to reconnect: try at once, whatever stopped it. takeover: replace the Postbox that has the
       * host (after a `busy`), for the next session only.
       * @param {{ takeover?: boolean }} [o]
       */
      retry({ takeover: take = false } = {}) {
        if (closed) return;
        if (take) takeoverNext = true;
        rec.retry();
      },
      /**
       * Closes the current session without giving up, when nothing needs the host (hosts.mjs): the link is idle until a
       * send, need() or wake() opens another, so the host’s daemon can exit at its idleTimeout. Turns go on.
       */
      idle() {
        if (!closed) current?.close();
      },
      /** Stops reconnecting and closes the session; turns go on on the host. Listeners for 'error' hear it. */
      close() {
        if (closed) return;
        closed = true;
        current = null;
        rec.dispose();
        giveUp(sshFailure('failed', destination, { why: 'Postbox closed its connection to the host.' }));
      },
    },
  );
}

/**
 * An emitter with live read-only properties and methods, as ssh.mjs builds its own.
 * @template {object} T @template {Record<string, () => any>} G @template {object} M
 * @param {T} target @param {G} getters @param {M} methods
 * @returns {T & M & { readonly [K in keyof G]: ReturnType<G[K]> }}
 */
function withGetters(target, getters, methods) {
  for (const [k, get] of Object.entries(getters)) Object.defineProperty(target, k, { get, enumerable: true });
  return /** @type {any} */ (Object.assign(target, methods));
}
