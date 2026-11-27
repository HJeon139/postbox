// Each transcript item’s place, for a screen reader (#1048). With items off screen skipped (view-skip.mjs), Chromium
// keeps no accessibility tree for a skipped item’s contents, so a reader reached only the items that had drawn. The
// item’s own box isn’t skipped: as an article with aria-posinset and aria-setsize, each item is reached and says where
// it is among them, “4 of 496”, and focusing one (Alt+↑/↓, keys.mjs) draws it. Only while every item is mounted: the
// window (#866) mounts the items near the view, so their places among the mounted ones would be wrong.

/** Transcripts already counted: a view built again on the same one adds no second observer. */
const counting = new WeakSet();

/**
 * Keeps each shown item of the transcript an article at its place among them, as items come, go, or are hidden.
 * @param {HTMLElement} el  the transcript
 */
export function countItems(el) {
  if (counting.has(el)) return;
  counting.add(el);
  let queued = false;
  const place = () => {
    queued = false;
    // The window takes hold only as a transcript is built, from new nodes (window.mjs, build), so none keeps a place.
    const held = Boolean(el.dataset.window);
    const shown = [...el.children].filter((n) => n.classList.contains('item') && !(/** @type {HTMLElement} */ (n).hidden));
    const of = String(shown.length);
    // Only what changed is written: an append changes every item’s count, and nothing else.
    shown.forEach((n, i) => {
      if (n.getAttribute('role') !== 'article') n.setAttribute('role', 'article');
      if (held) return;
      const at = String(i + 1);
      if (n.getAttribute('aria-posinset') !== at) n.setAttribute('aria-posinset', at);
      if (n.getAttribute('aria-setsize') !== of) n.setAttribute('aria-setsize', of);
    });
  };
  // Only the transcript’s own children, not its subtree: what streams inside an item changes no place, and an item drawn
  // again, as one that draws nothing too, is a new node.
  new MutationObserver(() => {
    if (queued) return;
    queued = true;
    queueMicrotask(place);
  }).observe(el, { childList: true });
  place();
}
