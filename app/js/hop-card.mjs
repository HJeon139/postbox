// The add card (#228): another agent wakes one the conversation doesn’t have, and the card asks you to add it. A
// wake-limit card from before #1623, which asked to continue a chain of wakes, shows as a line with no buttons. And
// focusComposer, which it and the transcript use, so the two modules don't import each other.

import { api } from './client.mjs';
import { $, h, icon } from './dom.mjs';
import { toast } from './ui.mjs';

export const focusComposer = () => $('#composer-input')?.focus();

/**
 * A card that asked to continue a chain of wakes, or a pair’s, from before #1623: nothing asks that now, and one still
 * open closed at startup, so it shows what became of it, with no count and nothing to answer.
 */
function oldWakeCard(it) {
  return h('div.col.sys-line', icon('agent', 'i-sm'), h('b', it.from), ' asked to wake ', h('b', it.to), ` · ${oldOutcome(it.status)}`);
}

/** What the person answered on an old wake-limit card, or that it closed with no answer. */
function oldOutcome(status) {
  if (status === 'allowed') return 'allowed';
  if (status === 'declined') return 'not allowed';
  return 'closed';
}

export function hopBlock(it, ctx) {
  if (!it.join) return oldWakeCard(it);
  const open = it.status === 'open';
  const act = (allow) =>
    api(`/api/threads/${ctx.threadId}/items/${it.id}/act`, { action: allow ? 'confirm' : 'cancel' })
      .then(focusComposer)
      .catch((e) => toast({ title: 'That didn’t go through', text: e.message, level: 'blocking' }));
  return h(
    'div.col.block',
    { role: 'group', class: open ? '' : 'answered', style: open ? { borderColor: 'var(--accent)' } : {} },
    h(
      'div.block-head',
      open ? h('span.g.g-needs', { 'aria-hidden': 'true' }) : null,
      h('span.title.grow', `Add ${it.to} to this conversation?`),
      h('span.kind', 'Confirm · from Postbox'),
    ),
    h(
      'div.block-body.md',
      h('p', `${it.from} wants to wake ${it.to}, which isn’t in this conversation. Added, it joins with a note on why, and gets the message.`),
      it.reason ? h('p.dim.small', `${it.from}’s reason: “${it.reason}”`) : null,
      open && it.held?.length ? heldLine(it.held) : null,
      !open ? h('span.answered-note', icon('check', 'i-sm'), answeredNote(it)) : null,
    ),
    open
      ? h(
          'div.block-foot',
          h('button.btn', { type: 'button', onclick: () => act(true) }, `Add ${it.to}`),
          h('button.btn', { type: 'button', onclick: () => act(false) }, `Don’t add ${it.to}`),
        )
      : null,
  );
}

/** The wakes held on a waiting card (#439): they go, or don’t, with your answer, so the card says whose they are. */
function heldLine(held) {
  const who = held.map((w) => `${w.from}’s message to ${w.to}`);
  const list = who.length > 3 ? `${who.slice(0, 3).join(', ')} and ${who.length - 3} more` : who.join(who.length === 2 ? ' and ' : ', ');
  return h('p.small.hop-held', `Also waiting on your answer: ${list}. Allowing this sends ${held.length === 1 ? 'it' : 'them'} too.`);
}

/** What became of an answered card. */
function answeredNote(it) {
  // Its agent was removed or retired, so no answer was needed (#693).
  if (it.status === 'closed') return `Closed: ${it.closedWhy ?? 'its agent left'}, so nothing went`;
  return it.status === 'allowed' ? 'Added' : 'Not added';
}
