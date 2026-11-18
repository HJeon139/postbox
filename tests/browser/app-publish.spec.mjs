// #1478: an app publishes its data from the browser, and its agent hears of it at its next turn: no card, no line in the
// person’s voice, nobody needing the person. The pre-display check’s frames run the app too, and publish nothing.

import { expect, test } from '@playwright/test';
import * as arrange from '../arrange.mjs';
import { clickApp, frameOf } from './app-pointer.mjs';
import { failOnPageErrors, startPostbox, synced } from './postbox.mjs';

// Publishes on load, and in a burst of 30 with a click on its big button, as an app does as the person drags or types.
// Each publish says whether its frame is one of the pre-display check’s hidden ones, which load with ?check.
const LIST = `<main style="padding:12px"><button id="b" class="btn" type="button" style="display:block;width:100%;height:120px">Rate Emma higher</button></main>
<script>
let rating = 3;
const check = new URLSearchParams(location.search).has('check');
const share = () => postbox.publish({ book: 'Emma', rating, check }).then((r) => postbox.saveState({ answered: r.ok }));
document.getElementById('b').addEventListener('click', () => { for (let i = 0; i < 30; i++) { rating++; share(); } });
postbox.ready.then(share);
</script>`;

/** @type {Awaited<ReturnType<typeof startPostbox>>} */
let app;
test.beforeAll(async () => {
  app = await startPostbox('app-publish');
});
test.afterAll(async () => {
  await app?.stop();
});
failOnPageErrors(test);

test('#1478 an app publishes on load and on each edit, the latest of a burst once; its agent gets one notice, and nobody needs the person', async ({
  page,
}) => {
  const { rt, store } = app;
  /** Each publish the page sent the server, in order. @type {any[]} */
  const sent = [];
  page.on('request', (r) => {
    if (r.method() === 'POST' && /\/api\/apps\/[^/]+\/publish$/.test(r.url())) sent.push(r.postDataJSON().data);
  });
  const t = rt.createThread({ projectId: Object.values(rt.store.state.projects)[0].id, title: 'List', personaIds: [arrange.persona(rt, 'librarian').id] });
  const se = arrange.agentIn(rt, t.id);
  await page.goto(`${app.origin}/#/t/${t.id}`);
  await synced(page, app);
  const id = `list-${t.id}`;
  rt.toolsFor(se.id).show_app({ id, title: 'List', code: LIST, permissions: [] });
  await expect(frameOf(page, 'List'), 'the app to load').toHaveAttribute('data-sized', '1');
  const notices = () => rt.delivery.waiting(se.id).filter((e) => e.source === 'notice' && e.text.startsWith(`[app ${id}]`));

  await expect.poll(() => rt.store.state.published[id]?.data, { message: 'what the app published on load' }).toEqual({ book: 'Emma', rating: 3, check: false });
  await expect.poll(() => rt.store.state.apps[id]?.state?.answered, { message: 'the app heard its publish was kept' }).toBe(true);
  const onLoad = sent.length;
  await clickApp(page, 'List');
  await expect.poll(() => rt.store.state.published[id]?.data?.rating, { message: 'the burst’s last publish' }).toBe(33);
  expect(sent.length - onLoad, 'a burst of 30 publishes sends the latest, not each one').toBeLessThanOrEqual(2);
  expect(sent.at(-1).rating, 'sent in order: the last one sent is the latest').toBe(33);
  expect(
    sent.filter((d) => d.check),
    'the pre-display check’s hidden frames publish nothing',
  ).toEqual([]);

  expect(notices(), 'one notice for the changes').toHaveLength(1);
  expect(rt.session(se.id).needs ?? null, 'nobody needs the person').toBe(null);
  expect(store.items(t.id).filter((x) => x.kind === 'voice' || x.kind === 'appsend')).toHaveLength(0);
  await expect(page.locator('.appsend')).toHaveCount(0);
});
