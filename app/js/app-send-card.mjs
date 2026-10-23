// What an app sends past its limit (#38), waiting on a card for you to allow.

import { api } from './client.mjs';
import { h, icon, plural } from './dom.mjs';
import { toast } from './ui.mjs';

/** The sends a minute that go straight through (app/js/apps.mjs); the card says so. */
export const SEND_LIMIT = 5;

/** What an answered card says came of its sends: allowed, not allowed, or dropped when its app was retired (#193). */
const outcome = (it, n) =>
  it.retired
    ? `Not sent: ${it.title} was retired.`
    : it.status === 'allowed'
      ? `Allowed. ${n === 1 ? 'It was' : 'They were'} sent.`
      : `Not allowed. ${n === 1 ? 'It wasn’t' : 'They weren’t'} sent.`;

// ── An app’s sends waiting for you ───────────────────────────────────────────────────────
// Past the limit, an app’s sends wait on this card (the server’s appsend item). Postbox draws it, like the
// permission and refusal cards: Allow sends them to the agent as they were sent, Don’t allow drops them.
export function renderAppSendCard(it, ctx) {
  const open = it.status === 'open';
  const n = it.events.length;
  // One answer: the buttons turn off at the first press (a double click would answer twice), and back on if it
  // didn’t go through. Then focus goes to the composer of the thread the card is in, a panel’s or the main one.
  /** @param {string} action @param {MouseEvent} e */
  const act = (action, e) => {
    const card = /** @type {HTMLElement} */ (e.currentTarget).closest('.appsend');
    const buttons = [...(card?.querySelectorAll('button') ?? [])];
    for (const b of buttons) b.disabled = true;
    const composer = card?.closest('.sidepanel') ? document.getElementById('side-input') : document.getElementById('composer-input');
    api(`/api/threads/${ctx.threadId}/items/${it.id}/act`, { action })
      .then(() => composer?.focus())
      .catch((err) => {
        for (const b of buttons) b.disabled = false;
        toast({ title: 'That didn’t go through', text: err.message, level: 'blocking' });
      });
  };
  const titleId = `as-${it.id}`;
  return h(
    'div.col.block.appsend',
    { role: 'group', 'aria-labelledby': titleId, class: open ? '' : 'answered', style: open ? { borderColor: 'var(--accent)' } : {} },
    h(
      'div.block-head',
      open ? h('span.g.g-needs', { 'aria-hidden': 'true' }) : null,
      h(
        'span.title.grow',
        { id: titleId },
        open ? `${it.title} wants to send ${plural(n, 'message')} for you` : `${it.title} asked to send ${plural(n, 'message')} for you`,
      ),
      h('span.kind', 'Approve · from Postbox'),
    ),
    h(
      'div.block-body',
      open
        ? h(
            'p.small',
            `An app can send up to ${SEND_LIMIT} messages a minute in your voice. These came after that, so they wait for you. Each one starts a turn for the agent.`,
          )
        : null,
      h(
        'ul.appsend-list',
        it.events.map((ev) => h('li', ev.voice, ev.quote ? h('span.app-says', 'The app’s summary: ', h('q', ev.quote)) : null)),
      ),
      !open ? h('span.answered-note', icon(it.status === 'allowed' ? 'check' : 'x', 'i-sm'), outcome(it, n)) : null,
    ),
    open
      ? h(
          'div.block-foot',
          h('button.btn', { type: 'button', onclick: (e) => act('allow', e) }, 'Allow'),
          h('button.btn', { type: 'button', onclick: (e) => act('deny', e) }, 'Don’t allow'),
        )
      : null,
  );
}
