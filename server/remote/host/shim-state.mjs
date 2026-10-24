// The host’s shim’s state (#120): what waits for the daemon, the daemon link and its timings. shim.mjs makes it, and
// the shim-*.mjs modules take it first, as `sh`. shim.mjs’s header says how each kind of call waits.

import { encode, HOST_DEFAULTS } from '../../../shared/remote-protocol.mjs';

const SECOND = 1000;
const MINUTE = 60 * SECOND;
/** How long the shim waits, in milliseconds. */
export const TIMINGS = timings({
  /** Between progress notifications while a prompt waits. */
  progress: MINUTE,
  /** An asked tool fails once the daemon has been unreachable this long. */
  unreachable: 30 * SECOND,
  /** An asked tool fails if the daemon hasn’t answered it in this long. */
  askMax: 10 * MINUTE,
  /** The first and the longest pause before connecting again. */
  backoff: 100,
  backoffMax: 5 * SECOND,
  /** A cap under the daemon’s permissionWaitMax; Infinity is no cap. */
  waitMax: Number.POSITIVE_INFINITY,
});

/**
 * A message for the daemon, kept until it’s settled and sent again, in order, after each reconnect.
 * @typedef {{ msg: Record<string, any>, kind: 'queue' | 'ask' | 'permission' | 'notice', rpcId?: any,
 *   started: number, timers: Set<ReturnType<typeof setTimeout>>, progress?: { token: string | number, value: number },
 *   tool?: string, down?: ReturnType<typeof setTimeout> | null }} Pending
 * @typedef {ReturnType<typeof shimState>} Shim
 */

/**
 * The shim’s state, for one turn.
 * @param {string} turn @param {ReturnType<typeof import('./paths.mjs').paths>} P
 */
export function shimState(turn, P) {
  const prefix = `${process.pid.toString(36)}${Date.now().toString(36)}`;
  let counter = 0;
  return {
    turn,
    P,
    /** @type {Map<string, Pending>} by the shim’s ID (an expiry or cancel notice by `notice:<id>`) */
    pending: new Map(),
    /** @type {Map<string, string>} The JSON-RPC request each pending ID answers, for a cancellation notification. */
    byRequest: new Map(),
    /** @type {WeakMap<Pending, ReturnType<typeof setTimeout>>} each prompt’s deadline */
    expiries: new WeakMap(),
    nextId: () => `${prefix}-${++counter}`,
    /** @type {import('node:net').Socket | null} */
    sock: null,
    /** Whether the daemon has welcomed this connection, so messages may go. */
    ready: false,
    /** The daemon’s permissionWaitMax, in milliseconds; the host’s default until a welcome says. */
    waitMax: Number(HOST_DEFAULTS.permissionWaitMax),
    backoff: TIMINGS.backoff,
    stopping: false,
    /** Whether the daemon being unreachable was already logged since the last welcome. */
    quiet: false,
    /** @type {ReturnType<typeof setTimeout> | null} */
    retry: null,
  };
}

/** Ends a pending entry: its timers stop and it’s no longer sent. @param {Shim} sh @param {string} id */
export function settle(sh, id) {
  const p = sh.pending.get(id);
  if (!p) return null;
  sh.pending.delete(id);
  for (const t of p.timers) clearTimeout(t);
  if (p.down) clearTimeout(p.down);
  if (p.rpcId !== undefined) sh.byRequest.delete(JSON.stringify(p.rpcId));
  return p;
}

/** @param {Pending} p @param {() => void} fn @param {number} ms */
export function after(p, fn, ms) {
  const t = setTimeout(() => {
    p.timers.delete(t);
    fn();
  }, ms);
  t.unref();
  p.timers.add(t);
  return t;
}

/** Writes one pending entry’s message if the daemon has welcomed this connection. @param {Shim} sh @param {Pending} p @param {string} id */
export function deliver(sh, p, id) {
  if (!sh.ready || !sh.sock) return;
  sh.sock.write(encode(p.msg));
  // A notice needs no answer: once it’s written to a welcomed link, it’s the daemon’s.
  if (p.kind === 'notice') settle(sh, id);
}

/**
 * The default waits, each shortened by POSTBOX_SHIM_TIMINGS if it says so. For tests only (see shim.mjs’s header).
 * @template {Record<string, number>} T @param {T} defaults @returns {T}
 */
function timings(defaults) {
  const raw = process.env.POSTBOX_SHIM_TIMINGS;
  if (!raw) return defaults;
  /** @type {Record<string, number>} */
  const out = { ...defaults };
  try {
    const given = JSON.parse(raw);
    for (const k of Object.keys(defaults)) {
      const v = given?.[k];
      if (Number.isFinite(v) && v >= 1 && v < out[k]) out[k] = v;
    }
  } catch {
    process.stderr.write('postbox shim: POSTBOX_SHIM_TIMINGS isn’t JSON, so it was ignored.\n');
  }
  return /** @type {T} */ (out);
}
