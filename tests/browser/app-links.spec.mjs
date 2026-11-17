// #1480: a web link in an agent app opens in a new tab when the person clicks it, and never on the app’s own: a link the
// app clicks by script, with nobody touching it, opens nothing. Postbox’s page stays where it was.

import { expect, test } from '@playwright/test';
import * as arrange from '../arrange.mjs';
import { clickApp, frameOf } from './app-pointer.mjs';
import { failOnPageErrors, startPostbox, synced } from './postbox.mjs';

// Its big button is a link. On load it clicks another link by script.
const LINKS = `<main style="padding:12px">
<a id="go" class="btn" href="https://example.invalid/clicked" style="display:block;height:120px">Open the other site</a>
</main>
<script>
postbox.ready.then(() => {
  if (postbox.check) return;
  const a = document.createElement('a');
  a.href = 'https://example.invalid/scripted';
  document.body.appendChild(a);
  a.click();
  postbox.saveState({ scripted: true });
});
</script>`;

/** @type {Awaited<ReturnType<typeof startPostbox>>} */
let app;
test.beforeAll(async () => {
  app = await startPostbox('app-links');
});
test.afterAll(async () => {
  await app?.stop();
});
failOnPageErrors(test);
// The click is checked with MessageEvent.userActivation, which only Chromium has (#76).
test.skip(({ browserName }) => browserName !== 'chromium', 'a link’s click is checked with MessageEvent.userActivation (#76)');

test('#1480 only a link the person clicks opens, in a new tab, and Postbox’s page stays', async ({ page, context }) => {
  const { rt } = app;
  const opened = [];
  await context.route('https://example.invalid/**', (route) => route.fulfill({ status: 200, contentType: 'text/html', body: '<title>Other</title>' }));
  context.on('page', (p) => opened.push(p));
  const t = rt.createThread({ projectId: Object.values(rt.store.state.projects)[0].id, title: 'Links', personaIds: [arrange.persona(rt, 'librarian').id] });
  const se = arrange.agentIn(rt, t.id);
  await page.goto(`${app.origin}/#/t/${t.id}`);
  await synced(page, app);
  const id = `links-${t.id}`;
  rt.toolsFor(se.id).show_app({ id, title: 'Links', code: LINKS, permissions: [] });
  await expect(frameOf(page, 'Links'), 'the app to load').toHaveAttribute('data-sized', '1');
  await expect.poll(() => rt.store.state.apps[id]?.state?.scripted, { message: 'the app clicked its link by script' }).toBe(true);
  const url = page.url();
  expect(opened, 'the scripted link opened nothing').toHaveLength(0);

  await clickApp(page, 'Links');
  await expect.poll(() => opened.map((p) => p.url()), { message: 'the clicked link opened a tab' }).toEqual(['https://example.invalid/clicked']);
  expect(page.url(), 'Postbox’s page stayed').toBe(url);
  await expect(frameOf(page, 'Links'), 'the app stayed on its page').toHaveAttribute('src', /\/sandbox\/app\//);
});
