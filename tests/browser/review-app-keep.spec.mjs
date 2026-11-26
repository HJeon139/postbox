// #1726: a review of an app rebuilt the whole block on every comment action, the app included, so a click on a part’s
// tag, on “Comment on the whole app”, or on Add draft comment reloaded the app the person was reviewing, and what
// they had done in it was lost. In CI the same reload tore the frame down while the click on its tag was still being
// delivered, and the click hung. Now the comments change around the app, and its frame stays.

import { expect, test } from '@playwright/test';
import * as arrange from '../arrange.mjs';
import { failOnPageErrors, startPostbox, synced } from './postbox.mjs';

// An app that names a part, and holds what the person types in it.
const APP = `<main style="padding:12px;color:var(--text)"><h2 id="t">Corpus summary</h2>
<input id="q" aria-label="Filter" style="width:160px"></main>
<script>postbox.anchors({ title: document.getElementById('t') });</script>`;

/** @type {Awaited<ReturnType<typeof startPostbox>>} */
let app;
test.beforeAll(async () => {
  app = await startPostbox('review-app-keep');
  arrange.withAdapter(app.rt, { name: 'mock', async deliver() {} });
});
test.afterAll(async () => {
  await app?.stop();
});
failOnPageErrors(test);

test('#1726 commenting on an app in a review keeps the app as the person left it: same frame, what they typed still there', async ({ page }) => {
  const { rt, store } = app;
  const thread = rt.createThread({ projectId: Object.values(store.state.projects)[0].id, title: 'Keep', personaIds: [arrange.persona(rt, 'researcher').id] });
  const tools = rt.toolsFor(arrange.agentIn(rt, thread.id).id);
  tools.show_app({ id: 'kept', title: 'Corpus summary', code: APP });
  tools.show_block({ block: { id: 'rv-kept', type: 'review', version: 1, title: 'Corpus summary', fallback: 'Review the app', format: 'app', appId: 'kept' } });
  await page.goto(`${app.origin}/#/t/${thread.id}`);
  await synced(page, app);
  await expect.poll(() => rt.store.state.apps.kept.check.status, { timeout: 15_000 }).toBe('passed');
  const item = store.items(thread.id).find((i) => i.kind === 'block' && i.block.id === 'rv-kept');
  const block = page.locator(`#main [data-key="${item.id}"]`);
  const iframe = block.locator('iframe.app-iframe');
  const frame = block.frameLocator('iframe.app-iframe');
  await expect(frame.locator('.pb-anchor-tag'), 'the app names its part').toHaveText(['title']);
  // The person types in the app, as they would to try it.
  const input = await frame.getByRole('textbox', { name: 'Filter' }).boundingBox();
  if (!input) throw new Error('The app’s field has no box.');
  await page.mouse.move(input.x + 20, input.y + input.height / 2, { steps: 4 });
  await expect(iframe, 'the app takes the pointer').toHaveCSS('pointer-events', 'auto');
  await page.mouse.click(input.x + 20, input.y + input.height / 2);
  await page.keyboard.type('poetry');
  await expect(frame.getByRole('textbox', { name: 'Filter' })).toHaveValue('poetry');
  await iframe.evaluate((el) => {
    el.dataset.kept = 'yes';
  });
  const same = async (what) => {
    await expect(block.locator('iframe.app-iframe[data-kept="yes"]'), `${what}: the same frame`).toHaveCount(1);
    await expect(block.getByRole('group', { name: 'Corpus summary', exact: true }), `${what}: the block is still named by its title`).toHaveCount(1);
    await expect(frame.getByRole('textbox', { name: 'Filter' }), `${what}: what the person typed`).toHaveValue('poetry');
    await expect(block.locator('.rv-pins p'), `${what}: the hint for the parts the app named`).toHaveText(
      'Or click a highlighted part of the app to comment on it.',
    );
  };
  // A comment on the whole app: the box opens, and is added as a draft.
  await block.getByRole('button', { name: 'Comment on the whole app' }).click();
  await expect(page.getByRole('textbox', { name: 'Comment on the whole app' })).toBeFocused();
  await same('opening a comment box');
  await page.keyboard.insertText('Needs units.');
  await block.getByRole('button', { name: 'Add draft comment' }).click();
  await expect(block.getByText('Needs units.')).toBeVisible();
  await same('adding a draft comment');
  // A part’s tag, clicked as a person does.
  const tag = await frame.getByRole('button', { name: 'Comment on title' }).boundingBox();
  if (!tag) throw new Error('The title’s tag has no box.');
  await page.mouse.move(tag.x + tag.width / 2, tag.y + tag.height / 2, { steps: 4 });
  await expect(iframe).toHaveCSS('pointer-events', 'auto');
  await page.mouse.click(tag.x + tag.width / 2, tag.y + tag.height / 2);
  await expect(page.getByRole('textbox', { name: 'Comment on title' }), 'a comment box on the title').toBeVisible();
  await same('a tag’s click');
  // The review still sends what was drafted.
  await expect(block.getByRole('button', { name: 'Submit review', exact: true })).toBeEnabled();
});

test('#1726 an app that isn’t drawn has no hint about its parts: what its frame named went with the frame', async ({ page }) => {
  const { rt, store } = app;
  const thread = rt.createThread({ projectId: Object.values(store.state.projects)[0].id, title: 'Hint', personaIds: [arrange.persona(rt, 'researcher').id] });
  const tools = rt.toolsFor(arrange.agentIn(rt, thread.id).id);
  tools.show_app({ id: 'hinted', title: 'Corpus summary', code: APP });
  tools.show_block({ block: { id: 'rv-hinted', type: 'review', version: 1, fallback: 'Review the app', format: 'app', appId: 'hinted' } });
  await page.goto(`${app.origin}/#/t/${thread.id}`);
  await synced(page, app);
  const item = store.items(thread.id).find((i) => i.kind === 'block' && i.block.id === 'rv-hinted');
  const block = page.locator(`#main [data-key="${item.id}"]`);
  await expect(block.locator('.rv-pins p')).toHaveText('Or click a highlighted part of the app to comment on it.');
  // The check holds the app back for its agent to fix: the review draws no app until it passes.
  store.emit('app', {
    ...store.state.apps.hinted,
    check: { status: 'fixing', attempt: 1, problems: [{ code: 'text-too-small', message: 'Labels are drawn under 9 px.' }] },
  });
  await synced(page, app);
  await expect(block.locator('iframe.app-iframe'), 'the app being fixed isn’t drawn').toHaveCount(0);
  await expect(block.locator('.rv-pins p'), 'no hint about parts of an app that isn’t there').toHaveText('');
});

test('#1726 an answered review of the same app, drawn again, leaves the open review its hint', async ({ page }) => {
  const { rt, store } = app;
  const thread = rt.createThread({ projectId: Object.values(store.state.projects)[0].id, title: 'Two', personaIds: [arrange.persona(rt, 'researcher').id] });
  const tools = rt.toolsFor(arrange.agentIn(rt, thread.id).id);
  tools.show_app({ id: 'twice', title: 'Corpus summary', code: APP });
  const review = (id) => {
    tools.show_block({ block: { id, type: 'review', version: 1, fallback: 'Review the app', format: 'app', appId: 'twice' } });
    return store.items(thread.id).find((i) => i.kind === 'block' && i.block.id === id);
  };
  const first = review('rv-first');
  arrange.setItem(rt, thread.id, first.id, { answered: true, answer: { action: 'approve', values: {}, read: false } });
  const open = review('rv-open');
  await page.goto(`${app.origin}/#/t/${thread.id}`);
  await synced(page, app);
  const block = page.locator(`#main [data-key="${open.id}"]`);
  const hint = block.locator('.rv-pins p[data-app-hint]');
  await expect(hint).toHaveText('Or click a highlighted part of the app to comment on it.');
  const answeredApp = `#main [data-key="${first.id}"] .rv-app`;
  await page.locator(answeredApp).evaluate((el) => el.setAttribute('data-first-draw', ''));
  // The answered review’s next frame never loads, so it never says what the app names: off screen, or waiting for
  // another app’s check, it wouldn’t either.
  await page.route('**/sandbox/app/twice/**', () => {});
  try {
    arrange.setItem(rt, thread.id, first.id, { answer: { action: 'approve', values: {}, read: true } });
    await synced(page, app);
    await expect(page.locator(`${answeredApp}:not([data-first-draw])`), 'the answered review is drawn again').toHaveCount(1);
    await block.getByRole('button', { name: 'Comment on the whole app', exact: true }).click();
    await expect(block.getByRole('textbox', { name: 'Comment on the whole app' })).toBeFocused();
    await expect(hint, 'the open review’s app is still there, and so is its hint').toHaveText('Or click a highlighted part of the app to comment on it.');
  } finally {
    await page.unrouteAll({ behavior: 'ignoreErrors' });
  }
});
