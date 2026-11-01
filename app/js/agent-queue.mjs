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

/**
 * One queued message’s row. Its parts are made once and updated in place by fillRow, so a repaint never replaces a
 * button that may hold focus (design-597-release-1, F1).
 */
function queuedMessageRow(entry, repaint) {
  const row = h('li.agent-queue-row');
  row._repaint = repaint;
  buildRow(row, entry);
  return row;
}

function buildRow(row, entry) {
  const { thread, q } = entry;
  const target = `/api/threads/${thread.id}/queue/${q.id}`;
  const send = h(
    'button.btn.sm',
    {
      type: 'button',
      dataset: { action: 'send' },
      onclick: () => api(`${target}/send`, {}).catch((e) => toast({ title: 'Couldn’t send now', text: e.message })),
    },
    'Send now',
  );
  const edit =
    q.kind === 'wake' ? null : h('button.btn.sm.ghost', { type: 'button', dataset: { action: 'edit' }, onclick: () => editQueuedMessage(row, target) }, 'Edit');
  const remove = h(
    'button.btn.sm.ghost',
    {
      type: 'button',
      dataset: { action: 'remove' },
      onclick: () => api(target, undefined, 'DELETE').catch((e) => toast({ title: 'Couldn’t remove', text: e.message })),
    },
    icon('x', 'i-sm'),
  );
  row.replaceChildren(h('p.small.dim.agent-queue-meta'), h('p.agent-queue-text'), h('div.row-flex.wrap.agent-queue-actions', send, edit, remove));
  row._entry = entry;
}

/** Puts a row’s text and names up to date without replacing its nodes. An editing row keeps its editor. */
function fillRow(row, entry, at, of, leaving) {
  row._entry = entry;
  row._at = at;
  row._of = of;
  if (row.dataset.editing) return;
  if (!row.querySelector('.agent-queue-actions')) buildRow(row, entry);
  const { thread, q } = entry;
  // Each button’s name starts with what it shows and says which message, so identical messages differ (V5).
  const which = `message ${at} of ${of}, “${q.text.replace(/\s+/g, ' ').slice(0, 40)}”`;
  const set = (el, text) => {
    if (el && el.textContent !== text) el.textContent = text;
  };
  set(row.querySelector('.agent-queue-meta'), q.kind === 'wake' ? `From @${q.from} · ${thread.title}` : thread.title);
  set(row.querySelector('.agent-queue-text'), q.text);
  const label = (action, text) => row.querySelector(`[data-action="${action}"]`)?.setAttribute('aria-label', text);
  label('send', `Send now: ${which}`);
  label('edit', `Edit ${which}`);
  label('remove', `Remove queued ${which}`);
  const send = row.querySelector('[data-action="send"]');
  if (send) send.disabled = leaving;
}

function editQueuedMessage(row, target) {
  const q = row._entry.q;
  // Escape here leaves the editor for its Save, keeping the draft; the dialog closes on the next one (F1, V4).
  const input = h('textarea.textarea.agent-queue-edit', { 'aria-label': 'Edit the queued message', dataset: { ownEscape: '' } }, q.text);
  const saveBtn = h('button.btn.sm', { type: 'button', onclick: () => save() }, 'Save');
  input.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    e.preventDefault();
    saveBtn.focus();
  });
  row.dataset.editing = '1';
  // Leaving the editor rebuilds the row’s buttons; focus goes to its Edit, the control the person used (F1).
  const done = () => {
    delete row.dataset.editing;
    buildRow(row, row._entry);
    row._repaint();
    row.querySelector('[data-action="edit"]')?.focus();
  };
  const save = () =>
    api(target, { text: input.value }, 'PATCH').then(done, (e) => {
      toast({ title: 'Couldn’t edit', text: e.message });
      input.focus();
    });
  row.replaceChildren(input, h('div.row-flex', saveBtn, h('button.btn.sm.ghost', { type: 'button', onclick: done }, 'Cancel')));
  input.focus();
}

/** The dialog’s note while its agent is being deleted; whether it is. */
function paintLeaving(note, se) {
  const leaving = Boolean(se.deleting);
  const text = leaving ? `@${se.handle} is being deleted. Undo keeps these queued; otherwise they’re posted to the conversation.` : '';
  if (note.textContent !== text) note.textContent = text;
  note.hidden = !leaving;
  return leaving;
}

export function openQueue(sessionId, anchor = null) {
  const session = S().sessions[sessionId];
  if (!session) return;
  const title = h('span');
  // Announced, not only shown: the agent is being deleted, and what happens to these messages (R1).
  const leavingNote = h('p.small.agent-queue-leaving', { role: 'status' });
  const body = h('div.agent-queue-dialog');
  const list = h('ul.agent-queue-list');
  body.append(leavingNote, list);
  let dialog;
  const paint = () => {
    // The agent is gone (purged, or its conversation archived): nothing here can be sent to it any more.
    const now = S().sessions[sessionId];
    if (!now || now.archived) return dialog?.close();
    const leaving = paintLeaving(leavingNote, now);
    const entries = entriesFor(sessionId);
    const ids = new Set(entries.map((entry) => entry.q.id));
    const editing = [...list.children].filter((row) => row.dataset.editing);
    const missing = editing.filter((row) => !ids.has(row.dataset.key));
    for (const row of missing)
      if (!row.querySelector('.agent-queue-missing'))
        row.append(h('p.err.agent-queue-missing', 'This message left the queue while you were editing. Copy your draft before closing it.'));
    const heading = `${entries.length} queued for @${session.handle}`;
    if (title.textContent !== heading) title.textContent = heading;
    if (!entries.length && !missing.length) {
      dialog?.close();
      return;
    }
    const all = [...entries, ...missing.map((row) => row._entry)];
    syncList(
      list,
      all,
      (entry) => entry.q.id,
      (entry) => queuedMessageRow(entry, paint),
      () => {},
    );
    for (const [i, row] of [...list.children].entries()) fillRow(row, all[i] ?? row._entry, i + 1, all.length, leaving);
  };
  paint();
  dialog = openDialog({
    title,
    body: [body],
    anchor,
    initialFocus: () => body.querySelector('button:not([disabled])'),
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
  const countEl = h('span.agent-queue-count', { 'aria-hidden': 'true' });
  button.append(icon('mail', 'i-sm'), countEl);
  const paint = () => {
    const count = entriesFor(session.id).length;
    button.hidden = count === 0;
    button.setAttribute('aria-label', `${count} message${count === 1 ? '' : 's'} queued for @${session.handle}`);
    // The count changes in place, so the button keeps focus through a repaint (F1).
    if (countEl.textContent !== String(count)) countEl.textContent = String(count);
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
  return (
    Object.values(S().sessions)
      // One being deleted still counts: its messages wait for Undo or the purge, and stay visible meanwhile (R1).
      .filter((se) => se.threadId === conv && !se.archived)
      .map((se) => ({ se, n: entriesFor(se.id).length }))
      .filter((x) => x.n > 0)
  );
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
  // One button, kept: its label changes in place, so it keeps focus through a repaint (F1).
  let button = container.querySelector('.queue-waiting');
  if (!button) {
    const text = h('span.queue-waiting-text');
    button = h(
      'button.btn.sm.ghost.queue-waiting',
      {
        type: 'button',
        onclick: () => {
          const now = waitingIn(threadId);
          if (now.length === 1) return openQueue(now[0].se.id, button);
          openMenu(button, now.map(({ se }) => agentQueueMenuItem(se, button)).filter(Boolean), { label: 'Queued messages' });
        },
      },
      icon('mail', 'i-sm'),
      text,
    );
    container.replaceChildren(button);
  }
  button.setAttribute('aria-haspopup', waiting.length === 1 ? 'dialog' : 'menu');
  const text = button.querySelector('.queue-waiting-text');
  if (text.textContent !== label) text.textContent = label;
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
