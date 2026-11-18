// A running reply’s words, in windows (designs/architecture/live-progress.md, “Text in windows”): a turn holds its
// deltas and stores them as one item.text when its window of LIVE_TEXT.windowMs ends, then holds the next. The owner
// decided on 17 November 2026 to send a turn’s words at a fixed rate and only to open pages: the stored item.text
// reaches every stream with its conversation open as its numbered event, and every other stream as a cursor, as any
// item event does, so a page is never ahead of its stream and nothing but the log carries the words.
// The words held are stored early, so what reads them reads them whole and in order: before a step the page is sent
// (a step’s `at` places it among the words before it), before a part settles (item.final, and the mentions in its last
// words, server/threads.mjs), when the words go to another part, and at the turn’s end.

import { LIVE_TEXT } from '../shared/limits.mjs';
import { onItemSettle } from './store-live.mjs';

/** The stores whose settling replies the turns’ words follow (watchSettles). */
const watched = new WeakSet();

/** A reply about to settle stores the words a running turn holds for it, before its patch. Once a store. @param {any} rt */
function watchSettles(rt) {
  if (watched.has(rt.store)) return;
  watched.add(rt.store);
  onItemSettle(rt.store, (_threadId, id) => {
    for (const turn of rt.running?.all?.() ?? []) if (turn.liveText?.itemId === id) storeText(rt, turn);
  });
}

/**
 * A delta of the turn’s words in a part: held until its window ends. Words in another part than those held store
 * those first. @param {any} rt @param {any} turn @param {string} itemId @param {string} delta
 */
export function liveText(rt, turn, itemId, delta) {
  watchSettles(rt);
  if (turn.liveText && turn.liveText.itemId !== itemId) storeText(rt, turn);
  if (turn.liveText) {
    turn.liveText.text += delta;
    return;
  }
  // A window opens with its first words, and its timer goes when they’re stored, at its end or early.
  const timer = setTimeout(() => storeText(rt, turn), LIVE_TEXT.windowMs);
  timer.unref?.();
  turn.liveText = { itemId, text: delta, timer };
}

/** The words held, stored as one item.text, as the window ends or early. @param {any} rt @param {any} turn */
export function storeText(rt, turn) {
  const words = turn.liveText;
  if (!words) return;
  clearTimeout(words.timer);
  turn.liveText = null;
  rt.store.emit('item.text', { threadId: turn.threadId, id: words.itemId, text: words.text });
}
