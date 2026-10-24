// A headless Chrome check of reactions (#251): the person reacts to an agent’s reply by mouse and by keyboard, sees
// each reaction under it, takes one back by clicking it again, and the server keeps what the page shows; axe is clean
// on the reply, its reactions and the menu. What the agent hears is tests/reactions.test.mjs’s.
//
//   node tools/check-reactions.mjs        (PB_PORT and PB_CHROME_PORT move it)

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { begin, check, click, end, fresh, page, press, settle } from './pane-check.mjs';

/** Enter as a person presses it: with the character, which is what activates a button or a menu item. */
async function enter() {
  for (const type of ['keyDown', 'keyUp'])
    await page.send('Input.dispatchKeyEvent', { type, key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, ...(type === 'keyDown' ? { text: '\r' } : {}) });
  await settle();
}

const AXE = await readFile(createRequire(import.meta.url).resolve('axe-core/axe.min.js'), 'utf8');
await begin('check-reactions', 4954, 10254);

/** The last agent reply in the conversation: its item, its React button, and its reactions. */
const REPLY = `[...document.querySelectorAll('#main .item')].filter((n) => n.querySelector('.who b')?.textContent.startsWith('@')).at(-1)`;
const reactButton = `${REPLY}.querySelector('.msg-actions button[aria-label="React to this message"]')`;
const chips = () => page.evaluate(`[...${REPLY}.querySelectorAll('.reactions .react-chip')].map((b) => b.textContent + ' ' + b.getAttribute('aria-pressed'))`);
const menuItem = (label) => `[...document.querySelectorAll('.menu [role=menuitem]')].find((b) => b.textContent.includes(${JSON.stringify(label)}))`;
/** The reactions the server keeps on that reply. */
const onServer = () =>
  page.evaluate(`fetch('/api/state').then((r) => r.json()).then(({ state }) => {
    const key = ${REPLY}.dataset.key;
    return Object.values(state.items).flat().find((i) => i.id === key)?.reactions?.map((r) => r.emoji) ?? [];
  })`);

await check('#251 a reaction by mouse shows under the reply, and the server keeps it', async () => {
  await fresh(1280);
  await page.evaluate(`${REPLY}.scrollIntoView({ block: 'center' })`);
  await click(reactButton);
  await page.waitFor(menuItem('Not good'), { label: 'the reactions menu' });
  assert.equal(await page.evaluate(`document.querySelectorAll('.menu [role=menuitem]').length`), 5);
  await click(menuItem('Not good'));
  await page.waitFor(`!!${REPLY}.querySelector('.reactions .react-chip')`, { label: 'the reaction under the reply' });
  assert.deepEqual(await chips(), ['👎 true']);
  assert.deepEqual(await onServer(), ['👎']);
});

await check('#251 by keyboard: React opens the menu, Enter picks one, and Enter on a reaction takes it back', async () => {
  await page.evaluate(`${reactButton}.focus()`);
  await enter();
  await page.waitFor(menuItem('Flag this'), { label: 'the reactions menu' });
  await page.evaluate(`${menuItem('Flag this')}.focus()`);
  await enter();
  await page.waitFor(`${REPLY}.querySelectorAll('.reactions .react-chip').length === 2`, { label: 'the second reaction' });
  assert.deepEqual(await chips(), ['👎 true', '🚩 true']);
  await page.evaluate(`[...${REPLY}.querySelectorAll('.react-chip')].find((b) => b.textContent === '👎').focus()`);
  await enter();
  await page.waitFor(`${REPLY}.querySelectorAll('.reactions .react-chip').length === 1`, { label: 'the reaction taken back' });
  assert.deepEqual(await chips(), ['🚩 true']);
  assert.deepEqual(await onServer(), ['🚩']);
});

await check('#251 axe finds nothing wrong with the reply, its reactions or the menu', async () => {
  await click(reactButton);
  await page.waitFor(menuItem('Good'), { label: 'the reactions menu' });
  await page.evaluate(`${AXE};0`);
  const bad =
    await page.evaluate(`axe.run({ include: [[${JSON.stringify('.menu')}]] }, { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'] } })
    .then(async (menu) => [...menu.violations, ...(await axe.run(${REPLY}, { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'] } })).violations].map((v) => v.id + ': ' + v.help))`);
  await press('Escape', 'Escape', 27);
  await settle();
  assert.deepEqual(bad, []);
});

await end();
