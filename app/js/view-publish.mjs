// What the transcript’s view is, written on it for anyone to read, moved out of view-state.mjs at its size limit.

/** @typedef {import('./view-state.mjs').View} View */

/**
 * What the view is, on the transcript for anyone to read (the UAT’s probe, #531): data-view-mode is following or
 * reading, and while reading, data-view-anchor and data-view-offset are the anchor’s key and how far down the view it
 * starts, to 0.1 px: where it is (shown) when a hold left it off the place it holds (view-state.mjs, holdAnchor).
 * data-view-moving is to-end while the smooth jump to the end runs: the view says following at once, but it reaches the
 * end only once the jump ends, and a slow machine can start the scroll frames after it’s asked for, so a reader that
 * waits for the page to hold still waits for this too (tools/page-still.mjs, #1238). Written after each entry point,
 * and only what changed.
 * @param {View} v
 */
export function publish(v) {
  const reading = !v.stuck && v.anchor;
  const next = {
    viewMode: v.stuck ? 'following' : 'reading',
    viewAnchor: reading ? v.anchor.key : '',
    viewOffset: reading ? String(Math.round((v.anchor.shown ?? v.anchor.at) * 10) / 10) : '',
    viewMoving: v.smoothing ? 'to-end' : '',
  };
  for (const [k, value] of Object.entries(next)) if (v.el.dataset[k] !== value) v.el.dataset[k] = value;
}
