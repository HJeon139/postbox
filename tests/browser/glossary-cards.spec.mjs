// Glossary cards nest (#103): a glossary term inside a definition opens a card of its own over its parent’s, by mouse
// and by keyboard; leaving the child closes only the child, a cycle (U → U:13 → U) and a fourth level open nothing,
// and the cards stay on screen at 375 px. transcript-render.spec.mjs checks the rest of how replies render. Moved
// from tools/check-transcript-render.mjs (#303).

import { expect, test } from '@playwright/test';
import { failOnPageErrors, frames, startPostbox, synced } from './postbox.mjs';

/** @type {Awaited<ReturnType<typeof startPostbox>>} */
let app;
let persona;
/** The conversation with the nested glossary. */
const T = {};

test.beforeAll(async () => {
  app = await startPostbox('glossary-cards');
  const { rt } = app;
  persona = rt.createPersona({ handle: 'analyst' });
  nested(Object.values(rt.s.projects)[0]);
});
test.afterAll(async () => {
  await app?.stop();
});
failOnPageErrors(test);
test.use({ colorScheme: 'light' });

/**
 * #103: a conversation whose glossary nests. The terms from #103’s report: U’s definition names U:13, and U:13’s names
 * U back. alpha → beta → gamma → delta is one level deeper than the cards go.
 */
function nested(project) {
  const { rt } = app;
  T.nested = rt.createThread({ projectId: project.id, title: 'Nested glossary', personaIds: [persona.id] });
  const ns = rt.sessionsIn(T.nested.id)[0];
  const define = rt.toolsFor(ns.id).define_term;
  define({ term: 'U', definition: 'The utility of a claim: U is the sum over its labels, such as U:13.' });
  define({ term: 'U:13', definition: 'The utility of label 13, one term of U.' });
  for (const [term, next] of [
    ['alpha', 'beta'],
    ['beta', 'gamma'],
    ['gamma', 'delta'],
  ])
    define({ term, definition: `Leads on to ${next}.` });
  define({ term: 'delta', definition: 'The last one.' });
  rt.addItem(T.nested.id, { kind: 'agent', sessionId: ns.id, personaId: ns.personaId, handle: ns.handle, text: 'Rank by U. Start at alpha.', status: 'done' });
}

async function open(page, hash) {
  await page.goto(`${app.origin}/${hash}`);
  await synced(page, app);
}

// ── #103: nested glossary cards ─────────────────────────────────────────────────────────

const card = (page, term) => page.getByRole('dialog', { name: `Glossary: ${term}`, exact: true });
const reply = (page) => page.locator(`.transcript[data-thread="${T.nested.id}"] .turn .md`);
/** The cards open, bottom to top. */
const openCards = (page) => page.locator('.hovercard').evaluateAll((cs) => cs.map((c) => c.getAttribute('aria-label')?.replace('Glossary: ', '')));
/** Points at a term in a card (or the reply), and waits for its own card to pin. */
async function hover(page, from, term, key = term.toLowerCase()) {
  await (from ? card(page, from) : reply(page)).locator(`.term[data-term="${key}"]`).hover();
  await expect(card(page, term), `the card for ${term}, pinned`).toHaveClass(/\bpinned\b/);
}
/** U’s card, pinned from the keyboard: Enter on U in the reply. */
async function pinU(page) {
  await reply(page).locator('.term[data-term="u"]').focus();
  await page.keyboard.press('Enter');
  await expect(card(page, 'U')).toHaveClass(/\bpinned\b/);
}
/**
 * That pointing at a term opened no card. A card opens as the pointer arrives, and only pins after a still moment, so
 * two frames after the move is when it would be there.
 */
async function opensNothing(page, from, key, want) {
  await card(page, from).locator(`.term[data-term="${key}"]`).hover();
  await frames(page);
  expect(await openCards(page)).toEqual(want);
}
async function openNested(page) {
  await open(page, `#/t/${T.nested.id}`);
  await expect(reply(page).locator('.term').first()).toBeVisible();
}

test('#103 hovering U, then U:13 in its card, shows both; leaving U:13 for U’s card closes only U:13', async ({ page }) => {
  await openNested(page);
  await hover(page, null, 'U');
  await expect(card(page, 'U').locator('.term[data-term="u"]'), 'U’s definition doesn’t link U itself').toHaveCount(0);
  await hover(page, 'U', 'U:13', 'u-13');
  expect(await openCards(page)).toEqual(['U', 'U:13']);
  await card(page, 'U:13').locator('.hc-head').hover();
  await card(page, 'U').locator('.hc-head').hover();
  await expect(card(page, 'U:13'), 'U:13’s card closes').toHaveCount(0);
  expect(await openCards(page)).toEqual(['U']);
  // Nothing counts down to close U’s card: a card closing after its pointer left shows its bar running out.
  const running = await card(page, 'U')
    .locator('.loadbar i')
    .evaluate((i) => i.getAnimations().filter((a) => a.playState === 'running').length);
  expect(running, 'U’s card stays').toBe(0);
});

test('#103 a cycle opens no more cards: U inside U:13’s card, under U’s', async ({ page }) => {
  await openNested(page);
  await hover(page, null, 'U');
  await hover(page, 'U', 'U:13', 'u-13');
  await opensNothing(page, 'U:13', 'u', ['U', 'U:13']);
});

test('#103 cards go three deep: delta inside gamma’s card opens nothing', async ({ page }) => {
  await openNested(page);
  await hover(page, null, 'alpha');
  await hover(page, 'alpha', 'beta');
  await hover(page, 'beta', 'gamma');
  await opensNothing(page, 'gamma', 'delta', ['alpha', 'beta', 'gamma']);
});

test('#103 by keyboard: Enter pins and moves into the card, Tab reaches U:13, Escape closes one card at a time', async ({ page }) => {
  await openNested(page);
  const at = () =>
    page.evaluate(() => {
      const a = /** @type {HTMLElement} */ (document.activeElement);
      return `${a.closest('.hovercard')?.getAttribute('aria-label') ?? 'page'} ${a.dataset.term ?? a.className}`;
    });
  await pinU(page);
  expect(await at(), 'Enter pins U’s card and moves into it').toBe('Glossary: U hovercard pinned');
  await page.keyboard.press('Tab');
  await expect.poll(at, { message: 'Tab reaches U:13' }).toBe('Glossary: U u-13');
  await page.keyboard.press('Space');
  await expect(card(page, 'U:13')).toHaveClass(/\bpinned\b/);
  expect(await openCards(page), 'Space pins U:13’s card over U’s').toEqual(['U', 'U:13']);
  await page.keyboard.press('Escape');
  await expect.poll(() => openCards(page), { message: 'Escape closes the top card' }).toEqual(['U']);
  await expect.poll(at, { message: 'and focus returns to its term' }).toBe('Glossary: U u-13');
  await page.keyboard.press('Escape');
  await expect.poll(() => openCards(page)).toEqual([]);
  await expect.poll(at, { message: 'focus returns to U in the reply' }).toBe('page u');
});

test('#103 a card that closes while it has focus, as the pointer opens another, gives focus back to its term', async ({ page }) => {
  await openNested(page);
  await pinU(page);
  await hover(page, null, 'alpha');
  expect(await openCards(page), 'the pointer’s card replaces U’s').toEqual(['alpha']);
  await expect(reply(page).locator('.term[data-term="u"]'), 'focus is back on U in the reply').toBeFocused();
});

test.describe('at 375 px', () => {
  test.use({ viewport: { width: 375, height: 812 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });

  test('#103 at 375 px, both cards stay on screen, and nothing scrolls sideways', async ({ page }) => {
    await openNested(page);
    // Opened by keyboard, which pins at once: pointing needs 650 ms of a still pointer, and under load timed out (#271).
    await pinU(page);
    await page.keyboard.press('Tab');
    await page.keyboard.press('Space');
    await expect(card(page, 'U:13')).toHaveClass(/\bpinned\b/);
    const inside = await page.locator('.hovercard').evaluateAll((cs) =>
      cs.map((c) => {
        const r = c.getBoundingClientRect();
        return r.left >= 0 && r.right <= innerWidth && r.top >= 0 && r.bottom <= innerHeight;
      }),
    );
    expect(inside, 'each card inside the window').toEqual([true, true]);
    expect(await page.evaluate(() => document.scrollingElement.scrollWidth <= innerWidth), 'no sideways scroll').toBe(true);
  });
});
