// A box that scrolls takes a tab stop, so a keyboard can reach and scroll it, and one that fits is no extra stop for
// Tab (#1964), as a dialog’s body does (scrollFocus in ui.mjs): a step’s output and a command’s output, and a code block,
// a table block, the Work view’s effort table, a file’s diff and a permission card’s draft (#1968). Its label stays
// either way, for when it does scroll. One observer serves every box, and lets go of a box once it leaves the page.

const boxes = new ResizeObserver((entries) => {
  for (const { target } of entries) {
    const box = /** @type {HTMLElement} */ (target);
    if (box.isConnected) fitStop(box);
    else boxes.unobserve(box);
  }
});

/** A box’s two labels, when it says whether it scrolls (a table block’s “…, scrolls”, #1968). */
const labelsOf = new WeakMap();

/** Sets a box’s tab stop by whether it scrolls now: the one decision, here and for a dialog’s body (ui.mjs). @param {HTMLElement} box */
export function fitStop(box) {
  const scrolls = box.scrollHeight > box.clientHeight || box.scrollWidth > box.clientWidth;
  if (scrolls) box.setAttribute('tabindex', '0');
  else box.removeAttribute('tabindex');
  const labels = labelsOf.get(box);
  if (labels) box.setAttribute('aria-label', scrolls ? labels.scrolls : labels.fits);
}

/**
 * Keeps a box’s tab stop to while it scrolls, from when it’s first laid out and as its size changes, as with the
 * window’s. It starts with the stop, so a box not laid out yet keeps it, as before #1964: one in an item the
 * transcript skips drawing (content-visibility, which axe still checks), one a repaint puts back where focus was
 * (keepFocus in ui.mjs, as the Work view repaints), or one still out of the page at the next frame. Its content isn’t
 * watched: each of these is drawn again, as a new box, when its content changes. Returns the box, for h().
 * With labels, the box says whether it scrolls too, starting as one that does.
 * @template {HTMLElement} T @param {T} box @param {{ scrolls: string, fits: string }} [labels] @returns {T}
 */
export function scrollStop(box, labels) {
  // Marked, so keepFocus (ui.mjs) counts it in place whether or not it has its stop now.
  box.dataset.scrollStop = '';
  box.setAttribute('tabindex', '0');
  if (labels) {
    labelsOf.set(box, labels);
    box.setAttribute('aria-label', labels.scrolls);
  }
  boxes.observe(box);
  return box;
}
