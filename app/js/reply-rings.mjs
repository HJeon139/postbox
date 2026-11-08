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
  if (follows) followersOf(se.id).add(follower(ring, word, threadId, it.id));
  return { ring, word };
}

// The lines that follow each session, as drawn: at most one in each transcript showing it. A session event paints these
// and nothing else, with no query over the page or a transcript (#564-b1). The latest reply changes only when an item
// does. Then a line that no longer is the latest rests and leaves the list, and the transcript’s new latest line joins:
// drawn later, as replyLine draws it, or already there, when the latest went back to an earlier reply (one replaced).
// Its ring and words are held weakly (held-weakly.mjs): a line whose transcript has left the page, and isn’t kept to
// show again, is let go of, not kept with its whole old page (#866).
/** @typedef {{ ring: WeakRef<Element>, word: WeakRef<Element>, threadId: string, itemId: string }} Follower */
/** @param {Element} ring @param {Element} word @param {string} threadId @param {string} itemId @returns {Follower} */
const follower = (ring, word, threadId, itemId) => ({ ring: new WeakRef(ring), word: new WeakRef(word), threadId, itemId });
/** @type {Map<string, Set<Follower>>} */
const followers = new Map();
/** How many lines a session’s list holds before it lets go of those off the page. */
const KEEP = 8;
/** @param {string} sessionId */
function followersOf(sessionId) {
  let set = followers.get(sessionId);
  if (!set) followers.set(sessionId, (set = new Set()));
  return set;
}

/** The speaker line of the transcript’s item `key`, looked for from the end, where the latest replies are. */
function lineOf(root, key) {
  for (let n = root.lastElementChild; n; n = n.previousElementSibling) {
    if (n instanceof HTMLElement && n.dataset.key === key) return n.querySelector('.who');
  }
  return null;
}

/**
 * The transcript’s latest line for the session, when it’s already drawn, made to follow it and put on the list.
 * @param {Element | null} root  the transcript @param {string} threadId @param {any} se
 */
function promote(root, threadId, se) {
  const key = latestReply(threadId, se.id);
  const line = root && key ? lineOf(root, key) : null;
  const id = CSS.escape(se.id);
  const ring = line?.querySelector(`pb-ring[data-session="${id}"]`);
  const word = line?.querySelector(`.who-state[data-session="${id}"]`);
  if (!ring || !word || !key) return;
  ringFor(se, 'xs', ring);
  paintWord(word, se, true);
  followersOf(se.id).add(follower(ring, word, threadId, key));
}

/**
 * Paints the lines that follow a session: each that is still its latest reply follows it; one that isn’t any more
 * rests and leaves the list, and its transcript’s latest line, if drawn, takes its place. O(the lines that follow it)
 * on a session event.
 * @param {any} se  the session
 */
function paintLines(se) {
  const set = followers.get(se.id);
  if (!set) return;
  // A line off the page is skipped, not painted; it may come back (a transcript kept to show again). Only a long list
  // lets go of those, so lines from transcripts gone for good don’t pile up.
  if (set.size > KEEP) for (const f of set) if (!f.ring.deref()?.isConnected) set.delete(f);
  for (const f of [...set]) {
    const ring = f.ring.deref();
    const word = f.word.deref();
    // Let go of by the page: nothing is left to paint.
    if (!ring || !word) set.delete(f);
    else if (!ring.isConnected) continue;
    else if (latestReply(f.threadId, se.id) === f.itemId) {
      ringFor(se, 'xs', ring);
      paintWord(word, se, true);
    } else {
      restRing(ring);
      paintWord(word, se, false);
      set.delete(f);
      promote(ring.closest('.transcript'), f.threadId, se);
    }
  }
}

/** The session whose lines a change can move: its own change, or a new, moved or patched message of its. @param {any} ch */
function sessionOf({ type, data: d }) {
  if (type === 'session') return d;
  // A patch can change which reply names its speaker (a reply replaced), before the transcript draws it again.
  const it = type === 'item.patch' ? itemIn(d.threadId, d.id) : movedOrAdded(type, d);
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
