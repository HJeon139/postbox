// A view’s repaint on store events: once a frame at most, and held while a press is down in the view (heldPaint,
// #898). The Work pane rebuilds every button in it on each work event while an agent works, so a press that spanned
// a repaint landed its click on nothing (#1010). The view’s own repaints, for what you just did there, don’t wait.

import { heldPaint } from './dom.mjs';

/**
 * soon() paints in the next frame, held while a press in root is down; held() paints held, now unless a press is down;
 * cancel() drops a frame not yet painted.
 * @param {HTMLElement} root  @param {() => void} paint
 */
export function heldFrame(root, paint) {
  const held = heldPaint(root, paint);
  let frame = 0;
  return {
    held,
    soon() {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(held);
    },
    cancel: () => cancelAnimationFrame(frame),
  };
}
