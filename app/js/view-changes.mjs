// Which changes to a followed transcript the view must note at once, rather than at the frame’s one note (#866,
// #903): a change that shrinks the page can be undone before the frame, and only a read at the shrink sees the view at
// the shrunk end (#297).

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
