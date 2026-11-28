// #856: in an app review the person clicks a point or drags a box anywhere on the app, and comments on it, whether or
// not the app names parts. The comment carries the region in px of the app’s page, with the size of the frame it was
// marked in and the app version it was made on, and Postbox draws it over the app’s frame with its number, from a reload too. A person who
// can’t drag marks a box with the arrow keys. At 375 and 1280 px, as the issue asks.

import { expect, test } from '@playwright/test';
import { PHONE, synced } from './postbox.mjs';
import { drag, drawnAt, fractions, frameSize, PLACE, regionIn, regionRoom, within } from './review-app-region-fixture.mjs';

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
  expect(within(fractions(c.region), { x: 0.2, y: 0.3, w: 0.4, h: 0.4, version: 1 }), `the region is the box dragged: ${JSON.stringify(c.region)}`).toBe(true);
  await expect
    .poll(() => frameSize(block), { message: 'in px of the frame it was marked in' })
    .toMatchObject({ width: c.region.width, height: c.region.height });
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
  await expect.soft(pins.getByText(new RegExp(`^On region 1 · ${PLACE}$`)), 'and its place in words').toBeVisible();
  await expect.soft(pins.getByText(/^On region 2 · a point at x \d+, y \d+, on v1, in a \d+ × \d+ px frame$/), 'and the point’s').toBeVisible();
}

async function marksByKeyboard({ page }) {
  const { block, answer } = await review(page);
  const mark = block.getByRole('button', { name: 'Mark a part of the app' });
  const layer = block.getByRole('application', { name: 'Mark a part of the app' });
  const status = block.locator('[data-mark-status]');
  const size = await frameSize(block);
  const [x, y, w, h] = [size.width * 0.4, size.height * 0.4, size.width * 0.2, size.height * 0.2].map(Math.round);
  const said = (/** @type {number[]} */ [bx, by, bw, bh]) => `Marking x ${bx}, y ${by}, ${bw} × ${bh} px, on v1, in a ${size.width} × ${size.height} px frame.`;
  await mark.focus();
  await page.keyboard.press('Enter');
  await expect(layer, 'marking takes focus to the layer over the app').toBeFocused();
  await expect(status, 'the box starts centered, a fifth of the frame each way, said in words').toHaveText(said([x, y, w, h]));
  await page.keyboard.press('Escape');
  await expect(mark, 'Escape gives focus back to the button').toBeFocused();
  await expect(block.locator('.rv-marks.marking'), 'and stops marking').toHaveCount(0);

  await page.keyboard.press('Enter');
  await expect(layer).toBeFocused();
  for (const key of ['ArrowRight', 'ArrowRight', 'ArrowRight', 'ArrowRight', 'ArrowRight', 'ArrowDown', 'ArrowDown', 'ArrowDown', 'ArrowUp', 'ArrowLeft'])
    await page.keyboard.press(key);
  for (const key of ['Shift+ArrowRight', 'Shift+ArrowRight', 'Shift+ArrowUp']) await page.keyboard.press(key);
  // 8 px a key: right 4, down 2, wider 2 and shorter 1.
  await expect(status, 'moved and resized').toHaveText(said([x + 32, y + 16, w + 16, h - 8]));
  await page.keyboard.press('Enter');
  await expect(page.getByRole('textbox', { name: 'Comment on region 1' }), 'Enter opens a comment on it').toBeFocused();
  await page.keyboard.insertText('Move this up.');
  await block.getByRole('button', { name: 'Add draft comment' }).click();
  await block.getByRole('button', { name: 'Submit review', exact: true }).click();
  await expect.poll(answer, { message: 'the agent gets the box the keys marked' }).toEqual([
    {
      anchor: 'region 1',
      region: expect.objectContaining({ x: x + 32, y: y + 16, w: w + 16, h: h - 8, ...size, version: 1 }),
      text: 'Move this up.',
      threadId: expect.any(String),
    },
  ]);
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
  const { block, update } = await review(page);
  const size = await frameSize(block);
  const thread = (id, anchor, version) => ({
    id,
    status: 'open',
    anchor,
    region: regionIn(size, { x: 0.1, y: 0.1, w: 0.3, h: 0.3, version }),
    comments: [{ author: '@researcher', text: `On v${version}.` }],
  });
  update({ threads: [thread('a1', 'region 1', 1), thread('a2', 'region 2', 2)] });
  await expect(block.locator('.rv-marks .rv-region[data-region="1"]'), 'the region on the version shown is drawn').toHaveCount(1);
  await expect(block.locator('.rv-marks .rv-region[data-region="2"]'), 'the one on v2 isn’t').toHaveCount(0);
  await expect(
    block.locator('.rv-pins').getByText(/^On region 2 · x \d+, y \d+, \d+ × \d+ px, on v2, in a \d+ × \d+ px frame, so it isn’t drawn on this version$/),
  ).toBeVisible();
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

test('#856 a region carries what the app has under it, as the kit says: the parts it overlaps and the visible text of the element at its center', async ({
  page,
}) => {
  const named = `<main style="padding:12px;color:var(--text)"><h2 id="t">Corpus summary</h2>
<div id="legend" class="key" style="padding:24px"><p id="total" class="big" style="margin:0;padding:16px">Twelve books, in three languages.<span style="display:none">hidden prompt</span></p></div></main>
<script>postbox.anchors({ title: document.getElementById('t'), legend: document.getElementById('legend') });</script>`;
  const { block, answer } = await review(page, {}, named);
  await block.getByRole('button', { name: 'Mark a part of the app' }).click();
  await block.locator('.rv-marks.marking').evaluate((el) => el.scrollIntoView({ block: 'center' }));
  const total = await block.frameLocator('iframe.app-iframe').locator('#total').boundingBox();
  if (!total) throw new Error('The app draws no #total.');
  await page.mouse.move(total.x + 8, total.y + 4);
  await page.mouse.down();
  await page.mouse.move(total.x + total.width - 8, total.y + total.height - 4, { steps: 6 });
  await page.mouse.up();
  await page.getByRole('textbox', { name: 'Comment on region 1' }).fill('Say which languages.');
  await block.getByRole('button', { name: 'Add draft comment' }).click();
  await block.getByRole('button', { name: 'Submit review', exact: true }).click();
  await expect.poll(answer, { message: 'the agent gets the comment' }).toHaveLength(1);
  expect(answer()[0].region.under, 'with the part it overlaps, and the element at its center').toEqual({
    parts: ['legend'],
    element: { tag: 'p', id: 'total', class: 'big', text: 'Twelve books, in three languages.' },
  });
});

test('#856 Mark a part of the app stays disabled when the app has no frame mounted', async ({ page }) => {
  const { block } = await review(page);
  const btn = block.getByRole('button', { name: 'Mark a part of the app' });
  await expect(btn, 'enabled once the app’s frame is mounted').toBeEnabled();
  // Remove the iframe from .app-body (as when an app is paused or pending its check): the observer disables the button.
  await block.locator('.app-body > iframe.app-iframe').evaluate((el) => el.remove());
  await expect(btn, 'disabled when no iframe.app-iframe is in .app-body').toBeDisabled();
});

test.describe('touch', () => {
  test.use({ viewport: { width: 375, height: 812 }, hasTouch: true });

  test('#856 tapping on a 375 px touch screen marks a point and submits it', async ({ page }) => {
    const { block, answer } = await review(page);
    await block.getByRole('button', { name: 'Mark a part of the app' }).tap();
    const layer = block.locator('.rv-marks.marking');
    await layer.evaluate((el) => el.scrollIntoView({ block: 'center' }));
    const r = await layer.boundingBox();
    if (!r) throw new Error('The layer over the app has no box.');
    await page.touchscreen.tap(r.x + r.width * 0.5, r.y + r.height * 0.4);
    await page.getByRole('textbox', { name: 'Comment on region 1' }).fill('Tight on a phone.');
    await block.getByRole('button', { name: 'Add draft comment' }).tap();
    await block.getByRole('button', { name: 'Submit review', exact: true }).tap();
    await expect.poll(answer, { message: 'the agent gets the tapped point' }).toHaveLength(1);
    expect(answer()[0].region).toMatchObject({ w: 0, h: 0, version: 1 });
    expect(answer()[0].region.width).toBeLessThanOrEqual(375);
  });
});
