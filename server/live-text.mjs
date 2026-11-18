// A running reply’s words, live (designs/architecture/live-progress.md, “Commit points”): Turns’ module, beside
// server/live-buffer.mjs. Each delta goes to the pages as a text frame with `at`, where its words start in the part’s
// text, and the words are stored only at a commit point, as one item.text with `at`: a step of the agent’s own
// (liveCommit), the part settling (the store’s settle hook, before threads.mjs’s patch), LIVE_TEXT.everyMs with no
// commit point, LIVE_TEXT.most of words, or the turn’s end (liveEnd). `at` lets a page that has the words live, or part
// of them, apply the stored chunk once (shared/state.mjs, item.text). The words ride on the turn (turn.liveText), one
// part at a time: a part settles, or the next words go to another, and its words are stored first.

import { LIVE_TEXT } from '../shared/limits.mjs';
import { committed } from './live-sent.mjs';
import { onItemSettle, sendLive } from './store-live.mjs';

/** The stores whose settling replies the turns’ words follow (watchSettles). */
const watched = new WeakSet();

/**
 * A reply about to settle stores the words a running turn holds for it, before its patch. Followed once a store.
 * @param {any} rt
 */
function watchSettles(rt) {
  if (watched.has(rt.store)) return;
  watched.add(rt.store);
  onItemSettle(rt.store, (_threadId, id) => {
    for (const turn of rt.running?.all?.() ?? []) if (turn.liveText?.itemId === id) commitText(rt, turn);
  });
}

/**
 * A delta of the turn’s words: kept, sent live with where it starts, and stored early when the words held reach
 * LIVE_TEXT.most. Words in another part than those held store those first.
 * @param {any} rt @param {any} turn @param {string} itemId  the part @param {number} at  where the delta starts in it
 * @param {string} delta
 */
export function liveText(rt, turn, itemId, at, delta) {
  watchSettles(rt);
  if (turn.liveText && turn.liveText.itemId !== itemId) commitText(rt, turn);
  if (!turn.liveText) {
    const timer = setTimeout(() => commitText(rt, turn), LIVE_TEXT.everyMs);
    timer.unref?.();
    turn.liveText = { itemId, at, text: '', timer };
  }
  turn.liveText.text += delta;
  sendLive(rt.store, { kind: 'text', threadId: turn.threadId, itemId, at, text: delta });
  if (turn.liveText.text.length >= LIVE_TEXT.most) commitText(rt, turn);
}

/**
 * A commit point of the words: the ones held go to the store as one item.text, with where they start, and a page that
 * had them all live isn’t sent it (server/live-sent.mjs). @param {any} rt @param {any} turn
 */
export function commitText(rt, turn) {
  const words = turn.liveText;
  if (!words) return;
  clearTimeout(words.timer);
  turn.liveText = null;
  if (!words.text) return;
  const data = { threadId: turn.threadId, id: words.itemId, text: words.text, at: words.at };
  committed.add(data);
  rt.store.emit('item.text', data);
}

/** The words held, for a snapshot: their part, where they start, and the words. @param {any} turn */
export function textSnapshot(turn) {
  const words = turn.liveText;
  return words?.text ? { itemId: words.itemId, at: words.at, text: words.text } : undefined;
}
