// The UAT runner’s members action (#1735): the Agents heading’s button opens the room’s form in the main menu, where
// the runner adds an agent with the Members list’s + or removes one with its −, as a person would, and reads who is in
// the room after. Kept out of tools/uat/driver.mjs, to keep that file to its size; it uses the driver’s clickAt and press.

import { js, sleep } from '../browser.mjs';
import { byText } from './selectors.mjs';

const TOP = `[...document.querySelectorAll('.dialog')].at(-1)`;
const ROWS = `[...document.querySelectorAll('.dialog [role="listbox"][aria-label^="Members of"] li[role="option"]')]`;
const row = (/** @type {string} */ handle) => `${ROWS}.find((li) => li.querySelector('b')?.textContent === ${js(`@${handle}`)})`;

/** Waits for an expression to hold, or says what it waited for. @param {any} kit @param {string} expr @param {string} what */
async function until(kit, expr, what) {
  for (let i = 0; i < 40; i++) {
    if (await kit.ev(`!!(${expr})`)) return;
    await sleep(150);
  }
  throw new Error(`Timed out waiting for ${what}.`);
}

/**
 * @param {{ ev: (expr: string) => Promise<any>, clickAt: Function, press: Function }} kit  the driver’s own
 * @param {{ add?: string, remove?: string }} change  an agent’s handle to add to the open conversation, or to remove
 * @returns {Promise<{ members: string[] }>}  the room’s members as its list names them, once the change took
 */
export async function changeMembers(kit, { add, remove }) {
  await kit.clickAt(`document.querySelector('.agents-head-btns button')`, 'Manage this conversation’s members');
  await until(kit, `document.getElementById('rm-add')`, 'the room’s form');
  if (add) {
    const handle = add.replace(/^@/, '');
    await kit.clickAt(`document.getElementById('rm-add')`, 'the Members list’s +');
    await kit.clickAt(byText('document', '.menu .mi, [role=menuitem]', `@${handle}`), `@${handle} in what + offers`);
    await until(kit, row(handle), `@${handle} in the Members list`);
  }
  if (remove) {
    const handle = remove.replace(/^@/, '');
    await kit.clickAt(row(handle), `@${handle}’s row`);
    await kit.clickAt(`document.querySelector(${js(`.dialog [aria-label^="Remove @${handle} from"]`)})`, 'the Members list’s −');
    await kit.clickAt(byText(TOP, 'button', 'Delete session'), 'the confirm’s Delete session');
    await until(kit, `!(${row(handle)})`, `@${handle} gone from the Members list`);
  }
  const members = await kit.ev(`${ROWS}.map((li) => li.querySelector('b')?.textContent ?? '')`);
  await kit.press('Escape');
  return { members };
}
