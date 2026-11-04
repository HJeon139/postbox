// The view's anchor (#531, B1b-a; #297, #341): where the transcript says you're reading in the harder layouts, with no item
// across the view, content above moving twice before a scroll event, and a tall item ending just above the view.
// Each test has a conversation of its own.

import { expect, test } from '@playwright/test';
import { failOnPageErrors, settled, startPostbox } from './postbox.mjs';
import { holds, LONG, open as openIn, room as roomIn } from './view-read-fixture.mjs';

test.use({ colorScheme: 'light' });

/** @type {Awaited<ReturnType<typeof startPostbox>>} */
let app;
test.beforeAll(async () => {
  app = await startPostbox('view-anchor');
});
test.afterAll(async () => {
  await app?.stop();
});
failOnPageErrors(test);

const room = (/** @type {string} */ title) => roomIn(app, title);
const open = (/** @type {any} */ page, /** @type {any} */ t, width = 1280) => openIn(app, page, t, width);

// Reading with no anchor: the view is scrolled up from the end, but no item crosses it, as when the height held after a
// shrink (release, view-state.mjs) is taller than the window. findAnchor returns null there, and the mode is reading.
test('V1: scrolled up into space below the last item, the view reads with no anchor, and says so', async ({ page }) => {
  const { t } = room('View read: no anchor');
  await open(page, t);
  const v = await page.evaluate(async (threadId) => {
    const el = /** @type {HTMLElement} */ (document.querySelector(`#main.transcript[data-thread="${threadId}"]`));
    el.style.minHeight = `${el.getBoundingClientRect().height + 3 * innerHeight}px`;
    const s = /** @type {Element} */ (document.scrollingElement);
    s.scrollTop = s.scrollHeight;
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    s.scrollTop -= innerHeight;
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    const last = [...el.querySelectorAll(':scope > [data-key]')].at(-1);
    return { ...el.dataset, lastBottom: /** @type {Element} */ (last).getBoundingClientRect().bottom };
  }, t.id);
  expect(v.lastBottom, 'no item is in view').toBeLessThan(0);
  expect([v.viewMode, v.viewAnchor, v.viewOffset]).toEqual(['reading', '', '']);
});

// #297: the transcript’s own correction, holding the anchor, fires its scroll event a frame later. By then what’s above
// may have moved again; the event must hold the anchor once more before taking it, not take where it drifted to.
test('V1: content above grows twice before the correction’s scroll event, and what you read stays put', async ({ page }) => {
  const { t } = room('View read: two growths above');
  await open(page, t);
  await page.mouse.move(640, 400);
  await page.mouse.wheel(0, -1200);
  await settled(page);
  const before = await holds(page, t, 'reading');
  const top = await page.evaluate(
    async ({ threadId, anchor }) => {
      const el = /** @type {HTMLElement} */ (document.querySelector(`#main.transcript[data-thread="${threadId}"]`));
      const n = /** @type {HTMLElement} */ (el.querySelector(`:scope > [data-key="${CSS.escape(anchor)}"]`));
      const above = /** @type {HTMLElement} */ (n.previousElementSibling);
      above.style.paddingTop = '100px';
      dispatchEvent(new Event('resize'));
      above.style.paddingTop = '200px';
      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
      return n.getBoundingClientRect().top;
    },
    { threadId: t.id, anchor: before.anchor },
  );
  expect(Math.abs(top - Number(before.offset)), 'the item you were reading didn’t move').toBeLessThanOrEqual(1);
  const after = await holds(page, t, 'after');
  expect([after.mode, after.anchor]).toEqual(['reading', before.anchor]);
});

// findAnchor walks back to the item before the one across the middle, then forward past any that end above the top.
test('V1: a tall item ending just above the view and one across the middle: the anchor is the one across the middle', async ({ page }) => {
  const { rt, store } = app;
  const project = Object.values(store.state.projects)[0];
  const t = rt.createThread({ projectId: project.id, title: 'View read: tall above', personaIds: [rt.personaByHandle('researcher').id] });
  const [se] = rt.sessionsIn(t.id);
  const say = (text) => rt.addItem(t.id, { kind: 'agent', sessionId: se.id, personaId: se.personaId, handle: se.handle, text, status: 'done' });
  for (let i = 1; i <= 6; i++) say(LONG(i));
  const tall = say(Array.from({ length: 40 }, (_, i) => LONG(100 + i)).join('\n\n')).id;
  const across = say(Array.from({ length: 8 }, (_, i) => LONG(200 + i)).join('\n\n')).id;
  for (let i = 1; i <= 6; i++) say(LONG(300 + i));
  await open(page, t);
  const v = await page.evaluate(
    async ({ threadId, tall, across }) => {
      const el = /** @type {HTMLElement} */ (document.querySelector(`#main.transcript[data-thread="${threadId}"]`));
      const s = /** @type {Element} */ (document.scrollingElement);
      const tallN = /** @type {HTMLElement} */ (el.querySelector(`:scope > [data-key="${tall}"]`));
      const acrossN = /** @type {HTMLElement} */ (el.querySelector(`:scope > [data-key="${across}"]`));
      s.scrollTop += tallN.getBoundingClientRect().bottom + 4;
      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
      const a = acrossN.getBoundingClientRect();
      return {
        anchor: el.dataset.viewAnchor,
        tallBottom: tallN.getBoundingClientRect().bottom,
        acrossTop: a.top,
        acrossBottom: a.bottom,
        mid: innerHeight / 2,
      };
    },
    { threadId: t.id, tall, across },
  );
  expect(v.tallBottom, 'the tall item ends above the view').toBeLessThanOrEqual(0);
  expect(v.acrossTop < v.mid && v.acrossBottom > v.mid, 'the next item crosses the middle').toBe(true);
  expect(v.anchor).toBe(across);
});
