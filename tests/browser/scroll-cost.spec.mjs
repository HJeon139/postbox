// Scrolling a long conversation costs about the same wherever you are in it (#572). On a seeded conversation of 1,000
// agent replies, each with its five reaction buttons, the page counts the rects it reads on one scroll event near the
// end. Taking the anchor (#88) used to read one per reply above the middle of the view.

import { expect, test } from '@playwright/test';
import * as arrange from '../arrange.mjs';
import { failOnPageErrors, newestShown, openAs, ROOM_MODES, settled, startPostbox, synced } from './postbox.mjs';

// Tracing is off: Playwright's trace snapshots walk every node of the page each action, and on a room of 1,000 items
// or more under content-visibility that takes longer than the test (view-skipped.spec.mjs).
test.use({ colorScheme: 'light', trace: 'off' });

/** @type {Awaited<ReturnType<typeof startPostbox>>} */
let app;

test.beforeAll(async () => {
  app = await startPostbox('scroll-cost', { demo: false });
  app.store.emit('project', { id: 'pr_scroll', name: 'Scroll', folder: app.root });
});
test.afterAll(async () => app?.stop());
failOnPageErrors(test);
// With the window on, as a long room opens by default (#866): the cost and the leak are the person’s.

const REPLIES = 1000;

/** A conversation of 1,000 agent replies, open in the page and held at its end. */
async function seeded(page, name) {
  const { rt } = app;
  const p = rt.createPersona({ handle: name });
  const t = rt.createThread({ projectId: 'pr_scroll', title: `Scroll ${name}`, personaIds: [p.id] });
  const se = arrange.agentIn(rt, t.id);
  for (let i = 0; i < REPLIES; i++)
    arrange.post(rt, t.id, {
      kind: 'agent',
      sessionId: se.id,
      personaId: se.personaId,
      handle: se.handle,
      text: `Reply ${i} says one short thing.`,
      status: 'done',
    });
  await page.addInitScript(countRects);
  await page.goto(`${app.origin}/#/t/${t.id}`);
  await synced(page, app);
  await newestShown(page, app, t.id);
  await settled(page);
  return t;
}

/** Runs in the page before Postbox does: counts getBoundingClientRect calls in window.__rects. */
function countRects() {
  const read = Element.prototype.getBoundingClientRect;
  /** @type {any} */ (window).__rects = 0;
  Element.prototype.getBoundingClientRect = function () {
    /** @type {any} */ (window).__rects++;
    return read.call(this);
  };
}

/** Scrolls the window by dy, and returns the rects read from then until its scroll event has been handled. */
const rectsFor = (page, dy) =>
  page.evaluate(
    (d) =>
      new Promise((done) => {
        /** @type {any} */ (window).__rects = 0;
        addEventListener('scroll', () => setTimeout(() => done(/** @type {any} */ (window).__rects)), { once: true });
        scrollBy(0, d);
      }),
    dy,
  );

for (const mode of ROOM_MODES)
  test(`#572: a scroll event near the end of 1,000 replies reads a few rects, not one per reply above, ${mode}`, async ({ page }) => {
    await openAs(page, mode);
    await seeded(page, mode === 'whole room' ? 'anchor-whole' : 'anchor');
    // Up from the end, so the view isn’t stuck there and each scroll takes the anchor.
    await rectsFor(page, -2000);
    await settled(page);
    const reads = [];
    for (let i = 0; i < 5; i++) reads.push(await rectsFor(page, -100));
    test.info().annotations.push({ type: 'measured', description: `rects per scroll event: ${reads.join(', ')}` });
    expect(Math.max(...reads), `rects read per scroll event: ${reads.join(', ')}`).toBeLessThanOrEqual(40);
  });

const STEP = 800;
const STEPS = 60;

/**
 * Takes the page to the room’s first reply. With the window on, one scroll to the top shows only the window’s top, and
 * the window then mounts the replies above it and keeps the view where it was, so it takes several (#1649).
 */
async function atRoomTop(page, firstId) {
  const atTop = () => page.evaluate((id) => scrollY === 0 && !!document.querySelector(`.transcript > [data-key="${CSS.escape(id)}"]`), firstId);
  await expect
    .poll(
      async () => {
        await page.evaluate(() => scrollTo(0, 0));
        await settled(page);
        return atTop();
      },
      { message: 'the room’s first reply at the top of the page', timeout: 60_000 },
    )
    .toBe(true);
}

/** Wheels down 60 steps of 800 px, and returns how far the page scrolled. */
async function wheeled(page) {
  await page.mouse.move(640, 400);
  for (let i = 0; i < STEPS; i++) {
    await page.mouse.wheel(0, STEP);
    await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
  }
  return page.evaluate(() => Math.round(scrollY));
}

/**
 * Wheels down from the room’s first reply, tracing it. Returns how far the page scrolled, and the trace’s count and
 * total ms per event name.
 */
async function traced(page, firstId) {
  await atRoomTop(page, firstId);
  const browser = page.context().browser();
  await browser.startTracing(page, { categories: ['devtools.timeline', 'disabled-by-default-devtools.timeline', 'cc'] });
  const moved = await wheeled(page);
  const { traceEvents } = JSON.parse((await browser.stopTracing()).toString());
  /** @type {Record<string, number>} */
  const count = {};
  /** @type {Record<string, number>} */
  const ms = {};
  for (const e of traceEvents)
    if (e.ph === 'X' && e.dur) {
      count[e.name] = (count[e.name] ?? 0) + 1;
      ms[e.name] = (ms[e.name] ?? 0) + e.dur / 1000;
    }
  return { moved, count, ms };
}

// Dark draws its icons with nothing on them, so it is the measure: on light, a filter per icon (5,000 of them here)
// made each repaint of a scroll lay out, commit and map the images of every one, about 35 times dark’s cost. With the
// filter put back (#1649), light painted 3.3 times as often as dark with the window on, and took 4.5 times as long to
// lay out, commit and map with the whole room, at the same count. So light’s counts are bound to dark’s, and its time
// to a ratio of dark’s with no fixed slack: before #1649 it was 3 times dark plus 50 ms, which let light take 8 times
// dark on a fast machine and failed a runner slow enough that dark took 60 ms.
const COMPOSITING = ['Layerize', 'ProxyImpl::Commit', 'DiscardableImageMap::Generate'];
const COUNTED = ['ProxyImpl::Commit', 'Paint'];

for (const mode of ROOM_MODES)
  test(`#572: scrolling 1,000 replies on light costs about what it does on dark to lay out and commit, ${mode}`, async ({ page, browserName }) => {
    test.skip(browserName !== 'chromium', 'the trace comes from Chromium’s DevTools protocol');
    await openAs(page, mode);
    test.setTimeout(180_000);
    const t = await seeded(page, mode === 'whole room' ? 'icons-whole' : 'icons');
    const firstId = app.store.items(t.id)[0].id;
    /** @type {Record<string, Awaited<ReturnType<typeof traced>>>} */
    const run = {};
    // Once over the room first, untraced. The first pass lays out each reply it reaches for the first time and learns
    // its height, so it commits and lays out more than any pass after it, whichever theme makes it (#1649).
    await atRoomTop(page, firstId);
    await wheeled(page);
    for (const theme of /** @type {const} */ (['dark', 'light'])) {
      await page.emulateMedia({ colorScheme: theme });
      // Read in the page, not with a locator: a locator's check that misses takes an aria snapshot of the page, and on
      // 1,000 skipped items that lays each one out, seconds the theme's change then waits behind (#712a).
      await expect.poll(() => page.evaluate(() => document.documentElement.dataset.theme)).toBe(theme);
      run[theme] = await traced(page, firstId);
    }
    const ms = (theme) => Math.round(COMPOSITING.reduce((sum, name) => sum + (run[theme].ms[name] ?? 0), 0));
    const counts = (theme) => COUNTED.map((name) => `${run[theme].count[name] ?? 0} ${name}`).join(', ');
    const said = `light ${counts('light')}; dark ${counts('dark')} (${COMPOSITING.join(' + ')}: light ${ms('light')} ms, dark ${ms('dark')} ms)`;
    test.info().annotations.push({ type: 'measured', description: said });
    // Each theme scrolled the same 60 steps from the same place, or their counts measure different work. Before #1649,
    // each pass began at the window’s top: dark’s, the first, began near the room’s end and ran out of room after 15
    // steps, and light’s began further up and scrolled 47, so light did three times the work of the same kind.
    expect(run.dark.moved, 'dark scrolled every step').toBe(STEPS * STEP);
    expect(run.light.moved, 'light scrolled every step').toBe(STEPS * STEP);
    // Light still draws each icon with its rim, from a file of its own, and every one of them is there.
    const files = await page.evaluate(() => [
      ...new Set([...document.querySelectorAll('.react-btn')].map((n) => getComputedStyle(n, '::before').backgroundImage)),
    ]);
    expect(files, 'one file per reaction').toHaveLength(5);
    for (const f of files) {
      const url = f.match(/url\("(.+)"\)/)?.[1] ?? '';
      expect(url, 'the rimmed copy').toMatch(/-rim-72\.png$/);
      expect((await page.request.get(url)).ok(), `${url} loads`).toBe(true);
    }
    for (const name of COUNTED) {
      const dark = run.dark.count[name] ?? 0;
      expect(dark, `the trace recorded ${name}`).toBeGreaterThan(0);
      expect(run.light.count[name] ?? 0, `${name}: ${said}`).toBeLessThanOrEqual(Math.ceil(1.25 * dark));
    }
    expect(ms('dark'), 'the trace recorded the work it times').toBeGreaterThan(0);
    expect(ms('light'), said).toBeLessThanOrEqual(2 * ms('dark'));
  });
