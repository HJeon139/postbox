// Queued messages for one agent (#427): a counted mail button in its row, and a bounded dialog with each message’s actions.

import { api, client } from './client.mjs';
import { h, icon } from './dom.mjs';
import { openDialog, toast } from './ui.mjs';

const S = () => client.state;

function rootOf(thread) {
  let current = thread;
  while (current?.parentId) current = S().threads[current.parentId];
  return current?.id;
}

function entriesFor(sessionId) {
  const session = S().sessions[sessionId];
  if (!session) return [];
  return Object.values(S().threads)
    .filter((thread) => rootOf(thread) === session.threadId)
    .flatMap((thread) => (thread.queue ?? []).filter((q) => q.sessionIds.includes(sessionId)).map((q) => ({ thread, q })));
}

function queuedMessageRow(entry, repaint) {
  const { thread, q } = entry;
  const target = `/api/threads/${thread.id}/queue/${q.id}`;
  const row = h(
    'li.agent-queue-row',
    h('p.small.dim', q.kind === 'wake' ? `From @${q.from} · ${thread.title}` : thread.title),
    h('p.agent-queue-text', q.text),
    h(
      'div.row-flex.wrap',
      h(
        'button.btn.sm',
        { type: 'button', onclick: () => api(`${target}/send`, {}).catch((e) => toast({ title: 'Couldn’t send now', text: e.message })) },
        'Send now',
      ),
      q.kind === 'wake'
        ? null
        : h(
            'button.btn.sm.ghost',
            {
              type: 'button',
              onclick: (event) => editQueuedMessage(row, q, target, repaint, event.currentTarget),
            },
            'Edit',
          ),
      h(
        'button.btn.sm.ghost',
        {
          type: 'button',
          'aria-label': 'Remove the queued message',
          onclick: () => api(target, undefined, 'DELETE').catch((e) => toast({ title: 'Couldn’t remove', text: e.message })),
        },
        icon('x', 'i-sm'),
      ),
    ),
  );
  return row;
}

function editQueuedMessage(row, q, target, repaint, from) {
  const input = h('textarea.textarea.agent-queue-edit', { 'aria-label': 'Edit the queued message' }, q.text);
  const cancel = () => {
    repaint();
    queueMicrotask(() => from?.focus());
  };
  const save = () =>
    api(target, { text: input.value }, 'PATCH')
      .then(repaint)
      .catch((e) => {
        toast({ title: 'Couldn’t edit', text: e.message });
        input.focus();
      });
  row.replaceChildren(
    input,
    h('div.row-flex', h('button.btn.sm', { type: 'button', onclick: save }, 'Save'), h('button.btn.sm.ghost', { type: 'button', onclick: cancel }, 'Cancel')),
  );
  input.focus();
}

export function openQueue(sessionId, anchor = null) {
  const session = S().sessions[sessionId];
  if (!session) return;
  const title = h('span');
  const body = h('div.agent-queue-dialog');
  let dialog;
  const paint = () => {
    const entries = entriesFor(sessionId);
    title.textContent = `${entries.length} queued for @${session.handle}`;
    if (!entries.length) {
      dialog?.close();
      document.getElementById(`agent-row-${sessionId}`)?.focus();
      return;
    }
    body.replaceChildren(h('ul.agent-queue-list', ...entries.map((entry) => queuedMessageRow(entry, paint))));
  };
  paint();
  dialog = openDialog({
    title,
    body: [body],
    anchor,
    initialFocus: () => body.querySelector('button'),
    onClose: () => {
      off();
      anchor.setAttribute('aria-expanded', 'false');
    },
  });
  const off = client.on((change) => {
    if (change.type === 'load' || change.type === 'thread') paint();
  });
  anchor.setAttribute('aria-expanded', 'true');
}

export function agentQueueButton(session) {
  const button = h('button.btn.icon.sm.ghost.agent-queue-button', {
    type: 'button',
    'aria-haspopup': 'dialog',
    'aria-expanded': 'false',
    onclick: () => openQueue(session.id, button),
  });
  const paint = () => {
    const count = entriesFor(session.id).length;
    button.hidden = count === 0;
    button.setAttribute('aria-label', `${count} message${count === 1 ? '' : 's'} queued for @${session.handle}`);
    button.replaceChildren(icon('mail', 'i-sm'), h('span.agent-queue-count', { 'aria-hidden': 'true' }, String(count)));
  };
  paint();
  const off = client.on((change) => {
    if (!button.isConnected && button.dataset.seen) return off();
    button.dataset.seen ||= String(button.isConnected);
    if (change.type === 'load' || change.type === 'thread') paint();
  });
  return button;
}

/** Offline messages aren’t assigned to an agent yet, so they remain in the composer without duplicating on repaint. */
export function paintOfflineQueue(container, messages) {
  container.replaceChildren(
    ...messages.map((message) =>
      h(
        'div.queued',
        { dataset: { key: `offline-${message.threadId}-${message.text}-${message.attachments?.length ?? 0}` } },
        icon('clock', 'dim'),
        h('span.q-text', h('span.small.dim', 'Waiting for the connection'), h('br'), message.text),
      ),
    ),
  );
}

/** The phone conversation menu’s route to an agent queue, or null when it has none. */
export function agentQueueMenuItem(session) {
  const count = entriesFor(session.id).length;
  return count
    ? {
        label: `${count} message${count === 1 ? '' : 's'} queued for @${session.handle}`,
        icon: 'mail',
        run: () => openQueue(session.id, document.activeElement instanceof HTMLElement ? document.activeElement : null),
      }
    : null;
}
