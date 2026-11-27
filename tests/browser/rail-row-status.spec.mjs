// A room’s row in the sidebar lost its status word: with two or more agents, the names filled the line and the
// ellipsis cut “· idle” or “· needs you”, which only the ring then said (UAT of 26 Nov). The names now give way: they
// end in “…”, and the status word stays whole, at the sidebar’s default width. A word too long for the line gives way
// too, once the names are down to their first letters, so the row still names who it is.

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

/** A room of four agents, its row’s second line, and how that line lays out once it holds still. @param {any} page @param {string} title */
async function roomRow(page, title, arrangeIt = (/** @type {any} */ _t) => {}) {
  const { rt } = app;
  const personas = ['indexer', 'researcher', 'critic', 'librarian'].map((handle) => arrange.persona(rt, handle) ?? rt.createPersona({ handle }));
  const t = rt.createThread({ projectId: Object.values(rt.store.state.projects)[0].id, title, personaIds: personas.map((p) => p.id) });
  arrangeIt(t);
  await page.goto(`${app.origin}/#/t/${t.id}`);
  await synced(page, app);
  const sub = page.locator(`.rail a[href="#/t/${t.id}"] .name .sub`);
  const layout = async () => {
    await settled(page);
    return sub.evaluate((s) => {
      // The names, or the whole line where they have no box of their own.
      const who = /** @type {HTMLElement} */ (s.querySelector('.who') ?? s);
      const word = /** @type {HTMLElement} */ (s.querySelector('.state-word'));
      // The “·” after the space the word starts with, so a space lost at the start of the word shows.
      const dot = document.createRange();
      dot.setStart(/** @type {Text} */ (word.firstChild), 1);
      dot.setEnd(/** @type {Text} */ (word.firstChild), 2);
      const box = (/** @type {Element|Range} */ e) => e.getBoundingClientRect();
      return {
        line: Math.round(box(s).right),
        sameLine: Math.round(box(who).top) === Math.round(box(word).top),
        names: who.clientWidth,
        namesCut: who.scrollWidth > who.clientWidth,
        namesEnd: box(who).right,
        dot: box(dot).left,
        wordEnd: Math.round(box(word).right),
        wordWhole: word.scrollWidth <= word.clientWidth,
      };
    });
  };
  return { sub, layout };
}

test('a room of four agents keeps its status word whole in its sidebar row', async ({ page }) => {
  const { sub, layout } = await roomRow(page, 'Index planning');
  await expect(sub.locator('.state-word')).toHaveText(' · idle');
  const fit = await layout();
  expect.soft(fit.sameLine, 'the word is on the names’ line').toBe(true);
  expect.soft(fit.namesCut, 'the names end in “…”').toBe(true);
  expect.soft(fit.wordWhole, 'the word is whole').toBe(true);
  expect.soft(fit.dot - fit.namesEnd, 'a space between the names’ “…” and the “·”').toBeGreaterThan(1);
  expect.soft(fit.wordEnd, `the status word ends at ${fit.wordEnd} px, in a line that ends at ${fit.line} px`).toBeLessThanOrEqual(fit.line);
});

test('a status word too long for the line ends in “…” after the first letters of the names', async ({ page }) => {
  const { sub, layout } = await roomRow(page, 'Index sides', (t) => {
    const [se] = arrange.sessionsIn(app.rt, t.id);
    const side = arrange.putThread(app.rt, {
      ...{ id: `th_side${t.id.slice(3)}`, projectId: t.projectId, title: 'indexer ↔ critic', kind: 'side', parentId: t.id },
      ...{ pair: 'critic|indexer', woke: 'indexer', members: [], lastSpeaker: null, hops: 0, queue: [], createdAt: Date.now() },
    });
    arrange.setSession(app.rt, se.id, { state: 'tool', sideTurn: { threadId: side.id } });
  });
  await expect(sub.locator('.state-word')).toHaveText(' · calling tools in a side thread');
  const fit = await layout();
  expect.soft(fit.sameLine, 'the word is on the names’ line').toBe(true);
  expect.soft(fit.names, 'the names keep their first letters').toBeGreaterThan(10);
  expect.soft(fit.wordEnd, `the status word ends at ${fit.wordEnd} px, in a line that ends at ${fit.line} px`).toBeLessThanOrEqual(fit.line);
});
