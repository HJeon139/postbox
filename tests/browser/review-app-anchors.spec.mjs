// #855: comments on an app in a review attach to the parts it names with postbox.anchors. An app that names none had
// nothing to click, while the review still said “Click a highlighted part of the app to comment on it.” Now the review
// always offers a comment on the whole app, which reaches the agent as anchor “the whole app”, and its hint follows what
// the app names: none, or parts named at once or only after an await, as data apps do. An app that names parts keeps
// its name tags, and a tag’s click opens a comment box on that part. The first two apps are the issue’s repro.

import { expect, test } from '@playwright/test';
import * as arrange from '../arrange.mjs';
import { failOnPageErrors, startPostbox, synced } from './postbox.mjs';

const BARE = '<main style="padding:12px;color:var(--text)"><h2>Corpus summary</h2><p>Twelve books.</p></main>';
const NAMED = `<main style="padding:12px;color:var(--text)"><h2 id="t">Corpus summary</h2><div id="c" style="height:80px">Chart</div></main>
<script>postbox.anchors({ title: document.getElementById('t'), chart: document.getElementById('c') });</script>`;
// Parts named only once the app has its state, well after its page has loaded.
const LATE = `<main style="padding:12px;color:var(--text)"><h2 id="t">Corpus summary</h2></main>
<script>postbox.ready.then(() => new Promise((r) => setTimeout(r, 300))).then(() => postbox.anchors({ title: document.getElementById('t') }));</script>`;

/** @type {Awaited<ReturnType<typeof startPostbox>>} */
let app;
/** What the agents were sent. */
const calls = [];
test.beforeAll(async () => {
  app = await startPostbox('review-app-anchors');
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

/** A room with an app and a review of it, open on the page once the app has passed its check. */
async function review(page, id, code) {
  const { rt, store } = app;
  const thread = rt.createThread({
    projectId: Object.values(store.state.projects)[0].id,
    title: `Review ${id}`,
    personaIds: [arrange.persona(rt, 'researcher').id],
  });
  const tools = rt.toolsFor(arrange.agentIn(rt, thread.id).id);
  tools.show_app({ id, title: 'Corpus summary', code });
  const blockId = `rv-${id}`;
  tools.show_block({ block: { id: blockId, type: 'review', version: 1, fallback: 'Review the app', format: 'app', appId: id } });
  await page.goto(`${app.origin}/#/t/${thread.id}`);
  await synced(page, app);
  await expect.poll(() => rt.store.state.apps[id].check.status, { message: 'the app passes its check', timeout: 15_000 }).toBe('passed');
  const item = store.items(thread.id).find((i) => i.kind === 'block' && i.block.id === blockId);
  const block = page.locator(`#main [data-key="${item.id}"]`);
  await expect(block.locator('iframe.app-iframe'), 'the review draws the app').toHaveCount(1);
  return { block, blockId };
}

test('#855 an app that names no parts says so, and the person comments on the whole app', async ({ page }) => {
  const { block, blockId } = await review(page, 'bare', BARE);
  await expect(block.locator('.rv-pins p'), 'the hint says there’s nothing to click').toHaveText('This app marks no parts to comment on.');
  await block.getByRole('button', { name: 'Comment on the whole app' }).click();
  const box = page.getByRole('textbox', { name: 'Comment on the whole app' });
  await expect(box, 'a comment box on the whole app, with focus in it').toBeFocused();
  await page.keyboard.insertText('The numbers need units.');
  await block.getByRole('button', { name: 'Add draft comment' }).click();
  await block.getByRole('button', { name: 'Submit review', exact: true }).click();
  await expect
    .poll(() => calls.find((m) => m.kind === 'event' && m.event.blockId === blockId)?.event.values.comments, { message: 'the agent gets the comment' })
    .toEqual([expect.objectContaining({ anchor: 'the whole app', text: 'The numbers need units.' })]);
});

test('#855 an app that names parts keeps its tags, and a tag’s click opens a comment box on that part', async ({ page }) => {
  const { block } = await review(page, 'named', NAMED);
  await expect(block.locator('.rv-pins p'), 'the hint points at the highlighted parts').toHaveText('Or click a highlighted part of the app to comment on it.');
  await expect(block.getByRole('button', { name: 'Comment on the whole app' }), 'and the whole app still takes a comment').toBeVisible();
  const frame = block.frameLocator('iframe.app-iframe');
  await expect(frame.locator('.pb-anchor-tag'), 'a name tag on each part').toHaveText(['title', 'chart']);
  // As a person does: the pointer moves onto the app, which then takes it (app-pointer.mjs), and clicks the tag.
  const tag = await frame.getByRole('button', { name: 'Comment on chart' }).boundingBox();
  if (!tag) throw new Error('The chart’s tag has no box.');
  await page.mouse.move(tag.x + tag.width / 2, tag.y + tag.height / 2, { steps: 4 });
  await expect(block.locator('iframe.app-iframe'), 'the app takes the pointer').toHaveCSS('pointer-events', 'auto');
  await page.mouse.click(tag.x + tag.width / 2, tag.y + tag.height / 2);
  await expect(page.getByRole('textbox', { name: 'Comment on chart' }), 'a comment box on the chart').toBeVisible();
});

test('a click anywhere in a highlighted part opens a comment on it, and a click on a control in the part still works the app', async ({ page }) => {
  const PARTS = `<main style="padding:12px;color:var(--text)"><div id="c" style="height:120px;padding:8px">Chart<button id="b" type="button" style="color:var(--text);background:var(--panel)">Count</button><output id="o">0</output></div></main>
<script>document.getElementById('b').onclick = () => { const o = document.getElementById('o'); o.textContent = String(+o.textContent + 1); };
postbox.anchors({ chart: document.getElementById('c') });</script>`;
  const { block } = await review(page, 'parts', PARTS);
  const frame = block.frameLocator('iframe.app-iframe');
  // A spot in the chart’s outline, well away from its name tag and its button.
  const part = await frame.locator('#c').boundingBox();
  if (!part) throw new Error('The chart has no box.');
  const at = { x: part.x + part.width / 2, y: part.y + part.height - 12 };
  await page.mouse.move(at.x, at.y, { steps: 4 });
  await expect(block.locator('iframe.app-iframe'), 'the app takes the pointer').toHaveCSS('pointer-events', 'auto');
  await page.mouse.click(at.x, at.y);
  await expect(page.getByRole('textbox', { name: 'Comment on chart' }), 'a comment box on the chart').toBeVisible();
  await page.getByRole('textbox', { name: 'Comment on chart' }).press('Escape');
  // The app’s own button inside the part does what it does, and opens no comment.
  await frame.getByRole('button', { name: 'Count' }).click();
  await expect(frame.locator('#o')).toHaveText('1');
  await expect(page.getByRole('textbox', { name: 'Comment on chart' }), 'no comment box from the app’s button').toHaveCount(0);
});

test('#855 an app that names its parts only after an await gets the hint for its parts, not “no parts”', async ({ page }) => {
  const { block } = await review(page, 'late', LATE);
  await expect(block.locator('.rv-pins p'), 'once it names its title').toHaveText('Or click a highlighted part of the app to comment on it.');
  await expect(block.frameLocator('iframe.app-iframe').locator('.pb-anchor-tag'), 'its tag').toHaveText(['title']);
});

test('#855 a part an app names “the whole app” gets no tag, so it and the whole app never share a target', async ({ page }) => {
  const CLASH = `<main style="padding:12px;color:var(--text)"><h2 id="t">Corpus summary</h2><div id="c" style="height:80px">Chart</div></main>
<script>postbox.anchors({ 'the whole app': document.getElementById('t'), chart: document.getElementById('c') });</script>`;
  const { block, blockId } = await review(page, 'clash', CLASH);
  const frame = block.frameLocator('iframe.app-iframe');
  await expect(frame.locator('.pb-anchor-tag'), 'only the real part is tagged').toHaveText(['chart']);
  // A comment on the chart, by its tag, as a person does: the pointer moves onto the app, which then takes it.
  const tag = await frame.getByRole('button', { name: 'Comment on chart' }).boundingBox();
  if (!tag) throw new Error('The chart’s tag has no box.');
  await page.mouse.move(tag.x + tag.width / 2, tag.y + tag.height / 2, { steps: 4 });
  await expect(block.locator('iframe.app-iframe')).toHaveCSS('pointer-events', 'auto');
  await page.mouse.click(tag.x + tag.width / 2, tag.y + tag.height / 2);
  await page.getByRole('textbox', { name: 'Comment on chart' }).fill('Label the axis.');
  await block.getByRole('button', { name: 'Add draft comment' }).click();
  // And one on the whole app.
  await block.getByRole('button', { name: 'Comment on the whole app' }).click();
  await page.getByRole('textbox', { name: 'Comment on the whole app' }).fill('Too dense overall.');
  await block.getByRole('button', { name: 'Add draft comment' }).click();
  await block.getByRole('button', { name: 'Submit review', exact: true }).click();
  await expect
    .poll(() => calls.find((m) => m.kind === 'event' && m.event.blockId === blockId)?.event.values.comments, { message: 'the agent gets both comments' })
    .toEqual([
      expect.objectContaining({ anchor: 'chart', text: 'Label the axis.' }),
      expect.objectContaining({ anchor: 'the whole app', text: 'Too dense overall.' }),
    ]);
});
