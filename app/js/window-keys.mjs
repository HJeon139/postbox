// Home and End over a long conversation (#866). The browser scrolls there smoothly, and the window’s first mount on
// the way writes the scroll position, which ends that scroll a little way along. So while the page has the keys
// (focus on nothing in particular, not in a field or on a control), the window takes them itself: the range moves to
// the first or the newest item, and the view goes there at once.

/** Where the last click or touch was: Home and End belong to the scroll container it was in. @type {Element | null} */
let lastDown = null;
document.addEventListener('pointerdown', (e) => (lastDown = e.target instanceof Element ? e.target : null), true);

/** Whether el sits in a scroll container of its own, below the page: a side panel, a table, a dialog. @param {Element} el */
function inOtherScroller(el) {
  for (let n = /** @type {Element | null} */ (el); n && n !== document.body && n !== document.documentElement; n = n.parentElement) {
    const overflow = getComputedStyle(n).overflowY;
    if ((overflow === 'auto' || overflow === 'scroll') && n.scrollHeight > n.clientHeight) return true;
  }
  return false;
}

/** Whether a key press is the page’s own Home or End, not a field’s, a control’s or another scroll container’s. @param {KeyboardEvent} e */
const pageEdgeKey = (e) =>
  (e.key === 'Home' || e.key === 'End') &&
  !(e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) &&
  (e.target === document.body || e.target === document.documentElement) &&
  !(lastDown && inOtherScroller(lastDown));

/**
 * The range moves to the first or the newest item, and the view to the top or the end. Past what the page has loaded
 * (#1155), the conversation’s first or latest range is loaded first, and the window drawn again with it moves there.
 * @param {Set<any>} windows @param {any} w the window @param {boolean} last
 */
async function toEdge(windows, w, last) {
  const side = last ? 'after' : 'before';
  if (w.edges?.more(side)) {
    await w.edges.edge(side);
    w = [...windows].find((x) => !x.inPanel);
    if (!w) return;
  }
  const id = last ? w.entry.ids.at(-1) : w.entry.ids[0];
  if (id) w.reach(id);
  const box = /** @type {Element} */ (w.inPanel ? w.el.parentElement : document.scrollingElement);
  // Your own move: its scroll event tells the view so, and Home stops it following (view-state.mjs, onScroll).
  box.scrollTop = last ? box.scrollHeight : 0;
}

/** Listens for the page’s Home and End, for the main pane’s window among `windows`. @param {Set<any>} windows */
export function edgeKeys(windows) {
  document.addEventListener('keydown', (e) => {
    if (!pageEdgeKey(e)) return;
    const w = [...windows].find((x) => !x.inPanel);
    if (!w) return;
    e.preventDefault();
    void toEdge(windows, w, e.key === 'End');
  });
}
