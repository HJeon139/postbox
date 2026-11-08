// What the transcript’s view is, written on it for anyone to read, moved out of view-state.mjs at its size limit.

/** @typedef {import('./view-state.mjs').View} View */

/**
 * What the view is, on the transcript for anyone to read (the UAT’s probe, #531): data-view-mode is following or
 * reading, and while reading, data-view-anchor and data-view-offset are the anchor’s key and how far down the view it
 * starts, to 0.1 px. Written after each entry point, and only what changed.
 * @param {View} v
 */
export function publish(v) {
  const reading = !v.stuck && v.anchor;
  const next = {
    viewMode: v.stuck ? 'following' : 'reading',
    viewAnchor: reading ? v.anchor.key : '',
    viewOffset: reading ? String(Math.round(v.anchor.at * 10) / 10) : '',
  };
  for (const [k, value] of Object.entries(next)) if (v.el.dataset[k] !== value) v.el.dataset[k] = value;
}
