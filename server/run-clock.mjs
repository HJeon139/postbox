// Agents’ run clocks on the server: the person starts, pauses and resumes one (POST /api/sessions/:id/clock); a pause
// stops the agent’s turn and holds its next until the resume. Each turn the agent starts carries its line and records a clock.turn event, and when the budget runs out Postbox records
// clock.expired, stops the running turn and starts no other. The clock itself is in the store (shared/run-clock.mjs);
// the timer here is only derived from it, set again at each start of Postbox (rearmClocks), so a budget that ran out
// while Postbox was down expires as it starts. Time while Postbox is down counts: an agent on a host goes on working.

import { CLOCK_BUDGET_MAX_S, clockElapsed, clockLine, isLocalStop } from '../shared/run-clock.mjs';
import { httpError } from './helpers.mjs';
import { hostOf } from './remote/placement.mjs';
import { ON_HOST } from './remote/turns-shared.mjs';
import { resumeHeld } from './run-clock-held.mjs';
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
 * The agent’s turns on a host that Postbox asked to stop and the host hasn’t confirmed, which may run on there: each
 * stop is kept on the session until the daemon confirms it (server/remote/turns-stops.mjs, askStop). Read after the
 * stop, so a clock’s pause or expiry records them (#1526). And a turn from before a restart that still runs on its host
 * as far as Postbox knows, not attached again yet: its attach is stopped (deliver), and its host’s confirmation ends
 * it here too. @param {any} rt @param {string} sessionId
 */
function unconfirmedStops(rt, sessionId) {
  const r = rt.store.pending.session(sessionId)?.remoteTurn;
  const host = (r?.stopping ?? []).map((/** @type {any} */ x) => x.turn);
  if (r?.turn && ON_HOST.has(r.state) && !rt.turns.has(sessionId) && !host.includes(r.turn)) host.push(r.turn);
  // A turn on this computer that Stop left exiting: its CLI may work on through SIGINT’s grace period, until it exits.
  const local = rt.exiting.get(sessionId)?.turn;
  return local && !local.remote ? [...host, `turn:${local.id}`] : host;
}

/** Why the person must wait for a stop to take effect. @param {string} handle @param {string} what @param {string[]} stopping */
const stillOnHost = (handle, what, stopping = []) =>
  stopping.length && stopping.every(isLocalStop)
    ? `@${handle}’s stopped turn hasn’t ended yet, so @${handle} may still be working. Once it has, ${what}.`
    : `Postbox asked @${handle}’s host to stop its turn, and the host hasn’t confirmed it, so @${handle} may still be working there. Postbox asks again each time the host connects; once it confirms, ${what}.`;

/** A clock’s event’s field for the host turns still to stop, when there are any. @param {string[]} turns */
const stoppingField = (turns) => (turns.length ? { stopping: turns } : {});

/**
 * Refuses a clock’s start that can’t be a clean timed run: a bad budget, a second clock in the conversation, the agent
 * still working, or messages from before it waiting in its inbox.
 * @param {any} rt @param {any} se  the session, pending @param {any} clock  its clock, pending, if it has one @param {any} budgetS  as the request gave it
 */
function refuseStart(rt, se, clock, budgetS) {
  const sessionId = se.id;
  if (!Number.isInteger(budgetS) || budgetS < 1 || budgetS > CLOCK_BUDGET_MAX_S)
    throw httpError(422, `A run clock’s budget is a whole number of seconds from 1 to ${CLOCK_BUDGET_MAX_S}.`);
  // One clock per agent in a conversation: a second run there would start with the first one in its context (its
  // backend’s session, the room’s catch-up and its inbox), so it goes in a new conversation.
  if (clock)
    throw httpError(
      409,
      `@${se.handle} already had a run clock in this conversation. Start the next timed run in a new conversation, so it begins with nothing from this one.`,
    );
  // Nor while the agent works: that turn’s work and context, from before the clock, would count as the run’s. Busy
  // takes in a turn on a host that waits to be attached again after a restart (server/running.mjs), and a stop its
  // host hasn’t confirmed leaves a turn that may still run there (#1526).
  if (rt.running.busy(sessionId)) throw httpError(409, `@${se.handle} is still working on a turn. Stop it, or wait for it to end, then start the clock.`);
  if (unconfirmedStops(rt, sessionId).length) throw httpError(409, stillOnHost(se.handle, 'start the clock'));
  // Nor does a run start with messages from before it waiting in the inbox: its first turn would read them.
  const waiting = rt.delivery.waiting(sessionId).length;
  if (waiting)
    throw httpError(
      409,
      `@${se.handle} has ${waiting} message${waiting === 1 ? '' : 's'} waiting from before this clock. Remove them from its queue, or start the run in a new conversation.`,
    );
}

/**
 * The person’s action on an agent’s clock: start it with a budget in whole seconds, pause it or resume it.
 * @param {any} rt @param {string} sessionId @param {unknown} body @param {() => number} [now]
 */
export function clockAction(rt, sessionId, body, now = Date.now) {
  // Pending: a session deleted behind a held commit has no clock to start (#1526).
  const se = rt.store.pending.session(sessionId);
  if (!se) throw httpError(404, 'That session doesn’t exist. It may have been deleted.');
  const { action, budgetS } = /** @type {any} */ (body ?? {});
  const clock = clockOf(rt, sessionId);
  switch (action) {
    case 'start': {
      refuseStart(rt, se, clock, budgetS);
      rt.store.emit('clock.started', { sessionId, threadId: se.threadId, budgetMs: budgetS * 1000, at: now() });
      clockNote(rt, sessionId, 'started', { budgetMs: budgetS * 1000 });
      break;
    }
    case 'pause':
      if (clock?.state !== 'running') throw httpError(409, `@${se.handle} has no running run clock to pause.`);
      // Paused time isn’t counted, so the agent doesn’t work in it: its turn stops, and none starts until the resume.
      // Silent, as Send now is: the wakes queued for it wait for the resume rather than being dropped. A turn on a
      // host may run on until the host confirms its stop, so the clock counts on until then (clock.stopped).
      if (rt.turns.has(sessionId)) rt.stop(sessionId, { by: 'pause', silent: true });
      {
        const stopping = unconfirmedStops(rt, sessionId);
        rt.store.emit('clock.paused', { sessionId, ...stoppingField(stopping), at: now() });
        clockNote(rt, sessionId, 'paused', { ...clock, stopping });
      }
      break;
    case 'resume':
      if (clock?.state !== 'paused') throw httpError(409, `@${se.handle} has no paused run clock to resume.`);
      // A turn the pause stopped may still run on its host: a new one would run beside it, in paused time.
      if (clock.stopping?.length) throw httpError(409, stillOnHost(se.handle, 'resume the clock', clock.stopping));
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
  // A clock that counts: running, or paused while a turn it stopped may still run on its host.
  if (!clock || clock.state === 'expired' || clock.since === null) return;
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
 * (#1526). While the store can’t be written, the turn
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
  const at = now();
  // Stopped first, so the expiry records the turns on a host that may run on until the host confirms their stop.
  if (rt.turns.has(sessionId)) rt.stop(sessionId, { by: 'clock', silent: true });
  const stopping = unconfirmedStops(rt, sessionId);
  rt.store.emit('clock.expired', { sessionId, elapsedMs: clock.budgetMs, budgetMs: clock.budgetMs, ...stoppingField(stopping), at });
  clockNote(rt, sessionId, 'expired', { ...clock, stopping });
}

/**
 * A turn the clock’s pause or expiry stopped is over (server/remote/turns-stops.mjs, stopConfirmed, for a host’s turn;
 * turnExited, as its CLI exits, for one here, `turn:` and its id): clock.stopped records when, and a paused clock whose
 * last such turn it was stops counting. While the store can’t be written, it’s recorded once it can, at that time.
 * forced: why Postbox stopped waiting for a turn here that may still work ('watchdog', 'unkilled', 'restart'): the
 * clock then ends its timed run as void, since its time can’t be known, and no turn of the agent starts again.
 * @param {any} rt @param {string} sessionId @param {string} turn @param {number} [at] @param {string} [forced]
 */
export function clockStopConfirmed(rt, sessionId, turn, at = Date.now(), forced) {
  const was = clockOf(rt, sessionId);
  // A forced stop voids any clock not yet void, whoever stopped the turn: the person’s Stop, Send now, a store outage.
  if (!was || (forced ? was.voided : !was.stopping?.includes(turn))) return;
  if (!rt.store.writable) return whenWritable(rt, () => clockStopConfirmed(rt, sessionId, turn, at, forced));
  rt.store.emit('clock.stopped', { sessionId, turn, ...(forced ? { forced: true, why: forced } : {}), at });
  const clock = clockOf(rt, sessionId);
  const where = isLocalStop(turn) ? 'local' : 'host';
  clockNote(rt, sessionId, forced ? 'voided' : 'stopped', {
    budgetMs: clock.budgetMs,
    elapsedMs: clockElapsed(clock, at),
    state: clock.state,
    left: clock.stopping.length,
    where,
    forced,
  });
  armClock(rt, sessionId, () => at);
}

/**
 * A local turn the clock lists as still to stop, which this runtime isn’t waiting on: Postbox stopped between the stop
 * and the CLI’s exit, so when it ended, if it has, is lost. The run is void (clockStopConfirmed, forced). A turn still
 * exiting here, as at a Retry, is left for its exit.
 * @param {any} rt @param {string} sessionId @param {() => number} now
 */
function voidLostStops(rt, sessionId, now) {
  if (!rt.store.writable) return;
  const exiting = rt.exiting.get(sessionId)?.turn;
  for (const stop of (clockOf(rt, sessionId)?.stopping ?? []).filter(isLocalStop))
    if (stop !== `turn:${exiting?.id}`) clockStopConfirmed(rt, sessionId, stop, now(), 'restart');
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
    voidLostStops(rt, sessionId, now);
    const clock = clockOf(rt, sessionId);
    if (rt.store.writable) repairClockNote(rt, sessionId, clock);
    // Each running clock marks where Postbox’s record starts again, so a gap in it can be seen: an agent on a host may
    // have worked through it, past the budget, since the hard stop is this server’s timer.
    if (clock && clock.state !== 'expired' && clock.since !== null && rt.store.writable) {
      const at = now();
      rt.store.emit('clock.restored', { sessionId, elapsedMs: clockElapsed(clock, at), budgetMs: clock.budgetMs, at });
      const host = Boolean(hostOf(rt.personas.forSession(rt.store.pending.session(sessionId))));
      clockNote(rt, sessionId, 'restored', { budgetMs: clock.budgetMs, elapsedMs: clockElapsed(clock, at), host });
    }
    armClock(rt, sessionId, now);
  }
}

/**
 * A host turn attached again after a restart, for an agent its clock holds (server/turn-run.mjs): stopped as the clock
 * stops a turn, by its pause or its expiry, now that its remote turn names its host turn. Its host’s confirmation ends
 * it in the clock’s `stopping` (unconfirmedStops listed it as the clock paused or expired). @param {any} rt @param {any} turn
 */
export function stopHeldTurn(rt, turn) {
  if (rt.turns.get(turn.sessionId) !== turn) return;
  const clock = clockOf(rt, turn.sessionId);
  rt.stop(turn.sessionId, { by: clock?.state === 'paused' ? 'pause' : 'clock', silent: true });
}

/**
 * A turn of a clocked agent begins: the stream hears where its clock is, and the turn’s message carries the line, last
 * in its background (message.context), where every backend’s formatMessage puts it (server/adapters/guide.mjs). A
 * message for an agent with no clock is as it was.
 * @param {any} rt @param {string} sessionId @param {string} turnId @param {any} message @param {() => number} [now]
 */
export function clockTurn(rt, sessionId, turnId, message, now = Date.now) {
  const clock = clockOf(rt, sessionId);
  if (!clock || clock.state === 'expired') return message;
  // A slash command and a host turn attached again get no background (formatMessage, server/adapters/guide.mjs), so
  // they see no line, and clock.turn, which says a turn was told where its clock is, isn’t recorded for them.
  if (message.slash || typeof message.attach === 'string') return message;
  const at = now();
  rt.store.emit('clock.turn', { sessionId, turnId, elapsedMs: clockElapsed(clock, at), budgetMs: clock.budgetMs, state: clock.state, at });
  return { ...message, context: [...(message.context ?? []), clockLine(clock, at)] };
}
