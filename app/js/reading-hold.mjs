// A list in the Work pane held still while the person reads it (#1446 review): while the pointer or focus is in the
// pane, a list keeps the rows it shows, and once both have left, the pane draws the newer one. Rows never move under
// the pointer.

/**
 * Follows the pointer and focus in a pane. @param {HTMLElement} pane
 * @param {() => void} repaint  called once both have left, if a newer list waited
 */
export function readingHold(pane, repaint) {
  let pointer = false;
  let stale = false;
  const held = () => pointer || pane.contains(document.activeElement);
  const left = () => {
    if (stale && !held()) repaint();
  };
  const enter = () => {
    pointer = true;
  };
  const leave = () => {
    pointer = false;
    left();
  };
  // After the focus has moved, so activeElement is where it went.
  const blur = () => queueMicrotask(left);
  pane.addEventListener('pointerenter', enter);
  pane.addEventListener('pointerleave', leave);
  pane.addEventListener('focusout', blur);
  return {
    /** Whether the person is reading: the list keeps its rows, and the pane repaints once they leave. */
    reading() {
      stale = held();
      return stale;
    },
    destroy() {
      pane.removeEventListener('pointerenter', enter);
      pane.removeEventListener('pointerleave', leave);
      pane.removeEventListener('focusout', blur);
    },
  };
}
