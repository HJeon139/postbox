// The wake-limit card (#108): after ten agent wakes in a row without you (#320), the next one waits for your Allow. The same
// card asks to add an agent the conversation doesn’t have, when another agent wakes it (#228). And focusComposer, which
// it and the transcript use, so the two modules don't import each other.

import { api, client } from './client.mjs';
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
      h('span.title.grow', it.join ? `Add @${it.to} to this conversation?` : `Let @${it.from} wake @${it.to}?`),
      h('span.kind', 'Confirm · from Postbox'),
    ),
    h(
      'div.block-body.md',
      h(
        'p',
        it.join
          ? `@${it.from} wants to wake @${it.to}, which isn’t in this conversation. Added, it joins with a note on why, and gets the message.`
          : it.pair
            ? `@${it.from} and @${it.to} have woken each other ${it.pair} times in a row, so the next one waits for you.`
            : `That would be agent wake ${it.n} since your last message. After ${client.config?.hopLimit ?? 10} in a row, the next one waits for you.`,
      ),
      it.reason ? h('p.dim.small', `@${it.from}’s reason: “${it.reason}”`) : null,
      !open
        ? h('span.answered-note', icon('check', 'i-sm'), it.status === 'allowed' ? (it.join ? 'Added' : 'Allowed') : it.join ? 'Not added' : 'Not allowed')
        : null,
    ),
    open
      ? h(
          'div.block-foot',
          h('button.btn', { type: 'button', onclick: () => act(true) }, it.join ? `Add @${it.to}` : `Let @${it.from} wake @${it.to}`),
          h('button.btn', { type: 'button', onclick: () => act(false) }, it.join ? `Don’t add @${it.to}` : `Don’t wake @${it.to}`),
        )
      : null,
  );
}
