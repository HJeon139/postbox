// A reply that goes back (#1518; designs/intent.md, the row on agents waking agents): a turn only other agents’
// @-mentions started, whose replies @-mention no one, goes back to the agents whose mentions woke it, as if it had
// mentioned them. Every time (#1523): chaining is how agents talk, and the chain’s loop guard counts each bounce as
// any wake (#1623). A reply stops going back after a reaction to the reply that came back (#1553), or at an agent’s second
// reply in a row to the same agent from a turn that reply woke and that did nothing but write (#1591). Neither holds a
// wake an @-mention asks for. Functions take the Runtime first, as waiting code does until Turns is a service.

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
 * Whom the reply of a turn that went well goes back to, decided as the turn ends and before anything it took settles:
 * if it named no agent, its last reply goes back to whom backTo says. An agent no longer in the conversation is
 * skipped, since only the person adds one. An agent’s second reply in a row to the same agent that only writes ends
 * their exchange, whatever line it closes with (#1591), so it goes back to the others only.
 *
 * The reply keeps whom a turn that only wrote meant it for (`wordsOnly`), on its item, where the agent’s next turn in
 * the thread reads it, after a restart too. It is written here, not when the reply goes: the agent’s next turn may
 * start, and be told where its own reply goes, before this one has gone (round 3 of the review of PR #1724: told
 * “goes back to @beta and @gamma”, a reply went back to gamma alone). So the mark names the agents the exchange had
 * already ended with, which keeps it ended, and one an add card then holds the reply on.
 * @param {any} rt @param {any} turn @param {any} se @param {any[]} took  the entries the turn took
 * @returns {{ reply: any, to: string[] } | null}  the reply and whom it goes back to, or null when it goes back to no one
 */
export function planBack(rt, turn, se, took) {
  // turn.named: a reply or an open_topic of this turn @-mentioned an agent, even one that couldn’t be woken, or it
  // reviewed an agent’s block, which hands off to its author.
  if (turn.endErr || turn.named || turn.summarizeTo) return null;
  const wordsOnly = endedExchange(turn);
  const had = wordsOnly ? wroteOnlyTo(rt, se, turn.threadId, turn.id) : [];
  const conv = rt.threads.conversationToWrite(turn.threadId);
  const here = (/** @type {string} */ h) => rt.sessions.pendingIn(conv).some((/** @type {any} */ x) => x.handle === h && !x.retiredFork);
  // A turn that took no entries carries whom it goes back to: a host turn continued under a new ID goes back as the turn
  // it continues would have (#1538), and a retry of one that took none as the failed turn would have (#1541).
  const asked = turn.backTo ?? backTo(took);
  const open = asked.filter((h) => h !== se.handle && here(h) && !endedByReaction(rt, se, took, h, turn.startedAt));
  if (!open.length) return null;
  // Text with words: a harness may stream only whitespace around a tool call, such as a reaction, which is no reply.
  const reply = rt.store.pending.items(turn.threadId).findLast((/** @type {any} */ x) => x.kind === 'agent' && x.turnId === turn.id && x.text?.trim());
  if (!reply) return null;
  if (wordsOnly) rt.threads.patchItem(turn.threadId, reply.id, { wordsOnly: open });
  return { reply, to: open.filter((h) => !had.includes(h)) };
}

/**
 * The reply goes back to whom planBack decided, through agentWake, so the chain’s loop guard counts it and stops it at
 * the cap (#1623). The reply keeps whom it went to now (`wentBack`), which the transcript shows under it. One that
 * didn’t go, and isn’t held on an add card, tells its agent why in one line, as a mention that woke no one does.
 * @param {any} rt @param {any} turn @param {any} se @param {{ reply: any, to: string[] } | null} plan
 */
export function replyBack(rt, turn, se, plan) {
  if (!plan?.to.length) return;
  const { reply, to } = plan;
  const replyIn = turn.threadId !== se.threadId ? turn.threadId : null;
  const went = [];
  for (const h of to) {
    const r = rt.agentWake(se.id, h, reply.text, { replyIn, fromTurnId: turn.id, itemId: reply.id, prose: true, bounce: true });
    // Only one that went: a bounce held on an add card may never go, and the card shows it.
    if (r.ok) went.push(h);
    else if (!r.waiting) rt.sessions.tell(se.id, `Your reply didn’t go back to @${h}: ${r.message}`);
  }
  if (went.length) rt.threads.patchItem(turn.threadId, reply.id, { wentBack: went });
}

/**
 * The agents whose exchange with this one its next reply that only writes ends (#1591): those its last replies in the
 * thread were for, as far back as each came from a turn that only wrote. The count belongs to an
 * exchange, not to the agent: a lead that answered beta in words still answers gamma in words (round 2 of the review
 * of PR #1724). One such reply is delivered, since it may be a follow-up question, its answer, a reviewer’s “ship it”
 * or a hand-off in words, which Postbox can’t tell from a thanks without reading it. A second in a row to the same
 * agent is what the recorded loops were made of, so the owner chose to end the exchange there. A reply of the agent’s
 * that did work, or that a request or the person woke, carries no mark, so it starts every count again. Read by the
 * turn’s input too (turns.mjs), so what the agent is told is what happens.
 * @param {any} rt @param {any} se @param {string} threadId @param {string | null} [turnId]  the turn whose replies don’t count
 * @returns {string[]}  handles, without @
 */
export function wroteOnlyTo(rt, se, threadId, turnId = null) {
  const mine = rt.store.pending
    .items(threadId)
    .filter((/** @type {any} */ x) => x.kind === 'agent' && x.sessionId === se.id && x.turnId !== turnId && x.text?.trim());
  const from = mine.findLastIndex((/** @type {any} */ x) => !Array.isArray(x.wordsOnly)) + 1;
  return [...new Set(mine.slice(from).flatMap((/** @type {any} */ x) => x.wordsOnly))];
}

/**
 * Whether the agent ended its exchange with this one by a reaction (#1553): everything from it that woke this turn is a
 * reply that came back on its own, and the agent reacted to it. Its words, if it wrote any, then post and don’t go
 * back to it. They still wake whom they @-mention, that agent too: no rule holds a wake an @-mention asks for (#1591,
 * the owner’s ruling of 26 November 2026: “A @mention always wakes. no matter what rule”). In two UAT runs of
 * 21 November 2026, agents reacted ✅ and also wrote “Acknowledged.”, and each
 * acknowledgment went back, up to hop 262. Only a reply that came back counts: a direct @-mention is a request, and a
 * 👍 on it may come before the report, so a batch with one from that agent still goes back. Only a reaction made since
 * this turn began counts: one from a failed attempt the person retried doesn’t stop the Retry’s answer (critic’s review
 * of PR #1557).
 * @param {any} rt @param {any} se  the agent @param {any[]} took  the entries the turn took @param {string} handle
 * @param {number} since  when this turn began
 */
export function endedByReaction(rt, se, took, handle, since) {
  const from = took.filter((e) => e.source !== 'notice' && e.from === handle);
  return from.every((e) => e.source === 'mention' && e.bounce === true) && reactedTo(rt, se, took, handle, since);
}

/**
 * Whether the agent reacted, since this turn began, to everything from that agent that woke this turn: a reply that
 * came back, or one that @-mentioned it. endedByReaction asks it of replies that came back, and markReacted of any.
 * @param {any} rt @param {any} se  the agent @param {any[]} took  the entries the turn took @param {string} handle
 * @param {number} since  when this turn began
 */
function reactedTo(rt, se, took, handle, since) {
  const from = took.filter((e) => e.source !== 'notice' && e.from === handle);
  const reacted = (/** @type {any} */ e) =>
    (rt.store.pending.item(e.threadId, e.itemId)?.reactions ?? []).some((/** @type {any} */ r) => r.by === se.id && r.at >= since);
  return from.length > 0 && from.every(reacted);
}

/**
 * A turn that reacted to an agent’s reply, did no work, and still @-mentioned that agent (#1974): the mention wakes it,
 * since an @-mention always wakes (#1591, the owner’s ruling on PR #1823), and its turn is told the waker only reacted
 * (turn-input.mjs, reactedLine), so it can react and end with no words. Two agents that each reacted ✅ and then named
 * the other in a closing line woke each other up to the chain’s cap in four UAT runs. The turn’s replies keep whom it
 * reacted to (`reactedOnly`), marked as it ends, before the replies that settled at its end wake anyone. A reply that
 * settled mid-turn, because a tool call followed its text, woke its agents at once (mention-entries.mjs, `wake: live`),
 * so their turns don’t get the line: marking it earlier would mean holding that wake, and an @-mention always wakes.
 * @param {any} rt @param {any} turn @param {any} se @param {any[]} took  the entries the turn took
 */
export function markReacted(rt, turn, se, took) {
  if (!turn.mentioned?.length || !didNoWork(turn)) return;
  const to = turn.mentioned.filter((/** @type {string} */ h) => reactedTo(rt, se, took, h, turn.startedAt));
  if (!to.length) return;
  const mine = rt.store.pending.items(turn.threadId).filter((/** @type {any} */ x) => x.kind === 'agent' && x.turnId === turn.id && x.text?.trim());
  for (const reply of mine) rt.threads.patchItem(turn.threadId, reply.id, { reactedOnly: to });
}

/**
 * The agents that woke this one only by @-mentions from turns that reacted to its reply and did no work (markReacted):
 * every entry from each is such a mention. A reply that came back is told how its exchange ends already (turn-input.mjs,
 * replyGoes). Read by the turn’s input (turns.mjs).
 * @param {{ source: string, from?: string, bounce?: boolean }[]} entries
 * @param {(e: any) => string[] | undefined} marks  whom the entry’s item’s turn reacted to @param {string} handle  this agent
 * @returns {string[]}  handles, without @
 */
export function reactedOnlyFrom(entries, marks, handle) {
  const asked = entries.filter((e) => e.source !== 'notice');
  const senders = [...new Set(asked.flatMap((e) => (e.from && e.from !== 'you' ? [e.from] : [])))];
  const only = (/** @type {any} */ e) => e.source === 'mention' && !e.bounce && marks(e)?.includes(handle);
  return senders.filter((h) => asked.filter((e) => e.from === h).every(only));
}

/**
 * Only replies that went back on their own woke it, and it had nothing to add (#1543): it took no step and acted
 * through none of Postbox’s tools, a reaction aside. An exchange between agents may end there quietly, since a
 * failure is an alarm the person can’t act on (empty-reply.mjs), and the second reply in a row that such turns of
 * one agent write to the same agent doesn’t go back to it (#1591, wroteOnlyTo): a model closes its turn with a line, the harness posts
 * it as the reply, and two agents sent each other “I’m ending without a reply.” about 50 times each in a UAT run of
 * 23 November 2026. It still wakes whom it @-mentions. A turn that took a step had work to report (#485), and its
 * reply goes back, however many came back before (#1523). A direct @-mention is a request, so a turn it woke still
 * owes its reply, which goes back, as do the person’s Retry and a host turn continued after Interrupted or Sign-in
 * needed: the first was the person asking, and the second may have done its work before it was cut off.
 * @param {any} turn
 */
export const endedExchange = (turn) => !turn.asked?.message?.retry && !turn.origin && !turn.backTo && onlyBounces(turn) && didNoWork(turn);

/**
 * Whether a turn did no work: it took no step, and acted through none of Postbox’s tools, a reaction aside. Read by
 * endedExchange and markReacted. @param {any} turn
 */
const didNoWork = (turn) => !tookStep(turn) && !turn.acted;

/** Whether the entries a turn took were replies going back and Postbox’s notices, with one reply at least. @param {any} turn */
function onlyBounces(turn) {
  const asked = (turn.asked?.message?.entries ?? []).filter((/** @type {any} */ e) => e.source !== 'notice');
  return asked.length > 0 && asked.every((/** @type {any} */ e) => e.source === 'mention' && e.bounce === true);
}

/**
 * Whether a turn took a step: not a subagent’s, a thought or narration (turn-held.mjs counts the same), nor a call to
 * one of Postbox’s own tools, which is work only when the tool acted (`acted`; tool-gate.mjs, isOwnWork). @param {any} turn
 */
const tookStep = (turn) =>
  (turn.steps ?? []).some((/** @type {any} */ s) => !s.who && s.kind !== 'thought' && s.kind !== 'said' && !turn.postboxSteps?.has(s.id));
