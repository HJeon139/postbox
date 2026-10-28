// An activity list keeps the open or closed state the person chose while its streaming reply re-renders (#488).

import { expect, test } from '@playwright/test';
import { failOnPageErrors, startPostbox, synced } from './postbox.mjs';

/** @type {Awaited<ReturnType<typeof startPostbox>>} */
let app;
let thread;
let addSteps = () => {};
let finish = () => {};
let addWait;
let finishWait;

test.beforeAll(async () => {
  addWait = new Promise((resolve) => {
    addSteps = resolve;
  });
  finishWait = new Promise((resolve) => {
    finish = resolve;
  });
  app = await startPostbox('activity-state');
  app.rt.adapters.register({
    name: 'mock',
    async deliver(_session, message, ctx) {
      if (message.text === 'New reply') {
        ctx.activity({ id: 'new-read', label: 'Read the result', state: 'done', ms: 10 });
        ctx.text('A separate reply.');
        return;
      }
      ctx.activity({ id: 'first-read', label: 'Read the request', state: 'done', ms: 10 });
      ctx.activity({ id: 'first-thought', kind: 'thought', label: 'Plan the work.', detail: 'Plan the work, then check each result.', state: 'done' });
      await addWait;
      ctx.activity({ id: 'second-read', label: 'Read the source', state: 'done', ms: 10 });
      ctx.activity({ id: 'search', label: 'grep for callers', state: 'done', ms: 10 });
      ctx.activity({ id: 'test', label: 'Run the focused test', state: 'done', ms: 10 });
      ctx.activity({ id: 'second-thought', kind: 'thought', label: 'Check the result.', detail: 'Check the result against the request.', state: 'done' });
      await finishWait;
      ctx.activity({ id: 'final-read', label: 'Read the final result', state: 'done', ms: 10 });
      ctx.text('Done.');
    },
  });
  const persona = app.rt.createPersona({ handle: 'worker' });
  thread = app.rt.createThread({ projectId: Object.values(app.store.state.projects)[0].id, title: 'Activity state', personaIds: [persona.id] });
});

test.afterAll(async () => {
  addSteps();
  finish();
  await app?.stop();
});

failOnPageErrors(test);
test.use({ colorScheme: 'light' });

test('#488 an invalid block’s raw details keep the state the person chose when the item updates', async ({ page }) => {
  await page.goto(`${app.origin}/#/t/${thread.id}`);
  await synced(page, app);
  const session = app.rt.sessionsIn(thread.id)[0];
  const shown = app.rt.toolsFor(session.id).show_block({
    block: { id: 'invalid-state', type: 'timeline', version: 1, title: 'Unknown block', fallback: 'Plain-text fallback.' },
  });
  expect(shown.ok, 'the unknown block is refused').toBe(false);
  const item = app.store.items(thread.id).find((entry) => entry.kind === 'block' && entry.raw?.id === 'invalid-state');
  expect(item, 'the invalid block is kept with its fallback').toBeTruthy();
  await synced(page, app);
  const raw = page.locator(`[data-key="${item.id}"] details.raw`);
  await raw.locator('> summary').click();
  await expect(raw).toHaveAttribute('open', '');

  app.rt.patchItem(thread.id, item.id, { errors: [...item.errors, 'A second validation error.'] });
  await synced(page, app);
  await expect(raw, 'the raw block stays open when its item is rebuilt').toHaveAttribute('open', '');
});

test('#488 an activity list and thought keep the state the person chose while the reply updates', async ({ page }) => {
  await page.goto(`${app.origin}/#/t/${thread.id}`);
  await synced(page, app);
  app.rt.sendMessage(thread.id, { text: 'Watch activity' });

  const activity = page.locator('details.activity');
  await expect(activity).toHaveCount(1);
  await activity.locator('> summary').click();
  const thought = activity.locator('details.step-text').filter({ hasText: 'Plan the work.' });
  await thought.locator('> summary').click();
  await expect(activity).toHaveAttribute('open', '');
  await expect(thought).toHaveAttribute('open', '');

  addSteps();
  await expect
    .poll(() => app.store.items(thread.id).find((item) => item.kind === 'agent')?.activity?.steps?.length, { message: 'three steps and a thought added' })
    .toBe(6);
  await synced(page, app);
  await expect(activity, 'the activity list stays open').toHaveAttribute('open', '');
  await expect(thought, 'the thought stays open').toHaveAttribute('open', '');
  await expect(activity.locator('.step-text', { hasText: 'Run the focused test' }), 'the newest step shows').toBeVisible();

  await activity.locator('> summary').click();
  await expect(activity).not.toHaveAttribute('open', '');
  finish();
  await expect.poll(() => app.rt.turns.size, { message: 'the first turn to finish' }).toBe(0);
  await synced(page, app);
  await expect(activity, 'closing the activity list survives its next update').not.toHaveAttribute('open', '');

  app.rt.sendMessage(thread.id, { text: 'New reply' });
  await expect.poll(() => app.rt.turns.size, { message: 'the second turn to finish' }).toBe(0);
  await synced(page, app);
  await expect(page.locator('details.activity')).toHaveCount(2);
  await expect(page.locator('details.activity').last(), 'a new reply starts closed').not.toHaveAttribute('open', '');
});
