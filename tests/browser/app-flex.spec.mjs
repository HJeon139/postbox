// The flexible-apps prototype (designs/prototypes/flexible-apps.md), in a browser: an app publishes its data for its
// agent with no card and nobody needing the person; a form’s submit event fires; a web link opens in a new tab only
// when the person clicks it, and never replaces Postbox’s page.

import { expect, test } from '@playwright/test';
import * as arrange from '../arrange.mjs';
import { clickApp, frameOf } from './app-pointer.mjs';
import { failOnPageErrors, startPostbox, synced } from './postbox.mjs';

// Its big button is a link to another site. On load it publishes, submits its form by script, and clicks its own
// link by script, which Postbox mustn’t follow: nobody clicked.
const FLEX = `<main style="padding:12px">
<a id="go" class="btn" href="https://example.invalid/clicked" style="display:block;height:120px">Open the other site</a>
<form id="f"><label>Name <input id="n" value="Ada"></label><button type="submit">Save</button></form>
</main>
<script>
const st = {};
document.getElementById('f').addEventListener('submit', (e) => { e.preventDefault(); st.submitted = true; postbox.saveState(st); });
postbox.ready.then(() => {
  if (postbox.check) return;
  postbox.publish({ name: document.getElementById('n').value }).then((r) => { st.published = r.ok; postbox.saveState(st); });
  document.getElementById('f').requestSubmit();
  const a = document.createElement('a');
  a.href = 'https://example.invalid/scripted';
  document.body.appendChild(a);
  a.click();
});
</script>`;

/** @type {Awaited<ReturnType<typeof startPostbox>>} */
let app;
test.beforeAll(async () => {
  app = await startPostbox('app-flex');
});
test.afterAll(async () => {
  await app?.stop();
});
failOnPageErrors(test);
test.skip(({ browserName }) => browserName !== 'chromium', 'a link’s click is checked with MessageEvent.userActivation (#76)');

test('an app publishes with no card, its form submits, and only a clicked link opens, in a new tab', async ({ page, context }) => {
  const { rt } = app;
  const opened = [];
  await context.route('https://example.invalid/**', (route) => route.fulfill({ status: 200, contentType: 'text/html', body: '<title>Other</title>' }));
  context.on('page', (p) => opened.push(p));
  const t = rt.createThread({ projectId: Object.values(rt.store.state.projects)[0].id, title: 'Flex', personaIds: [arrange.persona(rt, 'librarian').id] });
  const se = arrange.agentIn(rt, t.id);
  await page.goto(`${app.origin}/#/t/${t.id}`);
  await synced(page, app);
  const id = `flex-${t.id}`;
  rt.toolsFor(se.id).show_app({ id, title: 'Flex', code: FLEX, permissions: [] });
  await expect(frameOf(page, 'Flex'), 'the app to load').toHaveAttribute('data-sized', '1');
  const state = () => rt.store.state.apps[id]?.state ?? {};

  await expect.poll(() => rt.store.state.apps[id]?.published, { message: 'what the app published' }).toEqual({ name: 'Ada' });
  await expect.poll(() => state().submitted, { message: 'the form’s submit event fired' }).toBe(true);
  expect(
    rt.delivery.waiting(se.id).some((e) => e.source === 'notice' && e.text.startsWith(`[app ${id}]`)),
    'a notice waits for the agent',
  ).toBe(true);
  expect(rt.session(se.id).needs ?? null, 'nobody needs the person').toBe(null);
  await expect(page.locator('.appsend')).toHaveCount(0);
  expect(opened, 'the scripted link opened nothing').toHaveLength(0);

  const url = page.url();
  await clickApp(page, 'Flex');
  await expect.poll(() => opened.map((p) => p.url()), { message: 'the clicked link opened a tab' }).toEqual(['https://example.invalid/clicked']);
  expect(page.url(), 'Postbox’s page stayed').toBe(url);
});
