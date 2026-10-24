// Keeps what has focus clear of the conversation’s composer (#232, WCAG 2.4.11 Focus Not Obscured). The composer
// sticks to the bottom of the window, over the end of the conversation, and the browser scrolls a control you Tab to
// only as far as the window’s edge: under the composer. scroll-padding-bottom would do the same, but it kept the view
// from staying at the end when the thread panel opened or an app grew (#88), so this scrolls only when the composer
// covers what has focus, and only down, toward the end the view sticks to.

/** Room for the focus ring (2 px, 2 px out) and a little air above the composer. */
const AIR = 8;

/** The bottom of what sticks to the top of the window: the top bar, and below 768 px the strip of rings. */
const topEdge = () => Math.max(0, ...['header.topbar', '.ringstrip'].map((s) => document.querySelector(s)?.getBoundingClientRect().bottom ?? 0));

/** Scrolls the page so the composer, and the Jump to latest pill above it, don’t cover el, which has focus. */
function keepClear(el) {
  const composer = document.getElementById('composer-input')?.closest('.composer');
  // Only what scrolls under it, by keyboard: a click on a message focuses it too, and mustn’t move it.
  if (!composer?.parentElement?.contains(el) || composer.contains(el) || document.activeElement !== el || !el.matches(':focus-visible')) return;
  const r = el.getBoundingClientRect();
  // Where the higher of the two that are beside it starts.
  const beside = [composer, composer.querySelector('.jump')]
    .map((n) => n?.getBoundingClientRect())
    .filter((b) => b?.height && b.left < r.right && b.right > r.left);
  const cover = Math.min(...beside.map((b) => b.top));
  if (!beside.length || r.bottom + AIR <= cover || r.top >= innerHeight) return;
  // Only when the composer is what you’d see there, not a full-screen review or app over it.
  const c = composer.getBoundingClientRect();
  if (!composer.contains(document.elementFromPoint((c.left + c.right) / 2, c.top + 1))) return;
  // As far as its end needs, but never past its start: a tall message keeps its top in view.
  const by = Math.min(r.bottom + AIR - cover, r.top - topEdge() - AIR);
  if (by > 0) window.scrollBy(0, by);
}

// After the frame the browser scrolls the newly focused element into view in.
document.addEventListener('focusin', (e) => {
  const el = e.target;
  if (el instanceof Element) requestAnimationFrame(() => keepClear(el));
});
