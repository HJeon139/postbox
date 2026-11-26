// Where an agent’s reply went, said under it. One that went back to the agents whose @-mentions woke its writer,
// because it @-mentions no one (#1518), so the person sees why that agent woke next. And an ask whose answer never
// reached its writer (#634): the agent it asked ended its turn without a reply that reached them. Notes, not cards:
// nothing waits on the person.

import { h } from './dom.mjs';

/** “Sent back to @alpha: this reply @-mentions no one.”, or nothing. @param {{ wentBack?: string[] }} it */
export function wentBackNote(it) {
  const to = Array.isArray(it.wentBack) ? it.wentBack : [];
  if (!to.length) return null;
  return h('span.went-back', `Sent back to ${to.map((x) => `@${x}`).join(' and ')}: this reply @-mentions no one.`);
}

/** “No reply from @beta.”, or nothing. @param {{ noReplyFrom?: string[] }} it */
export function noReplyNote(it) {
  const from = Array.isArray(it.noReplyFrom) ? it.noReplyFrom : [];
  if (!from.length) return null;
  return h('span.no-reply', `No reply from ${from.map((x) => `@${x}`).join(' or ')}.`);
}
