// #1726: an app frame mounted under a pointer that’s already resting on its place must become the frame that takes
// the pointer (app-pointer.mjs), or what the person types into it goes nowhere: the page gives the focus back to the
// page (apps.mjs, checkFocus). In CI the pointer rested on the app’s place 30 ms before its frame was inserted.

import { expect, test } from '@playwright/test';
import * as arrange from '../arrange.mjs';
import { failOnPageErrors, startPostbox, synced } from './postbox.mjs';

/** @type {Awaited<ReturnType<typeof startPostbox>>} */
let app;
test.beforeAll(async () => {
  app = await startPostbox('app-pointer-rest');
  arrange.withAdapter(app.rt, { name: 'mock', async deliver() {} });
});
test.afterAll(async () => {
  await app?.stop();
});
failOnPageErrors(test);

test('#1726 a frame mounted under a resting pointer takes it, so typing reaches the app', async ({ page }, info) => {
  const id = `rest-app-${info.repeatEachIndex}`;
  const { rt, store } = app;
  const thread = rt.createThread({ projectId: Object.values(store.state.projects)[0].id, title: 'Rest', personaIds: [arrange.persona(rt, 'researcher').id] });
  const tools = rt.toolsFor(arrange.agentIn(rt, thread.id).id);
  await page.goto(`${app.origin}/#/t/${thread.id}`);
  await synced(page, app);
  tools.show_app({ id, title: 'Rest app', code: '<label>Draft <input id="draft"></label>' });
  // The pointer comes to rest on the app’s place while its check runs, before its frame is there.
  const body = page.locator(`.app-body[data-app-id="${id}"]`);
  await expect(body).toBeVisible();
  await expect(page.locator('iframe.app-iframe[title="Rest app"]')).toHaveCount(0);
  const box = await body.boundingBox();
  if (!box) throw new Error('The app’s place has no box.');
  await page.mouse.move(box.x + 40, box.y + 20);
  const iframe = page.locator('iframe.app-iframe[title="Rest app"]');
  await expect(iframe, 'the frame mounts under the resting pointer').toHaveCount(1, { timeout: 30_000 });
  await expect(iframe, 'and takes the pointer, with no move').toHaveClass(/\blive\b/);
  await iframe.contentFrame().locator('#draft').fill('typed');
  await expect(iframe.contentFrame().locator('#draft')).toHaveValue('typed');
  await expect.poll(() => page.evaluate(() => document.activeElement?.getAttribute('title')), { message: 'the app keeps the keyboard' }).toBe('Rest app');
});
