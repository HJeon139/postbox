// A conversation with no messages yet: its agent, ready, and its example prompts to start from. Moved from
// thread.mjs, which hands it sendMessage, since importing thread.mjs from here would make a cycle.

import { client, sessionsOf } from './client.mjs';
import { h } from './dom.mjs';
import { ringFor } from './ring.mjs';

const S = () => client.state;

/**
 * @param {string} threadId
 * @param {(threadId: string, text: string) => unknown} send  sends a prompt, as thread.mjs's sendMessage does
 */
export function welcome(threadId, send) {
  const se = sessionsOf(threadId)[0];
  const p = se && S().personas[se.personaId];
  if (!se || !p) return h('div.col', h('p.dim', 'No agent is in this conversation yet. @-mention one to bring it in.'));
  const ring = ringFor(se, 'lg');
  ring.dataset.session = se.id;
  return h(
    'section.col',
    { style: { display: 'flex', flexDirection: 'column', gap: '18px', padding: '32px 0' } },
    h('div.row-flex', { style: { gap: '14px' } }, ring, h('div', h('h1.title', `${p.handle} is ready`), h('p.dim', String(p.description ?? '')))),
    h(
      'div',
      { role: 'list', 'aria-label': 'Example prompts', style: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: '10px' } },
      (p.examples ?? []).map(([title, sub]) =>
        h(
          'button.prompt',
          {
            type: 'button',
            role: 'listitem',
            style: {
              all: 'unset',
              boxSizing: 'border-box',
              cursor: 'pointer',
              display: 'flex',
              flexDirection: 'column',
              gap: '4px',
              padding: '12px',
              border: '1px solid var(--line-strong)',
              borderRadius: '8px',
              background: 'var(--panel)',
            },
            onclick: () => send(threadId, title),
          },
          h('b', title),
          h('span.small.dim', sub),
        ),
      ),
    ),
  );
}
