// The wake-limit cards (#108, #320, #439): until #492 removed the limits, a wake past one waited on a card for your
// Allow. A card Postbox stored then still shows and can be answered: what it said, the wakes held on it, and one that
// closed as retired. No new wake raises one (tests/wakes-no-pair-limit.test.mjs, tests/browser/wake-chain.spec.mjs).

import { expect, test } from '@playwright/test';
import { failOnPageErrors, startPostbox, synced } from './postbox.mjs';

/** @type {Awaited<ReturnType<typeof startPostbox>>} */
let app;
/** @type {any} */
let room;
/** @type {any} */
let heldRoom;
/** @type {any} */
let retiredRoom;

test.beforeAll(async () => {
  app = await startPostbox('wake-limit');
  const { rt, store } = app;
  store.emit('project', { id: 'pr_wakes', name: 'Wakes', folder: app.root });
  const personas = ['waker', 'woken', 'other'].map((handle) => rt.createPersona({ handle, backend: 'mock', permissionMode: 'auto', tools: [] }));
  /** A conversation with a wake-limit card as Postbox stored it before #492, and its sessions by handle. */
  const withCard = (title, card) => {
    const t = rt.createThread({ projectId: 'pr_wakes', title, personaIds: personas.map((p) => p.id) });
    const se = (h) => rt.sessionsIn(t.id).find((x) => x.handle === h);
    const held = (card.held ?? []).map((w) => ({ ...w, fromSessionId: se(w.from).id }));
    rt.addItem(t.id, { kind: 'hop', fromSessionId: se('waker').id, from: 'waker', to: 'woken', text: 'check 11', reason: 'check 11', n: 11, ...card, held });
    return t;
  };
  room = withCard('Wakes', { status: 'open' });
  heldRoom = withCard('Held', {
    status: 'open',
    held: [{ from: 'other', to: 'waker', text: 'count the lines in work/', replyIn: null, fromTurnId: null, itemId: null, at: Date.now() }],
  });
  retiredRoom = withCard('Retired', { status: 'retired', retiredWhy: 'you wrote to it', retiredAt: Date.now() });
});
test.afterAll(async () => {
  await app?.stop();
});
failOnPageErrors(test);

test('a stored wake-limit card still shows, says what it was, and can be allowed', async ({ page }) => {
  await page.goto(`${app.origin}/#/t/${room.id}`);
  await synced(page, app);
  const card = page.locator('.transcript .block').filter({ hasText: 'Let @waker wake @woken?' });
  await expect(card).toBeVisible();
  await expect(card).toContainText('That would have been agent wake 11 since your last message, past the limit Postbox kept then.');
  await card.getByRole('button', { name: 'Let @waker wake @woken' }).click();
  await expect(card).toContainText('Allowed');
});

test('a wake held on a stored card shows on it until you answer, and goes when you allow it (#439)', async ({ page }) => {
  await page.goto(`${app.origin}/#/t/${heldRoom.id}`);
  await synced(page, app);
  const card = page.locator('.transcript .block').filter({ hasText: 'Let @waker wake @woken?' });
  const line = card.locator('.hop-held');
  await expect(line).toContainText('Also waiting on your answer: @other’s message to @waker');
  await expect(line).toContainText('Allowing this sends it too.');
  await card.getByRole('button', { name: 'Let @waker wake @woken' }).click();
  await expect(card).toContainText('Allowed');
  await expect(line).toHaveCount(0);
  await expect(page.locator('.transcript')).toContainText('count the lines in work/');
});

test('a stored card that closed as retired says why, and has no buttons (#439)', async ({ page }) => {
  await page.goto(`${app.origin}/#/t/${retiredRoom.id}`);
  await synced(page, app);
  const card = page.locator('.transcript .block').filter({ hasText: 'Let @waker wake @woken?' });
  await expect(card).toContainText('Closed: @woken got a turn another way (you wrote to it), so its message went on, or asks again');
  await expect(card.getByRole('button', { name: 'Let @waker wake @woken' })).toHaveCount(0);
});
