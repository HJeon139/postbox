// The wake-limit cards (#108, #320, #372): after HOP_LIMIT agent wakes in a row without you, or PAIR_LIMIT between the
// same two agents, the next one waits for your Allow, and the card says the limit the server keeps, not a number of its own.

import { expect, test } from '@playwright/test';
import { HOP_LIMIT, PAIR_LIMIT } from '../../server/side-threads.mjs';
import { failOnPageErrors, startPostbox, synced } from './postbox.mjs';

/** @type {Awaited<ReturnType<typeof startPostbox>>} */
let app;
/** @type {any} */
let room;
/** @type {any} */
let pairRoom;
/** @type {any} */
let heldRoom;

test.beforeAll(async () => {
  app = await startPostbox('wake-limit');
  const { rt, store } = app;
  store.emit('project', { id: 'pr_wakes', name: 'Wakes', folder: app.root });
  const personas = ['waker', 'woken'].map((handle) => rt.createPersona({ handle, backend: 'mock', permissionMode: 'auto', tools: [] }));
  room = rt.createThread({ projectId: 'pr_wakes', title: 'Wakes', personaIds: personas.map((p) => p.id) });
  const waker = rt.sessionsIn(room.id).find((se) => se.handle === 'waker');
  // Allowed ones, so the pair’s own limit doesn’t stop them first: they still count toward HOP_LIMIT.
  for (let i = 0; i < HOP_LIMIT; i++) rt.agentWake(waker.id, 'woken', `check ${i + 1}`, { confirmed: true });
  rt.agentWake(waker.id, 'woken', `check ${HOP_LIMIT + 1}`);
  pairRoom = rt.createThread({ projectId: 'pr_wakes', title: 'Pair', personaIds: personas.map((p) => p.id) });
  const [w, o] = ['waker', 'woken'].map((h) => rt.sessionsIn(pairRoom.id).find((se) => se.handle === h));
  rt.agentWake(w.id, 'woken', 'please check');
  rt.agentWake(o.id, 'waker', 'checked');
  rt.agentWake(w.id, 'woken', 'thanks');
  // A card waits, and a third agent's hand-off that needs one of its own is held on it (#439).
  const other = rt.createPersona({ handle: 'other', backend: 'mock', permissionMode: 'auto', tools: [] });
  heldRoom = rt.createThread({ projectId: 'pr_wakes', title: 'Held', personaIds: [...personas, other].map((p) => p.id) });
  const [hw, ho, hx] = ['waker', 'woken', 'other'].map((h) => rt.sessionsIn(heldRoom.id).find((se) => se.handle === h));
  rt.agentWake(hw.id, 'woken', 'please check');
  rt.agentWake(ho.id, 'waker', 'checked');
  rt.agentWake(hw.id, 'woken', 'thanks');
  rt.agentWake(hx.id, 'waker', 'a task for you');
  rt.agentWake(hw.id, 'other', 'ready');
  rt.agentWake(hx.id, 'waker', 'count the lines in work/');
});
test.afterAll(async () => {
  await app?.stop();
});
failOnPageErrors(test);

test('the card waits after the limit’s wakes, and says the limit the server keeps', async ({ page }) => {
  expect(HOP_LIMIT, 'raised from 3 (#320)').toBe(10);
  await page.goto(`${app.origin}/#/t/${room.id}`);
  await synced(page, app);
  const card = page.locator('.transcript .block').filter({ hasText: 'Let @waker wake @woken?' });
  await expect(card).toBeVisible();
  await expect(card).toContainText(
    `That would be agent wake ${HOP_LIMIT + 1} since your last message. After ${HOP_LIMIT} in a row, the next one waits for you.`,
  );
  await expect(card.getByRole('button', { name: 'Let @waker wake @woken' })).toBeEnabled();
});

test('two agents waking each other in turn stop after a hand-off and its answer, and the card says so (#372)', async ({ page }) => {
  await page.goto(`${app.origin}/#/t/${pairRoom.id}`);
  await synced(page, app);
  const card = page.locator('.transcript .block').filter({ hasText: 'Let @waker wake @woken?' });
  await expect(card).toContainText(`@waker and @woken have woken each other ${PAIR_LIMIT} times in a row, so the next one waits for you.`);
  await expect(card.getByRole('button', { name: 'Let @waker wake @woken' })).toBeEnabled();
});

test('a wake held on the waiting card shows on it until you answer, and goes when you allow it (#439)', async ({ page }) => {
  await page.goto(`${app.origin}/#/t/${heldRoom.id}`);
  await synced(page, app);
  const card = page.locator('.transcript .block').filter({ hasText: 'Let @waker wake @woken?' });
  const line = card.locator('.hop-held');
  // The mock agents answer each wake, and their answers are held too, so only @other’s is checked by name.
  await expect(line).toContainText('Also waiting on your answer: @other’s message to @waker');
  await expect(line).toContainText('Allowing this sends them too.');
  await card.getByRole('button', { name: 'Let @waker wake @woken' }).click();
  await expect(card).toContainText('Allowed');
  await expect(line).toHaveCount(0);
  await expect(page.locator('.transcript')).toContainText('count the lines in work/');
});
