// How the UAT driver names things in the page. Moved out of tools/uat/driver.mjs, so its review and hosts modules
// share them.

import { js } from '../browser.mjs';

export const ITEM = (key) => `document.querySelector('[data-key=${js(key)}]')`;
// Matches a control by its visible text or its label, since icon buttons (Expand table) have only a label.
export const byText = (scope, sel, text) =>
  `[...(${scope}?.querySelectorAll(${js(sel)}) ?? [])].find((e) => e.offsetParent !== null && (e.textContent + ' ' + (e.getAttribute('aria-label') ?? '')).replace(/\\s+/g, ' ').trim().toLowerCase().includes(${js(String(text).toLowerCase())}))`;

// Buttons whose labels are prefixes of another button need an exact match. Permission cards have “Don’t allow…”
// (opens the reason form) before “Don’t allow” (submits it), so an includes match toggles the opener twice.
export const byExactText = (scope, sel, text) =>
  `[...(${scope}?.querySelectorAll(${js(sel)}) ?? [])].find((e) => e.offsetParent !== null && (e.textContent + ' ' + (e.getAttribute('aria-label') ?? '')).replace(/\\s+/g, ' ').trim().toLowerCase() === ${js(String(text).toLowerCase())})`;
