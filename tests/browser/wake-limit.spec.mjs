// The wake-limit card (#108, #320): after HOP_LIMIT agent wakes in a row without you, the next one waits for your
// Allow, and the card says the limit the server keeps, not a number of its own.

import { expect, test } from '@playwright/test';
import { HOP_LIMIT } from '../../server/side-threads.mjs';
import { failOnPageErrors, startPostbox, synced } from './postbox.mjs';

/** @type {Awaited<ReturnType<typeof startPostbox>>} */
let app;
/** @type {any} */
let room;

test.beforeAll(async () => {
  app = await startPostbox('wake-limit');
  const { rt, store } = app;
  store.emit('project', { id: 'pr_wakes', name: 'Wakes', folder: app.root });
  const personas = ['waker', 'woken'].map((handle) => rt.createPersona({ handle, backend: 'mock', permissionMode: 'auto', tools: [] }));
  room = rt.createThread({ projectId: 'pr_wakes', title: 'Wakes', personaIds: personas.map((p) => p.id) });
  const waker = rt.sessionsIn(room.id).find((se) => se.handle === 'waker');
  for (let i = 0; i <= HOP_LIMIT; i++) rt.agentWake(waker.id, 'woken', `check ${i + 1}`);
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
