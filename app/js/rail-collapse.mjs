// The rail’s collapse: hidden or shown (⌘\), as the person left it, and hidden for a while when the right pane needs
// its room (#7, pane-width.mjs), without changing what the person chose.

import { toast } from './ui.mjs';

export function railHidden() {
  try {
    return localStorage.getItem('pb-rail') === 'hidden';
  } catch {
    return false;
  }
}

/** Whether the rail shows: the person’s choice, unless the right pane hid it for now. */
export const railShown = () => !railHidden() && !document.querySelector('.app.rail-auto');

/** Whether the rail can’t show at all: the right pane is open and has no room beside it. */
const noRoom = () => !railShown() && !!document.querySelector('.app[data-rail-no-room]');

function paintToggle() {
  const b = document.getElementById('rail-toggle');
  b?.setAttribute('aria-label', railShown() ? 'Hide the sidebar' : 'Show the sidebar');
  b?.setAttribute('aria-pressed', String(railShown()));
  if (noRoom()) b?.setAttribute('aria-disabled', 'true');
  else b?.removeAttribute('aria-disabled');
}

/**
 * Hides the rail while the right pane needs its room, or brings it back; full: the pane has no room beside the rail
 * at all, so it can’t show.
 */
export function setRailAuto(on, full = false) {
  const app = document.querySelector('.app');
  if (!app || (app.classList.contains('rail-auto') === on && app.hasAttribute('data-rail-no-room') === full)) return;
  app.classList.toggle('rail-auto', on);
  app.toggleAttribute('data-rail-no-room', full);
  paintToggle();
}

/**
 * Shows or hides the rail (⌘\), and remembers it. Hidden for the right pane, it shows again for as long as the pane
 * is open.
 */
export function toggleRail() {
  const app = document.querySelector('.app');
  // Shown, it would push the pane full screen over it, so it stays hidden, and says why.
  if (noRoom()) {
    toast({ title: 'No room for the sidebar beside the pane', text: 'Close the pane, or widen the window, to show it.' });
    return;
  }
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
  // The right pane takes the room it leaves, or gives it back (pane-width.mjs); shown, the rail stays while it’s open.
  dispatchEvent(new CustomEvent('pb-rail', { detail: { keep: !hide } }));
}
