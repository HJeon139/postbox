// Each transcript item’s place, for a screen reader (#1048). With items off screen skipped (view-skip.mjs), Chromium
// keeps no accessibility tree for a skipped item’s contents, so a reader reached only the items that had drawn. The
// item’s own box isn’t skipped: as an article with aria-posinset and aria-setsize, each item is reached and says where
// it is among them, “4 of 496”, and Alt+↑/↓ (keys.mjs) reaches each in turn. Only while every item is mounted: the
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
    const held = Boolean(el.dataset.window);
    const shown = [...el.children].filter((n) => n.classList.contains('item') && !(/** @type {HTMLElement} */ (n).hidden));
    const of = String(shown.length);
    // Only what changed is written: an append changes every item’s count, and nothing else.
    shown.forEach((n, i) => {
      // A card that is already a group (a permission, an ask to see an app) keeps its role, and its place in the count,
      // which a group can’t carry: the articles around it still count it.
      if (!n.hasAttribute('role')) n.setAttribute('role', 'article');
      const at = String(i + 1);
      if (held || n.getAttribute('role') !== 'article') {
        // Held by the window, a node it kept from the whole room (a running app, the focused item) loses its place.
        n.removeAttribute('aria-posinset');
        n.removeAttribute('aria-setsize');
        return;
      }
      if (n.getAttribute('aria-posinset') !== at) n.setAttribute('aria-posinset', at);
      if (n.getAttribute('aria-setsize') !== of) n.setAttribute('aria-setsize', of);
    });
  };
  // Only items coming or going among the transcript’s own children: what streams inside an item changes no place, an
  // item drawn again (as one that draws nothing too) is a new node, and the working rows re-appended at the end aren’t
  // items.
  const isItem = (/** @type {Node} */ n) => n instanceof Element && n.classList.contains('item');
  new MutationObserver((records) => {
    if (queued || !records.some((r) => [...r.addedNodes, ...r.removedNodes].some(isItem))) return;
    queued = true;
    queueMicrotask(place);
  }).observe(el, { childList: true });
  place();
}
