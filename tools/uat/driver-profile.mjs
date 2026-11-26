// The UAT runner’s profile action (#558): the top bar’s button opens Settings on the person’s profile, where the
// runner writes what the tester gives, presses Save profile, reads what the tab says agents are told, and closes
// Settings, as a person would. Kept out of tools/uat/driver.mjs, to keep that file to its size; it uses the driver’s
// clickAt and press.

import { js, sleep } from '../browser.mjs';

/** The tab’s fields, by the label a tester reads on them. */
const FIELDS = { name: 'pf-name', 'also written as': 'pf-aliases', preferences: 'pf-prefs', 'time zone': 'pf-tz', pronouns: 'pf-pronouns' };

const by = (/** @type {string} */ id) => `document.getElementById(${js(id)})`;

/**
 * @param {{ ev: (expr: string) => Promise<any>, clickAt: Function, press: Function, page: any }} kit  the driver’s own
 * @param {{ field: string, value: string }[]} fills  each field by its label and what it should hold; '' clears it
 * @returns {Promise<{ told: string, held: Record<string, string> }>}  what the tab says agents are told once saved,
 *   and what each field held when Save was pressed
 */
export async function saveProfile(kit, fills) {
  await kit.clickAt(`document.querySelector('[aria-label="Settings"]')`, 'the Settings button');
  for (let i = 0; i < 40 && !(await kit.ev(`!!${by('pf-save')}`)); i++) await sleep(100);
  if (!(await kit.ev(`!!${by('pf-save')}`))) throw new Error('Settings didn’t open on the Profile tab.');
  for (const { field, value } of fills) {
    const label = String(field ?? '')
      .trim()
      .toLowerCase();
    if (!Object.hasOwn(FIELDS, label)) throw new Error(`The profile has no “${field}” field. It has: Name, Also written as, Preferences, Time zone, Pronouns.`);
    const id = FIELDS[/** @type {keyof typeof FIELDS} */ (label)];
    await kit.clickAt(by(id), `the ${field} field`);
    await kit.ev(`(() => { const el = ${by(id)}; el.value = ''; el.dispatchEvent(new Event('input', { bubbles: true })); })()`);
    if (String(value ?? '') !== '') await kit.page.send('Input.insertText', { text: String(value) });
  }
  const held = Object.fromEntries(await Promise.all(Object.entries(FIELDS).map(async ([label, id]) => [label, await kit.ev(`${by(id)}.value`)])));
  await kit.clickAt(by('pf-save'), 'Save profile');
  // The tab draws itself again once the save comes back.
  await sleep(600);
  const told = String((await kit.ev(`${by('pf-told')}?.textContent ?? ''`)) ?? '');
  await kit.press('Escape');
  return { told, held };
}
