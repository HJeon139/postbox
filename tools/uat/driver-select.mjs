// The UAT driver’s pick of an option in a form’s select field, by the text the tester gave (tools/uat/driver.mjs, act).
// Moved from driver.mjs.

import { js } from '../browser.mjs';

/**
 * Picks the first option of the select whose text holds `value`, ignoring case, as a person would by reading it, and
 * tells the page it changed. With no such option, the step fails, saying so, as a choice’s missing option does: left as
 * it was, the field’s default read as the tester’s pick (#1781).
 * @param {(expr: string) => Promise<any>} ev  @param {string} control  an expression for the select
 * @param {unknown} field  the field’s label, as the tester named it  @param {unknown} value
 */
export async function pickOption(ev, control, field, value) {
  const picked = await ev(
    `(() => { const s = ${control}; const o = [...s.options].find((o) => o.textContent.toLowerCase().includes(${js(String(value).toLowerCase())})); if (!o) return false; s.value = o.value; s.dispatchEvent(new Event('change', { bubbles: true })); s.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`,
  );
  if (!picked) throw new Error(`Couldn’t find the option “${value}” in the field “${field}”.`);
}
