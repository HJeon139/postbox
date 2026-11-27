// Each transcript item’s place, for a screen reader (#1048). With items off screen skipped (view-skip.mjs), Chromium
// keeps no accessibility tree for a skipped item’s contents until it draws. Its box is in the tree, skipped or not, and
// focusing it (Alt+↑/↓, keys.mjs) draws it. Each main-pane item is an article named by its own words (asArticle), and
// carries aria-posinset and aria-setsize, “4 of 496”, among the shown items (countItems). Only while every item is
// mounted: the window (#866) mounts the items near the view, so their places among the mounted ones would be wrong.

/** How many items asArticle has made, for ids no two drawings share. */
let drawn = 0;

/**
 * Makes a main-pane item an article before it’s on the page, as it’s built (thread.mjs, render): written once it’s
 * mounted, the role would restyle it. An article is named only by its author, so it’s labeled by itself: focused,
 * it draws, and a reader hears its words, as it did before it was an article. A skipped item’s name is empty until it
 * draws, as its contents are. A card that is already a group keeps its role and its own name.
 * @param {HTMLElement} node  the item  @param {string} key  its item id
 */
export function asArticle(node, key) {
  if (node.hasAttribute('role')) return;
  node.setAttribute('role', 'article');
  // An id of this drawing only: one shared with the node it replaces would move focus onto the new one when an item is
  // drawn again or moved (rerender-state.mjs, holdFocus), which items never did.
  node.id = `item-${key}-${++drawn}`;
  node.setAttribute('aria-labelledby', node.id);
}

/** Transcripts already counted: a view built again on the same one adds no second observer. */
const counting = new WeakSet();

/**
 * Keeps each shown item of the transcript at its place among them, as items come and go. An item that comes to draw
 * nothing is a new, hidden node (thread.mjs, render), so watching the children is enough: nothing hides one in place.
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
      // A card that is already a group (a permission, an ask to see an app) is no article (asArticle): it keeps its place
      // in the count, which a group can’t carry, and the articles around it still count it.
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
