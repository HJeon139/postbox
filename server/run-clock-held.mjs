// The turns a run clock holds that came another way than the agent’s inbox, kept for its resume. Moved from
// server/run-clock.mjs.

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
export function resumeHeld(rt, sessionId) {
  const held = heldTurns.get(rt)?.get(sessionId) ?? [];
  heldTurns.get(rt)?.delete(sessionId);
  for (const { message, summarizeTo, threadId } of held) rt.turnService.run(sessionId, message, { summarizeTo, threadId });
  rt.delivery.wake(sessionId);
}
