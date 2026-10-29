// The wake-limit card (#108, #320): after HOP_LIMIT agent wakes in a row without you, the next one waits for your Allow,
// and the card says the limit the server keeps, not a number of its own. The pair limit between two agents (#372) is
// gone since #492 (tests/browser/wake-chain.spec.mjs).

import { expect, test } from '@playwright/test';
import { HOP_LIMIT } from '../../server/side-threads.mjs';
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
  const personas = ['waker', 'woken'].map((handle) => rt.createPersona({ handle, backend: 'mock', permissionMode: 'auto', tools: [] }));
  room = rt.createThread({ projectId: 'pr_wakes', title: 'Wakes', personaIds: personas.map((p) => p.id) });
  const waker = rt.sessionsIn(room.id).find((se) => se.handle === 'waker');
  /** HOP_LIMIT wakes of woken, allowed so the mock agents' answers don't reach the limit first, then one past it. */
  const pastLimit = (se) => {
    for (let i = 0; i < HOP_LIMIT; i++) rt.agentWake(se.id, 'woken', `check ${i + 1}`, { confirmed: true });
    rt.agentWake(se.id, 'woken', `check ${HOP_LIMIT + 1}`);
  };
  pastLimit(waker);
  // A card waits, and a third agent's hand-off that needs one of its own is held on it (#439).
  const other = rt.createPersona({ handle: 'other', backend: 'mock', permissionMode: 'auto', tools: [] });
  heldRoom = rt.createThread({ projectId: 'pr_wakes', title: 'Held', personaIds: [...personas, other].map((p) => p.id) });
  const [hw, hx] = ['waker', 'other'].map((h) => rt.sessionsIn(heldRoom.id).find((se) => se.handle === h));
  pastLimit(hw);
  rt.agentWake(hx.id, 'waker', 'count the lines in work/');
  // A card whose target you then write to closes, retired (#439).
  retiredRoom = rt.createThread({ projectId: 'pr_wakes', title: 'Retired', personaIds: personas.map((p) => p.id) });
  const rw = rt.sessionsIn(retiredRoom.id).find((se) => se.handle === 'waker');
  pastLimit(rw);
  rt.sendMessage(retiredRoom.id, { text: '@woken it’s done, thanks' });
});
test.afterAll(async () => {
  await app?.stop();
});
failOnPageErrors(test);

test('the card waits after the limit’s wakes, and says the limit the server keeps', async ({ page }) => {
  expect(HOP_LIMIT, 'raised from 3 (#320), and to 50 as a backstop (#492)').toBe(50);
  await page.goto(`${app.origin}/#/t/${room.id}`);
  await synced(page, app);
  const card = page.locator('.transcript .block').filter({ hasText: 'Let @waker wake @woken?' });
  await expect(card).toBeVisible();
  await expect(card).toContainText(`That would be agent wake ${HOP_LIMIT + 1} in this chain, past the limit of ${HOP_LIMIT}, so it waits for you.`);
  await expect(card.getByRole('button', { name: 'Let @waker wake @woken' })).toBeEnabled();
});

test('a wake held on the waiting card shows on it until you answer, and goes when you allow it (#439)', async ({ page }) => {
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

test('a card whose target you write to closes, and says why (#439)', async ({ page }) => {
  await page.goto(`${app.origin}/#/t/${retiredRoom.id}`);
  await synced(page, app);
  const card = page.locator('.transcript .block').filter({ hasText: 'Let @waker wake @woken?' });
  await expect(card).toContainText('Closed: @woken got a turn another way (you wrote to it), so its message went on, or asks again');
  await expect(card.getByRole('button', { name: 'Let @waker wake @woken' })).toHaveCount(0);
});
