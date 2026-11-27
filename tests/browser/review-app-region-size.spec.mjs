// #856, a region over a resize and over an app that grows: a region is kept in px of the app’s page, with the width
// of the frame it was marked in, since a frame of another width may lay the app out another way. It’s drawn only in a
// frame as wide as that, and otherwise listed in words as not drawn. Content above a region doesn’t move when the app
// grows below it, so the region stays over what was marked.

import { expect, test } from '@playwright/test';
import { settled } from './postbox.mjs';
import { regionRoom } from './review-app-region-fixture.mjs';

const room = regionRoom('review-app-region-size');
const { review } = room;

test.use({ viewport: { width: 1280, height: 900 } });

// An app with a heading at its top, and a button that grows it below.
const GROWS = `<main style="padding:12px;color:var(--text)"><h2 id="title" style="margin:0 0 8px">Corpus summary</h2>
<button id="grow" class="btn" type="button">Show more</button><div id="more"></div></main>
<script>document.getElementById('grow').onclick = () => { document.getElementById('more').style.height = '600px'; };</script>`;

/** Drags across the layer over the app, between two points of the page, in CSS px. */
async function dragPx(page, block, from, to) {
  const layer = block.locator('.rv-marks.marking');
  await layer.evaluate((el) => el.scrollIntoView({ block: 'center' }));
  await page.mouse.move(...from);
  await page.mouse.down();
  await page.mouse.move(...to, { steps: 6 });
  await page.mouse.up();
}

/** Where an element of the app is on the page, in CSS px, from its box in the frame. */
async function boxIn(block, selector) {
  const box = await block.frameLocator('iframe.app-iframe').locator(selector).boundingBox();
  if (!box) throw new Error(`${selector} isn’t drawn in the app.`);
  return box;
}

test('#856 a region marked in a 1280 px window isn’t drawn at 375 px: it’s listed as marked at its width, and drawn again at 1280 px', async ({ page }) => {
  const { block, answer } = await review(page);
  const wide = await block.locator('iframe.app-iframe').evaluate((f) => f.clientWidth);
  await block.getByRole('button', { name: 'Mark a part of the app' }).click();
  const layer = await block.locator('.rv-marks.marking').boundingBox();
  if (!layer) throw new Error('The layer over the app has no box.');
  await dragPx(page, block, [layer.x + layer.width * 0.5, layer.y + 20], [layer.x + layer.width * 0.9, layer.y + 120]);
  await page.getByRole('textbox', { name: 'Comment on region 1' }).fill('The legend overlaps.');
  await block.getByRole('button', { name: 'Add draft comment' }).click();
  const drawn = block.locator('.rv-marks .rv-region[data-region="1"]');
  await expect(drawn, 'drawn in the frame it was marked in').toHaveCount(1);

  await page.setViewportSize({ width: 375, height: 812 });
  await expect(drawn, 'not drawn in a narrower frame, which may lay the app out another way').toHaveCount(0);
  const note = block.locator('.rv-pins').getByText(new RegExp(`On region 1 · .*, marked ${wide} px wide, so it isn’t drawn at this width$`));
  await expect(note, 'listed in words, with the width it was marked at').toBeVisible();

  await page.setViewportSize({ width: 1280, height: 900 });
  await expect(drawn, 'drawn again at the width it was marked at').toHaveCount(1);
  await expect(block.locator('.rv-pins').getByText(/isn’t drawn at this width/), 'and no longer listed as not drawn').toHaveCount(0);
  await block.getByRole('button', { name: 'Submit review', exact: true }).click();
  await expect.poll(answer, { message: 'the agent gets the region' }).toHaveLength(1);
  expect(answer()[0].region.width, 'with the width of the frame it was marked in').toBe(wide);
});

test('#856 a region stays over what was marked when the app grows below it', async ({ page }) => {
  const { block } = await review(page, {}, GROWS);
  await block.getByRole('button', { name: 'Mark a part of the app' }).click();
  await block.locator('.rv-marks.marking').evaluate((el) => el.scrollIntoView({ block: 'center' }));
  const title = await boxIn(block, '#title');
  await dragPx(page, block, [title.x, title.y], [title.x + title.width * 0.5, title.y + title.height]);
  await page.getByRole('textbox', { name: 'Comment on region 1' }).fill('Say what the corpus is.');
  await block.getByRole('button', { name: 'Add draft comment' }).click();
  const frame = block.locator('iframe.app-iframe');
  const before = await frame.evaluate((f) => f.getBoundingClientRect().height);
  // A frame takes the pointer once the pointer is over it (app-pointer.mjs), as a person’s hand gets there first.
  await block.locator('.rv-marks').evaluate((el) => el.scrollIntoView({ block: 'center' }));
  await settled(page);
  const grow = await boxIn(block, '#grow');
  await page.mouse.move(grow.x + grow.width / 2, grow.y + grow.height / 2);
  await page.mouse.click(grow.x + grow.width / 2, grow.y + grow.height / 2);
  await expect.poll(() => frame.evaluate((f) => f.getBoundingClientRect().height), { message: 'the app grew' }).toBeGreaterThan(before + 300);
  await block.locator('.rv-marks').evaluate((el) => el.scrollIntoView({ block: 'center' }));
  await settled(page);
  const drawn = await block.locator('.rv-marks .rv-region[data-region="1"]').boundingBox();
  const now = await boxIn(block, '#title');
  expect(drawn, 'the region is drawn').not.toBeNull();
  const off = Math.max(Math.abs((drawn?.y ?? 0) - now.y), Math.abs((drawn?.x ?? 0) - now.x));
  expect(off, `the region is still over the heading: drawn at ${JSON.stringify(drawn)}, the heading at ${JSON.stringify(now)}`).toBeLessThanOrEqual(3);
});
