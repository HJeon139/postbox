// One script error doesn’t unload an app that has drawn (#964). The sandbox already contains the app, so stopping it
// protects nothing and takes away a visual that was mostly fine. It keeps running, with a strip under it that names the
// error and offers Reload and Ask to fix. An app that drew nothing real (nothing at all, only an error message, or a
// blank canvas) still gets the “stopped working” card. app/kit/drawn.js decides which.
// The apps throw on purpose, so these tests don’t fail on page errors.

import { expect, test } from '@playwright/test';
import { frameOf } from './app-pointer.mjs';
import { startPostbox, synced } from './postbox.mjs';

/** An app that shows `body`, throws once it’s shown (not in its check), and saves state after the error. */
const throwsAfter = (body, error) => `${body}
<script>
postbox.ready.then(() => {
  if (postbox.check) return;
  setTimeout(() => { throw new Error('${error}'); }, 100);
  setTimeout(() => postbox.saveState({ after: true }), 600);
});
</script>`;
const DREW = throwsAfter(
  '<main style="padding:12px"><h2>Orders by week</h2><svg width="300" height="120"><rect width="200" height="80" fill="var(--s1)"/></svg></main>',
  'a later handler failed',
);
const NOTHING = throwsAfter('', 'nothing was drawn');
const ONLY_ERROR = throwsAfter('<main style="padding:12px"><p>Error: the data failed to load.</p></main>', 'no data');
const BLANK_CANVAS = throwsAfter('<main style="padding:12px"><canvas width="300" height="150"></canvas></main>', 'the canvas stayed blank');

/** @type {Awaited<ReturnType<typeof startPostbox>>} */
let app;
test.beforeAll(async () => {
  app = await startPostbox('app-runtime-error');
});
test.afterAll(async () => {
  await app?.stop();
});

/** A conversation of its own with @librarian, open in the page, where it shows one app once its check is done. */
async function shown(page, title, code) {
  const { rt } = app;
  const t = rt.createThread({ projectId: Object.values(rt.s.projects)[0].id, title, personaIds: [rt.personaByHandle('librarian').id] });
  const se = rt.sessionsIn(t.id)[0];
  await page.goto(`${app.origin}/#/t/${t.id}`);
  await synced(page, app);
  const id = `${title.toLowerCase().replace(/\W+/g, '-')}-${t.id}`;
  rt.toolsFor(se.id).show_app({ id, title, code, permissions: [] });
  await expect.poll(() => rt.s.apps[id]?.check.status, { message: `${title} to pass its check` }).toMatch(/^(passed|note)$/);
  return id;
}

test('#964 an app that drew keeps running after a script error, with the error named under it', async ({ page }) => {
  const id = await shown(page, 'Weekly orders', DREW);
  const strip = page.locator('.app-error');
  await expect(strip).toBeVisible();
  await expect(strip).toContainText('Weekly orders hit a script error and is still running');
  await expect(strip.locator('code')).toContainText('Error: a later handler failed');
  await expect(strip.getByRole('button', { name: 'Ask librarian to fix it' })).toBeVisible();
  await expect(page.getByText('Weekly orders stopped working')).toHaveCount(0);
  await expect(frameOf(page, 'Weekly orders')).toBeVisible();
  await expect.poll(() => app.rt.s.apps[id]?.state?.after, { message: 'the app to run on after its error' }).toBe(true);

  await test.step('Reload app loads it again, without the strip until it throws again', async () => {
    await strip.getByRole('button', { name: 'Reload app' }).click();
    await expect(frameOf(page, 'Weekly orders')).toBeVisible();
    await expect(page.locator('.app-error code')).toContainText('Error: a later handler failed');
  });
});

for (const [title, code, error] of [
  ['Shows nothing', NOTHING, 'nothing was drawn'],
  ['Shows only an error', ONLY_ERROR, 'no data'],
  ['Blank canvas', BLANK_CANVAS, 'the canvas stayed blank'],
])
  test(`#964 ${title.toLowerCase()}: a script error still shuts it, with the card naming the error`, async ({ page }) => {
    await shown(page, title, code);
    await expect(page.getByText(`${title} stopped working`)).toBeVisible();
    await expect(page.locator('.app-placeholder code')).toContainText(`Error: ${error}`);
    await expect(page.locator('.app-error')).toBeHidden();
  });
