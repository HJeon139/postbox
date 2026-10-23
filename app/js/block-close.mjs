// Closing a block that asks without answering it (#106): the person’s Dismiss, and the note a closed block shows,
// saying who closed it and why. The agent hears a dismissal as the person’s answer. An agent closes a block of its
// own with update_block { id, withdraw } (server/blocks.mjs).

import { ASKING } from '/shared/catalog.mjs';
import { h, icon, timeOf } from './dom.mjs';

/** A block its agent withdrew before it was answered has no answer: it’s drawn as answered, with nothing chosen. @param {any} item */
export const asDrawn = (item) => (item.answered && !item.answer ? { ...item, answer: { action: '', values: {}, at: item.closed?.at } } : item);

/**
 * Puts a closed block’s note in place of its answer’s (after it, for an answer the agent then withdrew), or a Dismiss
 * button on an open block that asks, after its answer buttons.
 * @param {HTMLElement} node  the block as drawn @param {any} item
 * @param {(setError: (message: string | null) => void) => void} dismiss  sends the dismissal
 */
export function closing(node, item, dismiss) {
  const c = item.closed;
  if (c) {
    const by = c.by === 'person' ? 'Dismissed by you' : `Withdrawn by @${c.handle}`;
    const note = h('span.answered-note.closed-note', icon('x', 'i-sm'), `${by} at ${timeOf(c.at)}${c.reason ? `: ${c.reason}` : ''}`);
    const answered = node.querySelector('.answered-note');
    if (c.by === 'agent' && item.answer) answered?.after(note);
    else answered?.replaceWith(note);
    return;
  }
  if (!ASKING.has(item.block.type) || item.answered) return;
  const err = h('span');
  const setError = (m) => err.replaceChildren(m ? h('span.err', { role: 'alert' }, icon('warn'), m) : '');
  // After the block’s own answer, in its foot, so going to the block and Tab reach its answer first.
  const foot = [...node.children].findLast((c) => c.classList.contains('block-foot')) ?? node.querySelector('.block-head');
  foot?.append(h('button.btn.sm.dismiss', { type: 'button', onclick: () => dismiss(setError) }, 'Dismiss'), err);
}
