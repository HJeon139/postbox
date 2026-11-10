// Going to an item in the same transcript from a line that stands for it: a moved item's stub (#49) and a retired
// app's link to what replaced it (#193). Both bring the item into view and focus what answers it. Moved from
// thread.mjs and apps.mjs, where each had the same steps. The jump goes through jumpTo, so the item stays where it
// lands while what's between draws (#712), after the window mounts it if it's off the page (#866).

import { jumpTo } from './view-jump.mjs';
import { mountFor } from './window.mjs';

/**
 * Brings the transcript's item into view and focuses its first control, else the item.
 * @param {Event} e  the click, on a control in the transcript @param {string} itemId
 */
export function goToItem(e, itemId) {
  const box = /** @type {HTMLElement} */ (e.currentTarget).closest('.transcript');
  // An item the window holds off the page is mounted first (#866, W3).
  const node = mountFor(itemId) ?? box?.querySelector(`:scope > [data-key="${CSS.escape(itemId)}"]`);
  if (!(node instanceof HTMLElement)) return;
  jumpTo(node);
  (node.querySelector('button:not([disabled]), input, textarea, select') ?? node).focus({ preventScroll: true });
}
