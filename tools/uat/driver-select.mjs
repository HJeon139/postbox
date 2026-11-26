// The UAT driver's pick of an option in a form's select field, by the text the tester gave (tools/uat/driver.mjs, act).
// Moved from driver.mjs.

import { js } from '../browser.mjs';

/**
 * Picks the first option of the select whose text holds `value`, ignoring case, as a person would by reading it, and
 * tells the page it changed.
 * @param {(expr: string) => Promise<any>} ev  @param {string} control  an expression for the select  @param {unknown} value
 */
export function pickOption(ev, control, value) {
  return ev(
    `(() => { const s = ${control}; const o = [...s.options].find((o) => o.textContent.toLowerCase().includes(${js(String(value).toLowerCase())})); if (o) { s.value = o.value; s.dispatchEvent(new Event('change', { bubbles: true })); s.dispatchEvent(new Event('input', { bubbles: true })); } })()`,
  );
}
