// A draft that grows the composer at the end of the conversation keeps the newest message above it, and the next
// reply is followed (#422, one of PF-3’s scroll regressions for #508 B1’s view state). Scrolled up, a growing draft
// moves nothing you’re reading. Each test has a conversation of its own; every step waits for the page to hold still
// and then measures once.

import { expect, test } from '@playwright/test';
import { failOnPageErrors, frames, settled, startPostbox, synced } from './postbox.mjs';

/** @type {Awaited<ReturnType<typeof startPostbox>>} */
let app;
test.beforeAll(async () => {
  app = await startPostbox('composer-grow');
});
test.afterAll(async () => {
  await app?.stop();
});
failOnPageErrors(test);

const LONG = (n) => `Reply ${n}. The observation is the only outside evidence in the loop, so it keeps the plan grounded while the agent reads the results.`;

/** A room long enough to scroll, with @researcher. */
function room(title) {
  const { rt, store } = app;
  const project = Object.values(store.state.projects)[0];
  const t = rt.createThread({ projectId: project.id, title, personaIds: [rt.personaByHandle('researcher').id] });
  const [se] = rt.sessionsIn(t.id);
  for (let i = 1; i <= 24; i++) {
    if (i % 3 === 1) rt.addItem(t.id, { kind: 'user', text: `Question ${i}?` });
    else rt.addItem(t.id, { kind: 'agent', sessionId: se.id, personaId: se.personaId, handle: se.handle, text: LONG(i), status: 'done' });
  }
  return { t, se };
}

/** Streams a reply a few words a frame, ends it, and waits for the page to draw its end. */
async function stream(page, t, se, text) {
  const { rt, store } = app;
  const it = rt.addItem(t.id, { kind: 'agent', sessionId: se.id, personaId: se.personaId, handle: se.handle, text: '', status: 'streaming' });
  for (const chunk of text.match(/\S+\s*/g) ?? []) {
    store.emit('item.text', { threadId: t.id, id: it.id, text: chunk });
    await frames(page);
  }
  rt.patchItem(t.id, it.id, { status: 'done' });
  await expect(page.locator(`[data-key="${it.id}"] .caret`)).toHaveCount(0);
  await settled(page);
  return it;
}

/** How far the newest message’s bottom is above the composer’s top: negative when the composer covers it. */
const clearance = (page) =>
  page.evaluate(() => {
    const items = document.querySelectorAll('#main .item');
    const last = items[items.length - 1];
    const composer = document.querySelector('.composer');
    return Math.round((composer?.getBoundingClientRect().top ?? 0) - (last?.getBoundingClientRect().bottom ?? 0));
  });
const composerHeight = (page) => page.locator('.composer').evaluate((c) => Math.round(c.getBoundingClientRect().height));

/** Opens the conversation at the given width, at its end. */
async function open(page, t, width) {
  await page.setViewportSize({ width, height: 800 });
  await page.goto(`${app.origin}/#/t/${t.id}`);
  await synced(page, app);
  await expect(page.locator(`.transcript[data-thread="${t.id}"] .item`).first()).toBeVisible();
  await settled(page);
  expect(await clearance(page), 'the newest message starts above the composer').toBeGreaterThanOrEqual(0);
}

/** Types a six-line draft with Shift+Enter, as a person does, and waits for the composer to have grown. */
async function sixLines(page) {
  const before = await composerHeight(page);
  const input = page.locator('#composer-input');
  await input.click();
  for (let i = 1; i <= 6; i++) {
    await input.pressSequentially(`Line ${i} of the draft`);
    if (i < 6) await input.press('Shift+Enter');
  }
  await expect.poll(() => composerHeight(page), { message: 'the composer to grow with the draft' }).toBeGreaterThan(before + 60);
  await settled(page);
}

for (const width of [1280, 375]) {
  test(`#422 at ${width} px: at the end, a six-line draft keeps the newest message above the composer`, async ({ page }) => {
    const { t } = room(`Draft at the end, ${width}`);
    await open(page, t, width);
    await sixLines(page);
    expect(await clearance(page), 'the newest message is still above the composer').toBeGreaterThanOrEqual(0);
  });

  test(`#422 at ${width} px: after a six-line draft, a reply that streams in is followed`, async ({ page }) => {
    const { t, se } = room(`Reply after a draft, ${width}`);
    await open(page, t, width);
    await sixLines(page);
    await stream(page, t, se, LONG(99));
    expect(await clearance(page), 'the reply ends above the composer').toBeGreaterThanOrEqual(0);
  });
}

test('#422: scrolled up, a growing draft moves nothing you’re reading', async ({ page }) => {
  const { t } = room('Draft while reading back');
  await open(page, t, 1280);
  await page.mouse.move(640, 400);
  await page.mouse.wheel(0, -600);
  await settled(page);
  const reading = () =>
    page.evaluate(() => {
      const n = /** @type {HTMLElement | undefined} */ (document.elementFromPoint(640, innerHeight / 3)?.closest('.item'));
      return n ? { key: n.dataset.key ?? '', top: Math.round(n.getBoundingClientRect().top) } : null;
    });
  const before = await reading();
  expect(before, 'a message is in view').not.toBeNull();
  await sixLines(page);
  expect(await reading(), 'the same message, where it was').toEqual(before);
});
