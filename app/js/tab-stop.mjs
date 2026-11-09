// The next element Tab or Shift+Tab goes to, in document order, for apps.mjs to see whether it’s an app frame. It
// walks from the focused element and reads layout only for each candidate in turn, until the first that takes focus:
// the transcript skips its items off screen (#712a), and reading the rects of every focusable on the page laid each
// skipped item out, 975 layouts and about 3 s for one Tab in a 1,000-item room (view-skipped-tab.spec.mjs). It costs
// the elements between the focus and the next stop, not the page.

const FOCUSABLE = 'a[href], button, input, select, textarea, iframe.app-iframe, [tabindex]:not([tabindex="-1"]), [contenteditable="true"]';

/** Whether Tab can stop at el: cheap checks first, so only a likely stop reads its layout. @param {Element} el */
function isStop(el) {
  if (!(el instanceof HTMLElement) || !el.matches(FOCUSABLE)) return false;
  if (el.tabIndex < 0 || /** @type {any} */ (el).disabled) return false;
  if (el.closest('[hidden]') || el.parentElement?.closest('[inert]')) return false;
  return el.getClientRects().length > 0;
}

/** The last element of the body in document order. @param {TreeWalker} walker */
function toLast(walker) {
  walker.currentNode = document.body;
  while (walker.lastChild()) {}
  return /** @type {Element} */ (walker.currentNode);
}

/**
 * The element Tab (or Shift+Tab, back) goes to from the focused one, in document order; from the page’s start (or
 * end) when the focused element isn’t a stop.
 * @param {boolean} back @returns {HTMLElement | null}
 */
export function nextTabStop(back) {
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_ELEMENT);
  const from = document.activeElement;
  const step = () => /** @type {Element | null} */ (back ? walker.previousNode() : walker.nextNode());
  let el;
  if (from && from !== document.body && document.body.contains(from) && isStop(from)) {
    walker.currentNode = from;
    el = step();
  } else el = back ? toLast(walker) : step();
  while (el && !isStop(el)) el = step();
  return /** @type {HTMLElement | null} */ (el);
}
