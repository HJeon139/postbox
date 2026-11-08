// A scroll the transcript hasn’t heard about yet: the browser fires the scroll event in the next frame’s scroll steps,
// not when the view moves (#341; the view’s rules are #508’s design, “Browser”). In the frame between:
// - a reply that lands right after you scroll up is counted as unseen, so Jump to latest shows;
// - a scroll down while you’re reading back isn’t taken back when something resizes in that frame. #341 saw it about once
//   in 45 to 90 runs. The resize must change the transcript's height: a 1 px padding on a reply doesn't (its margins
//   absorb it), which is why this spec passed on main before. 40 px grows the transcript every time.
// Each test has a conversation of its own.

import { expect, test } from '@playwright/test';
import { failOnPageErrors, settled, startPostbox, synced } from './postbox.mjs';

test.use({ colorScheme: 'light' });

/** @type {Awaited<ReturnType<typeof startPostbox>>} */
let app;
test.beforeAll(async () => {
  app = await startPostbox('scroll-frame');
});
test.afterAll(async () => {
  await app?.stop();
});
failOnPageErrors(test);

const LONG = (n) =>
  `Reply ${n}. The observation is the only outside evidence in the loop, so it keeps the plan grounded while the agent reads the results one at a time.`;

/** A long room with @researcher. */
function room(title) {
  const { rt, store } = app;
  const project = Object.values(store.state.projects)[0];
  const t = rt.createThread({ projectId: project.id, title, personaIds: [rt.personaByHandle('researcher').id] });
  const [se] = rt.sessionsIn(t.id);
  const say = (/** @type {string} */ text) =>
    rt.addItem(t.id, { kind: 'agent', sessionId: se.id, personaId: se.personaId, handle: se.handle, text, status: 'done' });
  for (let i = 1; i <= 30; i++) {
    if (i % 3 === 1) rt.addItem(t.id, { kind: 'user', text: `Question ${i}?` });
    else say(LONG(i));
  }
  return { t };
}

async function open(page, t) {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto(`${app.origin}/#/t/${t.id}`);
  await synced(page, app);
  await expect(page.locator(`.transcript[data-thread="${t.id}"] .item`).first()).toBeVisible();
  await settled(page);
}

test('#341 a reply that lands in the frame you scroll up in is counted, and Jump to latest shows', async ({ page }) => {
  const { t } = room('Reply in the scroll’s frame');
  await open(page, t);
  // Scroll up, and in the same task, before the frame’s scroll event, hand the page a reply as its stream does: through
  // the client’s apply and emit. A real reply lands in that window only now and then; this makes it every time.
  await page.evaluate(async (threadId) => {
    const { client } = await import('/app/js/client.mjs');
    const { apply } = await import('/shared/state.mjs');
    const item = { id: 'it_inframe', kind: 'agent', handle: 'researcher', text: 'A reply in the same frame as the scroll up.', status: 'done', at: Date.now() };
    scrollBy(0, -240);
    apply(client.state, 'item.add', { threadId, item });
    client.emit({ type: 'item.add', data: { threadId, item } });
  }, t.id);
  await settled(page);
  await expect(page.locator('.jump'), 'Jump to latest, for the reply below the view').toBeVisible();
});

test('#341 a scroll down while reading back isn’t taken back by a resize in the same frame', async ({ page }) => {
  const { t } = room('Scroll down, then a resize');
  await open(page, t);
  await page.mouse.move(640, 400);
  await page.mouse.wheel(0, -1200);
  await settled(page);
  // In an animation frame, as focus-clear.mjs scrolls: scroll down 120 px, then make a reply above the view taller. The
  // frame's scroll steps have run already, so the ResizeObserver runs before the scroll event tells the transcript the
  // view moved.
  const { before, grew } = await page.evaluate(
    () =>
      new Promise((done) => {
        const main = /** @type {HTMLElement} */ (document.querySelector('#main'));
        const h0 = main.getBoundingClientRect().height;
        requestAnimationFrame(() => {
          const before = scrollY;
          scrollBy(0, 120);
          const first = document.querySelector('#main .item');
          if (first instanceof HTMLElement) first.style.paddingBottom = '40px';
          requestAnimationFrame(() => done({ before, grew: main.getBoundingClientRect().height - h0 }));
        });
      }),
  );
  expect(grew, 'the resize changed the transcript’s height, so the race ran').toBeGreaterThan(0);
  await settled(page);
  const end = await page.evaluate(() => scrollY);
  expect(end, 'the view stays where the scroll put it, plus what grew above').toBeGreaterThanOrEqual(before + 120 + grew - 1);
});

// #357's review found it (fixed in a0b13bf5): while following, a change to the transcript notes where the view is, so a
// clamp at the page's new end isn't read as a scroll up (#297). Noting it anywhere else would take a scroll up made in the
// same frame, before its scroll event, for a clamp, and pull the view back to the end.
test('#357 a scroll up, then a change in the same frame, isn’t taken for a clamp and pulled back to the end', async ({ page }) => {
  const { t } = room('Scroll up, then a change');
  await open(page, t);
  const end = await page.evaluate(() => scrollY);
  // In one task, before the scroll event: scroll up 240 px, then restyle the newest reply, which the transcript's
  // MutationObserver notes (a microtask) and its ResizeObserver then follows.
  await page.evaluate(() => {
    scrollBy(0, -240);
    const items = document.querySelectorAll('#main .item');
    const last = items[items.length - 1];
    if (last instanceof HTMLElement) last.style.paddingBottom = '40px';
  });
  await settled(page);
  const at = await page.evaluate(() => scrollY);
  expect(at, 'the view stays where you scrolled it, not back at the end').toBeLessThan(end - 200);
});

// critic's P1 on #959: a resize heard before your scroll's event takes that scroll in (heard()), so by the event the
// scroll looks like the transcript's own. Your scroll down to the end must still follow it.
test('#341 a scroll down to the end, with a resize heard before its event, follows the end', async ({ page }) => {
  const { t } = room('Scroll to the end, then a resize');
  await open(page, t);
  await page.mouse.move(640, 400);
  await page.mouse.wheel(0, -300);
  await settled(page);
  expect(await page.locator('#main.transcript').getAttribute('data-view-mode'), 'reading, a little way up').toBe('reading');
  // In one task, before the scroll event: to the end, then a resize the transcript hears first.
  await page.evaluate(() => {
    const s = /** @type {Element} */ (document.scrollingElement);
    s.scrollTop = s.scrollHeight;
    dispatchEvent(new Event('resize'));
  });
  await settled(page);
  expect(await page.locator('#main.transcript').getAttribute('data-view-mode'), 'at the end you scrolled to, it follows').toBe('following');
});

// critic's P3 on #959: a jump pins its item until you scroll; a scroll of yours that a resize heard first is yours too.
test('#341 a scroll up after a jump, with a resize heard before its event, lets the jump’s item go', async ({ page }) => {
  const { t } = room('Jump, then a scroll heard first');
  await open(page, t);
  const key = await page.evaluate(async () => {
    const { jumpTo } = await import('/app/js/view-jump.mjs');
    const items = document.querySelectorAll('#main > [data-key]');
    const item = /** @type {HTMLElement} */ (items[12]);
    jumpTo(item);
    return item.dataset.key;
  });
  await settled(page);
  await page.evaluate(() => {
    scrollBy(0, -300);
    dispatchEvent(new Event('resize'));
  });
  await settled(page);
  const anchor = await page.locator('#main.transcript').getAttribute('data-view-anchor');
  expect(anchor, 'the anchor is taken where you scrolled, not the item you jumped to').not.toBe(key);
});

// Firefox, as skipped items above draw shorter than their estimates, moves the view up to keep what’s on screen still
// (#712a; Linux Firefox with shorter items, and the Mac): the page got shorter, and the move up isn’t you. Here, while
// following: an item above shrinks, the view moves up by more, and a resize is heard before the scroll event.
test('#712a following, a move up the browser makes as the page gets shorter keeps the view following', async ({ page }) => {
  const { t } = room('Following, the page shorter');
  await open(page, t);
  expect(await page.locator('#main.transcript').getAttribute('data-view-mode')).toBe('following');
  await page.evaluate(() => {
    const items = document.querySelectorAll('#main > [data-key]');
    const above = /** @type {HTMLElement} */ (items[items.length - 6]);
    above.style.marginTop = '-40px';
    scrollBy(0, -60);
    dispatchEvent(new Event('resize'));
  });
  await settled(page);
  expect(await page.locator('#main.transcript').getAttribute('data-view-mode'), 'it still follows').toBe('following');
});

test('#341 two resizes before the scroll event take an unheard scroll once, not twice', async ({ page }) => {
  const { t } = room('Two resizes, one unheard scroll');
  await open(page, t);
  await page.mouse.move(640, 400);
  await page.mouse.wheel(0, -900);
  await settled(page);
  // Scroll up by 240 px and, before its scroll event, have the transcript hear two resizes: the first takes the unheard
  // scroll into the anchor, and the second must find nothing left to take.
  const moved = await page.evaluate(async () => {
    const s = /** @type {Element} */ (document.scrollingElement);
    const before = s.scrollTop;
    s.scrollTop = before - 240;
    dispatchEvent(new Event('resize'));
    dispatchEvent(new Event('resize'));
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    return before - s.scrollTop;
  });
  expect(moved, 'the view stays where the scroll put it').toBeGreaterThanOrEqual(239);
  expect(moved).toBeLessThanOrEqual(241);
});

test('#341 following, a scroll up the transcript hasn’t heard of, then a resize: the view stays where the scroll put it', async ({ page }) => {
  const { t } = room('Unheard scroll up from the end');
  await open(page, t);
  // At the end, following. Scroll up by 240 px and, before its scroll event, have the transcript hear a resize: it
  // unsticks there, takes the anchor where the view now is, and must not take the same scroll in again.
  const moved = await page.evaluate(async () => {
    const s = /** @type {Element} */ (document.scrollingElement);
    const before = s.scrollTop;
    s.scrollTop = before - 240;
    dispatchEvent(new Event('resize'));
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    return before - s.scrollTop;
  });
  expect(moved, 'the view stays where the scroll put it').toBeGreaterThanOrEqual(239);
  expect(moved).toBeLessThanOrEqual(241);
});
