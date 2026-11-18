// A reply that went back to the agents whose @-mentions woke its writer, because it @-mentions no one (#1518): said
// under the reply, so the person sees why that agent woke next. A note, not a card: nothing waits on the person.

import { h } from './dom.mjs';

/** “Sent back to @alpha: this reply @-mentions no one.”, or nothing. @param {{ wentBack?: string[] }} it */
export function wentBackNote(it) {
  const to = Array.isArray(it.wentBack) ? it.wentBack : [];
  if (!to.length) return null;
  return h('span.went-back', `Sent back to ${to.map((x) => `@${x}`).join(' and ')}: this reply @-mentions no one.`);
}
