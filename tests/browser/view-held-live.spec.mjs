// While you follow a running reply, it shrinks and grows back over and over: its older steps fold into “N earlier
// steps”, its working row comes and goes. The transcript holds the room a shrink leaves below the newest message with
// its own bottom margin (view-state.mjs follow(), #959, #1150), so the view doesn’t jump. That room was only ever added
// to: a reply that grew back grew past it, so each shrink and regrowth left more empty room below, and following
// scrolled into it, until the page showed nothing but the room. The held room now gives back what the reply grows
// into, so it’s never more than one shrink, and the newest message stays in view.

import { expect, test } from '@playwright/test';
import * as arrange from '../arrange.mjs';
import { failOnPageErrors, frames, settled, startPostbox, synced } from './postbox.mjs';

/** @type {Awaited<ReturnType<typeof startPostbox>>} */
let app;
test.beforeAll(async () => {
  app = await startPostbox('view-held-live');
});
test.afterAll(async () => app?.stop());
failOnPageErrors(test);

const WORDS = (n) => Array.from({ length: n }, (_, i) => `Line ${i} of what the agent has found so far, as it streams in.`).join('\n\n');

test('following a running reply that shrinks and grows back, the held room stays within one shrink and the reply in view', async ({ page }) => {
  const { rt, store } = app;
  const project = Object.values(store.state.projects)[0];
  const t = rt.createThread({ projectId: project.id, title: 'Held live', personaIds: [arrange.persona(rt, 'researcher').id] });
  const [se] = arrange.sessionsIn(rt, t.id);
  for (let i = 1; i <= 12; i++) arrange.post(rt, t.id, { kind: 'user', text: `Question ${i}, long enough to take a line or two of the room.` });
  const reply = arrange.post(rt, t.id, { kind: 'agent', sessionId: se.id, personaId: se.personaId, handle: se.handle, text: WORDS(12), status: 'streaming' });
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto(`${app.origin}/#/t/${t.id}`);
  await synced(page, app);
  await settled(page);
  const transcript = page.locator('#main.transcript');
  await expect(transcript).toHaveAttribute('data-view-mode', 'following');
  const held = () => transcript.evaluate((el) => Number.parseFloat(/** @type {HTMLElement} */ (el).style.marginBottom) || 0);
  const box = () =>
    page
      .locator(`#main > .item[data-key="${reply.id}"]`)
      .evaluate((n) => ({ top: n.getBoundingClientRect().top, bottom: n.getBoundingClientRect().bottom, view: innerHeight }));
  let biggest = 0;
  for (let round = 0; round < 8; round++) {
    // It shrinks, as its older steps fold, then grows back past where it was.
    const before = (await box()).bottom - (await box()).top;
    arrange.setItem(rt, t.id, reply.id, { text: WORDS(6) });
    await frames(page);
    await settled(page);
    biggest = Math.max(biggest, before - ((await box()).bottom - (await box()).top));
    store.emit('item.text', { threadId: t.id, id: reply.id, text: `\n\n${WORDS(7).split('\n\n').slice(0, 7).join('\n\n')}` });
    await frames(page);
    await settled(page);
  }
  expect(await held(), `the held room, against the largest shrink of ${Math.round(biggest)} px`).toBeLessThanOrEqual(biggest + 1);
  const b = await box();
  expect(b.bottom, 'the reply’s end is in view').toBeLessThanOrEqual(b.view);
  expect(b.bottom, 'and the reply hasn’t scrolled away above').toBeGreaterThan(b.view / 2);
  await expect(transcript).toHaveAttribute('data-view-mode', 'following');
});

// A running reply’s parts can shrink and grow again in one frame, before the view measures: the browser clamps the
// view up to the shorter page, and the page then grows past where it was. With nothing lost by the time it measured,
// the view took a clamp of more than its slack for you scrolling up, and stopped following. A page longer than the view
// held, with the same newest message, still in view, is that clamp (view-state.mjs clamped()).
test('following, a shrink and regrowth in one frame, with no input of yours, keeps following at the end', async ({ page }) => {
  const { rt, store } = app;
  const project = Object.values(store.state.projects)[0];
  const t = rt.createThread({ projectId: project.id, title: 'Held live, one frame', personaIds: [arrange.persona(rt, 'researcher').id] });
  const [se] = arrange.sessionsIn(rt, t.id);
  for (let i = 1; i <= 12; i++) arrange.post(rt, t.id, { kind: 'user', text: `Question ${i}, long enough to take a line or two of the room.` });
  arrange.post(rt, t.id, { kind: 'agent', sessionId: se.id, personaId: se.personaId, handle: se.handle, text: WORDS(12), status: 'done' });
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto(`${app.origin}/#/t/${t.id}`);
  await synced(page, app);
  // A part of the newest reply that the live view would draw, 60 px tall.
  await page.evaluate(() => {
    const part = document.createElement('div');
    part.id = 'live-part';
    part.style.height = '60px';
    [...document.querySelectorAll('#main > .item')].at(-1)?.append(part);
  });
  await settled(page);
  const transcript = page.locator('#main.transcript');
  await expect(transcript).toHaveAttribute('data-view-mode', 'following');
  for (let round = 0; round < 3; round++) {
    await page.evaluate(() => {
      const part = /** @type {HTMLElement} */ (document.getElementById('live-part'));
      part.style.height = '30px'; // it shrinks by more than the view’s slack
      void document.scrollingElement?.scrollTop; // a layout: the browser clamps the view to the shorter page
      part.style.height = `${60 + 200}px`; // and grows past where it was, in the same frame
    });
    await frames(page);
    await settled(page);
    await expect(transcript, `round ${round}`).toHaveAttribute('data-view-mode', 'following');
    await page.evaluate(() => {
      /** @type {HTMLElement} */ (document.getElementById('live-part')).style.height = '60px';
    });
    await settled(page);
  }
  const atEnd = await page.evaluate(() => {
    const s = /** @type {Element} */ (document.scrollingElement);
    return s.scrollHeight - s.clientHeight - s.scrollTop;
  });
  expect(atEnd, 'at the end').toBeLessThanOrEqual(2);
});

// The held room gives back only what the newest message grows into. Growth above it, such as a picture loading in an
// older message, keeps the room: given back, the page’s end wouldn’t move, and the newest message would slide down
// under the pointer by what grew (#1469’s review).
test('following, growth above the newest message keeps the held room, and the newest message where it was', async ({ page }) => {
  const { rt, store } = app;
  const project = Object.values(store.state.projects)[0];
  const t = rt.createThread({ projectId: project.id, title: 'Held, growth above', personaIds: [arrange.persona(rt, 'researcher').id] });
  const [se] = arrange.sessionsIn(rt, t.id);
  for (let i = 1; i <= 12; i++) arrange.post(rt, t.id, { kind: 'user', text: `Question ${i}, long enough to take a line or two of the room.` });
  const reply = arrange.post(rt, t.id, { kind: 'agent', sessionId: se.id, personaId: se.personaId, handle: se.handle, text: WORDS(12), status: 'streaming' });
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto(`${app.origin}/#/t/${t.id}`);
  await synced(page, app);
  await settled(page);
  const transcript = page.locator('#main.transcript');
  await expect(transcript).toHaveAttribute('data-view-mode', 'following');
  arrange.setItem(rt, t.id, reply.id, { text: WORDS(6) });
  await frames(page);
  await settled(page);
  const held = () => transcript.evaluate((el) => Number.parseFloat(/** @type {HTMLElement} */ (el).style.marginBottom) || 0);
  await expect.poll(held, { message: 'the shrink is held' }).toBeGreaterThan(0);
  await settled(page);
  const room = await held();
  const top = () => page.locator(`#main > .item[data-key="${reply.id}"]`).evaluate((n) => n.getBoundingClientRect().top);
  const before = await top();
  await page.evaluate(() => {
    const items = [...document.querySelectorAll('#main > .item')];
    /** @type {HTMLElement} */ (items.at(-2)).style.paddingBottom = '80px'; // a picture loading above the newest message
  });
  await frames(page);
  await settled(page);
  expect(await held(), 'the held room stays').toBeCloseTo(room, 0);
  expect(Math.abs((await top()) - before), 'the newest message stays where it was').toBeLessThanOrEqual(1);
});
