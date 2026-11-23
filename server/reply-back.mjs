// A reply that goes back (#1518; designs/intent.md, the row on agents waking agents): a turn only other agents’
// @-mentions started, whose replies @-mention no one, goes back to the agents whose mentions woke it, as if it had
// mentioned them. Every time (#1523): chaining is how agents talk, an agent ends an exchange with a reaction, which
// posts no reply, and the room’s chain limit counts each bounce as any wake. Functions take the Runtime first, as
// waiting code does until Turns is a service.

/**
 * Whom a turn that took these entries goes back to when its replies @-mention no one: the agents whose mentions it
 * took, a reply that came back included, unless one of the entries is anything else (the person’s message, a
 * scheduled wake, a review). Notices ride along, and don’t count. Read by the turn’s input too (turn-input.mjs), so
 * what the agent is told is what happens.
 * @param {{ source: string, from?: string }[]} entries @returns {string[]}  handles, without @
 */
export function backTo(entries) {
  const asked = entries.filter((e) => e.source !== 'notice');
  if (!asked.length || asked.some((e) => e.source !== 'mention')) return [];
  return [...new Set(asked.filter((e) => e.from).map((e) => /** @type {string} */ (e.from)))];
}

/**
 * The end of a turn that went well: if it named no agent, its last reply goes back to whom backTo says, through
 * agentWake, so the chain limit counts it and a card asks past it. An agent no longer in the conversation is skipped,
 * since only the person adds one. The reply keeps whom it went to now (`wentBack`), which the transcript shows under it.
 * @param {any} rt @param {any} turn @param {any} se @param {any[]} took  the entries the turn took
 */
export function replyBack(rt, turn, se, took) {
  // turn.named: a reply or an open_topic of this turn @-mentioned an agent, even one that couldn’t be woken, or it
  // reviewed an agent’s block, which hands off to its author.
  if (turn.endErr || turn.named || turn.summarizeTo) return;
  const conv = rt.threads.conversationToWrite(turn.threadId);
  const here = (/** @type {string} */ h) => rt.sessions.pendingIn(conv).some((/** @type {any} */ x) => x.handle === h && !x.retiredFork);
  // A turn that took no entries carries whom it goes back to: a host turn continued under a new ID goes back as the turn
  // it continues would have (#1538), and a retry of one that took none as the failed turn would have (#1541).
  const asked = turn.backTo ?? backTo(took);
  const to = asked.filter((h) => h !== se.handle && here(h) && !endedByReaction(rt, se, took, h, turn.startedAt));
  if (!to.length) return;
  // Text with words: a harness may stream only whitespace around a tool call, such as a reaction, which is no reply.
  const reply = rt.store.pending.items(turn.threadId).findLast((/** @type {any} */ x) => x.kind === 'agent' && x.turnId === turn.id && x.text?.trim());
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

/**
 * Whether the agent ended its exchange with this one by a reaction (#1553): everything from it that woke this turn is a
 * reply that came back on its own, and the agent reacted to it. Its words, if it wrote any, then post without waking
 * it again. In two UAT runs of 21 November 2026, agents reacted ✅ and also wrote “Acknowledged.”, and each
 * acknowledgment went back, up to hop 262. Only a reply that came back counts: a direct @-mention is a request, and a
 * 👍 on it may come before the report, so a batch with one from that agent still goes back. Only a reaction made since
 * this turn began counts: one from a failed attempt the person retried doesn’t stop the Retry’s answer (critic’s review
 * of PR #1557).
 * @param {any} rt @param {any} se  the agent @param {any[]} took  the entries the turn took @param {string} handle
 * @param {number} since  when this turn began
 */
export function endedByReaction(rt, se, took, handle, since) {
  const from = took.filter((e) => e.source !== 'notice' && e.from === handle);
  const reacted = (/** @type {any} */ e) =>
    (rt.store.pending.item(e.threadId, e.itemId)?.reactions ?? []).some((/** @type {any} */ r) => r.by === se.id && r.at >= since);
  return from.length > 0 && from.every((e) => e.source === 'mention' && e.bounce === true && reacted(e));
}

/**
 * Only replies that went back on their own woke it, and it ended at once with nothing to add (#1543): an exchange
 * between agents may end quietly, and a failure there is an alarm the person can’t act on. A turn that took a step had
 * work to report (#485). A direct @-mention is a request, so a turn it woke still owes its reply, as do the person’s
 * Retry and a host turn continued after Interrupted or Sign-in needed: the first was the person asking, and the second
 * may have done its work before it was cut off.
 * @param {any} turn
 */
export const endedExchange = (turn) => !turn.asked?.message?.retry && !turn.origin && !turn.backTo && onlyBounces(turn) && !tookStep(turn);

/** Whether the entries a turn took were replies going back and Postbox’s notices, with one reply at least. @param {any} turn */
function onlyBounces(turn) {
  const asked = (turn.asked?.message?.entries ?? []).filter((/** @type {any} */ e) => e.source !== 'notice');
  return asked.length > 0 && asked.every((/** @type {any} */ e) => e.source === 'mention' && e.bounce === true);
}

/** Whether a turn took a step: not a subagent’s, a thought or narration (turn-held.mjs counts the same). @param {any} turn */
const tookStep = (turn) => (turn.steps ?? []).some((/** @type {any} */ s) => !s.who && s.kind !== 'thought' && s.kind !== 'said');
