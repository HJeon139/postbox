// #934: an app that calls postbox.send several times in one click has them stored in the order it sent them. The page
// posts each send on its own, so with nothing ordering them the server could store a later one first. The page now
// sends an app’s sends one after another; a failed one doesn’t hold back the rest. One click starts one turn (#1488):
// the first send of the burst is an event, and the rest are notes its agent reads with read_app, in the same order.

import { expect, test } from '@playwright/test';
import * as arrange from '../arrange.mjs';
import { clickApp, frameOf } from './app-pointer.mjs';
import { allowPageError, failOnPageErrors, startPostbox, synced } from './postbox.mjs';

// Seven, as the button measured in #1488 sent: past the old limit of five a minute, which raised a card.
const N = 7;
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
// Without MessageEvent.userActivation, Firefox sends every app send as a note (#76, #1488), so no click starts a turn here.
test.skip(({ browserName }) => browserName !== 'chromium', 'app sends need MessageEvent.userActivation (#76)');

/**
 * A conversation with @librarian showing the burst app, loaded, with each event POST counted and the first held until
 * the test lets it go. Returns the steps its voices name in stored order, and when the page has taken every send.
 */
async function burstApp(page, name) {
  const { rt, store } = app;
  const held = { requests: 0, /** @type {(how: 'continue' | 'fail') => void} */ release: () => {} };
  await page.route(/\/api\/apps\/[^/]+\/(event|note)$/, async (route) => {
    held.requests++;
    if (held.requests > 1) return route.continue();
    const how = await new Promise((r) => {
      held.release = r;
    });
    if (how === 'continue') return route.continue();
    return route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: 'The server failed this one.' }) });
  });
  const t = rt.createThread({ projectId: Object.values(rt.store.state.projects)[0].id, title: name, personaIds: [arrange.persona(rt, 'librarian').id] });
  const se = arrange.agentIn(rt, t.id);
  await page.goto(`${app.origin}/#/t/${t.id}`);
  await synced(page, app);
  const id = `burst-${t.id}`;
  rt.toolsFor(se.id).show_app({ id, title: name, code: BURST, permissions: [] });
  await expect.poll(() => rt.store.state.apps[id]?.check.status, { message: 'the app to pass its check' }).toMatch(/^(passed|note)$/);
  await expect(frameOf(page, name), 'the app to load').toHaveAttribute('data-sized', '1');
  const voices = () => store.items(t.id).filter((x) => x.kind === 'voice' && x.appId === id);
  const notes = () => rt.store.state.appNotes[id]?.notes ?? [];
  // The event’s step, then the notes’: every note follows the click’s one event.
  const steps = () => [...voices().map((x) => Number(/Step (\d+)/.exec(x.quote ?? x.text)?.[1])), ...notes().map((n) => n.values.i)];
  /** Clicks, waits until the page has taken all N sends, and until any it posted beside the held one are stored. */
  const click = async () => {
    await clickApp(page, name);
    await expect.poll(() => rt.store.state.apps[id]?.state?.queued, { message: 'the page took every send' }).toBe(N);
    if (held.requests > 1) await expect.poll(() => steps().length, { message: 'the sends posted beside the held one' }).toBe(N - 1);
  };
  return { steps, voices, notes, click, held };
}

test('#934, #1488 one click’s sends are one turn and the rest notes, stored in the order the app sent them, though the server answers the first last', async ({
  page,
}) => {
  const { steps, voices, notes, click, held } = await burstApp(page, 'Burst in order');
  await click();
  held.release('continue');
  await expect.poll(steps, { message: `all ${N} sends stored` }).toHaveLength(N);
  expect(steps()).toEqual(Array.from({ length: N }, (_, i) => i + 1));
  expect(voices(), 'one line in your voice: one turn').toHaveLength(1);
  expect(notes(), 'the rest are notes').toHaveLength(N - 1);
  await expect(page.getByText('wants to send'), 'no card asks you to allow them').toHaveCount(0);
});

test('#934 a send that fails doesn’t hold back the ones after it, which are still stored in order', async ({ page }) => {
  allowPageError(page, /500|server failed/i);
  const { steps, click, held } = await burstApp(page, 'Burst after a failure');
  await click();
  held.release('fail');
  await expect.poll(steps, { message: `the ${N - 1} sends after the failed one stored` }).toHaveLength(N - 1);
  expect(steps()).toEqual(Array.from({ length: N - 1 }, (_, i) => i + 2));
});

test('#934 a send that never gets an answer doesn’t hold back the ones after it for long', async ({ page }) => {
  const { steps, click } = await burstApp(page, 'Burst past a stuck send');
  await click();
  // The first POST is never answered; the chain moves on once its turn has waited long enough.
  await expect.poll(steps, { message: `the ${N - 1} sends after the stuck one stored`, timeout: 20_000 }).toHaveLength(N - 1);
  expect(steps()).toEqual(Array.from({ length: N - 1 }, (_, i) => i + 2));
});
