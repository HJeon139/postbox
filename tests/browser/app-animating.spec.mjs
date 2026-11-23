// #438: an agent’s app whose animation loop never stops is reported to its agent, with nothing shown to the person.
// The kit (app/kit/frames.js) reports a run of frames that lasts 30 s with no input from the person, once, however the
// app asks for its frames; one the person keeps going, a timer’s now-and-then redraw, or a loop that pauses longer than
// the kit’s gap is never reported. The spec
// sets the kit’s 30 s to IDLE_MS before each page loads (window.__pbIdleMs, read by app/kit/frames.js).

import { expect, test } from '@playwright/test';
import * as arrange from '../arrange.mjs';
import { clickApp, frameOf } from './app-pointer.mjs';
import { failOnPageErrors, startPostbox, synced } from './postbox.mjs';

/** A loop that draws every frame, forever, as the Michaelis–Menten app in #438 did. */
const FOREVER = `<main style="padding:12px"><p id="t">0</p></main>
<script>
let n = 0;
const step = () => { document.getElementById('t').textContent = String(++n); requestAnimationFrame(step); };
requestAnimationFrame(step);
</script>`;
/** A clock that redraws once each 300 ms, by a timer asking for one frame: no loop. */
const TIMER = `<main style="padding:12px"><p id="t">0</p></main>
<script>
let n = 0;
setInterval(() => requestAnimationFrame(() => { document.getElementById('t').textContent = String(++n); }), 300);
</script>`;
/** A loop driven by a timer asking for a frame every 16 ms: animation all the same. */
const TIMER_LOOP = `<main style="padding:12px"><p id="t">0</p></main>
<script>
let n = 0;
setInterval(() => requestAnimationFrame(() => { document.getElementById('t').textContent = String(++n); }), 16);
</script>`;
/** A loop that draws for 0.6 s, then rests 0.5 s, over and over: each run is short of the kit’s time. */
const PAUSING = `<main style="padding:12px"><p id="t">0</p></main>
<script>
let n = 0;
let until = 0;
const step = (now) => { document.getElementById('t').textContent = String(++n); if (now < until) requestAnimationFrame(step); else setTimeout(start, 500); };
const start = () => { until = performance.now() + 600; requestAnimationFrame(step); };
start();
</script>`;
/** The kit’s 30 s, for this spec. */
const IDLE_MS = 1500;
/** A loop that draws until 1 s after the last click, as a drag or a game draws while the person plays. */
const ON_CLICK = `<main style="padding:12px"><button id="b" type="button" style="display:block;width:100%;height:80px">Run</button><p id="t">0</p></main>
<script>
let until = 0;
let n = 0;
const step = (now) => { document.getElementById('t').textContent = String(++n); if (now < until) requestAnimationFrame(step); };
document.getElementById('b').addEventListener('click', () => { const idle = performance.now() >= until; until = performance.now() + 1000; if (idle) requestAnimationFrame(step); });
</script>`;

/** @type {Awaited<ReturnType<typeof startPostbox>>} */
let app;
test.beforeAll(async () => {
  app = await startPostbox('app-animating');
});
test.afterAll(async () => {
  await app?.stop();
});
failOnPageErrors(test);

/** A conversation with @researcher’s app, open on the page, and what its agent has heard about it. */
async function shown(page, title, code) {
  const { rt } = app;
  await page.addInitScript((ms) => {
    window.__pbIdleMs = ms;
  }, IDLE_MS);
  const t = rt.createThread({ projectId: Object.values(rt.store.state.projects)[0].id, title, personaIds: [arrange.persona(rt, 'researcher').id] });
  const se = arrange.agentIn(rt, t.id);
  const { appId } = rt.toolsFor(se.id).show_app({ title, code });
  await page.goto(`${app.origin}/#/t/${t.id}`);
  await synced(page, app);
  await expect.poll(() => rt.store.state.apps[appId]?.check.status, { timeout: 15_000 }).toMatch(/^(passed|note)$/);
  await expect(frameOf(page, title)).toHaveAttribute('data-sized', '1');
  const heard = () => (rt.s.sessions[se.id].context ?? []).filter((line) => line.includes('kept animating'));
  const frame = page.frameLocator(`iframe.app-iframe[title="${title}"]`);
  /** The app’s own clock, which a spec waits on rather than for a fixed time. */
  const now = () => frame.locator('body').evaluate(() => performance.now());
  return { heard, frame, now };
}

test('#438 an app whose loop draws on with no input is reported to its agent once, and the person sees nothing', async ({ page }) => {
  const { heard, frame, now } = await shown(page, 'Forever', FOREVER);
  await expect(frame.locator('#t'), 'the loop runs').not.toHaveText('0');
  await expect.poll(heard, { message: 'its agent hears it' }).toEqual([expect.stringContaining('Your app “Forever” v1 kept animating for 30 seconds')]);
  // Twice as long again, by the app’s own clock, and it’s still once.
  const at = await now();
  await expect.poll(now, { timeout: 15_000 }).toBeGreaterThan(at + IDLE_MS * 2);
  expect(heard(), 'once').toHaveLength(1);
  await expect(page.locator('.app-holder .app-note'), 'nothing for the person').toHaveCount(0);
});

test('#438 an app that animates only while the person keeps using it is never reported', async ({ page }) => {
  const { heard, frame, now } = await shown(page, 'On click', ON_CLICK);
  // A click every half second keeps one run of frames going for three times IDLE_MS, with input all along.
  await clickApp(page, 'On click');
  const start = await now();
  while ((await now()) < start + IDLE_MS * 3) {
    const before = Number(await frame.locator('#t').textContent());
    const at = await now();
    await expect.poll(now).toBeGreaterThan(at + 500);
    await page.mouse.down();
    await page.mouse.up();
    expect(Number(await frame.locator('#t').textContent()), 'it’s still animating').toBeGreaterThan(before);
  }
  expect(heard()).toEqual([]);
});

test('#438 an app that redraws on a timer, one frame at a time, is never reported', async ({ page }) => {
  const { heard, frame, now } = await shown(page, 'Timer', TIMER);
  const at = await now();
  await expect.poll(now, { timeout: 15_000 }).toBeGreaterThan(at + IDLE_MS * 3);
  await expect(frame.locator('#t'), 'it redraws').not.toHaveText('0');
  expect(heard()).toEqual([]);
});

test('#438 a loop a timer drives, asking for a frame every 16 ms, is reported as a loop', async ({ page }) => {
  const { heard } = await shown(page, 'Timer loop', TIMER_LOOP);
  await expect.poll(heard, { message: 'its agent hears it', timeout: 15_000 }).toEqual([expect.stringContaining('Your app “Timer loop” v1 kept animating')]);
});

test('#438 a loop that rests longer than the kit’s gap each time is never reported', async ({ page }) => {
  const { heard, frame, now } = await shown(page, 'Pausing', PAUSING);
  const at = await now();
  await expect.poll(now, { timeout: 15_000 }).toBeGreaterThan(at + IDLE_MS * 3);
  await expect(frame.locator('#t'), 'it animates').not.toHaveText('0');
  expect(heard()).toEqual([]);
});
