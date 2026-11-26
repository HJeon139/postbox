// The way to an agent’s queue from the room’s form in the main menu (app/js/rooms-tab.mjs, #427): a button in the
// Members list’s bar for the agent picked. Where the sidebar is hidden, the form is the way to a queue.

import { openQueue, queuedFor } from './agent-queue.mjs';
import { h } from './dom.mjs';
import { onChangeWhileAlive } from './held-weakly.mjs';

/** The room form’s queue button as the queue stands: its count in words, and off, saying why, while nothing waits. */
function paintMemberQueue(/** @type {HTMLElement} */ button, /** @type {any} */ session) {
  const count = queuedFor(session.id);
  const words = `${count} message${count === 1 ? '' : 's'} queued`;
  const off = count ? '' : `No messages are waiting for ${session.handle}.`;
  if (button.textContent !== words) button.textContent = words;
  button.setAttribute('aria-label', `${words} for ${session.handle}`);
  button.setAttribute('aria-disabled', String(!count));
  if (off) button.setAttribute('aria-description', off);
  else button.removeAttribute('aria-description');
  button.title = off;
}

/** The listener of a button in the room’s form: made here, so it closes over nothing that holds the button (#866). */
function followMemberQueue(/** @type {any} */ session) {
  return (/** @type {HTMLElement} */ b, /** @type {any} */ change) => {
    if (['load', 'thread', 'session', 'entry.add', 'entry.patch'].includes(change.type)) paintMemberQueue(b, session);
  };
}

/**
 * The way to an agent’s queue from the room’s form, in its Members list’s bar (#427): where the sidebar is hidden, the
 * form is the way there. It follows the queue as the sidebar’s mail button does, and stays in the bar, dimmed and
 * saying why, while nothing waits: gone, it would move the bar’s controls and drop focus under the sheet. Its words
 * leave the handle to the row picked and to its name, so the longest handle fits a narrow sheet.
 * @param {any} session
 */
export function memberQueueButton(session) {
  const button = h('button.btn.sm.member-queue', {
    type: 'button',
    'aria-haspopup': 'dialog',
    onclick: () => button.getAttribute('aria-disabled') === 'true' || openQueue(session.id, button),
  });
  paintMemberQueue(button, session);
  onChangeWhileAlive(button, followMemberQueue(session));
  return button;
}
