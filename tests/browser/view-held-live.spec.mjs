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
