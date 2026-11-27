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
async function review(page, extra = {}, code = BARE) {
  const { rt, store } = app;
  const n = ++rooms;
  const thread = rt.createThread({
    projectId: Object.values(store.state.projects)[0].id,
    title: `Region ${n}`,
    personaIds: [arrange.persona(rt, 'researcher').id],
  });
  const tools = rt.toolsFor(arrange.agentIn(rt, thread.id).id);
  const id = `region-app-${n}`;
  tools.show_app({ id, title: 'Corpus summary', code });
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
  /** The review’s agent updates it, with these fields over the block as shown. */
  const update = (/** @type {Record<string, any>} */ fields) => {
    const r = tools.update_block({ block: { ...store.item(thread.id, item.id).block, ...fields } });
    if (!r.ok) throw new Error(r.message);
  };
  return { block, answer, update, item: () => store.item(thread.id, item.id) };
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

test('#856 a room with two app reviews, opened afresh, draws a region marked on the first', async ({ page }) => {
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
  await block.getByRole('button', { name: 'Add draft comment' }).click();
  // The agent, which saw no region yet, comments on a place of its own as “region 1”.
  const theirs = { x: 0.6, y: 0.1, w: 0.2, h: 0.2, version: 1 };
  update({ threads: [{ id: 'a1', status: 'open', anchor: 'region 1', region: theirs, comments: [{ author: '@researcher', text: 'Is this axis right?' }] }] });
  const pins = block.locator('.rv-pins');
  await expect(pins.getByText('On region 1 · x 60%, y 10%, 20% × 20%, on v1'), 'the agent’s is listed where it is').toBeVisible();
  await expect(pins.getByText(/^On region 2 · x 10%, y 50%, 30% × 40%, on v1$/), 'the draft’s takes the next number').toBeVisible();
  expect(within(await drawnAt(block.locator('.rv-marks .rv-region[data-region="1"]')), theirs), 'region 1 is drawn where the agent put it').toBe(true);
  expect(
    within(await drawnAt(block.locator('.rv-marks .rv-region[data-region="2"]')), { x: 0.1, y: 0.5, w: 0.3, h: 0.4, version: 1 }),
    'region 2 where the person marked it',
  ).toBe(true);
  // A drawn region is a mark, not a control: it’s not in the interaction color.
  const colors = await block.locator('.rv-marks .rv-region[data-region="1"]').evaluate((el) => {
    const accent = getComputedStyle(document.documentElement).getPropertyValue('--accent').trim();
    const probe = document.body.appendChild(Object.assign(document.createElement('i'), { style: `color:${accent}` }));
    const amber = getComputedStyle(probe).color;
    probe.remove();
    return { border: getComputedStyle(el).borderTopColor, amber };
  });
  expect(colors.border, 'a drawn region isn’t amber').not.toBe(colors.amber);
  await block.getByRole('button', { name: /^Submit/ }).click();
  await expect.poll(() => answer()?.map((c) => c.anchor), { message: 'the answer keeps the draft’s new number' }).toEqual(['region 2']);
});
