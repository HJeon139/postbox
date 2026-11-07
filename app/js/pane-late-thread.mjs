// A thread the address names before the page has it (#887). Reply in thread goes to its new topic thread’s address
// as soon as the server answers, and the thread’s own event can reach the page after that, when the pane has already
// found nothing to open. The pane opens it when that event lands, if the address still names it, and moves focus to
// its composer only if focus is still where the click left it.

import { client, S } from './client.mjs';
import { route } from './ui.mjs';

/**
 * Listens for the thread a conversation’s address names while its pane has none open.
 * @param {string} convId  the conversation
 * @param {{ mounted: () => boolean, set: (r: any) => void }} pane  whether a thread is open there, and how to open the address’s
 * @returns {() => void}  stops listening
 */
export function openLateThread(convId, pane) {
  return client.on((change) => {
    if (change.type !== 'thread' && change.type !== 'load') return;
    if (pane.mounted()) return;
    const r = route();
    if (r.threadId !== convId || !r.sideId) return;
    if (change.type === 'thread' && change.data.id !== r.sideId) return;
    const untouched = focusUntouched(r.sideId);
    pane.set(r);
    if (untouched && pane.mounted()) document.getElementById('side-input')?.focus();
  });
}

/**
 * Whether focus is where Reply in thread left it: on the page, or on the message the thread starts from. Checked by
 * where it is, not by the button: the message may have been drawn again meanwhile.
 * @param {string} sideId
 */
function focusUntouched(sideId) {
  const at = document.activeElement;
  if (!at || at === document.body) return true;
  const rootItemId = S().threads[sideId]?.rootItemId;
  return !!rootItemId && !!at.closest(`[data-key="${CSS.escape(rootItemId)}"]`);
}
