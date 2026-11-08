// The browser’s ResizeObserver loop warning isn’t a crash (#960). An app whose ResizeObserver callback resizes what
// it observes makes Chromium fire an error event with no error object, “ResizeObserver loop completed with
// undelivered notifications”: the rest is delivered next frame and nothing is wrong. Postbox used to shut such an app
// down with “stopped working”, and once an app that drew kept running (#964), it showed an error strip under it. A real
// script error is still reported.

import { expect, test } from '@playwright/test';
import { frameOf } from './app-pointer.mjs';
import { failOnPageErrors, startPostbox, synced } from './postbox.mjs';

// Grows its box from its own ResizeObserver callback a few times, which raises the loop warning, and saves what the
// window saw, so the test knows the warning really fired in the shown frame.
const LOOPS = `<main style="padding:12px"><div id="box" style="height:40px;background:var(--s1)"></div><p>Grows itself</p></main>
<script>
const seen = [];
addEventListener('error', (e) => { seen.push({ message: e.message, error: !!e.error }); });
const box = document.getElementById('box');
let n = 0;
new ResizeObserver(() => { if (n++ < 4) box.style.height = 40 + n * 10 + 'px'; }).observe(box);
postbox.ready.then(() => {
  if (postbox.check) return;
  setTimeout(() => postbox.saveState({ done: true, seen }), 300);
});
</script>`;
// Throws once it’s shown, outside its check. It draws nothing, so the error stops it whether or not an app that drew
// would keep running (#964).
const THROWS = `<script>
postbox.ready.then(() => {
  if (postbox.check) return;
  setTimeout(() => { throw new Error('a real failure'); }, 100);
});
</script>`;

/** @type {Awaited<ReturnType<typeof startPostbox>>} */
let app;
test.beforeAll(async () => {
  app = await startPostbox('app-resize-loop');
});
test.afterAll(async () => {
  await app?.stop();
});
/** A conversation of its own with @librarian, open in the page, where it shows one app that passes its check. */
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

test.describe('the warning', () => {
  failOnPageErrors(test);
  test('#960 an app that raises the ResizeObserver loop warning keeps running, and isn’t shown as stopped', async ({ page }) => {
    const id = await shown(page, 'Grows itself', LOOPS);
    await expect(frameOf(page, 'Grows itself'), 'the app to load').toHaveAttribute('data-sized', '1');
    await expect.poll(() => app.rt.s.apps[id]?.state?.done, { message: 'the app to say what it saw' }).toBe(true);
    // Not degenerate: the warning fired in the shown frame, as an error event with no error object.
    expect(app.rt.s.apps[id].state.seen).toContainEqual({ message: expect.stringMatching(/^ResizeObserver loop/), error: false });
    // Not reported at all: neither the card nor, for an app that drew, the error strip under it (#964).
    await expect(page.getByText('Grows itself stopped working')).toHaveCount(0);
    await expect(page.locator('.app-error')).toBeHidden();
    await expect(frameOf(page, 'Grows itself')).toBeVisible();
  });
});

// The page throws the app’s error, so this test can’t fail on page errors.
test('#960 an app that throws a real error is still stopped, and the card names the error', async ({ page }) => {
  await shown(page, 'Throws', THROWS);
  await expect(page.getByText('Throws stopped working')).toBeVisible();
  await expect(page.locator('.app-placeholder code')).toContainText('Error: a real failure');
});
