// The rail’s collapse: hidden or shown (⌘\), as the person left it, and hidden for a while when the right pane needs
// its room (#7, pane-width.mjs), without changing what the person chose.

export function railHidden() {
  try {
    return localStorage.getItem('pb-rail') === 'hidden';
  } catch {
    return false;
  }
}

/** Whether the rail shows: the person’s choice, unless the right pane hid it for now. */
export const railShown = () => !railHidden() && !document.querySelector('.app.rail-auto');

function paintToggle() {
  const b = document.getElementById('rail-toggle');
  b?.setAttribute('aria-label', railShown() ? 'Hide the sidebar' : 'Show the sidebar');
  b?.setAttribute('aria-pressed', String(railShown()));
}

/** Hides the rail while the right pane needs its room, or brings it back. */
export function setRailAuto(on) {
  const app = document.querySelector('.app');
  if (!app || app.classList.contains('rail-auto') === on) return;
  app.classList.toggle('rail-auto', on);
  paintToggle();
}

/**
 * Shows or hides the rail (⌘\), and remembers it. Hidden for the right pane, it shows again for as long as the pane
 * is open.
 */
export function toggleRail() {
  const app = document.querySelector('.app');
  if (app?.classList.contains('rail-auto')) {
    app.classList.remove('rail-auto');
    paintToggle();
    dispatchEvent(new CustomEvent('pb-rail', { detail: { keep: true } }));
    return;
  }
  const hide = !railHidden();
  try {
    localStorage.setItem('pb-rail', hide ? 'hidden' : 'shown');
  } catch {}
  app?.classList.toggle('rail-hidden', hide);
  paintToggle();
  // The right pane takes the room it leaves, or gives it back (pane-width.mjs).
  dispatchEvent(new Event('pb-rail'));
}
