// The rail’s collapse: hidden or shown (⌘\), as the person left it.

export function railHidden() {
  try {
    return localStorage.getItem('pb-rail') === 'hidden';
  } catch {
    return false;
  }
}

/** Shows or hides the rail (⌘\), and remembers it. */
export function toggleRail() {
  const hide = !railHidden();
  try {
    localStorage.setItem('pb-rail', hide ? 'hidden' : 'shown');
  } catch {}
  document.querySelector('.app')?.classList.toggle('rail-hidden', hide);
  const b = document.getElementById('rail-toggle');
  if (b) {
    b.setAttribute('aria-label', hide ? 'Show the sidebar' : 'Hide the sidebar');
    b.setAttribute('aria-pressed', String(!hide));
  }
  // The right pane takes the room it leaves, or gives it back (pane-width.mjs).
  dispatchEvent(new Event('pb-rail'));
}
