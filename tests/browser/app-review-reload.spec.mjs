// #930: a review rendering a new app body called releaseApps() at once, while the transcript was still being built
// off the page. An app item above the review had made its frame and body, but they weren’t on the page yet, so the
// sweep dropped the frame’s record and stopped watching its body. That app then never heard its own messages: its
// hello, size, theme, sends and pins were ignored, and it stayed unsized.
//
// The app above is brought into view before its size is checked. Off screen, Chromium throttles a cross-origin frame’s
// rendering, and an app’s sandbox is cross-origin, so an app just above the view may not measure itself until it’s
// scrolled to. Checked where it lay, the case raced the view’s settle: it failed 1 in 10 on CI, and 2 in 20 and 1 in 40 here, with
// the app’s hello heard and no size sent.

import { expect, test } from '@playwright/test';
import * as arrange from '../arrange.mjs';
import { failOnPageErrors, settled, startPostbox, synced } from './postbox.mjs';

const TALL = '<main style="padding:12px"><button id="b" type="button" style="display:block;width:100%;height:160px">Big</button></main>';
/** @type {Awaited<ReturnType<typeof startPostbox>>} */
let app;
test.beforeAll(async () => {
  app = await startPostbox('app-review-reload');
});
test.afterAll(async () => app?.stop());
failOnPageErrors(test);

test('#930 an app above an open app review still loads after a reload', async ({ page }) => {
  const { rt } = app;
  const t = rt.createThread({
    projectId: Object.values(rt.store.state.projects)[0].id,
    title: 'Review reload',
    personaIds: [arrange.persona(rt, 'librarian').id],
  });
  const tools = rt.toolsFor(arrange.agentIn(rt, t.id).id);
  await page.goto(`${app.origin}/#/t/${t.id}`);
  await synced(page, app);
  const show = async (title) => {
    const id = `${title.toLowerCase()}-${t.id}`;
    tools.show_app({ id, title, code: TALL, permissions: [] });
    await expect.poll(() => rt.store.state.apps[id]?.check.status).toMatch(/^(passed|note)$/);
    return id;
  };
  await show('Above');
  const reviewed = await show('Reviewed');
  tools.show_block({ block: { id: 'rv1', type: 'review', version: 1, title: 'Reviewed', fallback: 'Review the app.', format: 'app', appId: reviewed } });
  await synced(page, app);
  await expect(page.locator('iframe.app-iframe[title="Above"]')).toHaveAttribute('data-sized', '1');
  await page.reload();
  await synced(page, app);
  await settled(page);
  await expect(page.locator('.rv-box iframe.app-iframe')).toHaveAttribute('data-sized', '1');
  const above = page.locator('.app-holder iframe.app-iframe[title="Above"]');
  await above.scrollIntoViewIfNeeded();
  await expect(above, 'the app above the review loads (its messages are heard)').toHaveAttribute('data-sized', '1', { timeout: 8000 });
});
