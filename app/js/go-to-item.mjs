// Going to an item in the same transcript from a line that stands for it: a moved item's stub (#49) and a retired
// app's link to what replaced it (#193). Both bring the item into view and focus what answers it. Moved from
// thread.mjs and apps.mjs, where each had the same steps, unchanged.

/**
 * Brings the transcript's item into view and focuses its first control, else the item.
 * @param {Event} e  the click, on a control in the transcript @param {string} itemId
 */
export function goToItem(e, itemId) {
  const box = /** @type {HTMLElement} */ (e.currentTarget).closest('.transcript');
  const node = box?.querySelector(`:scope > [data-key="${CSS.escape(itemId)}"]`);
  if (!(node instanceof HTMLElement)) return;
  node.scrollIntoView({ block: 'center' });
  (node.querySelector('button:not([disabled]), input, textarea, select') ?? node).focus({ preventScroll: true });
}
