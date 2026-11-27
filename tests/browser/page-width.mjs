// How wide Postbox’s page lays out, for the checks that it doesn’t scroll sideways (#966). The page clips its sideways
// overflow (app/workbench.css), so document.documentElement.scrollWidth is the window’s width whatever lays out past
// it, and the content past the edge is cut off, not reachable. This measures what’s laid out: the widest right edge of
// any element not clipped or scrolled sideways by a box in its containing-block chain, and not fixed to the window,
// which never widened the page.

/**
 * The page’s laid-out width in CSS pixels: at least the window’s, more when something reaches past its right edge.
 * Self-contained, so a spec can run it in the page: `page.evaluate(widestRight)`.
 */
export function widestRight() {
  const root = document.documentElement;
  // Whether a box of this position has `p` as its containing block: an absolute one’s is its nearest positioned or
  // transformed ancestor, a fixed one’s only a transformed one (else the window), a static one’s its parent.
  const holds = (/** @type {CSSStyleDeclaration} */ cs, /** @type {string} */ pos) => {
    const makes = cs.transform !== 'none' || cs.filter !== 'none' || /paint|layout|strict|content/.test(cs.contain);
    if (pos === 'fixed') return makes;
    if (pos === 'absolute') return makes || cs.position !== 'static';
    return true;
  };
  // Whether the box is left out: fixed to the window, which never widened the page, or inside a containing block that
  // clips or scrolls it sideways.
  const leftOut = (/** @type {Element} */ el) => {
    let pos = getComputedStyle(el).position;
    for (let p = el.parentElement; p && p !== document.body && p !== root; p = p.parentElement) {
      const cs = getComputedStyle(p);
      if (!holds(cs, pos)) continue;
      if (cs.overflowX !== 'visible') return true;
      pos = cs.position;
    }
    return pos === 'fixed';
  };
  let widest = root.clientWidth;
  for (const el of document.body.querySelectorAll('*')) {
    const right = el.getBoundingClientRect().right + scrollX;
    if (right <= widest + 0.5 || leftOut(el)) continue;
    widest = right;
  }
  return Math.ceil(widest);
}

/** @param {import('@playwright/test').Page} page */
export const pageWidth = (page) => page.evaluate(widestRight);
