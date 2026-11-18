// A reply that goes back (#1518; designs/intent.md, the row on agents waking agents): a turn only other agents’
// @-mentions started, whose replies @-mention no one, goes back to the agents whose mentions woke it, as if it had
// mentioned them. Once: the turn that bounce starts goes back to no one, so “thanks, got it” never comes back, and the
// room’s chain limit counts each bounce as any wake. Functions take the Runtime first, as waiting code does until Turns
// is a service.

/**
 * Whom a turn that took these entries goes back to when its replies @-mention no one: the agents whose mentions it
 * took, unless one of the entries is anything else (the person’s message, a scheduled wake, a review). A mention that
 * was itself a reply going back sends nothing back, so the agents it came from aren’t named. Notices ride along, and
 * don’t count. Read by the turn’s input too (turn-input.mjs), so what the agent is told is what happens.
 * @param {{ source: string, from?: string, bounce?: boolean }[]} entries @returns {string[]}  handles, without @
 */
export function backTo(entries) {
  const asked = entries.filter((e) => e.source !== 'notice');
  if (!asked.length || asked.some((e) => e.source !== 'mention')) return [];
  return [...new Set(asked.filter((e) => !e.bounce && e.from).map((e) => /** @type {string} */ (e.from)))];
}

/**
 * The end of a turn that went well: if it named no agent, its last reply goes back to whom backTo says, through
 * agentWake, so the chain limit counts it and a card asks past it. An agent no longer in the conversation is skipped,
 * since only the person adds one. The reply keeps whom it went to now (`wentBack`), which the transcript shows under it.
 * @param {any} rt @param {any} turn @param {any} se @param {any[]} took  the entries the turn took
 */
export function replyBack(rt, turn, se, took) {
  // turn.named: a reply or an open_topic of this turn @-mentioned an agent, even one that couldn’t be woken.
  if (turn.endErr || turn.named || turn.summarizeTo) return;
  const conv = rt.threads.lineage(turn.threadId).at(-1);
  const here = (/** @type {string} */ h) => rt.sessions.in(conv).some((/** @type {any} */ x) => x.handle === h && !x.retiredFork);
  const to = backTo(took).filter((h) => h !== se.handle && here(h));
  if (!to.length) return;
  const reply = rt.store.pending.items(turn.threadId).findLast((/** @type {any} */ x) => x.kind === 'agent' && x.turnId === turn.id && x.text);
  if (!reply) return;
  const replyIn = turn.threadId !== se.threadId ? turn.threadId : null;
  const went = [];
  for (const h of to) {
    const r = rt.agentWake(se.id, h, reply.text, { replyIn, fromTurnId: turn.id, itemId: reply.id, prose: true, bounce: true });
    // Only one that went: a bounce past the chain limit waits on the card, which shows it, and may never go.
    if (r.ok) went.push(h);
  }
  if (went.length) rt.threads.patchItem(turn.threadId, reply.id, { wentBack: went });
}
