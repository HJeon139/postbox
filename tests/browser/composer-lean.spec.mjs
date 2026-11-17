// The composer is its input row plus one line (#1437): the static help lives in the placeholder, the line under the
// input holds only the hints that apply while you type, one menu button adds a file or an agent or runs a command,
// and nothing above the input repeats the agent rows’ mail buttons. On the demo’s mock agents, in a room of its own
// where @researcher spoke last.

import { expect, test } from '@playwright/test';
import * as arrange from '../arrange.mjs';
import { failOnPageErrors, focusIs, startPostbox, synced } from './postbox.mjs';

/** @type {Awaited<ReturnType<typeof startPostbox>>} */
let app;
test.beforeAll(async () => {
  app = await startPostbox('composer-lean');
});
test.afterAll(async () => {
  await app?.stop();
});
failOnPageErrors(test);

let count = 0;
/** A room of its own with @critic and @researcher, where @researcher spoke last, open in the page at width. */
async function room(page, width = 1280) {
  const { rt, store } = app;
  const t = rt.createThread({
    projectId: Object.keys(store.state.projects)[0],
    title: `Lean ${++count}`,
    personaIds: ['critic', 'researcher'].map((h) => arrange.persona(rt, h).id),
  });
  const researcher = arrange.agentIn(rt, t.id, 'researcher');
  arrange.post(rt, t.id, { kind: 'agent', sessionId: researcher.id, personaId: researcher.personaId, handle: 'researcher', text: 'Done.', status: 'done' });
  arrange.putThread(rt, { ...store.state.threads[t.id], lastSpeaker: researcher.id });
  await page.setViewportSize({ width, height: 800 });
  await page.goto(`${app.origin}/#/t/${t.id}`);
  await synced(page, app);
  await expect(page.locator('#composer-input')).toBeVisible();
  return t;
}
const hint = (page) => page.locator('.composer .hint');
const menuButton = (page) => page.locator('.composer-box').getByRole('button', { name: 'Add a file or an agent, or run a command' });

test('#1437 the empty composer has its help in the placeholder and an empty line under it, one line high', async ({ page }) => {
  await room(page);
  await expect(page.locator('#composer-input')).toHaveAttribute('placeholder', 'Reply to researcher · @ to wake an agent, / for commands, ! to run');
  await expect(hint(page), 'no static help under the input').toHaveText('');
  const box = await hint(page).boundingBox();
  expect(box?.height, 'the line keeps its one line of room').toBeGreaterThan(10);
  expect(box?.height, 'and only one').toBeLessThan(20);
  await expect(page.locator('.composer')).not.toContainText('Enter to send');
  await expect(page.locator('.composer')).not.toContainText('for commands');
});

test('#1437 on a phone the placeholder is short enough not to be cut off', async ({ page }) => {
  await room(page, 375);
  await expect(page.locator('#composer-input')).toHaveAttribute('placeholder', 'Reply to researcher');
});

test('#1437 the line says who a draft reaches once you type, and is empty again when you clear it', async ({ page }) => {
  await room(page);
  await page.locator('#composer-input').focus();
  await page.keyboard.insertText('Is revision 3 final?');
  await expect(hint(page)).toHaveText('Replying to researcher mock (last speaker)');
  await page.keyboard.press('ControlOrMeta+a');
  await page.keyboard.press('Backspace');
  await expect(hint(page)).toHaveText('');
});

test('#1437 one menu button adds a file or an agent, or opens the commands, by keyboard', async ({ page }) => {
  await room(page);
  await expect(page.locator('.composer-box button'), 'the menu button and Send').toHaveCount(2);
  await menuButton(page).focus();
  await page.keyboard.press('Enter');
  const menu = page.getByRole('menu', { name: 'Add or run' });
  for (const item of ['Upload from computer', 'From the project folder', 'From a boilerplate', 'Commands and skills'])
    await expect(menu.getByRole('menuitem', { name: new RegExp(`^${item}`) })).toBeVisible();
  // The last item, by wrapping round from the first.
  await page.keyboard.press('ArrowUp');
  await focusIs(page, /^menuitem: \/?Commands and skills/);
  await page.keyboard.press('Enter');
  await expect(page.locator('#slash-list')).toBeVisible();
  await expect(page.locator('#composer-input')).toHaveValue('/');
  await expect(page.locator('#composer-input')).toBeFocused();
});
