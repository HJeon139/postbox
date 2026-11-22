// The turns a run clock holds that came another way than the agent’s inbox, kept for its resume, and dropped once
// none can run: at the expiry, at a void, and when the session is deleted (#1526). A Retry or a Send now that would
// start a turn the clock holds is refused instead of held, so no reply says it was retried while nothing runs.
// Moved from server/run-clock.mjs.

import { httpError } from './helpers.mjs';

/** @type {WeakMap<any, Map<string, any[]>>} each runtime’s turns held by a paused clock, by session: memory only */
const heldTurns = new WeakMap();

/**
 * A turn that came another way than the inbox (a message held behind a turn, a release after a stop) for an agent whose
 * clock is paused: kept for the resume. One whose clock expired is dropped. Memory only: a restart loses them, as it loses a message held for a busy agent.
 * @param {any} rt @param {string} sessionId @param {{ message: any, summarizeTo: string|null, threadId: string|null }} turn
 */
export function holdForClock(rt, sessionId, turn) {
  // An expired clock holds its agent for good: the turn can never run, so it isn’t kept.
  if (rt.store.pending.clock(sessionId)?.state === 'expired') return;
  const mine = heldTurns.get(rt) ?? new Map();
  heldTurns.set(rt, mine);
  mine.set(sessionId, [...(mine.get(sessionId) ?? []), turn]);
}

/** How many turns the clock holds for the agent now, in memory. @param {any} rt @param {string} sessionId */
export const heldCount = (rt, sessionId) => heldTurns.get(rt)?.get(sessionId)?.length ?? 0;

/** The clock resumed: the turns it held run, and the agent’s inbox can start one again. @param {any} rt @param {string} sessionId */
export function resumeHeld(rt, sessionId) {
  const held = heldTurns.get(rt)?.get(sessionId) ?? [];
  heldTurns.get(rt)?.delete(sessionId);
  for (const { message, summarizeTo, threadId } of held) rt.turnService.run(sessionId, message, { summarizeTo, threadId });
  rt.delivery.wake(sessionId);
}

/**
 * What the store says that ends the held turns of an agent: its clock expired or its run was voided, so none of them
 * can run, or its session was deleted (installRunClock subscribes this). @param {any} rt @param {any} ev
 */
export function dropHeldOn(rt, ev) {
  const sessionId = endedBy(ev);
  if (typeof sessionId === 'string') heldTurns.get(rt)?.delete(sessionId);
}

/** The session an event ends the held turns of, if it does. @param {any} ev @returns {unknown} */
function endedBy(ev) {
  if (ev.type === 'clock.expired' || (ev.type === 'clock.stopped' && ev.data?.forced === true)) return ev.data?.sessionId;
  return ev.type === 'remove' && ev.data?.kind === 'session' ? ev.data.id : null;
}

/** What each refused action can do once the clock resumes. */
const THEN = {
  retry: 'retry the reply',
  'send-now': 'send it, or send it without Send now and it waits in its inbox',
  'send-now-queued': 'send it now. It stays in the queue until then',
};

/**
 * Refuses an action that would start a turn of an agent its clock holds: Retry, Send now from the composer, or Send now
 * on a queued message. Waiting in the inbox is what a plain message does, so the composer’s refusal says to send it that
 * way, and a queued message stays where it is. The page has no clock control: a timed run’s runner resumes it through
 * the clock’s route (server/session-routes.mjs), so the refusal says how.
 * @param {any} rt @param {string} sessionId @param {'retry' | 'send-now' | 'send-now-queued'} action
 */
export function refuseWhileHeld(rt, sessionId, action) {
  if (!rt.runClock?.holds(sessionId)) return;
  const se = rt.store.pending.session(sessionId);
  const clock = rt.store.pending.clock(sessionId);
  const resume = `Resume it with POST /api/sessions/${sessionId}/clock and {"action":"resume"}, then ${THEN[action]}.`;
  throw httpError(
    409,
    clock?.state === 'paused'
      ? `@${se?.handle}’s run clock is paused, so no turn of @${se?.handle} starts until it resumes. ${resume}`
      : `@${se?.handle}’s run clock reached its budget, so no turn of @${se?.handle} starts in this conversation again. A new timed run goes in a new conversation.`,
  );
}
