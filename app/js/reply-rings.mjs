// The ring and the status words (“· thinking”) on an agent’s speaker lines in a transcript (#622). Only those on the
// line of its latest reply (latestReply, speaker-line.mjs) follow its session: the ring moves and is the button to what
// the agent needs, and the words say what it’s doing while it isn’t idle. The rings on its earlier lines rest: they say
// only whose they are, with no state or context, and their words are empty. So a session change draws one ring and
// one word, not one of each for every reply the agent ever wrote.

import { client, itemIn } from './client.mjs';
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
  if (follows) followersOf(se.id).add({ ring, word, threadId, itemId: it.id });
  return { ring, word };
}

// The lines that follow each session, as drawn: at most one in each transcript showing it. A session event paints these
// and nothing else, with no query over the page or a transcript (#564-b1). The latest reply changes only when an item
// does, and then a line that no longer is the latest rests and leaves the list, and the new one joins as it’s drawn.
/** @typedef {{ ring: Element, word: Element, threadId: string, itemId: string }} Follower */
/** @type {Map<string, Set<Follower>>} */
const followers = new Map();
/** @param {string} sessionId */
function followersOf(sessionId) {
  let set = followers.get(sessionId);
  if (!set) followers.set(sessionId, (set = new Set()));
  return set;
}
/** One that was on the page and has left it; one drawn but not placed yet stays. @type {WeakSet<Element>} */
const placed = new WeakSet();

/**
 * Paints the lines that follow a session: each that is still its latest reply follows it, and one that isn’t any more
 * rests and leaves the list. O(the lines that follow it), one in each transcript showing it.
 * @param {any} se  the session
 */
function paintLines(se) {
  const set = followers.get(se.id);
  if (!set) return;
  for (const f of set) {
    if (f.ring.isConnected) placed.add(f.ring);
    if (!f.ring.isConnected && placed.has(f.ring)) set.delete(f);
    else if (latestReply(f.threadId, se.id) === f.itemId) {
      ringFor(se, 'xs', f.ring);
      paintWord(f.word, se, true);
    } else {
      restRing(f.ring);
      paintWord(f.word, se, false);
      set.delete(f);
    }
  }
}

/** The session whose lines a change can move: its own change, or a new or moved message of its. @param {any} ch */
function sessionOf({ type, data: d }) {
  if (type === 'session') return d;
  const it = movedOrAdded(type, d);
  return it?.sessionId ? client.state.sessions[it.sessionId] : null;
}

/** The message a change adds or moves, or null. @param {string} type @param {any} d */
function movedOrAdded(type, d) {
  if (type === 'item.add') return d.item;
  if (type === 'item.move') return itemIn(d.threadId, d.id);
  return null;
}

// A message drawn again draws its line as it should be (replyLine); a session’s change, or a new or moved message,
// can move which of its lines follows it, in every transcript showing it.
client.on((ch) => {
  const se = sessionOf(ch);
  if (se) paintLines(se);
});
