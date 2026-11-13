// What you read or point at holds still while agents work (#1326). The person read mid-room, an agent’s update moved
// the page, and their click landed on something else. Agents stream replies, update blocks, and their apps and images
// grow, above the view and inside it; through all of it the element under a fixed point of the view, and the button
// under the pointer, stay where they were, within a pixel. Following the newest message, new content still scrolls
// in, but never under a button the pointer is on, or a click it has started.

import { expect, test } from '@playwright/test';
import * as arrange from '../arrange.mjs';
import { failOnPageErrors, settled, startPostbox, synced } from './postbox.mjs';
import { LONG } from './view-read-fixture.mjs';

test.use({ colorScheme: 'light', viewport: { width: 1280, height: 800 } });

/** @type {Awaited<ReturnType<typeof startPostbox>>} */
let app;
test.beforeAll(async () => {
  app = await startPostbox('hold-still');
});
test.afterAll(async () => {
  await app?.stop();
});
failOnPageErrors(test);

// An app with a list of rows; the test adds rows inside its frame, as an app does when its data arrives.
const ROWS = `<main style="padding:12px"><h2 style="margin:0">Results</h2><div id="rows"><p>First row</p></div></main>`;
// An image the test holds back until it says so: it loads with no size reserved, 240 px tall.
const PICTURE = '<svg xmlns="http://www.w3.org/2000/svg" width="480" height="240"><rect width="480" height="240" fill="#4a7"/></svg>';
const PICK = (/** @type {string} */ id) => ({
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
function room(title) {
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
async function open(page, t) {
  await page.goto(`${app.origin}/#/t/${t.id}`);
  await synced(page, app);
  await settled(page);
}

/** The app’s frame, once it’s drawn: an app is checked, then drawn, once it’s in view (app-check-scheduling). */
async function appDrawn(page) {
  const frame = page.locator('iframe.app-iframe[title="Results"]');
  await expect(frame).toHaveAttribute('data-sized', '1', { timeout: 20_000 });
  await settled(page);
  return frame;
}

/** Wheels the view, as a person scrolls, until the element’s top is at y, give or take the wheel’s rounding. */
async function scrollTo(page, /** @type {import('@playwright/test').Locator} */ el, /** @type {number} */ y) {
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
const watch = (page, x, y) =>
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
async function still(page, /** @type {string} */ label) {
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
async function growApp(page, /** @type {number} */ rows) {
  const frame = page.locator('iframe.app-iframe[title="Results"]');
  const before = await frame.evaluate((n) => n.getBoundingClientRect().height);
  const inside = await (await frame.elementHandle())?.contentFrame();
  await inside?.evaluate((n) => {
    for (let i = 0; i < n; i++) document.getElementById('rows')?.insertAdjacentHTML('beforeend', `<p>Row ${i + 2}</p>`);
  }, rows);
  await expect.poll(() => frame.evaluate((n) => n.getBoundingClientRect().height), { message: 'the app to grow' }).toBeGreaterThan(before + 100);
}

/** Streams paragraphs into a reply, a frame apart, and waits for the last to be drawn. */
async function stream(page, /** @type {any} */ t, /** @type {any} */ item, /** @type {number} */ from, /** @type {number} */ n) {
  for (let i = from; i < from + n; i++) {
    app.store.emit('item.text', { threadId: t.id, id: item.id, text: `${LONG(i)}\n\n` });
    await page.evaluate(() => new Promise((r) => requestAnimationFrame(r)));
  }
  await expect(page.locator(`[data-key="${item.id}"]`)).toContainText(`Reply ${from + n - 1}.`);
}

test('reading mid-room, what’s at the middle of the view holds still while agents stream, update and grow blocks around it', async ({ page }) => {
  test.setTimeout(60_000);
  const { t, tools, say, streaming } = room('Hold still: reading');
  for (let i = 1; i <= 5; i++) say(LONG(i));
  const live = streaming();
  for (let i = 6; i <= 8; i++) say(LONG(i));
  const reviewId = `notes-${t.id}`;
  const review = { id: reviewId, type: 'review', version: 1, title: 'notes.md', fallback: 'Notes', format: 'markdown', content: '# Notes\n\nOne line.' };
  tools.show_block({ block: review });
  for (let i = 9; i <= 10; i++) say(LONG(i));
  tools.show_app({ id: `results-${t.id}`, title: 'Results', code: ROWS, permissions: [] });
  const picture = `${app.origin}/media/hold-still-${t.id}.svg`;
  /** @type {() => void} */
  let release = () => {};
  const held = new Promise((r) => {
    release = () => r(undefined);
  });
  await page.route(picture, async (route) => {
    await held;
    await route.fulfill({ contentType: 'image/svg+xml', body: PICTURE });
  });
  const read = say(`${LONG(11)}\n\n![The chart](${picture})\n\nAfter the chart: the claims hold for every source we read.`);
  for (let i = 12; i <= 30; i++) say(LONG(i));
  await open(page, t);
  // The paragraph after the picture across the middle, the app above it in view, and the pointer off the conversation.
  const after = page.locator(`[data-key="${read.id}"] p`, { hasText: 'After the chart' });
  await scrollTo(page, after, 390);
  await appDrawn(page);
  await scrollTo(page, after, 390);
  await page.mouse.move(4, 400);
  const x = await after.evaluate((n) => n.getBoundingClientRect().left + 40);
  await watch(page, x, 400);
  const at = await page.evaluate(([x]) => document.elementFromPoint(x, 400)?.textContent ?? '', [x]);
  expect(at, 'the point is on the paragraph after the picture').toContain('After the chart');

  await test.step('a reply streams above the view', async () => {
    await stream(page, t, live, 100, 20);
    await still(page, 'stream above');
  });
  await test.step('the review above is revised, and moves to the end', async () => {
    tools.update_block({ block: { ...review, content: `# Notes\n\n${'A longer line.\n\n'.repeat(20)}`, previous: review.content } });
    await synced(page, app);
    await still(page, 'review moved');
  });
  await test.step('the app above the point grows', async () => {
    await growApp(page, 12);
    await still(page, 'app grows');
  });
  await test.step('the picture above the point loads', async () => {
    release();
    await expect.poll(() => page.locator(`[data-key="${read.id}"] img.md-img`).evaluate((n) => /** @type {HTMLImageElement} */ (n).naturalHeight)).toBe(240);
    await still(page, 'picture loads');
  });
  await test.step('agents post below', async () => {
    for (let i = 31; i <= 33; i++) say(LONG(i));
    await synced(page, app);
    await still(page, 'posts below');
  });
});

test('reading, a button under the pointer stays under it while a block above it grows, and the click lands on it', async ({ page }) => {
  test.setTimeout(60_000);
  const { t, tools, say, streaming } = room('Hold still: pointer');
  for (let i = 1; i <= 5; i++) say(LONG(i));
  const live = streaming();
  for (let i = 6; i <= 10; i++) say(LONG(i));
  tools.show_app({ id: `results-${t.id}`, title: 'Results', code: ROWS, permissions: [] });
  tools.show_block({ block: PICK(`pick-${t.id}`) });
  for (let i = 11; i <= 30; i++) say(LONG(i));
  await open(page, t);
  const chip = page.getByRole('radio', { name: 'The claims' });
  // The app across the middle, and the button below it.
  const frame = page.locator('iframe.app-iframe[title="Results"]');
  await scrollTo(page, frame, 300);
  await appDrawn(page);
  await scrollTo(page, frame, 300);
  const box = /** @type {{ x: number, y: number, width: number, height: number }} */ (await chip.boundingBox());
  const pointer = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  expect(pointer.y, 'the button is in view').toBeLessThan(780);
  await page.mouse.move(pointer.x, pointer.y);
  await watch(page, pointer.x, pointer.y);

  await test.step('a reply streams above the view', async () => {
    await stream(page, t, live, 100, 12);
    await still(page, 'stream above');
  });
  await test.step('the app above the button grows', async () => {
    await growApp(page, 12);
    await still(page, 'app grows');
  });
  await test.step('the click lands on the button', async () => {
    await page.mouse.down();
    await page.mouse.up();
    await expect(chip).toHaveAttribute('aria-checked', 'true');
  });
});

test('following the newest message, new content scrolls in, but not under a button the pointer moved onto or a click it started', async ({ page }) => {
  test.setTimeout(60_000);
  const { t, tools, say } = room('Hold still: following');
  for (let i = 1; i <= 20; i++) say(LONG(i));
  tools.show_app({ id: `results-${t.id}`, title: 'Results', code: ROWS, permissions: [] });
  tools.show_block({ block: PICK(`pick-${t.id}`) });
  await open(page, t);
  await appDrawn(page);
  const view = () =>
    page.evaluate((id) => {
      const s = /** @type {Element} */ (document.scrollingElement);
      return {
        mode: document.querySelector(`#main.transcript[data-thread="${id}"]`)?.getAttribute('data-view-mode'),
        gap: s.scrollHeight - s.scrollTop - s.clientHeight,
      };
    }, t.id);
  expect((await view()).mode, 'the view follows the newest message').toBe('following');

  await test.step('with the pointer off the conversation, a new reply scrolls in', async () => {
    await page.mouse.move(4, 400);
    const r = say(LONG(21));
    await expect(page.locator(`[data-key="${r.id}"]`)).toBeVisible();
    await settled(page);
    expect((await view()).gap, 'at the end').toBeLessThanOrEqual(2);
  });
  const chip = page.getByRole('radio', { name: 'The corpus' });
  const box = /** @type {{ x: number, y: number, width: number, height: number }} */ (await chip.boundingBox());
  const pointer = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  await page.mouse.move(pointer.x, pointer.y);
  await watch(page, pointer.x, pointer.y);

  await test.step('replies arrive while the pointer is on a button', async () => {
    for (let i = 22; i <= 24; i++) say(LONG(i));
    await synced(page, app);
    await still(page, 'replies arrive');
  });
  await test.step('a reply arrives between pressing the button and letting go, and the click lands on it', async () => {
    await page.mouse.down();
    say(LONG(25));
    await synced(page, app);
    await still(page, 'pressed');
    await page.mouse.up();
    await expect(chip).toHaveAttribute('aria-checked', 'true');
  });
  await test.step('once the click is done, the view goes on to the newest message, with the pointer still there', async () => {
    await settled(page);
    expect(await view()).toEqual({ mode: 'following', gap: expect.any(Number) });
    expect((await view()).gap, 'at the end').toBeLessThanOrEqual(2);
  });
});
