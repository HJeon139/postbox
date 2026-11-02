// The ring and the status words (“· thinking”) on an agent’s speaker lines in a transcript (#622). Only those on the
// line of its latest reply (latestReply, speaker-line.mjs) follow its session: the ring moves and is the button to what
// the agent needs, and the words say what it’s doing while it isn’t idle. The rings on its earlier lines rest: they say
// only whose they are, with no state or context, and their words are empty. So a session change draws one ring and
// one word, not one of each for every reply the agent ever wrote.

import { client } from './client.mjs';
import { h } from './dom.mjs';
import { restRing, ringFor, stateWord } from './ring.mjs';
import { latestReply } from './speaker-line.mjs';

/** Puts the session’s state in words on a line that follows it, and empties the words on one that doesn’t. */
function paintWord(el, se, follows) {
  const text = follows && se.state !== 'idle' ? `· ${stateWord(se.state).toLowerCase()}` : '';
  if (el.textContent !== text) el.textContent = text;
  return el;
}

/**
 * A speaker line’s ring and words for a message, as it’s drawn: following the session on its latest reply, resting
 * on any other.
 * @param {any} it  the message @param {any} se  its session @param {string} threadId  the transcript’s thread
 */
export function replyLine(it, se, threadId) {
  const follows = latestReply(threadId, se.id) === it.id;
  const ring = ringFor(se, 'xs');
  ring.dataset.session = se.id;
  if (!follows) restRing(ring);
  const word = paintWord(h('span.who-state', { dataset: { session: se.id }, 'aria-live': 'off' }), se, follows);
  return { ring, word };
}

/**
 * Paints one session’s speaker lines in a transcript: the latest reply’s follows it, and any other that does rests.
 * It looks up only those that show the session, never one per reply.
 * @param {HTMLElement} root  the transcript @param {any} se  the session
 */
function paintLines(root, se) {
  const id = CSS.escape(se.id);
  const latest = latestReply(root.dataset.thread ?? '', se.id);
  const line = latest ? root.querySelector(`:scope > [data-key="${CSS.escape(latest)}"] .who`) : null;
  for (const r of root.querySelectorAll(`.who pb-ring[data-session="${id}"]:not([state="rest"])`)) if (!line?.contains(r)) restRing(r);
  for (const w of root.querySelectorAll(`.who-state[data-session="${id}"]:not(:empty)`)) if (!line?.contains(w)) paintWord(w, se, false);
  const ring = line?.querySelector(`pb-ring[data-session="${id}"]`);
  if (ring) ringFor(se, 'xs', ring);
  const word = line?.querySelector('.who-state');
  if (word) paintWord(word, se, true);
}

/** The session whose lines a change can move: its own change, or a new or moved message of its. @param {any} ch */
function sessionOf({ type, data: d }) {
  if (type === 'session') return d;
  const it = type === 'item.add' ? d.item : type === 'item.move' ? client.state.items[d.threadId]?.find((x) => x.id === d.id) : null;
  return it?.sessionId ? client.state.sessions[it.sessionId] : null;
}

// A message drawn again draws its line as it should be (replyLine); a session’s change, or a new or moved message,
// can move which of its lines follows it, in every transcript showing it.
client.on((ch) => {
  const se = sessionOf(ch);
  if (se) for (const root of document.querySelectorAll('.transcript[data-thread]')) paintLines(/** @type {HTMLElement} */ (root), se);
});
