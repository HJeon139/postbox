// The card that asks the person whether Postbox may download the browser view_app renders with (#95;
// designs/architecture/view-app.md, “Agents see their app”). It looks and answers like the tool-request card
// (permission-cards.mjs, toolAskBlock), then says how the download went.

import { api } from './client.mjs';
import { h, icon } from './dom.mjs';
import { focusComposer } from './hop-card.mjs';
import { toast } from './ui.mjs';

/** What the card says once answered, by its status. */
const DONE = Object.freeze({
  downloading: ['clock', 'Downloading Chromium. The agent hears when it’s ready.'],
  ready: ['check', 'Downloaded. Agents can see their apps.'],
  failed: ['x', 'The download failed.'],
  declined: ['x', 'Not downloaded. Agents can’t see their apps. Postbox asks again in a week.'],
});

/** @param {any} it @param {{ threadId: string }} ctx */
export function viewAskBlock(it, ctx) {
  const open = it.status === 'open';
  const act = (action) =>
    api(`/api/threads/${ctx.threadId}/items/${it.id}/act`, { action })
      .then(focusComposer)
      .catch((e) => toast({ title: 'That didn’t go through', text: e.message, level: 'blocking' }));
  const titleId = `va-${it.id}`;
  const done = DONE[it.status];
  return h(
    'div.col.block',
    { role: 'group', 'aria-labelledby': titleId, class: open ? '' : 'answered', style: open ? { borderColor: 'var(--accent)' } : {} },
    h(
      'div.block-head',
      open ? h('span.g.g-needs', { 'aria-hidden': 'true' }) : null,
      h('span.title.grow', { id: titleId }, `@${it.handle} asks to see its app`),
      h('span.kind', 'Postbox’s browser'),
    ),
    h(
      'div.block-body',
      h('p', 'Download Chromium (about 200 MB on disk) so agents can see their apps?'),
      open
        ? h(
            'p.small.dim',
            'Postbox asks once, for every agent, and again a week after “Not now”. The browser renders apps in their sandbox on this computer, and only reads Postbox. Without it, agents rely on the text check and on you.',
          )
        : h('span.answered-note', icon(done?.[0] ?? 'check', 'i-sm'), done?.[1] ?? 'Answered.', it.reason ? ` ${it.reason}` : ''),
    ),
    open
      ? h(
          'div.block-foot',
          h('button.btn', { type: 'button', onclick: () => act('download') }, 'Download Chromium'),
          h('button.btn.ghost', { type: 'button', onclick: () => act('decline') }, 'Not now'),
        )
      : null,
  );
}
