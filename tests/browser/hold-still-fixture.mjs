// What hold-still.spec.mjs and hold-still-following.spec.mjs share (#1326): a Postbox of the spec file’s own, a room
// where two agents stream, show blocks and an app, and the probe that watches one point of the view every frame.

import { expect } from '@playwright/test';
import * as arrange from '../arrange.mjs';
import { failOnPageErrors, settled, startPostbox, synced } from './postbox.mjs';
import { LONG } from './view-read-fixture.mjs';

/** @type {Awaited<ReturnType<typeof startPostbox>>} */
export let app;
/** @type {any} the spec file’s Playwright test, for its steps’ notes */
let test;

/** Starts the spec file’s own Postbox, its hooks registered on t (Playwright’s test). @param {any} t @param {string} name */
export function holdStillApp(t, name) {
  test = t;
  t.use({ colorScheme: 'light', viewport: { width: 1280, height: 800 } });
  t.beforeAll(async () => {
    app = await startPostbox(name);
  });
  t.afterAll(async () => {
    await app?.stop();
  });
  failOnPageErrors(t);
}

// An app with a list of rows; the test adds rows inside its frame, as an app does when its data arrives.
export const ROWS = `<main style="padding:12px"><h2 style="margin:0">Results</h2><div id="rows"><p>First row</p></div></main>`;
// An image the test holds back until it says so: it loads with no size reserved, 240 px tall.
export const PICTURE = '<svg xmlns="http://www.w3.org/2000/svg" width="480" height="240"><rect width="480" height="240" fill="#4a7"/></svg>';
export const PICK = (/** @type {string} */ id) => ({
  id,
  type: 'choice',
  version: 1,
  title: 'Which first?',
  fallback: 'Corpus or claims?',
  prompt: 'Load which first?',
  options: [
    { id: 'corpus', label: 'The corpus' },
    { id: 'claims', label: 'The claims' },
  ],
});

/**
 * A room with two agents: @librarian’s reply still streaming near the top, then @researcher’s replies, review, app and
 * choice, as the test lays them out. say() posts a finished reply; the others show or update a block.
 * @param {string} title
 */
export function room(title) {
  const { rt, store } = app;
  const project = /** @type {any} */ (Object.values(store.state.projects)[0]);
  const t = rt.createThread({ projectId: project.id, title, personaIds: [arrange.persona(rt, 'researcher').id, arrange.persona(rt, 'librarian').id] });
  const [a, b] = arrange.sessionsIn(rt, t.id);
  const tools = rt.toolsFor(a.id);
  const say = (/** @type {string} */ text) =>
    arrange.post(rt, t.id, { kind: 'agent', sessionId: a.id, personaId: a.personaId, handle: a.handle, text, status: 'done' });
  const streaming = () =>
    arrange.post(rt, t.id, { kind: 'agent', sessionId: b.id, personaId: b.personaId, handle: b.handle, text: 'Reading the corpus. ', status: 'streaming' });
  return { t, a, b, tools, say, streaming };
}

/** Opens the room. @param {any} page @param {any} t */
export async function open(page, t) {
  await page.goto(`${app.origin}/#/t/${t.id}`);
  await synced(page, app);
  await settled(page);
}

/** The app’s frame, once it’s drawn: an app is checked, then drawn, once it’s in view (app-check-scheduling). */
export async function appDrawn(page) {
  const frame = page.locator('iframe.app-iframe[title="Results"]');
  await expect(frame).toHaveAttribute('data-sized', '1', { timeout: 20_000 });
  await settled(page);
  return frame;
}

/** Wheels the view, as a person scrolls, until the element’s top is at y, give or take the wheel’s rounding. */
export async function scrollTo(page, /** @type {import('@playwright/test').Locator} */ el, /** @type {number} */ y) {
  await page.mouse.move(640, 60);
  for (let i = 0; i < 4; i++) {
    const top = await el.evaluate((n) => n.getBoundingClientRect().top);
    if (Math.abs(top - y) < 2) break;
    await page.mouse.wheel(0, top - y);
    await settled(page);
  }
}

/**
 * Starts watching the point (x, y): what’s there now, every frame from now, and the page’s layout shifts. The element
 * is named by its item, its tag and its text, so an item drawn again with the same content counts as the same.
 * @param {any} page @param {number} x @param {number} y
 */
export const watch = (page, x, y) =>
  page.evaluate(
    ([x, y]) => {
      const name = (/** @type {Element | null} */ n) =>
        n && `${n.closest('[data-key]')?.getAttribute('data-key')}|${n.tagName}|${(n.getAttribute('title') ?? n.textContent ?? '').slice(0, 60)}`;
      const w = /** @type {any} */ (window);
      const first = document.elementFromPoint(x, y);
      w.__hold = { x, y, name: name(first), top: first?.getBoundingClientRect().top, frames: 0, worst: 0, elsewhere: 0, shift: 0 };
      new PerformanceObserver((list) => {
        for (const e of list.getEntries()) w.__hold.shift += /** @type {any} */ (e).value;
      }).observe({ type: 'layout-shift' });
      const tick = () => {
        const h = w.__hold;
        const n = document.elementFromPoint(h.x, h.y);
        h.frames++;
        if (name(n) !== h.name) h.elsewhere++;
        else h.worst = Math.max(h.worst, Math.abs(/** @type {Element} */ (n).getBoundingClientRect().top - h.top));
        requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
      w.__name = name;
      return w.__hold.name;
    },
    [x, y],
  );

/** Once the page holds still: what’s at the point, and how far it is from where it was. */
export async function still(page, /** @type {string} */ label) {
  await settled(page);
  const h = await page.evaluate(() => {
    const w = /** @type {any} */ (window);
    const n = document.elementFromPoint(w.__hold.x, w.__hold.y);
    return { ...w.__hold, now: w.__name(n), moved: n ? Math.abs(n.getBoundingClientRect().top - w.__hold.top) : null };
  });
  const measured = `moved ${h.moved?.toFixed(1)} px; worst frame ${h.worst.toFixed(1)} px, ${h.elsewhere} of ${h.frames} frames elsewhere; layout shift ${h.shift.toFixed(4)}`;
  test.info().annotations.push({ type: 'hold', description: `${label}: ${measured}` });
  expect.soft(h.now, `${label}: the same element is at the point (${measured})`).toBe(h.name);
  expect.soft(h.moved, `${label}: it hasn’t moved (${measured})`).toBeLessThanOrEqual(1);
  return h;
}

/** Adds rows inside the app’s frame, as its data arriving would, and waits for the frame to grow to fit them. */
export async function growApp(page, /** @type {number} */ rows) {
  const frame = page.locator('iframe.app-iframe[title="Results"]');
  const before = await frame.evaluate((n) => n.getBoundingClientRect().height);
  const inside = await (await frame.elementHandle())?.contentFrame();
  await inside?.evaluate((n) => {
    for (let i = 0; i < n; i++) document.getElementById('rows')?.insertAdjacentHTML('beforeend', `<p>Row ${i + 2}</p>`);
  }, rows);
  await expect.poll(() => frame.evaluate((n) => n.getBoundingClientRect().height), { message: 'the app to grow' }).toBeGreaterThan(before + 100);
}

/** Streams paragraphs into a reply, a frame apart, and waits for the last to be drawn. */
export async function stream(page, /** @type {any} */ t, /** @type {any} */ item, /** @type {number} */ from, /** @type {number} */ n) {
  for (let i = from; i < from + n; i++) {
    app.store.emit('item.text', { threadId: t.id, id: item.id, text: `${LONG(i)}\n\n` });
    await page.evaluate(() => new Promise((r) => requestAnimationFrame(r)));
  }
  await expect(page.locator(`[data-key="${item.id}"]`)).toContainText(`Reply ${from + n - 1}.`);
}
