// A session’s changes reach the page as session.patch, with only the fields that changed (designs/508, “Store
// events”). The page applies it with the shared reducer, then tells its listeners a `session` change carrying the
// whole session, so every module in app/js that tests `ch.type === 'session'` and reads `ch.data.threadId` (agents,
// thread, shell, open asks…) keeps working unchanged.

import { expect, test } from '@playwright/test';
import { failOnPageErrors, startPostbox, synced } from './postbox.mjs';

/** @type {Awaited<ReturnType<typeof startPostbox>>} */
let app;

test.beforeAll(async () => {
  app = await startPostbox('session-patch', { demo: false });
  app.store.emit('project', { id: 'pr_patch', name: 'Patch', folder: app.root });
});
test.afterAll(async () => app?.stop());
failOnPageErrors(test);

test('a session.patch reaches the page’s listeners as a whole-session change, and the agent’s ring follows it', async ({ page }) => {
  const { rt } = app;
  const p = rt.createPersona({ handle: 'patcher' });
  const t = rt.createThread({ projectId: 'pr_patch', title: 'Patches', personaIds: [p.id] });
  const se = rt.sessionsIn(t.id)[0];
  await page.goto(`${app.origin}/#/t/${t.id}`);
  await synced(page, app);
  // What the page’s listeners hear, as the modules in app/js listen.
  await page.evaluate(() =>
    import('/app/js/client.mjs').then(({ client }) => {
      /** @type {any} */ (window).heard = [];
      client.on((ch) => {
        if (ch.type === 'session' || ch.type === 'session.patch') /** @type {any} */ (window).heard.push({ type: ch.type, data: ch.data });
      });
    }),
  );
  rt.updateSession(se.id, { state: 'think', currentStep: 'Thinking', ctx: 40 });
  await synced(page, app);
  const heard = await page.evaluate(() => /** @type {any} */ (window).heard);
  expect
    .soft(
      heard.map((/** @type {any} */ h) => h.type),
      'listeners hear a session change, never the patch',
    )
    .toEqual(['session']);
  expect.soft(heard[0]?.data, 'carrying the whole session').toMatchObject({ id: se.id, threadId: t.id, handle: 'patcher', state: 'think', ctx: 40 });
  // The Agents section repaints from it, as before.
  await expect.soft(page.locator(`.agents-sec pb-ring[data-session="${se.id}"]`)).toHaveAttribute('state', 'think');
  rt.updateSession(se.id, { state: 'idle', currentStep: undefined });
  await synced(page, app);
  await expect.soft(page.locator(`.agents-sec pb-ring[data-session="${se.id}"]`)).toHaveAttribute('state', 'idle');
  const last = await page.evaluate(() => /** @type {any} */ (window).heard.at(-1).data);
  expect.soft(Object.hasOwn(last, 'currentStep'), 'a field the server unset is gone in the page too').toBe(false);
});
