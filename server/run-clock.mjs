// Agents’ run clocks on the server: the person starts, pauses and resumes one (POST /api/sessions/:id/clock); a pause
// stops the agent’s turn and holds its next until the resume. Each turn the agent starts carries its line and records a clock.turn event, and when the budget runs out Postbox records
// clock.expired, stops the running turn and starts no other. The clock itself is in the store (shared/run-clock.mjs);
// the timer here is only derived from it, set again at each start of Postbox (rearmClocks), so a budget that ran out
// while Postbox was down expires as it starts. Time while Postbox is down counts: an agent on a host goes on working.

import { CLOCK_BUDGET_MAX_S, clockElapsed, clockLine } from '../shared/run-clock.mjs';
import { httpError } from './helpers.mjs';
import { clockNote, repairClockNote } from './run-clock-notes.mjs';
import { whenWritable } from './store-wait.mjs';

/** The longest a Node timer waits; a later expiry is checked again when it fires. */
const MAX_TIMER_MS = 2 ** 31 - 1;

/** @type {WeakMap<any, Map<string, ReturnType<typeof setTimeout>>>} each runtime’s expiry timers, by session */
const timers = new WeakMap();

/**
 * An agent’s clock, pending, as memory will hold it once held writes are released: a clock started behind a held
 * commit times and holds its agent at once (server/store-held.mjs). @param {any} rt @param {string} sessionId
 */
const clockOf = (rt, sessionId) => rt.store.pending.clock(sessionId);

/**
 * The person’s action on an agent’s clock: start it with a budget in whole seconds, pause it or resume it.
 * @param {any} rt @param {string} sessionId @param {unknown} body @param {() => number} [now]
 */
export function clockAction(rt, sessionId, body, now = Date.now) {
  // Pending: a session deleted behind a held commit has no clock to start (hydrant-critic’s review of #1522).
  const se = rt.store.pending.session(sessionId);
  if (!se) throw httpError(404, 'That session doesn’t exist. It may have been deleted.');
  const { action, budgetS } = /** @type {any} */ (body ?? {});
  const clock = clockOf(rt, sessionId);
  switch (action) {
    case 'start': {
      if (!Number.isInteger(budgetS) || budgetS < 1 || budgetS > CLOCK_BUDGET_MAX_S)
        throw httpError(422, `A run clock’s budget is a whole number of seconds from 1 to ${CLOCK_BUDGET_MAX_S}.`);
      // One clock per agent in a conversation: a second run there would start with the first one in its context (its
      // backend’s session, the room’s catch-up and its inbox), so it goes in a new conversation.
      if (clock)
        throw httpError(
          409,
          `@${se.handle} already had a run clock in this conversation. Start the next timed run in a new conversation, so it begins with nothing from this one.`,
        );
      // Nor while the agent works: that turn’s work and context, from before the clock, would count as the run’s.
      if (rt.turns.has(sessionId) || rt.exiting.has(sessionId))
        throw httpError(409, `@${se.handle} is still working on a turn. Stop it, or wait for it to end, then start the clock.`);
      // Nor does a run start with messages from before it waiting in the inbox: its first turn would read them.
      const waiting = rt.delivery.waiting(sessionId).length;
      if (waiting)
        throw httpError(
          409,
          `@${se.handle} has ${waiting} message${waiting === 1 ? '' : 's'} waiting from before this clock. Remove them from its queue, or start the run in a new conversation.`,
        );
      rt.store.emit('clock.started', { sessionId, threadId: se.threadId, budgetMs: budgetS * 1000, at: now() });
      clockNote(rt, sessionId, 'started', { budgetMs: budgetS * 1000 });
      break;
    }
    case 'pause':
      if (clock?.state !== 'running') throw httpError(409, `@${se.handle} has no running run clock to pause.`);
      rt.store.emit('clock.paused', { sessionId, at: now() });
      clockNote(rt, sessionId, 'paused', clock);
      // Paused time isn’t counted, so the agent doesn’t work in it: its turn stops, and none starts until the resume.
      // Silent, as Send now is: the wakes queued for it wait for the resume rather than being dropped.
      if (rt.turns.has(sessionId)) rt.stop(sessionId, { by: 'pause', silent: true });
      break;
    case 'resume':
      if (clock?.state !== 'paused') throw httpError(409, `@${se.handle} has no paused run clock to resume.`);
      rt.store.emit('clock.resumed', { sessionId, at: now() });
      clockNote(rt, sessionId, 'resumed', { budgetMs: clock.budgetMs, elapsedMs: clockOf(rt, sessionId).usedMs });
      resumeHeld(rt, sessionId);
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
 * The budget ran out: the clock expires, and the agent’s running turn stops, silently: the messages waiting for it,
 * agents’ handoffs too, stay in its inbox, as the clock’s line says, rather than being stopped as a Stop stops them
 * (hydrant-critic’s review of #1522). While the store can’t be written, the turn
 * still stops (Stop is allowed then), and the clock’s record waits for writes to reopen, ahead of the turns held
 * meanwhile, so none of them starts first (server/store-wait.mjs).
 * @param {any} rt @param {string} sessionId @param {() => number} now
 */
function expireClock(rt, sessionId, now) {
  if (!rt.store.writable) {
    if (rt.turns.has(sessionId)) rt.stop(sessionId, { by: 'clock', silent: true });
    return whenWritable(rt, () => armClock(rt, sessionId, now), { first: true });
  }
  const clock = clockOf(rt, sessionId);
  rt.store.emit('clock.expired', { sessionId, elapsedMs: clock.budgetMs, budgetMs: clock.budgetMs, at: now() });
  clockNote(rt, sessionId, 'expired', clock);
  if (rt.turns.has(sessionId)) rt.stop(sessionId, { by: 'clock', silent: true });
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
  for (const sessionId of Object.keys(rt.s.clocks ?? {})) {
    const clock = clockOf(rt, sessionId);
    if (rt.store.writable) repairClockNote(rt, sessionId, clock);
    // Each running clock marks where Postbox’s record starts again, so a gap in it can be seen: an agent on a host may
    // have worked through it, past the budget, since the hard stop is this server’s timer.
    if (clock?.state === 'running' && rt.store.writable) {
      const at = now();
      rt.store.emit('clock.restored', { sessionId, elapsedMs: clockElapsed(clock, at), budgetMs: clock.budgetMs, at });
      clockNote(rt, sessionId, 'restored', { budgetMs: clock.budgetMs, elapsedMs: clockElapsed(clock, at) });
    }
    armClock(rt, sessionId, now);
  }
}

/** @type {WeakMap<any, Map<string, any[]>>} each runtime’s turns held by a paused clock, by session: memory only */
const heldTurns = new WeakMap();

/**
 * A turn that came another way than the inbox (a message held behind a turn, a release after a stop) for an agent whose
 * clock holds it: kept for the resume. An expired clock’s are kept too, and never run. Memory only: a restart loses
 * them, as it loses a message held for a busy agent.
 * @param {any} rt @param {string} sessionId @param {{ message: any, summarizeTo: string|null, threadId: string|null }} turn
 */
export function holdForClock(rt, sessionId, turn) {
  const mine = heldTurns.get(rt) ?? new Map();
  heldTurns.set(rt, mine);
  mine.set(sessionId, [...(mine.get(sessionId) ?? []), turn]);
}

/** The clock resumed: the turns it held run, and the agent’s inbox can start one again. @param {any} rt @param {string} sessionId */
function resumeHeld(rt, sessionId) {
  const held = heldTurns.get(rt)?.get(sessionId) ?? [];
  heldTurns.get(rt)?.delete(sessionId);
  for (const { message, summarizeTo, threadId } of held) rt.turnService.run(sessionId, message, { summarizeTo, threadId });
  rt.delivery.wake(sessionId);
}

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
