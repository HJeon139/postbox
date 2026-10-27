// The transcript keeps following while you type a long draft at the end (#422): the composer grows, and the newest
// message stays above it, then so does the reply that streams in next. Scrolled up, a growing draft leaves the view.

import { expect, test } from '@playwright/test';
import { failOnPageErrors, settled, startPostbox, synced } from './postbox.mjs';

/** @type {Awaited<ReturnType<typeof startPostbox>>} */
let app;
test.beforeAll(async () => {
  app = await startPostbox('composer-follow');
});
test.afterAll(async () => {
  await app?.stop();
});
failOnPageErrors(test);
test.use({ colorScheme: 'light' });

/** A conversation of ten questions and answers, open in the page at the given width. */
async function room(page, title, width) {
  const { rt, store } = app;
  const t = rt.createThread({ projectId: Object.values(store.state.projects)[0].id, title, personaIds: [rt.personaByHandle('librarian').id] });
  const se = rt.sessionsIn(t.id)[0];
  const say = (text, status = 'done') => rt.addItem(t.id, { kind: 'agent', sessionId: se.id, personaId: se.personaId, handle: se.handle, text, status });
  for (let i = 1; i <= 10; i++) {
    rt.addItem(t.id, { kind: 'user', text: `Question ${i}` });
    say(`Answer ${i}: the third shelf, by the window.`);
  }
  await page.setViewportSize({ width, height: 800 });
  await page.goto(`${app.origin}/#/t/${t.id}`);
  await synced(page, app);
  await settled(page);
  return { t, say };
}
/** How far the newest message ends below the composer’s top: 0 or less is above it. */
const under = (page) =>
  page.evaluate(() => {
    const last = /** @type {HTMLElement} */ ([...document.querySelectorAll('#main > [data-key]')].at(-1));
    const composer = /** @type {HTMLElement} */ (document.querySelector('#composer-input')?.closest('.composer'));
    return Math.round(last.getBoundingClientRect().bottom - composer.getBoundingClientRect().top);
  });
/** Types six lines with Shift+Enter, as a person writes a long draft. */
async function typeDraft(page) {
  await page.locator('#composer-input').focus();
  for (let i = 1; i <= 6; i++) {
    await page.keyboard.insertText(`line ${i} of a long draft`);
    await page.keyboard.press('Shift+Enter');
  }
}

for (const width of [1280, 375])
  test(`#422 at ${width} px, a six-line draft at the end keeps the newest message above the composer, and the next reply too`, async ({ page }) => {
    const { t, say } = await room(page, `Long draft ${width}`, width);
    expect(await under(page), 'the newest message starts above the composer').toBeLessThanOrEqual(0);
    await typeDraft(page);
    await settled(page);
    expect(await under(page), 'the draft grew the composer, and the newest message is still above it').toBeLessThanOrEqual(0);
    const reply = say('Streaming', 'streaming');
    let text = 'Streaming';
    for (let k = 0; k < 12; k++) {
      text += `\n\nParagraph ${k}: the 1874 Middlemarch sits with the first editions by the window.`;
      app.rt.patchItem(t.id, reply.id, { text });
    }
    app.rt.patchItem(t.id, reply.id, { text: `${text}\n\nDone.`, status: 'done' });
    await synced(page, app);
    await settled(page);
    expect(await under(page), 'the reply that streamed in ends above the composer: it was followed').toBeLessThanOrEqual(0);
  });

test('#422 scrolled up, a growing draft leaves the view where it is', async ({ page }) => {
  await room(page, 'Long draft, scrolled up', 1280);
  await page.mouse.move(760, 400);
  await page.mouse.wheel(0, -500);
  await settled(page);
  const y = await page.evaluate(() => scrollY);
  await typeDraft(page);
  await settled(page);
  expect(Math.abs((await page.evaluate(() => scrollY)) - y), 'the view didn’t move').toBeLessThanOrEqual(1);
});
