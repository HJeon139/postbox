// The status words beside agent names (“· thinking”), which follow their sessions as the rings do.

import { client } from './client.mjs';
import { stateWord } from './ring.mjs';

/**
 * Status words beside agent names: a <span class="who-state" data-session> gets “· thinking” and so on. In the
 * transcript (data-item set) it shows only on the agent’s latest message, and only while it’s busy or needs
 * you; elsewhere it always shows.
 */
function paintWord(el, se) {
  const live = se.state !== 'idle';
  const show = el.dataset.item ? live && latestItemOf(se) === el.dataset.item : true;
  const text = show ? `· ${stateWord(se.state).toLowerCase()}` : '';
  if (el.textContent !== text) el.textContent = text;
  if (el.dataset.item && text) shown.add(el);
  else shown.delete(el);
}

/** The transcript’s words showing now: with the latest reply’s and those outside it, all a session’s change can touch. */
const shown = new Set();

/**
 * One session’s words that can change (#622): those outside the transcript, the one on its latest reply, and any it
 * showed before. A long conversation has one beside each of its replies, and looking up every one was the cost.
 * @param {any} se
 */
function wordsOf(se) {
  const sel = `.who-state[data-session="${CSS.escape(se.id)}"]`;
  const latest = latestItemOf(se);
  const els = new Set(document.querySelectorAll(`${sel}:not([data-item])`));
  if (latest) for (const el of document.querySelectorAll(`${sel}[data-item="${CSS.escape(latest)}"]`)) els.add(el);
  for (const el of shown) if (el.dataset.session === se.id) els.add(el);
  return els;
}

const latestItemOf = (se) => {
  const list = client.state.items[se.threadId] ?? [];
  for (let i = list.length - 1; i >= 0; i--) if (list[i].sessionId === se.id && (list[i].kind === 'agent' || list[i].kind === 'block')) return list[i].id;
  return null;
};

let wordsFrame = 0;
let everyWord = false;
/** @type {Set<string>} */
const due = new Set();
/** Paints a session’s status words on the next frame, or with no session, every word in the page. @param {string} [sessionId] */
export const paintWords = (sessionId) => {
  if (sessionId) due.add(sessionId);
  else everyWord = true;
  cancelAnimationFrame(wordsFrame);
  wordsFrame = requestAnimationFrame(() => {
    const { sessions } = client.state;
    for (const el of shown) if (!el.isConnected) shown.delete(el);
    const els = everyWord ? document.querySelectorAll('.who-state[data-session]') : [...due].flatMap((id) => (sessions[id] ? [...wordsOf(sessions[id])] : []));
    everyWord = false;
    due.clear();
    for (const el of els) if (sessions[el.dataset.session]) paintWord(el, sessions[el.dataset.session]);
  });
};

/** What a change of the client’s repaints: a session’s own words, the words of a reply’s agent, or all of them. @param {any} ch */
export function wordsChanged(ch) {
  if (ch.type === 'load') paintWords();
  else if (ch.type === 'session') paintWords(ch.data.id);
  else if (ch.type === 'item.add' && ch.data.item?.sessionId) paintWords(ch.data.item.sessionId);
}
