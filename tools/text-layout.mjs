// The layout check of Postbox’s own screens (#681): text drawn over text or run into a control, text cut off by its
// box, and words broken mid-word. It runs the pre-display check’s own text checks (app/kit/check-layout.js,
// check-text.js), and app/kit/check-breaks.js beside them, so agents’ apps and Postbox’s screens are held to one rule.
// The browser specs run it through tests/browser/text-layout.mjs, and the UAT runner on each whole-window screenshot
// (tools/uat/layout-probe.mjs). Each finding names the element by a short selector path and quotes at most 40
// characters of its text.

import { readFileSync } from 'node:fs';

const kit = (name) => readFileSync(new URL(`../app/kit/${name}`, import.meta.url), 'utf8');
// Each file runs in a function of its own, as it would as a script of its own: check-text.js’s 'use strict' stays its
// own, and no file’s names reach another’s.
const own = (name) => `(function () {\n${kit(name)}\n})();`;

/**
 * An expression for page.evaluate (Playwright’s, or the UAT driver’s), which resolves to the problems on the page at
 * the window’s width, as { code, message }: text-overlap, text-overflow, text-cut-off, text-on-control and
 * mid-word-break. It measures text over text twice, a second apart, as the pre-display check does, so the page should
 * hold still for that second. It leaves the page as it found it: check-layout.js runs animation frames on a timer, for
 * the hidden frames it was written for, so the page’s own are put back as soon as it loads, and the window’s scroll after.
 * Only kit/kit.js’s rgb and lum, which this check doesn’t call, are stood in for.
 */
export const TEXT_LAYOUT = `(async () => {
  const kept = { raf: window.requestAnimationFrame, caf: window.cancelAnimationFrame, x: scrollX, y: scrollY };
  window.__pbCheck = { rgb: () => null, lum: () => 0 };
  // The transcript lets the browser skip the items off screen (#712), and asking what’s drawn at a point finds nothing
  // of one until a frame draws it, so everything is drawn while the check measures.
  const drawn = document.head.appendChild(document.createElement('style'));
  drawn.textContent = '* { content-visibility: visible !important; }';
  try {
    ${own('check-layout.js')}
    // The page isn’t a hidden frame: its own animation frames run, and its own ids cancel them.
    window.requestAnimationFrame = kept.raf;
    window.cancelAnimationFrame = kept.caf;
    ${own('check-text.js')}
    ${own('check-breaks.js')}
    const c = window.__pbCheck;
    const w = innerWidth;
    const found = await Promise.all([c.textOverlap(w), c.textOverflow(w), c.cutOff(w), c.textOnControl(w), c.midWordBreaks(w)]);
    return found.flat();
  } finally {
    drawn.remove();
    delete window.__pbCheck;
    window.requestAnimationFrame = kept.raf;
    window.cancelAnimationFrame = kept.caf;
    scrollTo({ left: kept.x, top: kept.y, behavior: 'instant' });
  }
})()`;
