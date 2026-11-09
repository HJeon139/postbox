// The wakes a turn's @-mentions make once it ends (#225, #372, #485). Moved from server/runtime.mjs, whose
// wakeMentions calls it, to keep runtime.mjs under its ceiling (#756). Functions take the Runtime first
// (architecture.md, “What a move may change”).

import { parseMentions } from '../shared/text.mjs';
import { tooLongToSend } from './helpers.mjs';

/**
 * An agent that @-mentions another agent wakes it, there, except in a summary sent back, which wakes no one (#225).
 * A reply doesn’t go back to the agent that woke this one by itself (#372): it’s in the conversation, read at that
 * agent’s next turn, and it wakes it only by @-mentioning it, as a hand-off does. The chain limit stops a runaway one.
 * Each wake after the first reuses the message the first went out as: a turn in an old side thread posts it once.
 * One the failed reply a retry answers already woke isn’t woken again (#485). Past SENDING.message the wake is refused,
 * as wake_agent’s is, and the agent told so (#362): cut, the other agent would act on half a message.
 * @param {any} rt @param {any} se @param {any} turn @param {string} text  what the woken agents are sent
 * @returns {string[]} the handles it woke, or that wait to be
 */
export function wakeMentions(rt, se, turn, text) {
  let said = turn.first;
  const woke = [];
  const tooLong = tooLongToSend('A reply that wakes another agent', text);
  for (const h of turn.summarizeTo ? [] : parseMentions(turn.said, rt.handles())) {
    if (h.toLowerCase() === se.handle.toLowerCase() || turn.woken.includes(h)) continue;
    // Its turn has ended, so where it spoke comes from the turn: a topic thread it spoke in, else the conversation.
    const replyIn = turn.threadId !== se.threadId ? turn.threadId : null;
    const r = tooLong ?? rt.agentWake(se.id, h, text, { replyIn, fromTurnId: turn.id, itemId: said, prose: true });
    if (r.itemId) said = r.itemId;
    if (r.ok || r.waiting) woke.push(h);
    else rt.tellAgent(se.id, `Your mention of @${h} woke no one: ${r.message}`);
  }
  return woke;
}
