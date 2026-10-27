// The composer’s queued messages (#228): yours, waiting for a busy agent, with Send now, Edit and Remove, and another
// agent’s wake waiting for its agent, which says whose and has no Edit.

import { api, S } from './client.mjs';
import { h, icon } from './dom.mjs';
import { toast } from './ui.mjs';

/**
 * A queued wake (#228) is another agent’s message, waiting for its agent to finish: it says whose, and has no Edit.
 * @param {HTMLElement} row @param {any} q
 */
export function asWake(row, q) {
  if (q.kind !== 'wake') return row;
  const what = row.querySelector('.q-text .small');
  if (what) what.textContent = `@${q.from}’s message · waits for ${what.textContent.replace(/^Queued · sends when (.*) finishes$/, '$1')} to finish`;
  [...row.querySelectorAll('button')].find((b) => b.textContent === 'Edit')?.remove();
  return row;
}

export function queuedRow(q, threadId, paint) {
  const names = q.sessionIds
    .map((id) => S().sessions[id]?.handle)
    .filter(Boolean)
    .map((x) => `@${x}`)
    .join(', ');
  const text = h('span.q-text', h('span.small.dim', `Queued · sends when ${names} finishes`), h('br'), q.text);
  const row = h(
    'div.queued',
    icon('clock', 'dim'),
    text,
    h(
      'button.btn.sm',
      {
        type: 'button',
        onclick: () => api(`/api/threads/${threadId}/queue/${q.id}/send`, {}).catch((e) => toast({ title: 'Couldn’t send now', text: e.message })),
      },
      'Send now',
    ),
    h(
      'button.btn.sm.ghost',
      {
        type: 'button',
        onclick: () => {
          // The row may have been refreshed in place, so mark the node it’s in now, not the one built here.
          const live = text.closest('.queued');
          const done = () => {
            delete live.dataset.editing;
            paint();
          };
          const input = h('input.input', {
            value: q.text,
            'aria-label': 'Edit the queued message',
            onkeydown: (e) => {
              if (e.key === 'Enter') saveEdit();
              if (e.key === 'Escape') done();
            },
          });
          const saveEdit = () =>
            api(`/api/threads/${threadId}/queue/${q.id}`, { text: input.value }, 'PATCH')
              .then(done)
              .catch((e) => toast({ title: 'Couldn’t edit', text: e.message }));
          live.dataset.editing = '1';
          text.replaceChildren(input, h('button.btn.sm', { type: 'button', onclick: saveEdit }, 'Save'));
          input.focus();
        },
      },
      'Edit',
    ),
    h(
      'button.btn.sm.ghost',
      { type: 'button', 'aria-label': 'Remove the queued message', onclick: () => api(`/api/threads/${threadId}/queue/${q.id}`, undefined, 'DELETE') },
      icon('x', 'i-sm'),
    ),
  );
  return row;
}
