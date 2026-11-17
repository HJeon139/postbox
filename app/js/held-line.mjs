// The quiet line a reply with no words of its own shows before its error or its stop: what its turn held
// (server/turn-held.mjs, shared/held-words.mjs). It asks nothing of the person, so it isn’t an alert of its own.

import { heldWords } from '/shared/held-words.mjs';
import { h } from './dom.mjs';

/** The line, or null with no record. @param {any} it  the reply */
export function heldLine(it) {
  const words = heldWords(it.held);
  return words ? h('div.held.small.dim', words) : null;
}
