// The composer is its input row plus one line (#1437): the static help lives in the placeholder, the line under the
// input holds only the hints that apply while you type, one menu button adds a file or an agent or runs a command,
// and nothing above the input repeats the agent rows’ mail buttons. On the demo’s mock agents, in a room of its own
// where @researcher spoke last.

import { expect, test } from '@playwright/test';
import * as arrange from '../arrange.mjs';
import { failOnPageErrors, focusIs, settled, startPostbox, synced } from './postbox.mjs';

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
  const said = arrange.post(rt, t.id, {
    kind: 'agent',
    sessionId: researcher.id,
    personaId: researcher.personaId,
    handle: 'researcher',
    text: 'Done.',
    status: 'done',
  });
  arrange.putThread(rt, { ...store.state.threads[t.id], lastSpeaker: researcher.id });
  await page.setViewportSize({ width, height: 800 });
  await page.goto(`${app.origin}/#/t/${t.id}`);
  await synced(page, app);
  await expect(page.locator('#composer-input')).toBeVisible();
  return { t, said };
}
/** The same room with a topic thread on researcher’s message open in the thread panel. */
async function topic(page, width = 1280) {
  const { t, said } = await room(page, width);
  const { threadId } = app.rt.startTopic(t.id, said.id);
  await synced(page, app);
  await page.goto(`${app.origin}/#/t/${t.id}/side/${threadId}`);
  await synced(page, app);
  await expect(page.locator('#side-input')).toBeVisible();
}
/** Whether a text box’s placeholder fits on its one line, measured in the box’s own font. */
const placeholderFits = (page, id) =>
  page.locator(`#${id}`).evaluate((ta) => {
    const css = getComputedStyle(ta);
    const ctx = document.createElement('canvas').getContext('2d');
    if (!ctx) return false;
    ctx.font = css.font;
    const room = ta.clientWidth - parseFloat(css.paddingLeft) - parseFloat(css.paddingRight);
    return ctx.measureText(ta.placeholder).width <= room;
  });
/** The input’s top, once the layout holds still. */
async function inputTop(page, id) {
  await settled(page);
  return (await page.locator(`#${id}`).boundingBox())?.y ?? Number.NaN;
}
const hint = (page) => page.locator('.composer .hint');
const menuButton = (page) => page.locator('.composer-box').getByRole('button', { name: 'Add a file, an agent or a command' });

test('#1437 the empty composer has its help in the placeholder and an empty line under it, one line high', async ({ page }) => {
  await room(page);
  await expect(page.locator('#composer-input')).toHaveAttribute('placeholder', 'Reply to researcher · @ to wake an agent, / for commands, ! to run');
  await expect(hint(page), 'no static help under the input').toHaveText('');
  const box = await hint(page).boundingBox();
  expect(box?.height, 'the line keeps its one line of room').toBeGreaterThan(10);
  expect(box?.height, 'and only one').toBeLessThanOrEqual(20);
  await expect(page.locator('.composer')).not.toContainText('Enter to send');
  await expect(page.locator('.composer')).not.toContainText('for commands');
});

for (const width of [1280, 375]) {
  test(`#1437 the placeholder fits its own box, in the conversation and in the thread panel (${width} px)`, async ({ page }) => {
    await room(page, width);
    await expect(page.locator('#composer-input')).toHaveAttribute('placeholder', /^Reply to researcher/);
    expect(await placeholderFits(page, 'composer-input'), 'the conversation’s').toBe(true);
    await topic(page, width);
    await expect(page.locator('#side-input')).toHaveAttribute('placeholder', /^Reply in thread/);
    expect(await placeholderFits(page, 'side-input'), 'the thread panel’s').toBe(true);
    // The topic thread’s note stays, on its one line, while there is no draft.
    await expect(page.locator('.composer:has(#side-input) .hint')).toContainText('Replies stay here');
  });

  test(`#1437 the input doesn’t move as each hint appears (${width} px)`, async ({ page }) => {
    await room(page, width);
    const ta = page.locator('#composer-input');
    const before = await inputTop(page, 'composer-input');
    for (const [draft, says] of [
      ['Is revision 3 final?', 'Replying to'],
      ['critic: what’s left?', 'Did you mean'],
      ['!ls', 'Runs in'],
      ['@critic /compact', 'Enter runs'],
    ]) {
      await ta.focus();
      await page.keyboard.press('ControlOrMeta+a');
      await page.keyboard.insertText(draft);
      await expect(hint(page)).toContainText(says);
      expect.soft(await inputTop(page, 'composer-input'), `“${draft}” leaves the input where it was`).toBeCloseTo(before, 0);
      const row = await hint(page).boundingBox();
      // One 20 px row of words, under the 4 px that covers the gap from the card down (#1463).
      expect.soft(row?.height, `“${draft}”’s hint is one row`).toBeLessThanOrEqual(24);
    }
    // “Did you mean” fits whole on the row, and the clipped text is there in full for a pointer.
    await ta.focus();
    await page.keyboard.press('ControlOrMeta+a');
    await page.keyboard.insertText('critic: what’s left?');
    const fix = await hint(page).locator('.did-you-mean').boundingBox();
    const row = await hint(page).boundingBox();
    expect(fix && row && fix.y >= row.y - 0.5 && fix.y + fix.height <= row.y + row.height + 0.5, 'Did you mean is inside its row').toBe(true);
    await page.keyboard.press('ControlOrMeta+a');
    await page.keyboard.insertText('!ls');
    await expect(hint(page)).toHaveAttribute('title', /^Runs in /);
    // A clipped folder is cut in the middle: its last part, where the command runs, stays on screen (a phone has no
    // tooltip).
    const folder = app.store.state.projects[Object.keys(app.store.state.projects)[0]].folder;
    const tail = hint(page).locator('.folder-tail');
    await expect(tail).toHaveText(`/${folder.split('/').filter(Boolean).at(-1)}`);
    const shown = await tail.boundingBox();
    const line = await hint(page).boundingBox();
    expect(shown && line && shown.x + shown.width <= line.x + line.width + 0.5, 'the folder’s last part is inside the row').toBe(true);
    // The tooltip keeps the parts apart.
    await page.keyboard.press('ControlOrMeta+a');
    await page.keyboard.insertText('critic: what’s left?');
    await expect(hint(page)).toHaveAttribute('title', /@critic\? · Replying to researcher/);
  });

  test(`#1437 a thread panel’s input doesn’t move as its hint appears (${width} px)`, async ({ page }) => {
    await topic(page, width);
    const before = await inputTop(page, 'side-input');
    await page.locator('#side-input').focus();
    await page.keyboard.insertText('!ls');
    await expect(page.locator('.composer:has(#side-input) .hint')).toContainText('! runs commands only');
    expect(await inputTop(page, 'side-input')).toBeCloseTo(before, 0);
  });
}

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

for (const width of [768, 900])
  test(`#442 at ${width} px a thread panel opened over the conversation leaves its composer its width`, async ({ page }) => {
    await topic(page, width);
    // The panel covers the conversation here, so the column behind it keeps its own width.
    await settled(page);
    const box = await page.locator('#composer-input').boundingBox();
    expect(box?.width, 'the conversation’s input keeps room for its placeholder and quota line').toBeGreaterThan(300);
    expect(await placeholderFits(page, 'composer-input'), 'its placeholder fits').toBe(true);
  });
