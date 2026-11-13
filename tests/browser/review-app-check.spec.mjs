// #857: an app review shown while its app is still being checked. The review draws “Checking the app…” then, and must
// draw the app as soon as its check passes, as the transcript’s copy does, or the same failure if the check fails, with
// no reload. The page’s check result is held back (the POST to /api/apps/:id/check) until the review is on screen, so
// the review is always drawn while the check is pending. At 375 and 1280 px.

import { expect, test } from '@playwright/test';
import * as arrange from '../arrange.mjs';
import { failOnPageErrors, startPostbox, synced } from './postbox.mjs';

const PLAIN = (text) => `<main style="padding:12px;color:var(--text)"><h2>${text}</h2><p>Twelve books.</p></main>`;
const BROKEN = '<script>\nconst value = null;\nvalue.missing();\n</script>';

/** @type {Awaited<ReturnType<typeof startPostbox>>} */
let app;
let drawer;
test.beforeAll(async () => {
  app = await startPostbox('review-app-check');
  arrange.withAdapter(app.rt, { name: 'mock', async deliver() {} });
  drawer = app.rt.createPersona({ handle: 'drawer' });
});
test.afterAll(async () => {
  await app?.stop();
});

/**
 * A room open on the page whose app check results are held: shows an app and, at once, a review of it. Gives the
 * review's and the app's locators, and release(), which lets the held results through.
 */
async function appAndReview(page, title, id, code) {
  const { rt, store } = app;
  const thread = rt.createThread({ projectId: Object.values(store.state.projects)[0].id, title, personaIds: [drawer.id] });
  /** @type {import('@playwright/test').Route[]} */
  const held = [];
  let holding = true;
  await page.route('**/api/apps/*/check', (route) => (holding ? held.push(route) : route.continue()));
  await page.goto(`${app.origin}/#/t/${thread.id}`);
  await synced(page, app);
  const tools = rt.toolsFor(arrange.agentIn(rt, thread.id).id);
  tools.show_app({ id, title, code, permissions: [] });
  tools.show_block({ block: { id: `rv-${id}`, type: 'review', version: 1, fallback: 'Review the app', format: 'app', appId: id } });
  const reviewItem = store.items(thread.id).find((i) => i.kind === 'block' && i.block.id === `rv-${id}`);
  const appItem = store.items(thread.id).find((i) => i.kind === 'block' && i.block.id === id);
  const review = page.locator(`#main [data-key="${reviewItem.id}"]`);
  const shown = page.locator(`#main [data-key="${appItem.id}"]`);
  await expect(review, 'the review waits for the check').toContainText('Checking the app before showing it');
  await expect.poll(() => held.length, { message: 'the check’s result is held' }).toBeGreaterThan(0);
  const release = async () => {
    holding = false;
    for (const route of held.splice(0)) await route.continue();
  };
  return { review, shown, release, status: () => rt.store.state.apps[id].check.status };
}

for (const width of [375, 1280])
  test.describe(`${width} px`, () => {
    test.use({ viewport: { width, height: 900 } });

    // The failing app's own script error reaches the page's error events by design, so only the passing case checks them.
    test.describe('passing', () => {
      failOnPageErrors(test);
      test(`#857 an app review shown during its app’s check draws the app once the check passes, with no reload (${width} px)`, async ({ page }) => {
        const id = `passes-${width}`;
        const { review, shown, release, status } = await appAndReview(page, `Passes ${width}`, id, PLAIN('Corpus summary'));
        await release();
        await expect.poll(status, { message: 'the check passed', timeout: 15_000 }).toBe('passed');
        await expect(shown.locator('iframe.app-iframe'), 'the transcript’s copy is drawn').toHaveCount(1);
        await expect(review.locator('iframe.app-iframe'), 'the review’s copy is drawn too').toHaveCount(1);
        await expect(review).not.toContainText('Checking the app before showing it');
      });

      test(`#857 once drawn, an app review’s frame isn’t reloaded when its app saves state (${width} px)`, async ({ page }) => {
        const id = `saves-${width}`;
        const { review, release, status } = await appAndReview(page, `Saves ${width}`, id, PLAIN('Corpus summary'));
        await release();
        await expect.poll(status, { message: 'the check passed', timeout: 15_000 }).toBe('passed');
        const frame = review.locator('iframe.app-iframe');
        await expect(frame).toHaveCount(1);
        await frame.evaluate((f) => {
          f.dataset.marked = 'before the save';
        });
        app.rt.appState(id, { picked: 'Shape' });
        await expect.poll(() => app.store.state.apps[id].state?.picked, { message: 'the state is saved' }).toBe('Shape');
        await synced(page, app);
        await expect(review.locator('iframe.app-iframe[data-marked="before the save"]'), 'the same frame, not a reloaded one').toHaveCount(1);
      });
    });

    test(`#857 an app review shown during its app’s check shows the same failure as the transcript when it fails (${width} px)`, async ({ page }) => {
      const id = `fails-${width}`;
      const { review, shown, release, status } = await appAndReview(page, `Fails ${width}`, id, BROKEN);
      await release();
      await expect.poll(status, { message: 'the check found the script error', timeout: 15_000 }).toBe('crashed');
      await expect(shown).toContainText('stopped working');
      await expect(review).toContainText('stopped working');
      await expect(review).not.toContainText('Checking the app before showing it');
      await expect(review.locator('iframe.app-iframe')).toHaveCount(0);
    });
  });
