// Home and End over a long conversation (#866). The browser scrolls there smoothly, and the window’s first mount on
// the way writes the scroll position, which ends that scroll a little way along. So while the page has the keys
// (focus on nothing in particular, not in a field or on a control), the window takes them itself: the range moves to
// the first or the newest item, and the view goes there at once.

/** Whether a key press is the page’s own Home or End, not a field’s or a control’s. @param {KeyboardEvent} e */
const pageEdgeKey = (e) =>
  (e.key === 'Home' || e.key === 'End') &&
  !(e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) &&
  (e.target === document.body || e.target === document.documentElement);

/**
 * The range moves to the first or the newest item, and the view to the top or the end.
 * @param {any} w the window @param {boolean} last
 */
function toEdge(w, last) {
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
    toEdge(w, e.key === 'End');
  });
}
