// net.fetch in a browser: an app gets public data through Postbox, while its own frame still reaches nothing, and what it
// fetched shows quietly in its agent’s activity. A local stand-in server plays the public site, through the allow list.

import http from 'node:http';
import { expect, test } from '@playwright/test';
import * as arrange from '../arrange.mjs';
import { frameOf } from './app-pointer.mjs';
import { allowPageError, failOnPageErrors, startPostbox, synced } from './postbox.mjs';

/** @type {Awaited<ReturnType<typeof startPostbox>>} */
let app;
/** @type {http.Server} */
let site;
let host = '';
test.beforeAll(async () => {
  site = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json', 'access-control-allow-origin': '*' });
    res.end(JSON.stringify({ visits: [120, 135, 160], cookie: req.headers.cookie ?? null }));
  });
  await new Promise((r) => site.listen(0, '127.0.0.1', () => r(undefined)));
  host = `127.0.0.1:${/** @type {any} */ (site.address()).port}`;
  process.env.POSTBOX_FETCH_ALLOW = host;
  app = await startPostbox('app-net-fetch');
});
test.afterAll(async () => {
  await app?.stop();
  site?.close();
  delete process.env.POSTBOX_FETCH_ALLOW;
});
failOnPageErrors(test);

// Tries its own fetch first, which the sandbox blocks, then net.fetch twice, and saves what each did.
const VISITS = (url) => `<main style="padding:12px"><p id="out">Loading</p></main>
<script>
postbox.ready.then(async () => {
  if (postbox.check) return;
  const own = await fetch(${JSON.stringify(url)}).then(() => 'reached', () => 'blocked');
  const a = await postbox.query('net.fetch', { url: ${JSON.stringify(url)} });
  const b = await postbox.query('net.fetch', { url: ${JSON.stringify(url)} });
  const data = JSON.parse(a.text);
  document.getElementById('out').textContent = data.visits.join(', ');
  postbox.saveState({ own, status: a.status, again: b.status, visits: data.visits, cookie: data.cookie });
});
</script>`;

test('an app gets public data through Postbox with no cookies, its own fetch stays blocked, and its agent’s activity says so', async ({ page }) => {
  const { rt, store } = app;
  // The app’s own fetch is blocked by its policy on purpose, and Chrome logs that twice.
  allowPageError(page, /Content Security Policy/, { times: 2 });
  const t = rt.createThread({ projectId: Object.values(rt.store.state.projects)[0].id, title: 'Visits', personaIds: [arrange.persona(rt, 'librarian').id] });
  const se = arrange.agentIn(rt, t.id);
  const reply = rt.threads.addItem(t.id, {
    kind: 'agent',
    sessionId: se.id,
    turnId: 'tu_visits',
    text: 'Here are the visits.',
    status: 'done',
    activity: { steps: [] },
  });
  await page.goto(`${app.origin}/#/t/${t.id}`);
  await synced(page, app);
  const id = `visits-${t.id}`;
  rt.toolsFor(se.id).show_app({ id, title: 'Visits', code: VISITS(`http://${host}/data.json`), permissions: ['net.fetch'] });
  await expect(frameOf(page, 'Visits'), 'the app to load').toHaveAttribute('data-sized', '1');
  const state = () => rt.store.state.apps[id]?.state ?? {};

  await expect.poll(() => state().status, { message: 'net.fetch answered' }).toBe(200);
  expect(state()).toMatchObject({ own: 'blocked', again: 200, visits: [120, 135, 160], cookie: null });
  await expect
    .poll(() => store.item(t.id, reply.id).activity.steps.map((s) => s.label), { message: 'the fetch in the agent’s activity' })
    .toEqual([`Visits fetched ${host} ×2`]);
  expect(rt.session(se.id).needs ?? null, 'nobody needs the person').toBe(null);
  await expect(page.locator('.toast'), 'no notification').toHaveCount(0);
});
