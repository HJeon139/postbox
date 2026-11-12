// The wakes a turn's @-mentions make once it ends (#225, #372, #485). Moved from server/runtime.mjs, whose
// wakeMentions calls it, to keep runtime.mjs under its ceiling (#756). Functions take the Runtime first
// (designs/architecture/code-size.md, “What a move may change”).

import { SENDING } from '../shared/limits.mjs';
import { parseMentions } from '../shared/text.mjs';
import { tooLongToSend } from './helpers.mjs';

/**
 * An agent that @-mentions another agent wakes it, there, except in a summary sent back, which wakes no one (#225).
 * A reply doesn’t go back to the agent that woke this one by itself (#372): it’s in the conversation, read at that
 * agent’s next turn, and it wakes it only by @-mentioning it, as a hand-off does. The chain limit stops a runaway one.
 * Each wake after the first reuses the message the first went out as: a turn in an old side thread posts it once.
 * One the failed reply a retry answers already woke isn’t woken again (#485). Past SENDING.message the wake is refused,
 * as wake_agent’s is (#362): cut, the other agent would act on half a message. The turn has ended, so the refusal is
 * posted where it spoke and the agent gets one notice turn to hand off with wake_agent, unless this turn was itself a
 * notice, so a long reply can’t loop.
 * @param {any} rt @param {any} se @param {any} turn @param {string} text  what the woken agents are sent
 * @returns {string[]} the handles it woke, or that wait to be
 */
export function wakeMentions(rt, se, turn, text) {
  let said = turn.first;
  const woke = [];
  const refused = [];
  const tooLong = tooLongToSend('A reply that wakes another agent', text);
  for (const h of turn.summarizeTo ? [] : parseMentions(turn.said, rt.handles())) {
    if (h.toLowerCase() === se.handle.toLowerCase() || turn.woken.includes(h)) continue;
    // Its turn has ended, so where it spoke comes from the turn: a topic thread it spoke in, else the conversation.
    const replyIn = turn.threadId !== se.threadId ? turn.threadId : null;
    if (tooLong) {
      refused.push(h);
      continue;
    }
    const r = rt.agentWake(se.id, h, text, { replyIn, fromTurnId: turn.id, itemId: said, prose: true });
    if (r.itemId) said = r.itemId;
    if (r.ok || r.waiting) woke.push(h);
    else rt.tellAgent(se.id, `Your mention of @${h} woke no one: ${r.message}`);
  }
  if (refused.length) refusedMentions(rt, se, turn, refused, text.length);
  return woke;
}

/**
 * Mentions refused for their reply's length (#362): one line where the turn spoke, so the person sees why the others
 * never started, and one notice turn for the agent naming wake_agent, which sends only what it chooses.
 * @param {any} rt @param {any} se @param {any} turn @param {string[]} handles  those mentioned @param {number} length
 */
function refusedMentions(rt, se, turn, handles, length) {
  const n = (k) => k.toLocaleString('en-US');
  const who = handles.map((h) => `@${h}`).join(', ');
  const over = `${n(length)} characters, past the ${n(SENDING.message)} a hand-off can send`;
  rt.addItem(turn.threadId, { kind: 'system', variant: 'send-refused', text: `@${se.handle}’s mention of ${who} woke no one: its reply has ${over}.` });
  if (turn.kind === 'notice') return;
  const text = `Your mention of ${who} woke no one: your reply has ${over}, so nothing was sent. Hand off with wake_agent, sending only what each needs.`;
  rt.deliver(se.id, { kind: 'notice', text }, { threadId: turn.threadId });
}
