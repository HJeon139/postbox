// #934: an app that calls postbox.send several times in one click has them stored in the order it sent them. The page
// posts each send on its own, so with nothing ordering them the server could store a later one first. The page now
// sends an app’s events one after another; a failed one doesn’t hold back the rest.

import { expect, test } from '@playwright/test';
import { Runtime } from '../../server/runtime.mjs';
import { clickApp, frameOf } from './app-pointer.mjs';
import { allowPageError, failOnPageErrors, startPostbox, synced } from './postbox.mjs';

const N = Runtime.APP_SEND_LIMIT;
// One click sends N events at once, none awaited, as an app that reports several steps might.
const BURST = `<main style="padding:12px"><button id="go" class="btn" type="button" style="display:block;width:100%;height:120px">Send all</button></main>
<script>
document.getElementById('go').addEventListener('click', () => {
  for (let i = 1; i <= ${N}; i++) postbox.send('step', { i }, 'Step ' + i).catch(() => {});
  postbox.saveState({ queued: ${N} });
});
</script>`;

/** @type {Awaited<ReturnType<typeof startPostbox>>} */
let app;
test.beforeAll(async () => {
  app = await startPostbox('app-send-order');
});
test.afterAll(async () => {
  await app?.stop();
});
failOnPageErrors(test);
// Without MessageEvent.userActivation, Firefox sends no app event without a card (#76), so none reaches the order here.
test.skip(({ browserName }) => browserName !== 'chromium', 'app sends need MessageEvent.userActivation (#76)');

/**
 * A conversation with @librarian showing the burst app, loaded, with each event POST counted and the first held until
 * the test lets it go. Returns the steps its voices name in stored order, and when the page has taken every send.
 */
async function burstApp(page, name) {
  const { rt, store } = app;
  const held = { requests: 0, /** @type {(how: 'continue' | 'fail') => void} */ release: () => {} };
  await page.route('**/api/apps/*/event', async (route) => {
    held.requests++;
    if (held.requests > 1) return route.continue();
    const how = await new Promise((r) => {
      held.release = r;
    });
    if (how === 'continue') return route.continue();
    return route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: 'The server failed this one.' }) });
  });
  const t = rt.createThread({ projectId: Object.values(rt.s.projects)[0].id, title: name, personaIds: [rt.personaByHandle('librarian').id] });
  const se = rt.sessionsIn(t.id)[0];
  await page.goto(`${app.origin}/#/t/${t.id}`);
  await synced(page, app);
  const id = `burst-${t.id}`;
  rt.toolsFor(se.id).show_app({ id, title: name, code: BURST, permissions: [] });
  await expect.poll(() => rt.s.apps[id]?.check.status, { message: 'the app to pass its check' }).toMatch(/^(passed|note)$/);
  await expect(frameOf(page, name), 'the app to load').toHaveAttribute('data-sized', '1');
  const steps = () =>
    store
      .items(t.id)
      .filter((x) => x.kind === 'voice' && x.appId === id)
      .map((x) => Number(/Step (\d+)/.exec(x.quote ?? x.text)?.[1]));
  /** Clicks, waits until the page has taken all N sends, and until any it posted beside the held one are stored. */
  const click = async () => {
    await clickApp(page, name);
    await expect.poll(() => rt.s.apps[id]?.state?.queued, { message: 'the page took every send' }).toBe(N);
    if (held.requests > 1) await expect.poll(() => steps().length, { message: 'the sends posted beside the held one' }).toBe(N - 1);
  };
  return { steps, click, held };
}

test('#934 sends from one click are stored in the order the app sent them, though the server answers the first last', async ({ page }) => {
  const { steps, click, held } = await burstApp(page, 'Burst in order');
  await click();
  held.release('continue');
  await expect.poll(steps, { message: `all ${N} sends stored` }).toHaveLength(N);
  expect(steps()).toEqual(Array.from({ length: N }, (_, i) => i + 1));
});

test('#934 a send that fails doesn’t hold back the ones after it, which are still stored in order', async ({ page }) => {
  allowPageError(page, /500|server failed/i);
  const { steps, click, held } = await burstApp(page, 'Burst after a failure');
  await click();
  held.release('fail');
  await expect.poll(steps, { message: `the ${N - 1} sends after the failed one stored` }).toHaveLength(N - 1);
  expect(steps()).toEqual(Array.from({ length: N - 1 }, (_, i) => i + 2));
});
