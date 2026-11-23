// #438: an agent’s app whose animation loop never stops is reported to its agent, with nothing shown to the person.
// The kit (app/kit/frames.js) reports a loop that draws for 30 s with no input from the person, once; one that draws
// only after the person clicks is never reported. And while the app is off screen, its frame callbacks wait. The spec
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
/** All of its content fixed, as a full-bleed canvas is, so its own page has no height. */
const FIXED = `<div style="position:fixed;inset:0;background:var(--panel)"><p style="margin:12px">Fixed</p></div>
<script>
let n = 0;
const step = () => { n++; requestAnimationFrame(step); };
requestAnimationFrame(step);
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

test('#438 while the app is off screen, its frame callbacks wait, and run when it’s back in view', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 700 });
  const { rt } = app;
  const { frame } = await shown(page, 'Off screen', FOREVER);
  const threadId = rt.store.state.apps[Object.keys(rt.store.state.apps).find((id) => rt.store.state.apps[id].title === 'Off screen')].threadId;
  for (let i = 0; i < 8; i++) arrange.post(rt, threadId, { kind: 'user', text: `Line ${i}\n\n${'A long line of words. '.repeat(40)}` });
  await synced(page, app);
  const held = () => frame.locator('body').evaluate(() => requestAnimationFrame(() => {}) < 0);
  await page.locator('.transcript').evaluate((el) => el.scrollTo(0, el.scrollHeight));
  await expect.poll(held, { message: 'off screen, a callback is held' }).toBe(true);
  await frameOf(page, 'Off screen').scrollIntoViewIfNeeded();
  await expect.poll(held, { message: 'in view, it runs' }).toBe(false);
});

test('#438 an app that redraws on a timer, one frame at a time, is never reported', async ({ page }) => {
  const { heard, frame, now } = await shown(page, 'Timer', TIMER);
  const at = await now();
  await expect.poll(now, { timeout: 15_000 }).toBeGreaterThan(at + IDLE_MS * 3);
  await expect(frame.locator('#t'), 'it redraws').not.toHaveText('0');
  expect(heard()).toEqual([]);
});

test('#438 a frame callback held off screen and cancelled as it’s released never runs', async ({ page }) => {
  const { frame } = await shown(page, 'Cancel', FOREVER);
  const ran = await frame.locator('body').evaluate(async () => {
    // As Postbox’s page says it (app/js/apps.mjs, onScreen), in one task: off screen, then back in view.
    const view = (on) => dispatchEvent(new MessageEvent('message', { data: { __pb: 1, type: 'view', on }, source: parent }));
    let calls = 0;
    view(false);
    const id = requestAnimationFrame(() => calls++);
    const heldId = id < 0;
    view(true);
    cancelAnimationFrame(id);
    // Two frames on: a released callback that wasn’t cancelled would have run by then.
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    return { heldId, calls };
  });
  expect(ran).toEqual({ heldId: true, calls: 0 });
});

test('#438 an app whose content is all fixed is in view while any of it shows', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 700 });
  const { rt } = app;
  const { frame } = await shown(page, 'Fixed', FIXED);
  const f = frameOf(page, 'Fixed');
  // Enough below it that the conversation can scroll its top out of view.
  const threadId = Object.values(rt.store.state.apps).find((a) => a.title === 'Fixed').threadId;
  for (let i = 0; i < 8; i++) arrange.post(rt, threadId, { kind: 'user', text: `Line ${i}\n\n${'A long line of words. '.repeat(40)}` });
  await synced(page, app);
  // Its frame’s top just above the window’s top edge, the rest still showing: its own page, which has no height, is at
  // that top edge, out of view, while the app shows.
  await f.evaluate((n) => {
    let scroller = n.parentElement;
    while (scroller && !(scroller.scrollHeight > scroller.clientHeight && /auto|scroll/.test(getComputedStyle(scroller).overflowY)))
      scroller = scroller.parentElement;
    (scroller ?? document.scrollingElement)?.scrollBy(0, n.getBoundingClientRect().top + 20);
  });
  await expect.poll(async () => (await f.boundingBox())?.y ?? 0).toBeLessThan(0);
  const box = await f.boundingBox();
  expect(box && box.y + box.height > 0, 'part of it shows').toBe(true);
  const runs = () => frame.locator('body').evaluate(() => requestAnimationFrame(() => {}) > 0);
  await expect.poll(runs, { message: 'its frames run' }).toBe(true);
});
