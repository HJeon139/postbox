// Queued messages for one agent (#427): a counted mail button in its row, and a bounded dialog with each message’s actions.

import { api, client, itemIn } from './client.mjs';
import { h, icon, syncList } from './dom.mjs';
import { onChangeWhileAlive } from './held-weakly.mjs';
import { QueueItems } from './queue-items.mjs';
import { placeholderText, queuedText } from './queue-row-text.mjs';
import { openDialog, toast } from './ui.mjs';

export { paintOfflineQueue } from './offline-queue.mjs';

const S = () => client.state;

/**
 * What waits for an agent: its inbox’s waiting entries (#1404).
 * @param {string} sessionId @param {QueueItems | null} [items]  an open queue’s fetched items
 */
function entriesFor(sessionId, items = null) {
  return S().sessions[sessionId] ? waitingFor(sessionId, items) : [];
}

/**
 * An agent’s messages waiting in its inbox (designs/rooms-at-scale.md, “Delivery”), as rows of its queue, whose routes
 * act on the entry by its id: another agent’s, with the row a queued wake had, and the person’s own, which they can
 * edit (#1404). Each says what waits, by its source (queue-row-text.mjs). One whose words are an item the page hasn’t
 * loaded says so in `want`, which an open queue fetches while the row is in view (queue-items.mjs, #1456).
 * @param {string} sessionId @param {QueueItems | null} [items]  an open queue’s fetched items
 */
function waitingFor(sessionId, items = null) {
  const waiting = (S().inbox?.[sessionId] ?? []).filter((e) => e.state === 'waiting' && e.from && e.itemId);
  return waiting
    .filter((e) => S().threads[e.threadId])
    .map((e) => {
      const theirs = e.source === 'person';
      const item = itemIn(e.threadId, e.itemId) ?? items?.item(e.itemId);
      const text = queuedText(e, item);
      const want = text === null && !item ? { threadId: e.threadId, itemId: e.itemId } : null;
      const q = {
        id: e.id,
        kind: theirs ? 'message' : 'wake',
        from: e.from,
        text: text ?? placeholderText(e),
        want,
        itemId: e.itemId,
        sessionIds: [sessionId],
      };
      return { thread: S().threads[e.threadId], q };
    });
}

/**
 * One queued message’s row. Its parts are made once and updated in place by fillRow, so a repaint never replaces a
 * button that may hold focus (design-597-release-1, F1).
 */
function queuedMessageRow(entry, repaint, items) {
  const row = h('li.agent-queue-row');
  row._repaint = repaint;
  row._items = items;
  items.watch(row);
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
function fillRow(row, entry, at, of) {
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
  set(row.querySelector('.agent-queue-meta'), q.kind === 'wake' ? `From ${q.from} · ${thread.title}` : thread.title);
  // The text keeps a fixed height, clamped, so words that arrive later move nothing (#1456); the whole of it is its title.
  const text = row.querySelector('.agent-queue-text');
  set(text, q.text);
  if (text && text.title !== q.text) text.title = q.text;
  // Until its words come, Edit would open on the placeholder, and Save would put that in place of the message.
  const edit = row.querySelector('[data-action="edit"]');
  if (edit) edit.disabled = Boolean(q.want);
  const label = (action, text) => row.querySelector(`[data-action="${action}"]`)?.setAttribute('aria-label', text);
  label('send', `Send now: ${which}`);
  label('edit', `Edit ${which}`);
  label('remove', `Remove queued ${which}`);
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
  // The edit is the item’s now: a copy fetched before it is dropped, so the row shows the edit (#1456).
  const saved = () => {
    row._items.forget(q.itemId);
    done();
  };
  const save = () =>
    api(target, { text: input.value }, 'PATCH').then(saved, (e) => {
      toast({ title: 'Couldn’t edit', text: e.message });
      input.focus();
    });
  row.replaceChildren(input, h('div.row-flex', saveBtn, h('button.btn.sm.ghost', { type: 'button', onclick: done }, 'Cancel')));
  input.focus();
}

/** Rows being edited whose message left the queue: they stay, with a note to copy the draft (V4). */
function markMissing(list, entries) {
  const ids = new Set(entries.map((entry) => entry.q.id));
  const missing = [...list.children].filter((row) => row.dataset.editing && !ids.has(row.dataset.key));
  for (const row of missing)
    if (!row.querySelector('.agent-queue-missing'))
      row.append(h('p.err.agent-queue-missing', 'This message left the queue while you were editing. Copy your draft before closing it.'));
  return missing;
}

/** Which row and action hold focus in the list, before a repaint. */
function focusedSlot(list) {
  const row = [...list.children].find((x) => x.contains(document.activeElement));
  const action = document.activeElement?.closest?.('[data-action]')?.getAttribute('data-action');
  return row ? { row, action, at: [...list.children].indexOf(row) } : null;
}

/** A focused row that left (its Remove, or the server) hands focus to the same action in the row now in its place. */
function refocusSlot(list, slot) {
  if (!slot || slot.row.isConnected || !list.children.length) return;
  const row = list.children[Math.min(slot.at, list.children.length - 1)];
  /** @type {HTMLElement | null} */ (row.querySelector(`[data-action="${slot.action}"]`) ?? row.querySelector('button'))?.focus();
}

/**
 * Calls `fn` at most once a frame, however often it’s asked: a long queue’s fetched items and changes paint it once a
 * frame, not once each (#1456). `cancel` drops a call not made yet. @param {() => void} fn
 */
function oncePerFrame(fn) {
  let frame = 0;
  return {
    ask: () => {
      frame ||= requestAnimationFrame(() => {
        frame = 0;
        fn();
      });
    },
    cancel: () => cancelAnimationFrame(frame),
  };
}

/**
 * Puts an open queue’s rows in place and up to date, keeps focus where it was, and asks for the items of rows in view.
 * @param {HTMLElement} list @param {any[]} all @param {() => void} paint @param {QueueItems} items
 */
function paintRows(list, all, paint, items) {
  const slot = focusedSlot(list);
  syncList(
    list,
    all,
    (entry) => entry.q.id,
    (entry) => queuedMessageRow(entry, paint, items),
    () => {},
  );
  for (const [i, row] of [...list.children].entries()) {
    fillRow(row, all[i] ?? row._entry, i + 1, all.length);
    items.fill(row);
  }
  refocusSlot(list, slot);
}

/**
 * Asks an open queue to repaint on the changes that touch it. A listed message’s item changes when the person edits it;
 * any other item’s patch, a streaming reply’s, is left alone. @param {HTMLElement} list @param {() => void} repaint
 */
function followQueueChanges(list, repaint) {
  const listed = (/** @type {string} */ itemId) => [...list.children].some((row) => /** @type {any} */ (row)._entry?.q.itemId === itemId);
  return client.on((change) => {
    if (change.type === 'item.patch' ? listed(change.data.id) : ['load', 'thread', 'session', 'entry.add', 'entry.patch'].includes(change.type)) repaint();
  });
}

export function openQueue(sessionId, anchor = null) {
  const session = S().sessions[sessionId];
  if (!session) return;
  const title = h('span');
  const body = h('div.agent-queue-dialog');
  const list = h('ul.agent-queue-list');
  body.append(list);
  let dialog;
  const later = oncePerFrame(() => paint());
  const items = new QueueItems(later.ask);
  const paint = () => {
    // The agent is gone (deleted, or a retired fork): nothing here can be sent to it any more.
    const now = S().sessions[sessionId];
    if (!now || now.retiredFork) return dialog?.close();
    const entries = entriesFor(sessionId, items);
    const missing = markMissing(list, entries);
    const heading = `${entries.length} queued for ${session.handle}`;
    if (title.textContent !== heading) title.textContent = heading;
    if (!entries.length && !missing.length) {
      dialog?.close();
      return;
    }
    paintRows(list, [...entries, ...missing.map((row) => row._entry)], paint, items);
  };
  paint();
  dialog = openDialog({
    title,
    body: [body],
    anchor,
    initialFocus: () => body.querySelector('button:not([disabled])'),
    onClose: () => {
      later.cancel();
      items.close();
      off();
      anchor?.setAttribute('aria-expanded', 'false');
      // What opened it may be gone or hidden (the agent left, its last message went, the menu closed): focus goes to
      // the composer, never to nothing.
      if (!anchor?.isConnected || anchor.closest('[hidden]')) queueMicrotask(() => document.getElementById('composer-input')?.focus());
    },
  });
  const off = followQueueChanges(list, later.ask);
  anchor?.setAttribute('aria-expanded', 'true');
}

/** A queue button’s count and name, as the queue stands. @param {HTMLElement} button @param {any} session */
function paintQueueButton(button, session) {
  const count = entriesFor(session.id).length;
  button.hidden = count === 0;
  button.setAttribute('aria-label', `${count} message${count === 1 ? '' : 's'} queued for ${session.handle}`);
  // The count changes in place, so the button keeps focus through a repaint (F1).
  const countEl = button.querySelector('.agent-queue-count');
  if (countEl && countEl.textContent !== String(count)) countEl.textContent = String(count);
}

/**
 * A queue button’s listener: it repaints the button it’s given, and stops once the button, after being on the page,
 * leaves it. Made here, not beside the button, so it closes over nothing that holds the button (#866).
 * @param {any} session
 */
function followQueue(session) {
  let mounted = false;
  return (/** @type {HTMLElement} */ b, /** @type {any} */ change, /** @type {() => void} */ off) => {
    if (b.isConnected) mounted = true;
    else if (mounted) return off();
    if (['load', 'thread', 'entry.add', 'entry.patch'].includes(change.type)) paintQueueButton(b, session);
  };
}

export function agentQueueButton(session) {
  const button = h('button.btn.icon.sm.ghost.agent-queue-button', {
    type: 'button',
    'aria-haspopup': 'dialog',
    'aria-expanded': 'false',
    onclick: () => openQueue(session.id, button),
  });
  button.append(icon('mail', 'i-sm'), h('span.agent-queue-count', { 'aria-hidden': 'true' }));
  paintQueueButton(button, session);
  // Weakly: a button built and never put on the page, or taken off it, is let go of with its listener (#912, #866).
  onChangeWhileAlive(button, followQueue(session));
  return button;
}

/** The phone conversation menu’s route to an agent queue, or null when it has none. */
export function agentQueueMenuItem(session, anchor) {
  const count = entriesFor(session.id).length;
  return count
    ? {
        label: `${count} message${count === 1 ? '' : 's'} queued for ${session.handle}`,
        icon: 'mail',
        run: () => openQueue(session.id, anchor),
      }
    : null;
}
