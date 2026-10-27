// The composer’s message box grows with what you type, up to 200 px (#422).

/**
 * Fits a textarea to its text. Measuring collapses it for a moment, so the composer around it keeps its height
 * meanwhile: otherwise the page gets shorter and pulls the view up, which the transcript takes for you scrolling away,
 * and it stops following the newest message (#422).
 * @param {HTMLTextAreaElement} ta
 */
export function fitTextarea(ta) {
  const box = /** @type {HTMLElement | null} */ (ta.closest('.composer'));
  if (box) box.style.minHeight = `${box.offsetHeight}px`;
  ta.style.height = 'auto';
  ta.style.height = `${Math.min(200, ta.scrollHeight)}px`;
  if (box) box.style.minHeight = '';
}
