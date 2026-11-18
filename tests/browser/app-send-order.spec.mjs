// #934: an app that calls postbox.send several times in one click has them stored in the order it sent them, and a
// failed or stuck one doesn’t hold back the rest. One click starts one turn (#1488): its first send is an event, and its
// later sends are notes its agent reads with read_app. The page sends an app’s notes at most once per 400 ms, the
// latest, with how many it replaced, so a burst is one turn and one note however its sends are spaced.

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
 * A conversation with @librarian showing an app, loaded: its lines in your voice, its notes, and its saved state.
 * @param {import('@playwright/test').Page} page @param {string} name @param {string} code
 */
async function showApp(page, name, code) {
  const { rt, store } = app;
  const t = rt.createThread({ projectId: Object.values(rt.store.state.projects)[0].id, title: name, personaIds: [arrange.persona(rt, 'librarian').id] });
  const se = arrange.agentIn(rt, t.id);
  await page.goto(`${app.origin}/#/t/${t.id}`);
  await synced(page, app);
  const id = `app-${t.id}`;
  rt.toolsFor(se.id).show_app({ id, title: name, code, permissions: [] });
  await expect.poll(() => rt.store.state.apps[id]?.check.status, { message: 'the app to pass its check' }).toMatch(/^(passed|note)$/);
  await expect(frameOf(page, name), 'the app to load').toHaveAttribute('data-sized', '1');
  const voices = () => store.items(t.id).filter((x) => x.kind === 'voice' && x.appId === id);
  const notes = () => rt.store.state.appNotes[id]?.notes ?? [];
  const state = () => rt.store.state.apps[id]?.state ?? {};
  return { voices, notes, state };
}

/** The burst app, with its first POST held until the test lets it go. */
async function burstApp(page, name) {
  const held = { /** @type {(how: 'continue' | 'fail') => void} */ release: () => {} };
  let first = true;
  await page.route(/\/api\/apps\/[^/]+\/event$/, async (route) => {
    if (!first) return route.continue();
    first = false;
    const how = await new Promise((r) => {
      held.release = r;
    });
    if (how === 'continue') return route.continue();
    return route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: 'The server failed this one.' }) });
  });
  const shown = await showApp(page, name, BURST);
  const step = (x) => Number(/Step (\d+)/.exec(x.quote ?? x.text)?.[1]);
  const click = async () => {
    await clickApp(page, name);
    await expect.poll(() => shown.state().queued, { message: 'the page took every send' }).toBe(N);
  };
  return { ...shown, step, click, held };
}

test('#934, #1488 one click’s burst is one turn and one note, the latest, stored while the first send waits for its answer', async ({ page }) => {
  const { voices, notes, step, click, held } = await burstApp(page, 'Burst in order');
  await click();
  await expect.poll(() => notes().map((n) => [n.values.i, n.replaced]), { message: 'the note, while the event waits' }).toEqual([[N, N - 2]]);
  held.release('continue');
  await expect.poll(() => voices().map(step), { message: 'the click’s one turn' }).toEqual([1]);
  await expect(page.getByText('wants to send'), 'no card asks you to allow them').toHaveCount(0);
});

test('#934 a send that fails doesn’t hold back the ones after it', async ({ page }) => {
  allowPageError(page, /500|server failed/i);
  const { voices, notes, click, held } = await burstApp(page, 'Burst after a failure');
  await click();
  held.release('fail');
  await expect.poll(() => notes().map((n) => n.values.i), { message: 'the burst’s note stored' }).toEqual([N]);
  expect(voices()).toHaveLength(0);
});

test('#934 a send that never gets an answer doesn’t hold back the ones after it', async ({ page }) => {
  const { notes, click } = await burstApp(page, 'Burst past a stuck send');
  await click();
  await expect.poll(() => notes().map((n) => n.values.i), { message: 'the burst’s note stored' }).toEqual([N]);
});

// One click whose handler awaits each send, sleeping between them for 100 ms to 1 s: all inside the click’s 5 s of
// activation, which a send doesn’t use up (#1488, the review’s probe: 120 ms apart gave 8 turns, 900 ms gave 6).
const SPACED = `<main style="padding:12px"><button id="go" class="btn" type="button" style="display:block;width:100%;height:120px">Go</button></main>
<script>
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
document.getElementById('go').addEventListener('click', async () => {
  const out = [];
  for (const gap of [0, 100, 120, 400, 900, 1000]) {
    await sleep(gap);
    const r = await postbox.send('step', { gap }, 'Step').catch((e) => ({ err: e.message }));
    out.push(r.noted ? 'noted' : r.err ? 'err' : 'sent');
  }
  postbox.saveState({ out });
});
</script>`;

test('#1488 one click whose sends come 100 ms to 1 s apart is one turn; the rest are notes', async ({ page }) => {
  const { voices, state } = await showApp(page, 'Spaced', SPACED);
  await clickApp(page, 'Spaced');
  await expect
    .poll(() => state().out, { message: 'the app recorded every answer', timeout: 15_000 })
    .toEqual(['sent', 'noted', 'noted', 'noted', 'noted', 'noted']);
  expect(voices(), 'one click, one turn').toHaveLength(1);
});

// One click whose handler awaits its first send before the next: the second arrives just after the first’s answer.
const AWAITED = `<main style="padding:12px"><button id="go" class="btn" type="button" style="display:block;width:100%;height:120px">Send two</button></main>
<script>
let clicks = 0;
document.getElementById('go').addEventListener('click', async () => {
  const c = ++clicks;
  const first = await postbox.send('step', { c, i: 1 }, 'Step 1');
  const second = await postbox.send('step', { c, i: 2 }, 'Step 2');
  postbox.saveState({ ['c' + c]: [first.noted ? 'noted' : 'sent', second.noted ? 'noted' : 'sent'] });
});
</script>`;

test('#1488 a click that awaits its first send before the next is one turn, and a second click starts a turn of its own', async ({ page }) => {
  const { voices, notes, state } = await showApp(page, 'Awaited', AWAITED);
  await clickApp(page, 'Awaited');
  await expect.poll(() => state().c1, { message: 'the first click’s answers' }).toEqual(['sent', 'noted']);
  expect(voices()).toHaveLength(1);
  expect(notes().map((n) => [n.values.c, n.values.i])).toEqual([[1, 2]]);
  // Within the first click’s 5 s of activation: a new click is a new gesture.
  await clickApp(page, 'Awaited');
  await expect.poll(() => state().c2, { message: 'the second click’s answers' }).toEqual(['sent', 'noted']);
  expect(voices(), 'one turn a click').toHaveLength(2);
});
