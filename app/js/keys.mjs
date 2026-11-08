// Keyboard shortcuts: ⌃J to the next that needs you, ⌘\ for the sidebar, ⌘K for the palette, Alt+↑/↓, Home and End
// to move through turns and blocks (item-nav.mjs), and Alt+End back to the composer.

import { itemEdges, stepItems } from './item-nav.mjs';
import { nextNeedsYou } from './needs-nav.mjs';
import { openPalette } from './sheets.mjs';
import { toggleRail } from './shell.mjs';
import { focusComposer } from './thread.mjs';

document.addEventListener('keydown', (e) => {
  const mod = e.metaKey || e.ctrlKey;
  if (e.ctrlKey && !e.metaKey && e.key.toLowerCase() === 'j') {
    e.preventDefault();
    nextNeedsYou();
    return;
  }
  // ⌘\ shows or hides the sidebar.
  if (mod && e.key === '\\') {
    e.preventDefault();
    toggleRail();
    return;
  }
  if (mod && e.key.toLowerCase() === 'k') {
    e.preventDefault();
    openPalette();
    return;
  }
  // Alt+↑/↓ moves between turns and blocks, and Home and End on one go to the first and last (item-nav.mjs, #866);
  // Alt+End returns to the composer.
  if (e.altKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) stepItems(e);
  if (e.key === 'Home' || e.key === 'End') itemEdges(e);
  if (e.altKey && e.key === 'End') {
    e.preventDefault();
    focusComposer();
  }
});
