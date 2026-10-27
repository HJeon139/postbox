// The composer’s queued messages (#228): yours, waiting for a busy agent, with Send now, Edit and Remove, and another
// agent’s wake waiting for its agent, which says whose and has no Edit. Larger queues collapse so the conversation stays usable (#427).

import { api, S } from './client.mjs';
import { h, icon, syncList } from './dom.mjs';
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

/** A composer queue that keeps individual rows, but collapses four or more behind one summary. */
export function queueBox(threadId, repaint) {
  const list = h('div.queue-list');
  const summary = h('button.btn.sm.ghost.queue-summary', { type: 'button', 'aria-expanded': 'false' });
  const el = h('div.outbox', summary, list);
  let expanded = false;
  summary.onclick = () => {
    expanded = !expanded;
    summary.setAttribute('aria-expanded', String(expanded));
    list.hidden = !expanded;
    summary.textContent = `${summary.dataset.count} queued messages · ${expanded ? 'Hide' : 'Show'}`;
  };
  return {
    el,
    paint(items, offline) {
      syncList(
        list,
        items,
        (q) => q.id,
        (q) => asWake(queuedRow(q, threadId, repaint), q),
        (node, q) => {
          if (node.dataset.editing) return;
          const fresh = asWake(queuedRow(q, threadId, repaint), q);
          node.replaceChildren(...fresh.childNodes);
        },
      );
      for (const message of offline)
        list.append(h('div.queued', icon('clock', 'dim'), h('span.q-text', h('span.small.dim', 'Waiting for the connection'), h('br'), message.text)));
      const count = items.length + offline.length;
      const collapsible = count > 3;
      summary.hidden = !collapsible;
      summary.dataset.count = String(count);
      summary.textContent = `${count} queued messages · ${expanded ? 'Hide' : 'Show'}`;
      list.classList.toggle('bounded', collapsible);
      list.hidden = collapsible && !expanded;
      if (!collapsible) expanded = false;
      summary.setAttribute('aria-expanded', String(collapsible && expanded));
    },
  };
}
