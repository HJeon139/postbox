// The wake-limit card (#108): after three agent wakes in a row without you, the next one waits for your Allow. And
// focusComposer, which it and the transcript use, so the two modules don't import each other.

import { api } from './client.mjs';
import { $, h, icon } from './dom.mjs';
import { toast } from './ui.mjs';

export const focusComposer = () => $('#composer-input')?.focus();

export function hopBlock(it, ctx) {
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
      h('span.title.grow', `Let @${it.from} wake @${it.to}?`),
      h('span.kind', 'Confirm · from Postbox'),
    ),
    h(
      'div.block-body.md',
      h('p', `That would be agent wake ${it.n} since your last message. After 3 in a row, the next one waits for you.`),
      it.reason ? h('p.dim.small', `@${it.from}’s reason: “${it.reason}”`) : null,
      !open ? h('span.answered-note', icon('check', 'i-sm'), it.status === 'allowed' ? 'Allowed' : 'Not allowed') : null,
    ),
    open
      ? h(
          'div.block-foot',
          h('button.btn', { type: 'button', onclick: () => act(true) }, `Let @${it.from} wake @${it.to}`),
          h('button.btn', { type: 'button', onclick: () => act(false) }, `Don’t wake @${it.to}`),
        )
      : null,
  );
}
