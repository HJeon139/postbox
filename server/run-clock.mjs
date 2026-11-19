// Agents’ run clocks on the server: the person starts, pauses and resumes one (POST /api/sessions/:id/clock), each turn
// the agent starts carries its line and records a clock.turn event, and when the budget runs out Postbox records
// clock.expired, stops the running turn and starts no other. The clock itself is in the store (shared/run-clock.mjs);
// the timer here is only derived from it, set again at each start of Postbox (rearmClocks), so a budget that ran out
// while Postbox was down expires as it starts. Time while Postbox is down counts: an agent on a host goes on working.

import { CLOCK_BUDGET_MAX_S, clockElapsed, clockLine } from '../shared/run-clock.mjs';
import { httpError } from './helpers.mjs';
import { whenWritable } from './store-wait.mjs';

/** The longest a Node timer waits; a later expiry is checked again when it fires. */
const MAX_TIMER_MS = 2 ** 31 - 1;

/** @type {WeakMap<any, Map<string, ReturnType<typeof setTimeout>>>} each runtime’s expiry timers, by session */
const timers = new WeakMap();

/** @param {any} rt @param {string} sessionId */
const clockOf = (rt, sessionId) => (rt.s.clocks && Object.hasOwn(rt.s.clocks, sessionId) ? rt.s.clocks[sessionId] : null);

/**
 * The person’s action on an agent’s clock: start it with a budget in whole seconds, pause it or resume it.
 * @param {any} rt @param {string} sessionId @param {unknown} body @param {() => number} [now]
 */
export function clockAction(rt, sessionId, body, now = Date.now) {
  const se = rt.session(sessionId);
  const { action, budgetS } = /** @type {any} */ (body ?? {});
  const clock = clockOf(rt, sessionId);
  switch (action) {
    case 'start': {
      if (!Number.isInteger(budgetS) || budgetS < 1 || budgetS > CLOCK_BUDGET_MAX_S)
        throw httpError(422, `A run clock’s budget is a whole number of seconds from 1 to ${CLOCK_BUDGET_MAX_S}.`);
      if (clock && clock.state !== 'expired')
        throw httpError(409, `@${se.handle}’s run clock is already ${clock.state}. Wait for it to expire before starting another.`);
      rt.store.emit('clock.started', { sessionId, threadId: se.threadId, budgetMs: budgetS * 1000, at: now() });
      break;
    }
    case 'pause':
      if (clock?.state !== 'running') throw httpError(409, `@${se.handle} has no running run clock to pause.`);
      rt.store.emit('clock.paused', { sessionId, at: now() });
      break;
    case 'resume':
      if (clock?.state !== 'paused') throw httpError(409, `@${se.handle} has no paused run clock to resume.`);
      rt.store.emit('clock.resumed', { sessionId, at: now() });
      break;
    default:
      throw httpError(422, 'A run clock’s action is start, pause or resume.');
  }
  armClock(rt, sessionId, now);
  return { clock: clockOf(rt, sessionId) };
}

/**
 * Sets the timer for a running clock’s expiry, in place of any it had, or clears it for a clock that isn’t running.
 * A clock past its budget expires now.
 * @param {any} rt @param {string} sessionId @param {() => number} [now]
 */
export function armClock(rt, sessionId, now = Date.now) {
  const mine = timers.get(rt) ?? new Map();
  timers.set(rt, mine);
  const old = mine.get(sessionId);
  if (old) {
    clearTimeout(old);
    rt.watchdogs.delete(old);
    mine.delete(sessionId);
  }
  const clock = clockOf(rt, sessionId);
  if (clock?.state !== 'running') return;
  const left = clock.budgetMs - clockElapsed(clock, now());
  if (left <= 0) return expireClock(rt, sessionId, now);
  // In rt.watchdogs, so Runtime’s close() clears it (server/runtime-close.mjs).
  const timer = setTimeout(
    () => {
      rt.watchdogs.delete(timer);
      mine.delete(sessionId);
      armClock(rt, sessionId, now);
    },
    Math.min(left, MAX_TIMER_MS),
  );
  timer.unref?.();
  rt.watchdogs.add(timer);
  mine.set(sessionId, timer);
}

/**
 * The budget ran out: the clock expires, and the agent’s running turn stops. While the store can’t be written, the turn
 * still stops (Stop is allowed then), and the clock’s record waits for writes to reopen, ahead of the turns held
 * meanwhile, so none of them starts first (server/store-wait.mjs).
 * @param {any} rt @param {string} sessionId @param {() => number} now
 */
function expireClock(rt, sessionId, now) {
  if (!rt.store.writable) {
    if (rt.turns.has(sessionId)) rt.stop(sessionId, { by: 'clock' });
    return whenWritable(rt, () => armClock(rt, sessionId, now), { first: true });
  }
  const clock = clockOf(rt, sessionId);
  rt.store.emit('clock.expired', { sessionId, elapsedMs: clock.budgetMs, budgetMs: clock.budgetMs, at: now() });
  if (rt.turns.has(sessionId)) rt.stop(sessionId, { by: 'clock' });
}

/** The runtimes whose store re-arms their clocks at Retry. */
const reloading = new WeakSet();

/**
 * Sets every running clock’s timer again as Postbox starts, expiring the ones that ran out meanwhile; and again each
 * time Retry installs the state the disk held (server/store-outage.mjs), whose clocks the old timers didn’t see.
 * @param {any} rt
 */
export function rearmClocks(rt, now = Date.now) {
  if (!reloading.has(rt)) {
    reloading.add(rt);
    rt.store.onReload(() => rearmClocks(rt, now));
  }
  for (const sessionId of Object.keys(rt.s.clocks ?? {})) armClock(rt, sessionId, now);
}

/** Whether an agent’s clock has expired, so no turn of its starts. @param {any} rt @param {string} sessionId */
export const clockExpired = (rt, sessionId) => clockOf(rt, sessionId)?.state === 'expired';

/**
 * A turn of a clocked agent begins: the stream hears where its clock is, and the turn’s message carries the line.
 * A message for an agent with no clock is as it was.
 * @param {any} rt @param {string} sessionId @param {string} turnId @param {any} message @param {() => number} [now]
 */
export function clockTurn(rt, sessionId, turnId, message, now = Date.now) {
  const clock = clockOf(rt, sessionId);
  if (!clock || clock.state === 'expired') return message;
  const at = now();
  rt.store.emit('clock.turn', { sessionId, turnId, elapsedMs: clockElapsed(clock, at), budgetMs: clock.budgetMs, state: clock.state, at });
  return { ...message, clock: clockLine(clock, at) };
}
