// Which changes to a followed transcript the view must note at once, rather than at the frame’s one note (#866,
// #903): a change that shrinks the page can be undone before the frame, and only a read at the shrink sees the view at
// the shrunk end (#297). The notes themselves, taken for view-state.mjs’s follow(), moved here from it at its size limit.

import { atEnd, box } from './view-geometry.mjs';

/** @typedef {import('./view-state.mjs').View} View */

/**
 * Whether a batch takes nodes out and puts none in: a shrink the frame’s later note may not see, since the page can
 * grow again before it. Streaming removes and adds in each batch, so it doesn’t count: 0 of 111 batches over three
 * streamed replies, where a record-by-record test counted 105. O(records), with no reads of the page.
 * @param {MutationRecord[]} records
 */
export function onlyRemoves(records) {
  let removes = false;
  for (const r of records) {
    if (r.addedNodes.length) return false;
    if (r.removedNodes.length) removes = true;
  }
  return removes;
}
/** After a change in the transcript, while stuck: where the view is, if it’s at the page’s new end (#297). @param {View} v */
export function noteEnd(v) {
  const s = v.changed ? box(v) : null;
  v.changed = false;
  if (s && v.stuck && !v.dead && atEnd(s)) v.lastTop = Math.min(v.lastTop, s.scrollTop);
}
/**
 * A change in the transcript: the note is taken now, at most once a frame, and else by follow() after the frame’s
 * layout. One read per batch forced a layout of the whole page per batch: 823 in one 72 s freeze (#866). A batch that
 * only removes is noted at once whatever the frame (view-changes.mjs).
 * @param {View} v @param {MutationRecord[]} records
 */
export function changed(v, records) {
  v.changed = true;
  if (v.noted && !onlyRemoves(records)) return;
  v.noted ||= requestAnimationFrame(() => (v.noted = 0));
  noteEnd(v);
}
/**
 * An item drawn again whole, as a finished reply is: it may come out shorter, and the page may grow back before the
 * frame (#297), so the note is taken now, while it’s short. Once per redraw, not per streamed delta (#903).
 * @param {View} v
 */
export function redrawn(v) {
  v.changed = true;
  noteEnd(v);
}
