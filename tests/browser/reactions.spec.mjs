// Reactions inline (#320, after #251): under each message, beside “Reply in thread”, all five reactions as buttons,
// always shown. Yours is highlighted; one made only by others shows a count from 1. Who reacted shows in a hover card, which opens on hover and on keyboard focus, and the button’s
// label names them too.

import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { expect, test } from '@playwright/test';
import { toggleReaction } from '../../server/reactions.mjs';
import { failOnPageErrors, startPostbox, synced } from './postbox.mjs';

/** @type {Awaited<ReturnType<typeof startPostbox>>} */
let app;
/** @type {any} */
let thread;
/** @type {any} */
let critic;
/** @type {any} */
let message;

test.beforeAll(async () => {
  app = await startPostbox('reactions');
  const { rt, store } = app;
  store.emit('project', { id: 'pr_react', name: 'Reactions', folder: app.root });
  const persona = rt.createPersona({ handle: 'judge', backend: 'mock', permissionMode: 'auto', tools: [] });
  thread = rt.createThread({ projectId: 'pr_react', title: 'Reactions', personaIds: [persona.id] });
  critic = rt.sessionsIn(thread.id)[0];
  message = rt.addItem(thread.id, {
    kind: 'agent',
    sessionId: critic.id,
    personaId: persona.id,
    handle: 'judge',
    turnId: 'turn_r',
    text: 'Here is the plan.',
    status: 'done',
  });
});
test.afterAll(async () => {
  await app?.stop();
});
failOnPageErrors(test);

const item = (page) => page.locator(`.transcript > [data-key="${message.id}"]`);
const reaction = (page, name) => item(page).getByRole('button', { name: new RegExp(`^${name}\\b`) });
/** The agent’s own reaction, as its react tool makes one. */
async function criticReacts(page, emoji) {
  toggleReaction(app.rt, thread.id, message.id, emoji, { id: critic.id, handle: 'judge' });
  await synced(page, app);
}
/** Takes back every reaction, so each case starts from none. */
function clear() {
  app.rt.store.emit('item.patch', { threadId: thread.id, id: message.id, patch: { reactions: [] }, reaction: { emoji: '👍', on: false, at: Date.now() } });
}

test.beforeEach(async ({ page }) => {
  clear();
  await page.goto(`${app.origin}/#/t/${thread.id}`);
  await synced(page, app);
  await expect(item(page)).toBeVisible();
  // Nowhere near the message, so nothing shows only because the pointer is over it.
  await page.mouse.move(5, 5);
});

test('all five reactions show beside “Reply in thread”, without hovering, and there’s no React menu', async ({ page }) => {
  for (const name of ['Good', 'Not good', 'Flag this', 'Unclear', 'Done']) await expect(reaction(page, name), name).toBeVisible();
  const actions = item(page).locator('.msg-actions');
  await expect(actions.getByRole('button', { name: /^Good\b/ }), 'in the same row as Reply in thread').toBeVisible();
  await expect(actions.getByText('Reply in thread')).toBeAttached();
  await expect(item(page).getByRole('button', { name: 'React to this message' })).toHaveCount(0);
});

test('yours is highlighted, with no count while it’s yours alone, and clicking again takes it back', async ({ page }) => {
  await reaction(page, 'Good').click();
  await expect(reaction(page, 'Good')).toHaveAttribute('aria-pressed', 'true');
  await expect(reaction(page, 'Good').locator('.react-count')).toHaveCount(0);
  await reaction(page, 'Good').click();
  await expect(reaction(page, 'Good')).toHaveAttribute('aria-pressed', 'false');
});

test('#418 one made only by an agent shows a count; yours stays distinct and raises it to two', async ({ page }) => {
  await criticReacts(page, '🚩');
  await expect(reaction(page, 'Flag this'), 'not yours').toHaveAttribute('aria-pressed', 'false');
  await expect(reaction(page, 'Flag this'), 'but made').toHaveClass(/\bmade\b/);
  await expect(reaction(page, 'Flag this').locator('.react-count'), 'one agent reacted').toHaveText('1');
  await reaction(page, 'Flag this').click();
  await expect(reaction(page, 'Flag this')).toHaveAttribute('aria-pressed', 'true');
  await expect(reaction(page, 'Flag this').locator('.react-count')).toHaveText('2');
  const box = async (sel) => (await reaction(page, 'Flag this').locator(sel).boundingBox()) ?? { x: 0 };
  expect((await box('.react-count')).x, 'the count is to the right of the icon').toBeGreaterThan((await box('img')).x);
});

test('who reacted shows in a hover card, on hover and on keyboard focus, and in the button’s name', async ({ page }) => {
  await criticReacts(page, '👍');
  await reaction(page, 'Good').click();
  await expect(reaction(page, 'Good')).toHaveAccessibleName(/you and @judge/);
  await reaction(page, 'Good').hover();
  await expect(page.locator('.hovercard'), 'on hover').toContainText('You and @judge');
  await page.mouse.move(5, 5);
  await expect(page.locator('.hovercard')).toHaveCount(0, { timeout: 5_000 });
  await reaction(page, 'Not good').focus();
  await page.keyboard.press('Shift+Tab');
  await expect(reaction(page, 'Good')).toBeFocused();
  await expect(page.locator('.hovercard'), 'on keyboard focus').toContainText('You and @judge');
  // Enter on it reacts, as on any button: it doesn’t pin the card instead.
  await page.keyboard.press('Enter');
  await expect(reaction(page, 'Good')).toHaveAttribute('aria-pressed', 'false');
});

test('a reaction nobody made opens no card', async ({ page }) => {
  await reaction(page, 'Unclear').hover();
  await expect(reaction(page, 'Unclear')).toHaveAccessibleName(/^Unclear/);
  await expect(page.locator('.hovercard')).toHaveCount(0);
});

test('the server keeps yours, beside an agent’s (#251)', async ({ page }) => {
  await criticReacts(page, '✅');
  await reaction(page, 'Done').click();
  await expect(reaction(page, 'Done')).toHaveAttribute('aria-pressed', 'true');
  await expect
    .poll(() => (app.store.item(thread.id, message.id)?.reactions ?? []).map((r) => (r.by ? `@${r.handle}` : 'you')).sort())
    .toEqual(['@judge', 'you']);
});

test('reacting to an app doesn’t draw its frame again (#251)', async ({ page }) => {
  const tools = app.rt.toolsFor(critic.id);
  tools.show_app({ id: 'tally', title: 'Tally', code: '<main style="padding:12px"><p>Tally</p></main>' });
  await synced(page, app);
  const appItem = page.locator(`.transcript > [data-key="${app.rt.s.apps.tally.itemId}"]`);
  await expect(appItem.locator('iframe.app-iframe')).toBeAttached({ timeout: 15_000 });
  await appItem.locator('iframe.app-iframe').evaluate((f) => {
    f.dataset.mark = 'same';
  });
  await appItem.getByRole('button', { name: /^Done\b/ }).click();
  await expect(appItem.getByRole('button', { name: /^Done\b/ })).toHaveAttribute('aria-pressed', 'true');
  await expect(appItem.locator('iframe.app-iframe'), 'the same frame').toHaveAttribute('data-mark', 'same');
});

test('axe finds nothing wrong with a message’s reactions, made or not', async ({ page }) => {
  await criticReacts(page, '👍');
  await reaction(page, 'Flag this').click();
  // Through the protocol, not a script tag: the page’s CSP refuses inline scripts, as it should.
  await page.evaluate(readFileSync(createRequire(import.meta.url).resolve('axe-core/axe.min.js'), 'utf8'));
  const violations = await page.evaluate(async (sel) => {
    const r = await window.axe.run(document.querySelector(sel), { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'] } });
    return { passed: r.passes.length, found: r.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`) };
  }, `.transcript > [data-key="${message.id}"]`);
  expect(violations.found).toEqual([]);
  // A run that passed no rule checked nothing.
  expect(violations.passed, 'rules that ran and passed').toBeGreaterThan(3);
});
