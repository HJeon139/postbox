// The composer’s box grows with its draft, up to 200 px, then scrolls. Moved out of mountComposer in
// app/js/thread.mjs, which is at its length ceiling.

/**
 * Sizes a draft’s box to its lines. Measuring collapses the box for a moment, which shortens the page, and the browser
 * clamps the view to the shorter page at once. At the end of the conversation that clamp reads as you scrolling up,
 * and the view stops following the newest message (#422). So each view it can clamp goes back where it was before
 * anything else sees it. @param {HTMLTextAreaElement} ta
 */
export function fitDraft(ta) {
  const views = [document.scrollingElement, ta.closest('.sp-body')].filter((v) => v instanceof Element);
  const tops = views.map((v) => v.scrollTop);
  ta.style.height = 'auto';
  ta.style.height = `${Math.min(200, ta.scrollHeight)}px`;
  views.forEach((v, i) => {
    if (v.scrollTop !== tops[i]) v.scrollTop = tops[i];
  });
}
