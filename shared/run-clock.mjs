// An agent’s run clock in the store’s reducer (their entries in EVENTS, shared/state.mjs): a budget the person sets for
// one agent in one conversation, and how much of it the agent has used. Postbox’s server sets every time here, so an
// agent on a host can’t move its clock; the agent reads it only in the line each of its turns carries (clockLine).
// A clock is { sessionId, threadId, budgetMs, usedMs, since, state, startedAt, expiredAt, stopping }: usedMs is what it
// used before `since`, when it last began counting, or null once it stops counting. Each event’s data carries `at`,
// the server’s time it happened, since the store’s events have no time of their own.
// `stopping` lists the turns that Postbox stopped, at a pause or the expiry, and that may still run: a turn on a host
// until the host confirms its stop (server/remote/turns-stops.mjs, askStop), as when the host can’t be reached, and a
// turn on this computer until its CLI has exited, after up to its grace period (server/adapters/process-group.mjs). A paused clock counts on until each has stopped (clock.stopped), so a pause the agent works through is no
// pause (#1526).
// An ended clock is one the person stopped before its budget (#1749): over for good, as an expired one is, with the
// time it had used. `endedAt` says when.

/** @typedef {'running' | 'paused' | 'expired' | 'ended'} ClockState */

/** Whether a clock’s run is over for good: it reached its budget, or the person ended it (#1749). @param {{ state?: string } | null | undefined} clock */
export const clockOver = (clock) => clock?.state === 'expired' || clock?.state === 'ended';

/**
 * A turn on this computer in a clock’s `stopping`: `turn:` and its id, until its CLI has exited (server/turn-stop.mjs).
 * Any other entry is a host’s turn, by the id its daemon knows. @param {string} stop
 */
export const isLocalStop = (stop) => stop.startsWith('turn:');

/** The longest budget the person can give a clock: 30 days, in seconds. */
export const CLOCK_BUDGET_MAX_S = 30 * 86_400;

const map = () => Object.create(null);
const clocksOf = (/** @type {any} */ s) => (s.clocks ??= map());

/**
 * What a clock has used by `now`, in milliseconds, never past its budget.
 * @param {{ budgetMs: number, usedMs: number, since: number | null }} clock @param {number} now
 */
export function clockElapsed(clock, now) {
  const running = clock.since === null ? 0 : Math.max(0, now - clock.since);
  return Math.min(clock.budgetMs, clock.usedMs + running);
}

/**
 * The line a turn of a clocked agent carries: whole seconds used, of whole seconds budgeted, and what the budget means,
 * as the guide must say every limit the server enforces (server/AGENTS.md, “Agent backends”).
 * @param {{ budgetMs: number, usedMs: number, since: number | null }} clock @param {number} now
 */
export const clockLine = (clock, now) =>
  `[Postbox] Run clock: elapsed ${Math.floor(clockElapsed(clock, now) / 1000)}s / budget ${Math.floor(clock.budgetMs / 1000)}s. At the budget, Postbox stops your turn and starts no other.`;

/**
 * Whether a run clock holds its agent’s turns: paused, until the person resumes it, or over, for good. Delivery starts
 * no turn from its inbox meanwhile (server/delivery.mjs), so what it was sent waits there. The caller passes the clock
 * as in-process code must read it, pending (server/store-held.mjs). @param {{ state?: string } | null | undefined} clock
 */
export const clockHolds = (clock) => clock?.state === 'paused' || clockOver(clock);

/**
 * Refuses a clock event without the fields it needs, before anything changes (#609): a session’s id, and a time.
 * @param {any} d @param {string[]} numbers  the other fields that must be finite numbers
 */
function check(d, numbers = []) {
  if (typeof d.sessionId !== 'string') throw new TypeError('A clock event names its session.');
  for (const k of ['at', ...numbers]) if (!Number.isFinite(d[k])) throw new TypeError(`A clock event’s ${k} is a number.`);
  if (d.stopping !== undefined && !(Array.isArray(d.stopping) && d.stopping.every((t) => typeof t === 'string')))
    throw new TypeError('A clock event’s stopping lists host turns by id.');
}

/** The host turns a clock’s event says are still to stop, or none. @param {any} d @returns {string[]} */
const stoppingOf = (d) => (d.stopping ? [...d.stopping] : []);

/** A clock’s event names a session it has, or does nothing. @param {any} s @param {any} d @param {(c: any) => void} f */
function withClock(s, d, f) {
  check(d);
  const clocks = clocksOf(s);
  const c = Object.hasOwn(clocks, d.sessionId) ? clocks[d.sessionId] : undefined;
  if (c) f(c);
}

export const CLOCK_EVENTS = Object.freeze({
  // The person started the clock: a new one, in place of any that came before.
  'clock.started': {
    apply: (/** @type {any} */ s, /** @type {any} */ d) => {
      check(d, ['budgetMs']);
      clocksOf(s)[d.sessionId] = {
        sessionId: d.sessionId,
        threadId: d.threadId,
        budgetMs: d.budgetMs,
        usedMs: 0,
        since: d.at,
        state: 'running',
        startedAt: d.at,
        expiredAt: null,
        stopping: [],
      };
    },
    public: true,
  },
  'clock.paused': {
    apply: (/** @type {any} */ s, /** @type {any} */ d) =>
      withClock(s, d, (c) => {
        if (c.state !== 'running') return;
        c.stopping = stoppingOf(d);
        // Counting on while a turn it stopped may still run on its host: clock.stopped ends that.
        if (!c.stopping.length) {
          c.usedMs = clockElapsed(c, d.at);
          c.since = null;
        }
        c.state = 'paused';
      }),
    public: true,
  },
  'clock.resumed': {
    apply: (/** @type {any} */ s, /** @type {any} */ d) =>
      withClock(s, d, (c) => {
        if (c.state !== 'paused') return;
        if (c.since === null) c.since = d.at;
        c.state = 'running';
      }),
    public: true,
  },
  // A turn began with the clock at elapsedMs: a record for the stream and the log, which changes nothing.
  'clock.turn': { apply: (/** @type {any} */ _s, /** @type {any} */ d) => check(d, ['elapsedMs', 'budgetMs']), public: true },
  // Postbox started again, or Retry reloaded the store, with the clock running: a mark of where a gap in the server’s
  // own record ends, which changes nothing. Time while Postbox was down counted; a timed run decides what a gap means.
  'clock.restored': { apply: (/** @type {any} */ _s, /** @type {any} */ d) => check(d, ['elapsedMs', 'budgetMs']), public: true },
  'clock.expired': {
    apply: (/** @type {any} */ s, /** @type {any} */ d) =>
      withClock(s, d, (c) => {
        c.usedMs = c.budgetMs;
        c.since = null;
        c.state = 'expired';
        c.expiredAt = d.at;
        c.stopping = stoppingOf(d);
      }),
    public: true,
  },
  // The person ended the run before its budget (#1749): the clock stops counting at what it had used, for good.
  'clock.ended': {
    apply: (/** @type {any} */ s, /** @type {any} */ d) => {
      check(d, ['elapsedMs', 'budgetMs']);
      withClock(s, d, (c) => {
        Object.assign(c, { usedMs: d.elapsedMs, since: null, state: 'ended', endedAt: d.at, stopping: stoppingOf(d) });
      });
    },
    public: true,
  },
  // The host confirmed that a turn the clock’s pause or expiry asked to stop is over: a paused clock whose last such
  // turn it was stops counting here.
  'clock.stopped': {
    apply: (/** @type {any} */ s, /** @type {any} */ d) => {
      if (typeof d.turn !== 'string') throw new TypeError('A clock.stopped event names its turn.');
      if (d.forced !== undefined && (d.forced !== true || typeof d.why !== 'string'))
        throw new TypeError('A clock.stopped event’s forced is true, with why, or left out.');
      withClock(s, d, (c) => {
        // Postbox stopped waiting for a turn here that may still work, whoever stopped it: its time can’t be known, so
        // the run is void, and no turn of the agent starts again (clockHolds), beside it or after.
        if (d.forced) {
          c.stopping = (c.stopping ?? []).filter((/** @type {string} */ t) => t !== d.turn);
          if (!clockOver(c)) Object.assign(c, { usedMs: clockElapsed(c, d.at), since: null, state: 'expired', expiredAt: d.at });
          c.voided ??= { why: d.why, at: d.at };
          return;
        }
        if (!c.stopping?.includes(d.turn)) return;
        c.stopping = c.stopping.filter((/** @type {string} */ t) => t !== d.turn);
        if (c.stopping.length || c.state !== 'paused' || c.since === null) return;
        c.usedMs = clockElapsed(c, d.at);
        c.since = null;
      });
    },
    public: true,
  },
});
