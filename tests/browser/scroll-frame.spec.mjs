// A scroll the transcript hasn’t heard about yet: the browser fires the scroll event in the next frame’s scroll steps,
// not when the view moves (#341, one of PF-3’s scroll regressions for #508 B1’s view state). In the frame between:
// - a reply that lands right after you scroll up is counted as unseen, so Jump to latest shows;
// - a scroll down while you’re reading back isn’t taken back when something resizes in that frame.
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
    const item = { id: 'it_inframe', kind: 'user', text: 'A reply in the same frame as the scroll up.', at: Date.now() };
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
  const before = await page.evaluate(() => Math.round(scrollY));
  // In an animation frame, as focus-clear.mjs scrolls: scroll down 120 px, then change the size of a reply above the
  // view. The frame’s scroll steps have run already, so the ResizeObserver runs before the scroll event tells the
  // transcript the view moved.
  await page.evaluate(
    () =>
      new Promise((done) =>
        requestAnimationFrame(() => {
          scrollBy(0, 120);
          const first = document.querySelector('#main .item');
          if (first instanceof HTMLElement) first.style.paddingBottom = '1px';
          done(null);
        }),
      ),
  );
  await settled(page);
  expect(await page.evaluate(() => Math.round(scrollY)), 'the view stays where the scroll put it, plus the 1 px above').toBeGreaterThanOrEqual(before + 119);
});
