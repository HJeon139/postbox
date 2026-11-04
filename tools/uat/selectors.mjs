// How the UAT driver names things in the page. Moved out of tools/uat/driver.mjs, so its review and hosts modules
// share them.

import { js } from '../browser.mjs';

export const ITEM = (key) => `document.querySelector('[data-key=${js(key)}]')`;
// A jump in the page goes through its own jumpTo, as a link or key there does, so the item it lands on stays put while
// the items it passed draw at their real sizes (#712). The expression awaits: use it inside an async function.
export const JUMP = (el, block) => `(await import('/app/js/view-jump.mjs')).jumpTo(${el}, ${js(block)})`;
// Matches a control by its visible text or its label, since icon buttons (Expand table) have only a label.
export const byText = (scope, sel, text) =>
  `[...(${scope}?.querySelectorAll(${js(sel)}) ?? [])].find((e) => e.offsetParent !== null && (e.textContent + ' ' + (e.getAttribute('aria-label') ?? '')).replace(/\\s+/g, ' ').trim().toLowerCase().includes(${js(String(text).toLowerCase())}))`;
