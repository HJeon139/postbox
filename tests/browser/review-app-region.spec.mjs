// #856: in an app review the person clicks a point or drags a box anywhere on the app, and comments on it, whether or
// not the app names parts. The comment carries the region as fractions of the app’s width and height, with the app
// version it was made on, and Postbox draws it over the app’s frame with its number, from a reload too. A person who
// can’t drag marks a box with the arrow keys. At 375 and 1280 px, as the issue asks.

import { expect, test } from '@playwright/test';
import * as arrange from '../arrange.mjs';
import { failOnPageErrors, PHONE, startPostbox, synced } from './postbox.mjs';

// An app that names no parts, tall enough to drag across.
const BARE = '<main style="height:320px;padding:12px;color:var(--text)"><h2>Corpus summary</h2><p>Twelve books.</p></main>';

/** @type {Awaited<ReturnType<typeof startPostbox>>} */
let app;
/** What the agents were sent. */
const calls = [];
test.beforeAll(async () => {
  app = await startPostbox('review-app-region');
  arrange.withAdapter(app.rt, {
    name: 'mock',
    async deliver(_session, message) {
      calls.push(message);
    },
  });
});
test.afterAll(async () => {
  await app?.stop();
});
failOnPageErrors(test);

let rooms = 0;
/** A room with an app and a review of it, open on the page once the app has passed its check. */
async function review(page, extra = {}) {
  const { rt, store } = app;
  const n = ++rooms;
  const thread = rt.createThread({
    projectId: Object.values(store.state.projects)[0].id,
    title: `Region ${n}`,
    personaIds: [arrange.persona(rt, 'researcher').id],
  });
  const tools = rt.toolsFor(arrange.agentIn(rt, thread.id).id);
  const id = `region-app-${n}`;
  tools.show_app({ id, title: 'Corpus summary', code: BARE });
  const blockId = `rv-region-${n}`;
  const shown = tools.show_block({ block: { id: blockId, type: 'review', version: 1, fallback: 'Review the app', format: 'app', appId: id, ...extra } });
  if (!shown.ok) throw new Error(shown.message);
  await page.goto(`${app.origin}/#/t/${thread.id}`);
  await synced(page, app);
  await expect.poll(() => rt.store.state.apps[id].check.status, { message: 'the app passes its check', timeout: 15_000 }).toBe('passed');
  const item = store.items(thread.id).find((i) => i.kind === 'block' && i.block.id === blockId);
  const block = page.locator(`#main [data-key="${item.id}"]`);
  await expect(block.locator('iframe.app-iframe'), 'the review draws the app').toHaveCount(1);
  await expect(block.locator('.app-body > .rv-marks'), 'with Postbox’s layer over its frame').toHaveCount(1);
  const answer = () => calls.find((m) => m.kind === 'event' && m.event.blockId === blockId)?.event.values.comments;
  return { block, answer, item: () => store.item(thread.id, item.id) };
}

/**
 * Drags across the layer over the app, from one point to another, each as fractions of its width and height, and ends
 * nudge pixels further each way, as a hand does.
 */
async function drag(page, block, from, to, nudge = 0) {
  const layer = block.locator('.rv-marks.marking');
  // Centered, so no part of it sits under the sticky top bar, which a narrow window leaves over the top of the view.
  await layer.evaluate((el) => el.scrollIntoView({ block: 'center' }));
  const r = await layer.boundingBox();
  if (!r) throw new Error('The layer over the app has no box.');
  await page.mouse.move(r.x + r.width * from[0], r.y + r.height * from[1]);
  await page.mouse.down();
  await page.mouse.move(r.x + r.width * to[0] + nudge, r.y + r.height * to[1] + nudge, { steps: 6 });
  await page.mouse.up();
}

/** Whether a region is about where it should be: within 2% of the app each way, on its version. */
const within = (got, want) => Object.keys(want).every((k) => Math.abs(got?.[k] - want[k]) <= (k === 'version' ? 0 : 0.02));

/** Where a drawn region is, as fractions of the app’s frame. */
const drawnAt = (drawn) =>
  drawn.evaluate((el) => {
    const r = el.getBoundingClientRect();
    const f = el.closest('.app-body')?.querySelector('iframe')?.getBoundingClientRect();
    if (!f) throw new Error('The region isn’t over an app’s frame.');
    return { x: (r.left - f.left) / f.width, y: (r.top - f.top) / f.height, w: r.width / f.width, h: r.height / f.height, version: 1 };
  });

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
    await synced(page, app);
    await expect.soft(block.locator('.rv-marks .rv-region[data-region="1"]'), 'the box, numbered').toHaveText('1');
    await expect.soft(block.locator('.rv-marks .rv-region.point[data-region="2"]'), 'the point, numbered').toHaveText('2');
    await expect.soft(block.getByText('The legend overlaps.'), 'its draft comment').toBeVisible();
    await block.getByRole('button', { name: 'Submit review', exact: true }).click();
    await expect.poll(() => item().answered, { message: 'the review is answered' }).toBe(true);
  });
  await page.reload();
  await synced(page, app);
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
