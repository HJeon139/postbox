// A box that scrolls takes a tab stop, so a keyboard can reach and scroll it, and one that fits is no extra stop for
// Tab (#1964), as a dialog’s body does (scrollFocus in ui.mjs): a step’s output and a command’s output. Its label stays
// either way, for when it does scroll. One observer serves every box, and lets go of a box once it leaves the page.

const boxes = new ResizeObserver((entries) => {
  for (const { target } of entries) {
    const box = /** @type {HTMLElement} */ (target);
    if (box.isConnected) fitStop(box);
    else boxes.unobserve(box);
  }
});

/** Sets a box’s tab stop by whether it scrolls now: the one decision, here and for a dialog’s body (ui.mjs). @param {HTMLElement} box */
export function fitStop(box) {
  if (box.scrollHeight > box.clientHeight || box.scrollWidth > box.clientWidth) box.setAttribute('tabindex', '0');
  else box.removeAttribute('tabindex');
}

/**
 * Keeps a box’s tab stop to while it scrolls, from when it’s first laid out and as its size changes, as with the
 * window’s. It starts with the stop, so a box not laid out yet keeps it, as before #1964: one in an item the
 * transcript skips drawing (content-visibility, which axe still checks), one a repaint puts back where focus was
 * (keepFocus in ui.mjs, as the Work view repaints), or one still out of the page at the next frame. Its content isn’t
 * watched: each of these is drawn again, as a new box, when its content changes. Returns the box, for h().
 * @template {HTMLElement} T @param {T} box @returns {T}
 */
export function scrollStop(box) {
  box.setAttribute('tabindex', '0');
  boxes.observe(box);
  return box;
}
