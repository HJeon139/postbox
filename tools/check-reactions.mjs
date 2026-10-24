// A headless Chrome check of reactions (#251): the person reacts to an agent’s reply by mouse and by keyboard, sees
// each reaction under it, drawn with its icon, takes one back by clicking it again, and the server keeps what the page
// shows; axe is clean on the reply, its reactions and the menu. What the agent hears is tests/reactions.test.mjs’s.
//
//   node tools/check-reactions.mjs        (PB_PORT and PB_CHROME_PORT move it)

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { reactTool } from '../server/reactions.mjs';
import { begin, check, click, end, fresh, ids, page, press, server, settle } from './pane-check.mjs';
import { reactItem } from './uat/telemetry-driver.mjs';

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
const chips = () => page.evaluate(`[...${REPLY}.querySelectorAll('.reactions .react-chip img')].map((i) => i.alt)`);
const menuItem = (label) => `[...document.querySelectorAll('.menu [role=menuitemcheckbox]')].find((b) => b.textContent.includes(${JSON.stringify(label)}))`;
const checked = () => page.evaluate(`[...document.querySelectorAll('.menu [role=menuitemcheckbox]')].map((b) => b.getAttribute('aria-checked'))`);
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
  assert.deepEqual(await checked(), ['false', 'false', 'false', 'false', 'false']);
  assert.deepEqual(await page.evaluate(`[...document.querySelectorAll('.menu .react-icon')].map((i) => i.alt)`), ['👍', '👎', '🚩', '❓', '✅']);
  // Every icon loads, and the UAT's telemetry driver finds each reaction by its emoji (#263).
  await page.waitFor(`[...document.querySelectorAll('.menu .react-icon')].every((i) => i.complete && i.naturalWidth === 64)`, { label: 'all five icons' });
  for (const e of ['👍', '👎', '🚩', '❓', '✅']) assert.ok(await page.evaluate(`!!${reactItem(e)}`), `the driver finds ${e}`);
  await click(menuItem('Not good'));
  await page.waitFor(`!!${REPLY}.querySelector('.reactions .react-chip')`, { label: 'the reaction under the reply' });
  assert.deepEqual(await chips(), ['👎']);
  await page.waitFor(`${REPLY}.querySelector('.react-chip img').naturalWidth === 64`, { label: 'the reaction’s icon' });
  assert.equal(await page.evaluate(`${REPLY}.querySelector('.react-chip').hasAttribute('aria-pressed')`), false);
  assert.deepEqual(await onServer(), ['👎']);
});

await check('#251 by keyboard: React opens the menu, Enter picks one, and Enter on a reaction takes it back', async () => {
  await page.evaluate(`${reactButton}.focus()`);
  await enter();
  await page.waitFor(menuItem('Flag this'), { label: 'the reactions menu' });
  assert.deepEqual(await checked(), ['false', 'true', 'false', 'false', 'false'], 'the menu says which reactions are on');
  await page.evaluate(`${menuItem('Flag this')}.focus()`);
  await enter();
  await page.waitFor(`${REPLY}.querySelectorAll('.reactions .react-chip').length === 2`, { label: 'the second reaction' });
  assert.deepEqual(await chips(), ['👎', '🚩']);
  await page.evaluate(`[...${REPLY}.querySelectorAll('.react-chip')].find((b) => b.querySelector('img').alt === '👎').focus()`);
  await enter();
  await page.waitFor(`${REPLY}.querySelectorAll('.reactions .react-chip').length === 1`, { label: 'the reaction taken back' });
  assert.deepEqual(await chips(), ['🚩']);
  assert.deepEqual(await onServer(), ['🚩']);
});

await check('#251 a reaction on an app adds its row, and its frame isn’t drawn again', async () => {
  const APP = `[...document.querySelectorAll('#main .item')].find((n) => n.querySelector('.appframe'))`;
  await page.evaluate(`(${APP}).scrollIntoView({ block: 'center' })`);
  await page.waitFor(`!!(${APP}).querySelector('.appframe iframe')`, { label: 'the app’s frame' });
  await page.evaluate(`(${APP}).querySelector('iframe').dataset.mark = 'same'`);
  await click(`(${APP}).querySelector('.msg-actions button[aria-label="React to this message"]')`);
  await page.waitFor(menuItem('Done'), { label: 'the reactions menu' });
  await click(menuItem('Done'));
  await page.waitFor(`!!(${APP}).querySelector('.reactions .react-chip')`, { label: 'the reaction under the app' });
  assert.equal(await page.evaluate(`(${APP}).querySelector('iframe').dataset.mark`), 'same', 'the app’s frame was drawn again');
});

await check('An agent’s reaction shows under the reply with its name in words, and clicking it adds yours beside it', async () => {
  const { rt, store } = server();
  const key = await page.evaluate(`${REPLY}.dataset.key`);
  const agent = rt.sessionsIn(ids.conv).find((s) => s.id !== store.item(ids.conv, key)?.sessionId) ?? rt.sessionsIn(ids.conv)[0];
  reactTool(rt, agent, { id: key, emoji: '❓' });
  await page.waitFor(`[...${REPLY}.querySelectorAll('.react-chip')].some((b) => b.textContent.includes('@${agent.handle}'))`, {
    label: 'the agent’s reaction, named',
  });
  const chip = `[...${REPLY}.querySelectorAll('.react-chip')].find((b) => b.querySelector('img')?.alt === '❓')`;
  assert.match(await page.evaluate(`${chip}.getAttribute('aria-label')`), new RegExp(`from @${agent.handle}: add yours$`));
  await click(chip);
  await page.waitFor(`${chip}.getAttribute('aria-label').endsWith('take yours back')`, { label: 'yours added beside it' });
  assert.match(await page.evaluate(`${chip}.getAttribute('aria-label')`), new RegExp(`from you and @${agent.handle}`));
  // In words on screen too, not only by its color (principle 5).
  assert.equal(await page.evaluate(`${chip}.querySelector('.react-who').textContent`), `you and @${agent.handle}`);
  assert.deepEqual(await onServer(), ['🚩', '❓', '❓']);
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
