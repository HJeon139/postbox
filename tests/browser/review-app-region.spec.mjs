// #856: in an app review the person clicks a point or drags a box anywhere on the app, and comments on it, whether or
// not the app names parts. The comment carries the region as fractions of the app’s width and height, with the app
// version it was made on, and Postbox draws it over the app’s frame with its number, from a reload too. A person who
// can’t drag marks a box with the arrow keys. At 375 and 1280 px, as the issue asks.

import { expect, test } from '@playwright/test';
import { PHONE, synced } from './postbox.mjs';
import { drag, drawnAt, regionRoom, within } from './review-app-region-fixture.mjs';

const room = regionRoom('review-app-region');
const { review } = room;

/** Marks a box and a point on a review, and adds a draft comment on each. */
async function markBoxAndPoint(page, block) {
  await block.getByRole('button', { name: 'Mark a part of the app' }).click();
  await drag(page, block, [0.1, 0.5], [0.4, 0.9]);
  await page.getByRole('textbox', { name: 'Comment on region 1' }).fill('The legend overlaps.');
  await block.getByRole('button', { name: 'Add draft comment' }).click();
  // A click marks a point, even one that moves a pixel or two between press and release.
  await block.getByRole('button', { name: 'Mark a part of the app' }).click();
  await drag(page, block, [0.75, 0.2], [0.75, 0.2], 2);
  await page.getByRole('textbox', { name: 'Comment on region 2' }).fill('This dot is the wrong color.');
  await block.getByRole('button', { name: 'Add draft comment' }).click();
}

async function dragsABox({ page }) {
  const { block, answer } = await review(page);
  await expect(block.locator('.rv-pins p').first(), 'the app names no parts').toHaveText('This app marks no parts to comment on.');
  await block.getByRole('button', { name: 'Mark a part of the app' }).click();
  await drag(page, block, [0.2, 0.3], [0.6, 0.7]);
  const box = page.getByRole('textbox', { name: 'Comment on region 1' });
  await expect(box, 'a comment box on the region, with focus in it').toBeFocused();
  await page.keyboard.insertText('This gap is too wide.');
  await block.getByRole('button', { name: 'Add draft comment' }).click();
  await block.getByRole('button', { name: 'Submit review', exact: true }).click();
  await expect.poll(answer, { message: 'the agent gets the comment on the region' }).toHaveLength(1);
  const [c] = answer();
  expect(c).toMatchObject({ anchor: 'region 1', text: 'This gap is too wide.' });
  expect(within(c.region, { x: 0.2, y: 0.3, w: 0.4, h: 0.4, version: 1 }), `the region is the box dragged: ${JSON.stringify(c.region)}`).toBe(true);
}

async function drawnOverReloads({ page }) {
  const { block, item } = await review(page);
  await markBoxAndPoint(page, block);
  await test.step('a draft’s region is kept over a reload', async () => {
    await page.reload();
    await synced(page, room.app);
    await expect.soft(block.locator('.rv-marks .rv-region[data-region="1"]'), 'the box, numbered').toHaveText('1');
    await expect.soft(block.locator('.rv-marks .rv-region.point[data-region="2"]'), 'the point, numbered').toHaveText('2');
    await expect.soft(block.getByText('The legend overlaps.'), 'its draft comment').toBeVisible();
    await block.getByRole('button', { name: 'Submit review', exact: true }).click();
    await expect.poll(() => item().answered, { message: 'the review is answered' }).toBe(true);
  });
  await page.reload();
  await synced(page, room.app);
  const drawn = block.locator('.rv-marks .rv-region[data-region="1"]');
  await expect.soft(drawn, 'the region is drawn on the app, numbered').toHaveText('1');
  await expect.soft(block.locator('.rv-marks .rv-region.point[data-region="2"]'), 'and the point').toHaveText('2');
  const at = await drawnAt(drawn);
  expect.soft(within(at, { x: 0.1, y: 0.5, w: 0.3, h: 0.4, version: 1 }), `drawn where it was marked: ${JSON.stringify(at)}`).toBe(true);
  await expect.soft(block.getByText('The legend overlaps.'), 'with its comment').toBeVisible();
  const pins = block.locator('.rv-pins');
  await expect.soft(pins.getByText(/^On region 1 · x 10%, y 50%, 30% × 40%, on v1$/), 'and its place in words').toBeVisible();
  await expect.soft(pins.getByText(/^On region 2 · a point at x 75%, y 20%, on v1$/), 'and the point’s').toBeVisible();
}

async function marksByKeyboard({ page }) {
  const { block, answer } = await review(page);
  const mark = block.getByRole('button', { name: 'Mark a part of the app' });
  const layer = block.getByRole('application', { name: 'Mark a part of the app' });
  const status = block.locator('[data-mark-status]');
  await mark.focus();
  await page.keyboard.press('Enter');
  await expect(layer, 'marking takes focus to the layer over the app').toBeFocused();
  await expect(status, 'the box starts centered, said in words').toHaveText('Marking x 40%, y 40%, 20% × 20%, on v1.');
  await page.keyboard.press('Escape');
  await expect(mark, 'Escape gives focus back to the button').toBeFocused();
  await expect(block.locator('.rv-marks.marking'), 'and stops marking').toHaveCount(0);

  await page.keyboard.press('Enter');
  await expect(layer).toBeFocused();
  for (const key of ['ArrowRight', 'ArrowRight', 'ArrowRight', 'ArrowRight', 'ArrowRight', 'ArrowDown', 'ArrowDown', 'ArrowDown', 'ArrowUp', 'ArrowLeft'])
    await page.keyboard.press(key);
  for (const key of ['Shift+ArrowRight', 'Shift+ArrowRight', 'Shift+ArrowUp']) await page.keyboard.press(key);
  await expect(status, 'moved and resized').toHaveText('Marking x 48%, y 44%, 24% × 18%, on v1.');
  await page.keyboard.press('Enter');
  await expect(page.getByRole('textbox', { name: 'Comment on region 1' }), 'Enter opens a comment on it').toBeFocused();
  await page.keyboard.insertText('Move this up.');
  await block.getByRole('button', { name: 'Add draft comment' }).click();
  await block.getByRole('button', { name: 'Submit review', exact: true }).click();
  await expect
    .poll(answer, { message: 'the agent gets the box the keys marked' })
    .toEqual([{ anchor: 'region 1', region: { x: 0.48, y: 0.44, w: 0.24, h: 0.18, version: 1 }, text: 'Move this up.', threadId: expect.any(String) }]);
}

for (const [label, use] of [
  ['1280 px', { viewport: { width: 1280, height: 900 } }],
  ['375 px', { viewport: { width: 375, height: 812 }, ...PHONE }],
]) {
  test.describe(`at ${label}`, () => {
    test.use(use);
    test('#856 a box dragged on an app that names no parts takes a comment, and the agent gets the region', dragsABox);
    test('#856 a region is drawn on the app with its number and listed with its comment, as a draft and once sent, over reloads', drawnOverReloads);
    test('#856 the keyboard marks a box: arrows move it, Shift resizes it, Enter comments, Escape stops', marksByKeyboard);
  });
}

test('#856 a region on another version of the app is listed, not drawn', async ({ page }) => {
  const thread = (id, anchor, version) => ({
    id,
    status: 'open',
    anchor,
    region: { x: 0.1, y: 0.1, w: 0.3, h: 0.3, version },
    comments: [{ author: '@researcher', text: `On v${version}.` }],
  });
  const { block } = await review(page, { threads: [thread('a1', 'region 1', 1), thread('a2', 'region 2', 2)] });
  await expect(block.locator('.rv-marks .rv-region[data-region="1"]'), 'the region on the version shown is drawn').toHaveCount(1);
  await expect(block.locator('.rv-marks .rv-region[data-region="2"]'), 'the one on v2 isn’t').toHaveCount(0);
  await expect(block.locator('.rv-pins').getByText('On region 2 · x 10%, y 10%, 30% × 30%, on v2, so it isn’t drawn on this version')).toBeVisible();
  await expect(block.getByText('On v2.'), 'its thread is still listed').toBeVisible();
});

test('#856 an app can’t name a part “region 1”: the regions the person marks take those names', async ({ page }) => {
  const named = `<main style="height:320px;padding:12px;color:var(--text)"><h2 id="t">Corpus summary</h2><p id="r">Twelve books.</p></main>
<script>postbox.anchors({ title: document.getElementById('t'), 'region 1': document.getElementById('r') });
// And it asks, itself, for a comment on its title, as a pin does, then on “region 1”, which would take its place.
postbox.ready.then(() => {
  parent.postMessage({ __pb: 1, type: 'pin', anchor: 'title' }, '*');
  parent.postMessage({ __pb: 1, type: 'pin', anchor: 'region 1' }, '*');
});</script>`;
  const { block } = await review(page, {}, named);
  const frame = block.frameLocator('iframe.app-iframe');
  await expect(frame.locator('.pb-anchor-tag'), 'only the part with another name is tagged').toHaveText(['title']);
  const onTitle = page.getByRole('textbox', { name: 'Comment on title' });
  await expect(onTitle, 'its pins are heard').toHaveCount(1);
  await expect(page.getByRole('textbox', { name: 'Comment on region 1' }), 'the app’s own pin on “region 1” opens nothing').toHaveCount(0);
  await expect(onTitle, 'and leaves the comment on its title open').toHaveCount(1);
  await block.getByRole('button', { name: 'Mark a part of the app' }).click();
  await drag(page, block, [0.2, 0.3], [0.6, 0.7]);
  await expect(page.getByRole('textbox', { name: 'Comment on region 1' }), 'the first mark is region 1').toBeFocused();
});
