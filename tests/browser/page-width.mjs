// How wide Postbox’s page lays out, for the checks that it doesn’t scroll sideways (#966). The page clips its sideways
// overflow (app/workbench.css), so document.documentElement.scrollWidth is the window’s width whatever lays out past
// it, and the content past the edge is cut off, not reachable. This measures what’s laid out: the widest right edge of
// any element not inside a box that clips or scrolls it sideways, and not fixed to the window, which never widened
// the page.

/**
 * The page’s laid-out width in CSS pixels: at least the window’s, more when something reaches past its right edge.
 * Self-contained, so a spec can run it in the page: `page.evaluate(widestRight)`.
 */
export function widestRight() {
  const root = document.documentElement;
  const contained = (/** @type {Element} */ el) => {
    for (let p = el.parentElement; p && p !== document.body && p !== root; p = p.parentElement) if (getComputedStyle(p).overflowX !== 'visible') return true;
    return false;
  };
  const fixed = (/** @type {Element} */ el) => {
    for (let e = /** @type {Element | null} */ (el); e && e !== document.body; e = e.parentElement) if (getComputedStyle(e).position === 'fixed') return true;
    return false;
  };
  let widest = root.clientWidth;
  for (const el of document.body.querySelectorAll('*')) {
    const right = el.getBoundingClientRect().right + scrollX;
    if (right <= widest + 0.5 || contained(el) || fixed(el)) continue;
    widest = right;
  }
  return Math.ceil(widest);
}

/** @param {import('@playwright/test').Page} page */
export const pageWidth = (page) => page.evaluate(widestRight);
