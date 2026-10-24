// The card for an agent that asks to turn on a tool the person turned off for it (#104), in the transcript
// (app/js/thread.mjs).

import { api } from './client.mjs';
import { h, icon } from './dom.mjs';
import { focusComposer } from './hop-card.mjs';
import { toast } from './ui.mjs';

// An agent asks for a tool the person turned off for it (#104). The card says what turning it on does before the click:
// it changes the persona, in every conversation, and the permission mode still decides each call.
export function toolAskBlock(it, ctx) {
  const open = it.status === 'open';
  const act = (action) =>
    api(`/api/threads/${ctx.threadId}/items/${it.id}/act`, { action })
      .then(focusComposer)
      .catch((e) => toast({ title: 'That didn’t go through', text: e.message, level: 'blocking' }));
  const titleId = `ta-${it.id}`;
  return h(
    'div.col.block',
    { role: 'group', 'aria-labelledby': titleId, class: open ? '' : 'answered', style: open ? { borderColor: 'var(--accent)' } : {} },
    h(
      'div.block-head',
      open ? h('span.g.g-needs', { 'aria-hidden': 'true' }) : null,
      h('span.title.grow', { id: titleId }, `@${it.handle} asks you to turn on “${it.label}”`),
      h('span.kind', 'Turned off · ', h('span.tool-name', it.tool)),
    ),
    h(
      'div.block-body',
      h('p', `It’s turned off for @${it.handle} in Postbox, so it can’t use it here.`),
      it.why ? h('p.small', h('b', `@${it.handle}: `), it.why) : null,
      open
        ? h(
            'p.small.dim',
            `Turning it on ticks it in @${it.handle}’s Tools, in every conversation, from its next turn. Its permission mode still decides each call.`,
          )
        : h('span.answered-note', icon(it.status === 'on' ? 'check' : 'x', 'i-sm'), it.status === 'on' ? 'Turned on.' : 'Kept off.'),
    ),
    open
      ? h(
          'div.block-foot',
          h('button.btn', { type: 'button', onclick: () => act('on') }, `Turn on for @${it.handle}`),
          h('button.btn.ghost', { type: 'button', onclick: () => act('off') }, 'Keep it off'),
        )
      : null,
  );
}
