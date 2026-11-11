// A resync with the transcript window off loads each open conversation whole, once (#1155): it reloaded the range it
// held, the default page of it, and the transcript then saw a partial room and loaded it all again.

import { expect, test } from '@playwright/test';
import { failOnPageErrors, newestShown, startPostbox, synced, wholeRoom } from './postbox.mjs';

/** @type {Awaited<ReturnType<typeof startPostbox>>} */
let app;
test.beforeAll(async () => {
  app = await startPostbox('resync-window-off');
});
test.afterAll(async () => app?.stop());
failOnPageErrors(test);
wholeRoom(test);

test('#1155 a resync with the window off loads the open conversation once, whole', async ({ page }) => {
  const projectId = /** @type {any} */ (Object.values(app.rt.s.projects)[0]).id;
  const room = app.rt.createThread({ projectId, title: 'A room of 300', personaIds: [] });
  for (let i = 0; i < 300; i++) app.rt.addItem(room.id, { kind: 'user', text: `Message ${i}` });
  await page.goto(`${app.origin}/#/t/${room.id}`);
  await synced(page, app);
  await newestShown(page, app, room.id);
  const loads = [];
  page.on('request', (r) => r.url().includes(`/api/threads/${room.id}/items`) && loads.push(new URL(r.url()).search));
  await page.evaluate(() => import('/app/js/client.mjs').then(({ load }) => load()));
  await synced(page, app);
  await expect(page.locator(`#main > .item[data-key="${app.store.items(room.id)[0].id}"]`), 'the first message, as the whole room').toBeAttached();
  expect(loads, 'one load, of the whole room').toEqual(['?limit=all']);
});
