// Scrolling up while an agent streams leaves the view up (#88): the wheel moves the view before its scroll event
// fires, and a reply’s chunks and new messages land in between, so nothing may take that for the page changing under
// the view and pull it back to the end (#297). Each test has a conversation of its own.

import { expect, test } from '@playwright/test';
import { failOnPageErrors, settled, startPostbox, synced } from './postbox.mjs';

test.use({ colorScheme: 'light' });

/** @type {Awaited<ReturnType<typeof startPostbox>>} */
let app;
test.beforeAll(async () => {
  app = await startPostbox('transcript-wheel');
});
test.afterAll(async () => {
  await app?.stop();
});
failOnPageErrors(test);

const LONG = (n) =>
  `Message ${n}. The ReAct loop alternates a thought, an action and an observation; the observation is the only outside evidence, so it keeps the plan grounded while the agent works through the search results one at a time.`;

/** A long room with @researcher and @critic: questions, and the agents’ long answers. */
function room(title) {
  const { rt, store } = app;
  const project = Object.values(store.state.projects)[0];
  const t = rt.createThread({ projectId: project.id, title, personaIds: [rt.personaByHandle('researcher').id, rt.personaByHandle('critic').id] });
  const [researcher, critic] = rt.sessionsIn(t.id);
  for (let i = 1; i <= 24; i++) {
    const se = i % 2 ? critic : researcher;
    if (i % 3 === 1) rt.addItem(t.id, { kind: 'user', text: `Question ${i}: what does the observation step add?` });
    else rt.addItem(t.id, { kind: 'agent', sessionId: se.id, personaId: se.personaId, handle: se.handle, text: LONG(i), status: 'done' });
  }
  return { t, researcher };
}
const gap = (page) => page.evaluate(() => Math.round(document.scrollingElement.scrollHeight - scrollY - innerHeight));

/** Opens a conversation, and waits for its transcript to draw and hold still at its end. */
async function open(page, t) {
  await page.goto(`${app.origin}/#/t/${t.id}`);
  await synced(page, app);
  await expect(page.locator(`.transcript[data-thread="${t.id}"] .item`).first()).toBeVisible();
  await settled(page);
  expect(await gap(page), 'stuck at the end').toBeLessThanOrEqual(2);
}

/**
 * Streams a long reply a few words a frame, the way an agent does, with a message from you every few frames, until
 * stop() is called; then ends the reply. The wheel moves the view before its scroll event fires.
 */
function streamOn(page, t, se) {
  const { rt, store } = app;
  const it = rt.addItem(t.id, { kind: 'agent', sessionId: se.id, personaId: se.personaId, handle: se.handle, text: '', status: 'streaming' });
  let on = true;
  const words =
    Array.from({ length: 30 }, (_, i) => LONG(600 + i))
      .join(' ')
      .match(/\S+\s*/g) ?? [];
  const done = (async () => {
    for (let i = 0; on && i < words.length; i++) {
      store.emit('item.text', { threadId: t.id, id: it.id, text: words[i] });
      // A message from someone else now and then: unlike the reply’s text, which the page draws in its next animation
      // frame, the page adds it as soon as it hears it, so it can land between a wheel turn and its scroll event.
      if (i % 4 === 3) rt.addItem(t.id, { kind: 'user', text: `Meanwhile ${i}` });
      await page.evaluate(() => new Promise((r) => requestAnimationFrame(r)));
    }
    rt.patchItem(t.id, it.id, { status: 'done' });
  })();
  return async () => {
    on = false;
    await done;
  };
}
/** The gap to the end in each of the next frames, read in the page, while the reply goes on streaming. */
const gapsOver = (page, n) =>
  page.evaluate(async (count) => {
    const gaps = [];
    for (let i = 0; i < count; i++) {
      await new Promise((r) => requestAnimationFrame(r));
      gaps.push(Math.round(document.scrollingElement.scrollHeight - scrollY - innerHeight));
    }
    return gaps;
  }, n);

for (const [how, steps] of [
  ['one turn of the wheel', [-300]],
  ['small steps of the wheel', [-60, -60, -60, -60, -60]],
])
  test(`#88 while an agent streams, ${how} up leaves the view up: nothing pulls it back to the end`, async ({ page }) => {
    const { t, researcher } = room(`Scroll up while streaming: ${how}`);
    await open(page, t);
    const stop = streamOn(page, t, researcher);
    try {
      // A few chunks in, so the view is following the reply as it grows.
      await expect.poll(() => page.locator('.caret').count(), { message: 'the reply streaming' }).toBe(1);
      await gapsOver(page, 5);
      await page.mouse.move(760, 400);
      for (const dy of steps) await page.mouse.wheel(0, dy);
      await expect.poll(() => gap(page), { message: 'the view off the end' }).toBeGreaterThan(2);
      const gaps = await gapsOver(page, 30);
      expect(Math.min(...gaps), `the gap in each frame after: ${gaps.join(', ')}`).toBeGreaterThan(100);
    } finally {
      await stop();
    }
    await settled(page);
    expect(await gap(page), 'still up once the reply ends').toBeGreaterThan(100);
  });
