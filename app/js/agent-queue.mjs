// Queued messages for one agent (#427): a counted mail button in its row, and a bounded dialog with each message’s actions.

import { conversationOf, threadsOfConversation } from '/shared/conversation.mjs';
import { api, client } from './client.mjs';
import { h, icon, syncList } from './dom.mjs';
import { openDialog, openMenu, toast } from './ui.mjs';

const S = () => client.state;

function entriesFor(sessionId) {
  const session = S().sessions[sessionId];
  if (!session) return [];
  return threadsOfConversation(S().threads, session.threadId)
    .map((id) => S().threads[id])
    .flatMap((thread) => (thread.queue ?? []).filter((q) => q.sessionIds.includes(sessionId)).map((q) => ({ thread, q })));
}

function queuedMessageRow(entry, repaint, at = 1, of = 1) {
  const { thread, q } = entry;
  const target = `/api/threads/${thread.id}/queue/${q.id}`;
  // Each button’s name starts with what it shows and says which message, so identical messages differ (V5).
  const which = `message ${at} of ${of}, “${q.text.replace(/\s+/g, ' ').slice(0, 40)}”`;
  const row = h(
    'li.agent-queue-row',
    h('p.small.dim', q.kind === 'wake' ? `From @${q.from} · ${thread.title}` : thread.title),
    h('p.agent-queue-text', q.text),
    h(
      'div.row-flex.wrap',
      h(
        'button.btn.sm',
        {
          type: 'button',
          'aria-label': `Send now: ${which}`,
          onclick: () => api(`${target}/send`, {}).catch((e) => toast({ title: 'Couldn’t send now', text: e.message })),
        },
        'Send now',
      ),
      q.kind === 'wake'
        ? null
        : h(
            'button.btn.sm.ghost',
            {
              type: 'button',
              'aria-label': `Edit ${which}`,
              onclick: (event) => editQueuedMessage(row, q, target, repaint, event.currentTarget),
            },
            'Edit',
          ),
      h(
        'button.btn.sm.ghost',
        {
          type: 'button',
          'aria-label': `Remove queued ${which}`,
          onclick: () => api(target, undefined, 'DELETE').catch((e) => toast({ title: 'Couldn’t remove', text: e.message })),
        },
        icon('x', 'i-sm'),
      ),
    ),
  );
  row._entry = entry;
  return row;
}

function editQueuedMessage(row, q, target, repaint, from) {
  const input = h('textarea.textarea.agent-queue-edit', { 'aria-label': 'Edit the queued message' }, q.text);
  row.dataset.editing = '1';
  const cancel = () => {
    delete row.dataset.editing;
    repaint();
    queueMicrotask(() => from?.focus());
  };
  const save = () =>
    api(target, { text: input.value }, 'PATCH')
      .then(() => {
        delete row.dataset.editing;
        repaint();
      })
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
  const list = h('ul.agent-queue-list');
  body.append(list);
  let dialog;
  const paint = () => {
    // The agent left (deleted, or its conversation archived): nothing here can be sent to it any more.
    const now = S().sessions[sessionId];
    if (!now || now.deleting || now.archived) return dialog?.close();
    const entries = entriesFor(sessionId);
    const ids = new Set(entries.map((entry) => entry.q.id));
    const editing = [...list.children].filter((row) => row.dataset.editing);
    const missing = editing.filter((row) => !ids.has(row.dataset.key));
    for (const row of missing)
      if (!row.querySelector('.agent-queue-missing'))
        row.append(h('p.err.agent-queue-missing', 'This message left the queue while you were editing. Copy your draft before closing it.'));
    title.textContent = `${entries.length} queued for @${session.handle}`;
    if (!entries.length && !missing.length) {
      dialog?.close();
      return;
    }
    const all = [...entries, ...missing.map((row) => row._entry)];
    const at = (entry) => all.indexOf(entry) + 1;
    syncList(
      list,
      all,
      (entry) => entry.q.id,
      (entry) => queuedMessageRow(entry, paint, at(entry), all.length),
      (row, entry) => {
        if (row.dataset.editing) return;
        const fresh = queuedMessageRow(entry, paint, at(entry), all.length);
        row.replaceChildren(...fresh.childNodes);
        row._entry = entry;
      },
    );
  };
  paint();
  dialog = openDialog({
    title,
    body: [body],
    anchor,
    initialFocus: () => body.querySelector('button'),
    onClose: () => {
      off();
      anchor?.setAttribute('aria-expanded', 'false');
      // What opened it may be gone or hidden (the agent left, its last message went, the menu closed): focus goes to
      // the composer, never to nothing.
      if (!anchor?.isConnected || anchor.closest('[hidden]')) queueMicrotask(() => document.getElementById('composer-input')?.focus());
    },
  });
  const off = client.on((change) => {
    if (change.type === 'load' || change.type === 'thread' || change.type === 'session') paint();
  });
  anchor?.setAttribute('aria-expanded', 'true');
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
  let mounted = false;
  const off = client.on((change) => {
    if (button.isConnected) mounted = true;
    else if (mounted) return off();
    if (change.type === 'load' || change.type === 'thread') paint();
  });
  return button;
}

/** How many offline messages show as rows before the rest are counted (#427, V1). */
const OFFLINE_ROWS = 2;

/**
 * Offline messages aren’t assigned to an agent yet, so they remain in the composer without duplicating on repaint:
 * at most two rows, then one line counting the rest, so the composer stays bounded.
 */
export function paintOfflineQueue(container, messages) {
  const more = messages.length - OFFLINE_ROWS;
  container.replaceChildren(
    ...messages
      .slice(0, OFFLINE_ROWS)
      .map((message) =>
        h(
          'div.queued',
          { dataset: { key: `offline-${message.threadId}-${message.text}-${message.attachments?.length ?? 0}` } },
          icon('clock', 'dim'),
          h('span.q-text', h('span.small.dim', 'Waiting for the connection'), h('br'), message.text),
        ),
      ),
    ...(more > 0 ? [h('div.queued.small.dim', { dataset: { key: 'offline-more' } }, `and ${more} more waiting for the connection`)] : []),
  );
}

/** The conversation’s agents with something queued for them, and how many each. */
function waitingIn(threadId) {
  const conv = conversationOf(S().threads, threadId);
  return Object.values(S().sessions)
    .filter((se) => se.threadId === conv && !se.archived && !se.deleting)
    .map((se) => ({ se, n: entriesFor(se.id).length }))
    .filter((x) => x.n > 0);
}

/**
 * The composer’s one line saying something waits (#427, V2), since the mail buttons may be collapsed or off screen.
 * With one agent waiting it opens that agent’s queue; with several, a menu of them.
 */
export function paintWaitingLine(container, threadId) {
  const waiting = waitingIn(threadId);
  const total = waiting.reduce((n, x) => n + x.n, 0);
  if (!total) return container.replaceChildren();
  const label = `${total} waiting for ${waiting.length} agent${waiting.length === 1 ? '' : 's'}`;
  const current = container.firstElementChild;
  if (current?.textContent === label) return;
  const button = h(
    'button.btn.sm.ghost.queue-waiting',
    {
      type: 'button',
      'aria-haspopup': waiting.length === 1 ? 'dialog' : 'menu',
      onclick: () => {
        const now = waitingIn(threadId);
        if (now.length === 1) return openQueue(now[0].se.id, button);
        openMenu(button, now.map(({ se }) => agentQueueMenuItem(se, button)).filter(Boolean), { label: 'Queued messages' });
      },
    },
    icon('mail', 'i-sm'),
    label,
  );
  container.replaceChildren(button);
}

/** The phone conversation menu’s route to an agent queue, or null when it has none. */
export function agentQueueMenuItem(session, anchor) {
  const count = entriesFor(session.id).length;
  return count
    ? {
        label: `${count} message${count === 1 ? '' : 's'} queued for @${session.handle}`,
        icon: 'mail',
        run: () => openQueue(session.id, anchor),
      }
    : null;
}
