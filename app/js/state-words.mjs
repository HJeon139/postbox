// The status words beside agent names (“· thinking”), which follow their sessions as the rings do.

import { client } from './client.mjs';
import { stateWord } from './ring.mjs';

/**
 * Status words beside agent names: a <span class="who-state" data-session> gets “· thinking” and so on. In the
 * transcript (data-item set) it shows only on the agent’s latest message, and only while it’s busy or needs
 * you; elsewhere it always shows.
 */
function paintStateWords(root, sessions, latestItemOf) {
  for (const el of root.querySelectorAll('.who-state[data-session]')) {
    const se = sessions[el.dataset.session];
    if (!se) continue;
    const live = se.state !== 'idle';
    const show = el.dataset.item ? live && latestItemOf(se) === el.dataset.item : true;
    const text = show ? `· ${stateWord(se.state).toLowerCase()}` : '';
    if (el.textContent !== text) el.textContent = text;
  }
}

const latestItemOf = (se) => {
  const list = client.state.items[se.threadId] ?? [];
  for (let i = list.length - 1; i >= 0; i--) if (list[i].sessionId === se.id && (list[i].kind === 'agent' || list[i].kind === 'block')) return list[i].id;
  return null;
};
let wordsFrame = 0;
/** Paints the page’s status words on the next frame. */
export const paintWords = () => {
  cancelAnimationFrame(wordsFrame);
  wordsFrame = requestAnimationFrame(() => paintStateWords(document, client.state.sessions, latestItemOf));
};
