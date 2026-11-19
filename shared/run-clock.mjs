// An agent’s run clock in the store’s reducer (their entries in EVENTS, shared/state.mjs): a budget the person sets for
// one agent in one conversation, and how much of it the agent has used. Postbox’s server sets every time here, so an
// agent on a host can’t move its clock; the agent reads it only in the line each of its turns carries (clockLine).
// A clock is { sessionId, threadId, budgetMs, usedMs, since, state, startedAt, expiredAt }: usedMs is what it used
// before `since`, when it last began running, or null while it’s paused or expired. Each event’s data carries `at`,
// the server’s time it happened, since the store’s events have no time of their own.

/** @typedef {'running' | 'paused' | 'expired'} ClockState */

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
 * Whether an agent’s clock holds its turns: paused, until the person resumes it, or expired, for good. Delivery starts
 * no turn from its inbox meanwhile (server/delivery.mjs), so what it was sent waits there.
 * @param {any} state @param {string} sessionId
 */
export function clockHolds(state, sessionId) {
  const c = state.clocks && Object.hasOwn(state.clocks, sessionId) ? state.clocks[sessionId] : null;
  return c?.state === 'paused' || c?.state === 'expired';
}

/**
 * Refuses a clock event without the fields it needs, before anything changes (#609): a session’s id, and a time.
 * @param {any} d @param {string[]} numbers  the other fields that must be finite numbers
 */
function check(d, numbers = []) {
  if (typeof d.sessionId !== 'string') throw new TypeError('A clock event names its session.');
  for (const k of ['at', ...numbers]) if (!Number.isFinite(d[k])) throw new TypeError(`A clock event’s ${k} is a number.`);
}

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
      };
    },
    public: true,
  },
  'clock.paused': {
    apply: (/** @type {any} */ s, /** @type {any} */ d) =>
      withClock(s, d, (c) => {
        if (c.state !== 'running') return;
        c.usedMs = clockElapsed(c, d.at);
        c.since = null;
        c.state = 'paused';
      }),
    public: true,
  },
  'clock.resumed': {
    apply: (/** @type {any} */ s, /** @type {any} */ d) =>
      withClock(s, d, (c) => {
        if (c.state !== 'paused') return;
        c.since = d.at;
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
      }),
    public: true,
  },
});
