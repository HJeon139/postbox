// Home and End over the conversation. The browser scrolls there smoothly, and in a long room the window’s first mount
// on the way writes the scroll position, which ends that scroll a little way along (#866); in a short room, twice on
// CI’s Linux runner, that scroll moved nothing at all (#1884). So while the page has the keys (focus not in a field, a
// widget of its own or another scroll container), the page takes them itself, in every room: a long room’s range moves
// to the first or the newest item, and the view goes there at once.

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

/**
 * Whether the person is in a scroller of its own within scope: focus is in one, or their last click or touch was.
 * @param {Element} target @param {Node} scope
 */
const inScroller = (target, scope) => inOtherScroller(target) || (!!lastDown && scope.contains(lastDown) && inOtherScroller(lastDown));

/** Where Home and End move a caret or a choice: a field. */
const FIELDS = 'input, textarea, select, [contenteditable]';
/** Where Home and End are the element's own: a field, or a widget that moves its own selection with them. */
const OWN_KEYS = `${FIELDS}, [role="listbox"], [role="menu"], [role="menubar"], [role="tablist"], [role="tree"], [role="grid"], [role="slider"], [role="spinbutton"]`;

/** Home or End alone, on an element: Ctrl+Home, Shift+End and the rest stay the browser’s. @param {KeyboardEvent} e */
const edgeKey = (e) => (e.key === 'Home' || e.key === 'End') && !(e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) && e.target instanceof Element;

/**
 * Whether a key press is the page’s own Home or End, not a field’s, a widget’s or another scroll container’s: with
 * focus on the page, the transcript (a click there, #1155’s UAT) or a button or link, where the browser scrolls the page.
 * @param {KeyboardEvent} e
 */
const pageEdgeKey = (e) => {
  const target = /** @type {Element} */ (e.target);
  return !target.closest(OWN_KEYS) && !inScroller(target, document);
};

/** The dialog focus is in, else the top one open over the page, else null. @param {Element} target @returns {Element | null} */
const dialogOf = (target) => target.closest('[role="dialog"]') ?? [...document.querySelectorAll('[aria-modal="true"]')].at(-1) ?? null;

/**
 * In a dialog, Home and End move a field’s caret or a scroller in it, and nothing else: the browser’s own scroll would
 * carry on to the conversation behind it, from a button, or from a widget that left the keys alone (#1884).
 * A click in the dialog counts, one before it opened doesn’t.
 * @param {KeyboardEvent} e @param {Element} dialog
 */
function inDialog(e, dialog) {
  const target = /** @type {Element} */ (e.target);
  if (!target.closest(FIELDS) && !inScroller(target, dialog)) e.preventDefault();
}

/**
 * The range moves to the first or the newest item, and the view to the top or the end. Past what the page has loaded
 * (#1155), the conversation’s first or latest range is loaded first, and the window drawn again with it moves there.
 * @param {Set<any>} windows @param {any} w the window, or null in a room without one @param {boolean} last
 */
async function toEdge(windows, w, last) {
  const side = last ? 'after' : 'before';
  if (w?.edges?.more(side)) {
    await w.edges.edge(side);
    w = [...windows].find((x) => !x.inPanel);
    if (!w) return;
  }
  const id = w && (last ? w.entry.ids.at(-1) : w.entry.ids[0]);
  if (id) w.reach(id);
  // The main pane’s conversation scrolls the page, with a window or without one.
  const box = /** @type {Element} */ (document.scrollingElement);
  // Your own move: its scroll event tells the view so, and Home stops it following (view-state.mjs, onScroll).
  box.scrollTop = last ? box.scrollHeight : 0;
}

/** Listens for the page’s Home and End, for the main pane’s conversation and its window among `windows`. @param {Set<any>} windows */
export function edgeKeys(windows) {
  document.addEventListener('keydown', (e) => {
    // Taken already, by a widget of its own.
    if (e.defaultPrevented || !edgeKey(e)) return;
    const dialog = dialogOf(/** @type {Element} */ (e.target));
    if (dialog) return inDialog(e, dialog);
    if (!pageEdgeKey(e)) return;
    // A long room’s window, or a short room’s transcript: without either, there’s no conversation for the keys.
    const w = [...windows].find((x) => !x.inPanel) ?? null;
    if (!w && !document.querySelector('.transcript#main')) return;
    e.preventDefault();
    void toEdge(windows, w, e.key === 'End');
  });
}
