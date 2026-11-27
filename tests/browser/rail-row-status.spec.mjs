// A room’s row in the sidebar lost its status word: with two or more agents, the names filled the line and the
// ellipsis cut “· idle” or “· needs you”, which only the ring then said (UAT of 26 Nov). The names now give way: they
// end in “…”, and the status word stays whole, at the sidebar’s default width.

import { expect, test } from '@playwright/test';
import * as arrange from '../arrange.mjs';
import { failOnPageErrors, settled, startPostbox, synced } from './postbox.mjs';

/** @type {Awaited<ReturnType<typeof startPostbox>>} */
let app;
test.beforeAll(async () => {
  app = await startPostbox('rail-row-status');
});
test.afterAll(async () => {
  await app?.stop();
});
failOnPageErrors(test);
test.use({ viewport: { width: 1280, height: 800 } });

test('a room of four agents keeps its status word whole in its sidebar row', async ({ page }) => {
  const { rt } = app;
  const personas = ['indexer', 'researcher', 'critic', 'librarian'].map((handle) => arrange.persona(rt, handle) ?? rt.createPersona({ handle }));
  const t = rt.createThread({ projectId: Object.values(rt.store.state.projects)[0].id, title: 'Index planning', personaIds: personas.map((p) => p.id) });
  await page.goto(`${app.origin}/#/t/${t.id}`);
  await synced(page, app);
  const sub = page.locator(`.rail a[href="#/t/${t.id}"] .name .sub`);
  await expect(sub.locator('.state-word')).toHaveText(' · idle');
  await settled(page);
  // The word’s whole box is inside the line’s, so nothing of it is cut off.
  const fit = await sub.evaluate((s) => {
    const box = s.getBoundingClientRect();
    const word = /** @type {HTMLElement} */ (s.querySelector('.state-word')).getBoundingClientRect();
    return { line: Math.round(box.right), word: Math.round(word.right) };
  });
  expect(fit.word, `the status word ends at ${fit.word} px, in a line that ends at ${fit.line} px`).toBeLessThanOrEqual(fit.line);
});
