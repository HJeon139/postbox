// A box that scrolls takes a tab stop, so a keyboard can reach and scroll it, and one that fits is no extra stop for
// Tab (#1964), as a dialog’s body does (scrollFocus in ui.mjs): a step’s output and a command’s output. Its label stays
// either way, for when it does scroll. One observer serves every box, and lets go of a box once it leaves the page.

const boxes = new ResizeObserver((entries) => {
  for (const { target } of entries) {
    const box = /** @type {HTMLElement} */ (target);
    if (box.isConnected) fit(box);
    else boxes.unobserve(box);
  }
});

/** Sets the box’s tab stop by whether it scrolls now. @param {HTMLElement} box */
function fit(box) {
  if (box.scrollHeight > box.clientHeight || box.scrollWidth > box.clientWidth) box.setAttribute('tabindex', '0');
  else box.removeAttribute('tabindex');
}

/**
 * Keeps a box’s tab stop to while it scrolls, from when it’s first laid out and as its size changes, as with the
 * window’s. Its content isn’t watched: each of these is drawn again, as a new box, when its content changes. Returns
 * the box, for h().
 * @template {HTMLElement} T @param {T} box @returns {T}
 */
export function scrollStop(box) {
  boxes.observe(box);
  return box;
}
