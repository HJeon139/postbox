// #883: a failed side-thread turn’s line offers Dismiss beside Retry, as the room’s callout does, and Dismiss
// releases its need without running the turn again. Its own file, beside side-threads.spec.mjs (at its size cap),
// with the same held backend and side room.

import { expect, test } from '@playwright/test';
import { failOnPageErrors, startPostbox, synced } from './postbox.mjs';
import { heldBackend, sideRoom } from './side-threads.mjs';

/** @type {Awaited<ReturnType<typeof startPostbox>>} */
let app;
/** @type {ReturnType<typeof heldBackend>} */
let held;
test.beforeAll(async () => {
  app = await startPostbox('dismiss-failed-side');
  held = heldBackend(app);
});
test.afterAll(async () => {
  await app?.stop();
});
failOnPageErrors(test);

const rooms = [];
test.afterEach(() => {
  for (const r of rooms.splice(0)) r.stop();
});
function room(title) {
  const r = sideRoom(app, title);
  rooms.push(r);
  return r;
}
/** A side thread where @researcher answered @indexer’s wake. Returns the side thread. */
async function withSide(r) {
  const side = r.oldSide();
  held.scripts.set(r.researcher.id, (ctx) => ctx.text('The 1908 edition drops two chapters.'));
  r.runIn(side, r.researcher.id, 'Which editions differ?');
  await r.idle();
  return app.store.state.threads[side.id];
}
async function open(page, hash) {
  await page.goto(`${app.origin}/${hash}`);
  await synced(page, app);
  await expect(page.locator('header.topbar')).toBeVisible();
}

for (const width of [375, 1280])
  test.describe(`${width} px`, () => {
    test.use({ viewport: { width, height: 900 } });

    test(`#883 a failed side-thread turn’s line offers Dismiss beside Retry, and Dismiss releases its need without rerunning it (${width} px)`, async ({
      page,
    }) => {
      const { store } = app;
      const r = room('Dismissed');
      const side = await withSide(r);
      held.scripts.set(r.researcher.id, async () => {
        throw new Error('API 500');
      });
      r.runIn(side, r.researcher.id, 'Review the plan.');
      await expect.poll(() => store.state.sessions[r.researcher.id].state, { message: 'the failed turn' }).toBe('failed');
      await open(page, `#/t/${r.room.id}`);
      const line = page.locator('#main [data-side-sig]').filter({ has: page.locator('.pill', { hasText: '@researcher failed' }) });
      await expect(line.getByRole('button')).toHaveText(['Retry', 'Dismiss']);
      const before = held.turns.length;
      await line.getByRole('button', { name: /Dismiss/ }).click();
      await expect.poll(() => store.state.sessions[r.researcher.id].needs, { message: 'the need is released' }).toBe(null);
      expect(held.turns.length, 'nothing ran again').toBe(before);
    });
  });
