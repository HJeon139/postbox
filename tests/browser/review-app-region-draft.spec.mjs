// #856, a region’s draft: what the person typed on a region they marked is kept as its draft comment, when an Edit
// closes its box or another box opens, and a region an agent numbers first while the draft is open is drawn beside the
// draft’s, which takes the next number. A room with two app reviews draws each one’s regions on its own app.

import { expect, test } from '@playwright/test';
import * as arrange from '../arrange.mjs';
import { synced } from './postbox.mjs';
import { BARE, drag, drawnAt, regionRoom, within } from './review-app-region-fixture.mjs';

const room = regionRoom('review-app-region-draft');
const { review } = room;

test('#856 an Edit while a region’s comment is open keeps what was typed on the region as its draft comment', async ({ page }) => {
  const { block } = await review(page);
  await block.getByRole('button', { name: 'Comment on the whole app' }).click();
  await page.keyboard.insertText('Too much text.');
  await block.getByRole('button', { name: 'Add draft comment' }).click();
  await block.getByRole('button', { name: 'Mark a part of the app' }).click();
  await drag(page, block, [0.2, 0.3], [0.6, 0.7]);
  await expect(page.getByRole('textbox', { name: 'Comment on region 1' })).toBeFocused();
  await page.keyboard.insertText('This gap is too wide.');
  // A region can’t be reopened to bring parked text back, so the Edit keeps it as a draft instead.
  await block.getByRole('button', { name: /^Edit your comment on/ }).click();
  const drafted = block.locator('.rv-thread', { has: page.locator('.status-tag.draft') });
  await expect(drafted.filter({ hasText: 'This gap is too wide.' }), 'what was typed on the region is a draft').toHaveCount(1);
  await expect(block.locator('.rv-marks .rv-region[data-region="1"]'), 'and its region is still drawn').toHaveCount(1);
});

test('#856 a room with two app reviews, opened afresh, draws a region marked on the first', async ({ page }) => {
  const app = room.app;
  const { rt, store } = app;
  const thread = rt.createThread({
    projectId: Object.values(store.state.projects)[0].id,
    title: 'Two reviews',
    personaIds: [arrange.persona(rt, 'researcher').id],
  });
  const tools = rt.toolsFor(arrange.agentIn(rt, thread.id).id);
  for (const n of [1, 2]) {
    tools.show_app({ id: `two-app-${n}`, title: `Summary ${n}`, code: BARE });
    tools.show_block({ block: { id: `rv-two-${n}`, type: 'review', version: 1, fallback: 'Review the app', format: 'app', appId: `two-app-${n}` } });
  }
  await page.goto(`${app.origin}/#/t/${thread.id}`);
  await synced(page, app);
  for (const n of [1, 2])
    await expect.poll(() => rt.store.state.apps[`two-app-${n}`].check.status, { message: `app ${n} passes its check`, timeout: 15_000 }).toBe('passed');
  // Opened afresh, the page builds the room’s items off the page, both reviews with them, before it shows them.
  await page.reload();
  await synced(page, app);
  const first = store.items(thread.id).find((i) => i.kind === 'block' && i.block.id === 'rv-two-1');
  const block = page.locator(`#main [data-key="${first.id}"]`);
  await expect(block.locator('.app-body > .rv-marks'), 'the first review’s layer is over its frame').toHaveCount(1);
  await block.getByRole('button', { name: 'Mark a part of the app' }).click();
  await drag(page, block, [0.1, 0.5], [0.4, 0.9]);
  await page.getByRole('textbox', { name: 'Comment on region 1' }).fill('The legend overlaps.');
  await block.getByRole('button', { name: 'Add draft comment' }).click();
  await expect(block.locator('.rv-marks .rv-region[data-region="1"]'), 'its region is drawn on its app').toHaveCount(1);
});

test('#856 a region an agent numbers first while the person’s draft is open is drawn beside the draft’s, which takes the next number', async ({ page }) => {
  const { block, update, answer } = await review(page);
  await block.getByRole('button', { name: 'Mark a part of the app' }).click();
  await drag(page, block, [0.1, 0.5], [0.4, 0.9]);
  await page.getByRole('textbox', { name: 'Comment on region 1' }).fill('The legend overlaps.');
  // The agent, which saw no region yet, comments on a place of its own as “region 1”, while the person’s box is open.
  const theirs = { x: 0.6, y: 0.1, w: 0.2, h: 0.2, version: 1 };
  update({ threads: [{ id: 'a1', status: 'open', anchor: 'region 1', region: theirs, comments: [{ author: '@researcher', text: 'Is this axis right?' }] }] });
  const open = page.getByRole('textbox', { name: 'Comment on region 2' });
  await expect(open, 'the open box is on region 2 now').toHaveValue('The legend overlaps.');
  await expect(open, 'and keeps the focus').toBeFocused();
  await block.getByRole('button', { name: 'Add draft comment' }).click();
  const pins = block.locator('.rv-pins');
  await expect(pins.getByText('On region 1 · x 60%, y 10%, 20% × 20%, on v1'), 'the agent’s is listed where it is').toBeVisible();
  await expect(pins.getByText(/^On region 2 · x 10%, y 50%, 30% × 40%, on v1$/), 'the draft’s takes the next number').toBeVisible();
  expect(within(await drawnAt(block.locator('.rv-marks .rv-region[data-region="1"]')), theirs), 'region 1 is drawn where the agent put it').toBe(true);
  expect(
    within(await drawnAt(block.locator('.rv-marks .rv-region[data-region="2"]')), { x: 0.1, y: 0.5, w: 0.3, h: 0.4, version: 1 }),
    'region 2 where the person marked it',
  ).toBe(true);
  // A drawn region is a mark, not a control: it’s in the text’s color, not amber, with a halo that sets it off the app.
  const colors = await block.locator('.rv-marks .rv-region[data-region="1"]').evaluate((el) => {
    const css = (/** @type {string} */ token) => {
      const probe = document.body.appendChild(Object.assign(document.createElement('i'), { style: `color:var(${token})` }));
      const c = getComputedStyle(probe).color;
      probe.remove();
      return c;
    };
    const s = getComputedStyle(el);
    return { border: s.borderTopColor, text: css('--text'), amber: css('--accent'), panel: css('--panel'), halo: s.boxShadow };
  });
  expect(colors.border, 'a drawn region isn’t amber').not.toBe(colors.amber);
  expect(colors.border, 'it’s in the text’s color').toBe(colors.text);
  expect(colors.halo, 'with a halo in the panel’s color').toContain(colors.panel);
  await block.getByRole('button', { name: /^Submit/ }).click();
  await expect.poll(() => answer()?.map((c) => c.anchor), { message: 'the answer keeps the draft’s new number' }).toEqual(['region 2']);
});

test('#856 what was typed on a region stays as its draft comment when the person marks another', async ({ page }) => {
  const { block, answer } = await review(page);
  await block.getByRole('button', { name: 'Mark a part of the app' }).click();
  await drag(page, block, [0.1, 0.5], [0.4, 0.9]);
  await page.getByRole('textbox', { name: 'Comment on region 1' }).fill('The legend overlaps.');
  await block.getByRole('button', { name: 'Mark a part of the app' }).click();
  await drag(page, block, [0.6, 0.1], [0.8, 0.3]);
  await expect(page.getByRole('textbox', { name: 'Comment on region 2' }), 'the new mark opens its box').toBeFocused();
  const drafted = block.locator('.rv-thread', { has: page.locator('.status-tag.draft') });
  await expect(drafted.filter({ hasText: 'The legend overlaps.' }), 'what was typed on region 1 is its draft').toHaveCount(1);
  await expect(block.locator('.rv-marks .rv-region[data-region="1"]'), 'and region 1 is still drawn').toHaveCount(1);
  await expect(block.locator('.rv-pins').getByText(/^On region 1 · x 10%, y 50%, 30% × 40%, on v1$/), 'on the place it was typed on').toBeVisible();
  await expect(page.getByRole('textbox', { name: 'Comment on region 2' }), 'the new box starts empty').toHaveValue('');
  await page.getByRole('textbox', { name: 'Comment on region 2' }).fill('This axis is cut off.');
  await block.getByRole('button', { name: /^Submit/ }).click();
  await expect
    .poll(() => answer()?.map((c) => [c.anchor, Math.round(c.region.x * 10) / 10, c.text]), { message: 'each text on its own region' })
    .toEqual([
      ['region 1', 0.1, 'The legend overlaps.'],
      ['region 2', 0.6, 'This axis is cut off.'],
    ]);
});

test('#856 a region’s box left blank takes no number: the next mark is region 1 again', async ({ page }) => {
  const { block } = await review(page);
  await block.getByRole('button', { name: 'Mark a part of the app' }).click();
  await drag(page, block, [0.75, 0.2], [0.75, 0.2]);
  await expect(page.getByRole('textbox', { name: 'Comment on region 1' }), 'a point opens its box').toBeFocused();
  await block.getByRole('button', { name: 'Mark a part of the app' }).click();
  await drag(page, block, [0.1, 0.5], [0.4, 0.9]);
  await expect(page.getByRole('textbox', { name: 'Comment on region 1' }), 'the blank one was dropped, so this is region 1').toBeFocused();
  await expect(block.locator('.rv-marks .rv-region'), 'and only it is drawn').toHaveCount(1);
});
