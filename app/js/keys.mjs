// Keyboard shortcuts: ⌃J to the next that needs you, ⌘\ for the sidebar, ⌘K for the palette, and Alt+↑/↓ and
// Alt+End to move through turns and blocks and back to the composer.

import { openPalette } from './sheets.mjs';
import { nextNeedsYou, toggleRail } from './shell.mjs';
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
  // Alt+↑/↓ moves between turns and blocks; Alt+End returns to the composer.
  if (e.altKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
    const items = [...document.querySelectorAll('#main > .item')];
    if (!items.length) return;
    e.preventDefault();
    const at = items.findIndex((n) => n.contains(document.activeElement));
    const next = items[at < 0 ? items.length - 1 : Math.max(0, Math.min(items.length - 1, at + (e.key === 'ArrowDown' ? 1 : -1)))];
    next.focus();
    next.scrollIntoView({ block: 'nearest' });
  }
  if (e.altKey && e.key === 'End') {
    e.preventDefault();
    focusComposer();
  }
});
