// Typing in the composer lays out the page once per frame, not three times a key (#641). Sizing the draft read the
// box’s scrollHeight and the page’s scrollTop on every input event, and each read laid out the whole conversation:
// about 65 ms a read in a room of 3,500 items, so a key took 232 ms to reach the screen.
// On a seeded conversation of 200 agent replies, the page counts Chromium’s layouts while a person types, and the
// composer still grows with the draft and shrinks when it’s cleared.

import { expect, test } from '@playwright/test';
import { failOnPageErrors, settled, startPostbox, synced } from './postbox.mjs';

/** @type {Awaited<ReturnType<typeof startPostbox>>} */
let app;

test.beforeAll(async () => {
  app = await startPostbox('composer-typing', { demo: false });
  app.store.emit('project', { id: 'pr_typing', name: 'Typing', folder: app.root });
});
test.afterAll(async () => app?.stop());
failOnPageErrors(test);

const TEXT = 'The observation is the only outside evidence in the loop, so it keeps the plan grounded. ';

/** A conversation of 200 agent replies, open in the page at its end, with the composer focused. */
async function seeded(page, name, width = 1280) {
  const { rt } = app;
  const p = rt.createPersona({ handle: name });
  const t = rt.createThread({ projectId: 'pr_typing', title: `Typing ${name}`, personaIds: [p.id] });
  const se = rt.sessionsIn(t.id)[0];
  for (let i = 0; i < 200; i++)
    rt.addItem(t.id, { kind: 'agent', sessionId: se.id, personaId: se.personaId, handle: se.handle, text: TEXT.repeat(4), status: 'done' });
  await page.setViewportSize({ width, height: 800 });
  await page.goto(`${app.origin}/#/t/${t.id}`);
  await synced(page, app);
  await expect(page.locator(`.transcript[data-thread="${t.id}"] .item`)).toHaveCount(200);
  const input = page.locator('#composer-input');
  await input.click();
  await settled(page);
  return input;
}

const KEYS = 'typing a message';

test('#641: each key typed into the composer costs at most one layout', async ({ page }) => {
  const input = await seeded(page, 'counter');
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Performance.enable');
  const layouts = async () => (await cdp.send('Performance.getMetrics')).metrics.find((m) => m.name === 'LayoutCount')?.value ?? 0;
  const before = await layouts();
  await input.pressSequentially(KEYS);
  await settled(page);
  const count = (await layouts()) - before;
  await cdp.detach();
  test.info().annotations.push({ type: 'measured', description: `${count} layouts for ${KEYS.length} keys` });
  await expect(input).toHaveValue(KEYS);
  // The frame after each key lays out once, and keys that land in the same frame share it; settling adds a frame or two.
  expect(count, `${count} layouts for ${KEYS.length} keys`).toBeLessThanOrEqual(KEYS.length + 4);
});

test('#641: the composer grows with a long draft, up to its limit, and shrinks when the draft is cleared', async ({ page }) => {
  const input = await seeded(page, 'grows');
  const height = () => input.evaluate((el) => Math.round(el.getBoundingClientRect().height));
  const one = await height();
  for (let i = 1; i <= 3; i++) {
    await input.pressSequentially(`Line ${i}`);
    await input.press('Shift+Enter');
  }
  await expect.poll(height, { message: 'three lines make the box taller' }).toBeGreaterThan(one + 30);
  for (let i = 4; i <= 14; i++) {
    await input.pressSequentially(`Line ${i}`);
    await input.press('Shift+Enter');
  }
  await settled(page);
  expect(await height(), 'the box stops at 200 px and scrolls').toBe(200);
  expect(await input.evaluate((el) => el.scrollHeight > el.clientHeight), 'the draft scrolls inside it').toBe(true);
  await input.press('ControlOrMeta+a');
  await input.press('Backspace');
  await expect.poll(height, { message: 'an empty draft is one line again' }).toBe(one);
});

test('#641: an empty composer stays one line when its placeholder wraps', async ({ page }) => {
  // A 24-letter handle, the longest a name can be, makes the placeholder wrap in a phone’s width. The empty box keeps one
  // line, as it did when script sized it, rather than growing to fit the placeholder.
  const input = await seeded(page, 'librarian-of-long-names1', 375);
  await expect(input).toHaveAttribute('placeholder', 'Message librarian-of-long-names1');
  const height = () => input.evaluate((el) => Math.round(el.getBoundingClientRect().height));
  const empty = await height();
  await input.pressSequentially('a');
  await settled(page);
  expect(empty, 'the empty box is as tall as one typed line').toBe(await height());
});
