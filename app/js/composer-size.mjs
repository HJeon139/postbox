// The composer’s box grows with its draft, up to 200 px, then scrolls.

// Where the browser sizes a field to its content, the CSS does it with no script at all (#641). Measuring here reads the
// box’s scrollHeight and the page’s scrollTop on every key, and each read lays out the whole conversation: in a room of
// 3,500 items, three layouts a key put a typed letter on screen 232 ms late.
const sizedByCSS = typeof CSS !== 'undefined' && CSS.supports('field-sizing', 'content');

/**
 * Sizes a draft’s box to its lines. Measuring collapses the box for a moment, which shortens the page, and the browser
 * clamps the view to the shorter page at once. At the end of the conversation that clamp reads as you scrolling up,
 * and the view stops following the newest message (#422). So each view it can clamp goes back where it was before
 * anything else sees it. @param {HTMLTextAreaElement} ta
 */
export function fitDraft(ta) {
  if (sizedByCSS) return;
  // The panel’s composer sits in its foot, beside the scroll box it can clamp, not inside it.
  const views = [document.scrollingElement, ta.closest('.sidepanel')?.querySelector('.sp-body')].filter((v) => v instanceof Element);
  const tops = views.map((v) => v.scrollTop);
  ta.style.height = 'auto';
  ta.style.height = `${Math.min(200, ta.scrollHeight)}px`;
  views.forEach((v, i) => {
    if (v.scrollTop !== tops[i]) v.scrollTop = tops[i];
  });
}
